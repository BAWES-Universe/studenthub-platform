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
    if (!draft.id || !isCalendarDate(draft.periodStart) || !isCalendarDate(draft.periodEnd) || draft.periodEnd < draft.periodStart || !/^[A-Z]{3}$/.test(draft.currencyCode)) throw new RangeError("invalid_transfer");
    await this.transaction(async c => {
      if (!await this.mayWrite(c, actorId, draft.companyId)) throw Error("forbidden");
      await c.query("INSERT INTO pay_transfers(id,company_id,period_start,period_end,currency_code) VALUES($1,$2,$3,$4,$5)", [draft.id,draft.companyId,draft.periodStart,draft.periodEnd,draft.currencyCode]);
      await c.query("INSERT INTO pay_line_audit(transfer_id,actor_id,operation,after_value) VALUES($1,$2,'create_transfer',$3)", [draft.id,actorId,JSON.stringify(draft)]);
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
    return this.transaction(c => this.writeInTransaction(c, actorId, transferId, expectedVersion, lines, edit));
  }
  /** Caller owns BEGIN/COMMIT/ROLLBACK; preserves every F1 write check and audit. */
  async appendLinesInTransaction(c: pg.PoolClient, actorId: string, transferId: string, expectedVersion: number, lines: readonly PayLineDraft[]): Promise<number> {
    return this.writeInTransaction(c, actorId, transferId, expectedVersion, lines, false);
  }
  private async writeInTransaction(c: pg.PoolClient, actorId: string, transferId: string, expectedVersion: number, lines: readonly PayLineDraft[], edit: boolean): Promise<number> {
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 0 || !lines.length) throw new RangeError("invalid_batch");
    lines.forEach(line => this.validateLine(line));
    {
      const t = (await c.query("SELECT *, period_start::text AS start_text, period_end::text AS end_text FROM pay_transfers WHERE id=$1 FOR UPDATE",[transferId])).rows[0];
      if (!t || !await this.mayWrite(c,actorId,t.company_id)) throw Error("not_found");
      if (t.status !== "draft" || t.deleted) throw Error("transfer_not_draft");
      if (t.version !== expectedVersion) throw Error("version_conflict");
      for (const line of lines) {
        if (line.currencyCode !== t.currency_code) throw Error("currency_mismatch");
        // Lock the applicable assignment against an ending correction during this write.
        const assigned = await c.query("SELECT id FROM work_assignments WHERE person_principal_id=$1 AND store_id=$2::uuid AND org_id=$3 AND start_date <= $5::date AND (end_date IS NULL OR end_date >= $4::date) FOR SHARE",[line.personId,line.storeId,t.company_id,t.start_text,t.end_text]);
        if (!assigned.rowCount) throw Error("person_not_assigned");
        const before = edit ? (await c.query("SELECT * FROM pay_transfer_lines WHERE id=$1 AND transfer_id=$2 FOR UPDATE",[line.id,transferId])).rows[0] : null;
        if (edit && (!before || before.person_id !== line.personId || before.store_id !== line.storeId)) throw Error("line_not_found");
        if (edit) await c.query("UPDATE pay_transfer_lines SET candidate_total=$3,company_total=$4,note=$5,calculation=$6 WHERE id=$1 AND transfer_id=$2",[line.id,transferId,line.candidateTotal,line.companyTotal,line.note,JSON.stringify(line.calculation)]);
        else await c.query("INSERT INTO pay_transfer_lines(id,transfer_id,person_id,store_id,currency_code,candidate_total,company_total,note,calculation) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)",[line.id,transferId,line.personId,line.storeId,line.currencyCode,line.candidateTotal,line.companyTotal,line.note,JSON.stringify(line.calculation)]);
        await c.query("INSERT INTO pay_line_audit(transfer_id,line_id,actor_id,operation,before_value,after_value) VALUES($1,$2,$3,$4,$5,$6)",[transferId,line.id,actorId,edit?"edit_line":"add_line",before?JSON.stringify(before):null,JSON.stringify(line)]);
      }
      await c.query("UPDATE pay_transfers SET version=version+1 WHERE id=$1",[transferId]);
      return expectedVersion+1;
    }
  }
}
