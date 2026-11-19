import type pg from "pg";
import { isCalendarDate } from "@studenthub/pay-contracts";
/** Persistence DTO: payroll domain values it and supplies its validator at composition time.
 * The db workspace must not import another area's unbuilt source files. */
export interface PayLineDraft {
  readonly id: string;
  readonly personId: string;
  readonly storeId: string;
  readonly currencyCode: string;
  readonly candidateTotal: string;
  readonly companyTotal: string;
  readonly note: string;
  readonly calculation: Readonly<Record<string, unknown>>;
}
/** A private JSON snapshot rejects values JSON serialization would silently change. */
type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
function snapshotJson(value: unknown, ancestors = new Set<object>()): JsonValue {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "object" || value === null || ancestors.has(value)) throw new RangeError("invalid_calculation_json");
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) throw new RangeError("invalid_calculation_json");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return Object.freeze(Array.from(value, item => snapshotJson(item, ancestors)));
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, item]) => [key, snapshotJson(item, ancestors)])));
  } finally { ancestors.delete(value); }
}
export function snapshotPayLine(line: PayLineDraft): PayLineDraft {
  const { id, personId, storeId, currencyCode, candidateTotal, companyTotal, note, calculation } = line;
  if (![id, personId, storeId, currencyCode, candidateTotal, companyTotal, note].every(value => typeof value === "string")) throw new RangeError("invalid_line");
  const json = snapshotJson(calculation);
  if (json === null || typeof json !== "object" || Array.isArray(json)) throw new RangeError("invalid_calculation_json");
  return Object.freeze({ id, personId, storeId, currencyCode, candidateTotal, companyTotal, note, calculation: json as Readonly<Record<string, JsonValue>> });
}
export interface PayTransferDraft { readonly id: string; readonly companyId: string; readonly periodStart: string; readonly periodEnd: string; readonly currencyCode: string }
/** Required policy executes on the same transaction/client as writes. No permissive production default. */
export type PayLineWritePolicy = (client: pg.PoolClient, actorId: string, companyId: string) => Promise<boolean>;
export class PostgresPayLinesStore {
  constructor(private readonly pool: pg.Pool, private readonly mayWrite: PayLineWritePolicy, private readonly validateLine: (line: PayLineDraft) => void) {}
  private async transaction<T>(fn: (c: pg.PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect(); let broken = false;
    try { await c.query("BEGIN"); const result = await fn(c); await c.query("COMMIT"); return result; }
    catch (error) { try { await c.query("ROLLBACK"); } catch { broken = true; } throw error; }
    finally { c.release(broken); }
  }
  async create(actorId: string, draft: PayTransferDraft): Promise<void> {
    const transfer: PayTransferDraft = Object.freeze({ id: draft.id, companyId: draft.companyId, periodStart: draft.periodStart, periodEnd: draft.periodEnd, currencyCode: draft.currencyCode });
    if (!Object.values(transfer).every(value => typeof value === "string") || !transfer.id || !transfer.companyId || !isCalendarDate(transfer.periodStart) || !isCalendarDate(transfer.periodEnd) || transfer.periodEnd < transfer.periodStart || !/^[A-Z]{3}$/.test(transfer.currencyCode)) throw new RangeError("invalid_transfer");
    await this.transaction(async c => {
      if (!await this.mayWrite(c, actorId, transfer.companyId)) throw Error("forbidden");
      await c.query("INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,$2,$3,$4,$5)", [transfer.id,transfer.companyId,transfer.periodStart,transfer.periodEnd,transfer.currencyCode]);
      await c.query("INSERT INTO pay_line_audit(transfer_id,actor_id,operation,after_value) VALUES($1,$2,'create_transfer',$3)", [transfer.id,actorId,JSON.stringify(transfer)]);
    });
  }
  /** Atomic append of valued lines. Generator-wide claims are not provided by this F-1 primitive. */
  async appendLines(actorId: string, transferId: string, expectedVersion: number, lines: readonly PayLineDraft[]): Promise<number> {
    return this.write(actorId,transferId,expectedVersion,lines,false);
  }
  async editLine(actorId: string, transferId: string, expectedVersion: number, line: PayLineDraft): Promise<number> {
    return this.write(actorId,transferId,expectedVersion,[line],true);
  }
  private async write(actorId: string, transferId: string, expectedVersion: number, lines: readonly PayLineDraft[], edit: boolean): Promise<number> {
    const snapshot = this.prepare(expectedVersion, lines);
    return this.transaction(c => this.writeSnapshot(c, actorId, transferId, expectedVersion, snapshot, edit));
  }
  /** The caller owns the transaction and must commit or roll it back. */
  async appendLinesInTransaction(c: pg.PoolClient, actorId: string, transferId: string, expectedVersion: number, lines: readonly PayLineDraft[]): Promise<number> {
    const snapshot = this.prepare(expectedVersion, lines);
    return this.writeSnapshot(c, actorId, transferId, expectedVersion, snapshot, false);
  }
  private prepare(expectedVersion: number, lines: readonly PayLineDraft[]): readonly PayLineDraft[] {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || !lines.length) throw new RangeError("invalid_batch");
    const snapshot = Object.freeze(Array.from(lines, snapshotPayLine));
    snapshot.forEach(line => this.validateLine(line));
    return snapshot;
  }
  private async writeSnapshot(c: pg.PoolClient, actorId: string, transferId: string, expectedVersion: number, snapshot: readonly PayLineDraft[], edit: boolean): Promise<number> {
    const t = (await c.query("SELECT *, period_start::text AS start_text, period_end::text AS end_text FROM pay_transfers WHERE id=$1 FOR UPDATE",[transferId])).rows[0];
    if (!t || !await this.mayWrite(c,actorId,t.company_id)) throw Error("not_found");
    if (t.status !== "draft" || t.deleted) throw Error("transfer_not_draft");
    if (t.version !== expectedVersion) throw Error("version_conflict");
    for (const line of snapshot) {
      if (line.currencyCode !== t.currency_code) throw Error("currency_mismatch");
      // Lock the applicable assignment against an ending correction during this write.
      const assigned = await c.query("SELECT id FROM work_assignments WHERE person_principal_id=$1 AND store_id=$2::uuid AND org_id=$3 AND start_date <= $5::date AND (end_date IS NULL OR end_date >= $4::date) FOR SHARE",[line.personId,line.storeId,t.company_id,t.start_text,t.end_text]);
      if (!assigned.rowCount) throw Error("person_not_assigned");
      const before = edit ? (await c.query("SELECT * FROM pay_transfer_lines WHERE id=$1 AND transfer_id=$2 AND person_id=$3 AND store_id=$4::uuid FOR UPDATE",[line.id,transferId,line.personId,line.storeId])).rows[0] : null;
      if (edit && !before) throw Error("line_not_found");
      if (edit) await c.query("UPDATE pay_transfer_lines SET candidate_total=$3,company_total=$4,note=$5,calculation=$6 WHERE id=$1 AND transfer_id=$2",[line.id,transferId,line.candidateTotal,line.companyTotal,line.note,JSON.stringify(line.calculation)]);
      else await c.query("INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[line.id,transferId,line.personId,line.storeId,line.currencyCode,line.candidateTotal,line.companyTotal,line.note,JSON.stringify(line.calculation)]);
      await c.query("INSERT INTO pay_line_audit(transfer_id,line_id,actor_id,operation,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6)",[transferId,line.id,actorId,edit?"edit_line":"add_line",before?JSON.stringify(before):null,JSON.stringify(line)]);
    }
    await c.query("UPDATE pay_transfers SET version=version+1 WHERE id=$1",[transferId]);
    return expectedVersion+1;
  }
}
