import { createHash } from "node:crypto";
import type pg from "pg";
import { planBankResult, readBankResultSheet, type BankCell, type BankCandidateLine, type BankRecordedPayment, type BankResultFormat,
  type BankRowDecision, type BankSheetResult } from "@studenthub/billing";
import { PostgresTransferLifecycleTransaction, type PayLifecycleActor, type PayLifecycleEffects, type PayLifecyclePolicy,
  type PayLifecycleTransfer } from "../payroll/postgres-transfer-lifecycle-store.js";

/** Whether the actor may handle bank result files at all (upload, look up, apply, read decisions).
 * Runs on the caller's client, inside the transaction where there is one. */
export type BankResultFileGate = (client: pg.PoolClient, actorId: string) => Promise<boolean>;

/**
 * Central file authority. A bank result file is not scoped to one company: one file can name lines of
 * any company, so handling files at all needs finance authority over the whole operator pool. That is a
 * `role` grant with subtree scope covering EVERY listed operator organization (on it, or on an ancestor of
 * it). A self-only grant, a grant on a company, or cover of only some operator organizations is refused,
 * as is an empty or unknown operator list. Per-transfer `complete` authorization still runs on apply.
 * The organization chains are locked FOR SHARE and read again, and the grants are read FOR SHARE.
 */
export function operatorFinanceGate(operatorOrgIds: readonly string[], role = "finance"): BankResultFileGate {
  const operators = [...new Set(operatorOrgIds)].sort();
  const chains = async (client: pg.PoolClient) => (await client.query<{ operator: string; id: string }>(`WITH RECURSIVE chain(operator, id, parent_org_id, depth) AS (
      SELECT id, id, parent_org_id, 0 FROM organizations WHERE id = ANY($1::text[])
      UNION ALL SELECT c.operator, o.id, o.parent_org_id, c.depth + 1 FROM organizations o JOIN chain c ON o.id = c.parent_org_id WHERE c.depth < 64)
    SELECT operator, id FROM chain ORDER BY operator, depth`, [operators])).rows;
  return async (client, actorId) => {
    if (operators.length === 0) return false;
    const before = await chains(client);
    const orgIds = [...new Set(before.map((row) => row.id))].sort();
    await client.query("SELECT id FROM organizations WHERE id = ANY($1::text[]) ORDER BY id FOR SHARE", [orgIds]);
    const held = new Set((await client.query<{ org_id: string }>(
      "SELECT org_id FROM grants WHERE principal_id = $1 AND role = $2 AND scope = 'subtree' AND org_id = ANY($3::text[]) ORDER BY org_id FOR SHARE",
      [actorId, role, orgIds])).rows.map((row) => row.org_id));
    const after = await chains(client);
    if (JSON.stringify(after) !== JSON.stringify(before)) return false;
    return operators.every((operator) => before.some((row) => row.operator === operator && held.has(row.id)));
  };
}

/** Runs the lifecycle `complete` action for a transfer inside the SAME locked
 * transaction (the payroll service's transitionInTransaction). Returns whether
 * the transfer changed. db does not import payroll source, so the caller wires it. */
export type BankResultCompletePort = (tx: PostgresTransferLifecycleTransaction, actor: PayLifecycleActor, transferId: string) => Promise<boolean>;

export type BankResultSubmit =
  | { readonly kind: "submitted"; readonly fileId: string }
  | { readonly kind: "duplicate_file"; readonly fileId: string }
  | { readonly kind: "refused"; readonly code: "forbidden" | "invalid_input" | "missing_headers" | "duplicate_headers" | "no_rows" | "too_many_rows"; readonly missing?: readonly string[] };

/** What applying a file decides, as the actor sees it, with the identity of exactly that outcome. */
export interface BankResultReview { readonly decisions: readonly BankRowDecision[]; readonly completedTransferIds: readonly string[]; readonly reviewId: string }
export type BankResultApply =
  /** Applied exactly as reviewed. */
  | ({ readonly kind: "applied" } & BankResultReview)
  /** A preview: nothing written. Apply with its reviewId. */
  | ({ readonly kind: "review" } & BankResultReview)
  /** The outcome is no longer the reviewed one: nothing written; this is the fresh review. */
  | ({ readonly kind: "changed" } & BankResultReview)
  | { readonly kind: "refused"; readonly code: "forbidden" | "not_found" | "already_applied" };
type Planned = { readonly kind: "planned"; readonly decisions: readonly BankRowDecision[]; readonly completedTransferIds: readonly string[] }
  | Extract<BankResultApply, { kind: "refused" }>;

/** The review identity: the file and every decision and completion the actor was shown, nothing else. */
const reviewIdOf = (fileId: string, decisions: readonly BankRowDecision[], completedTransferIds: readonly string[]) =>
  createHash("sha256").update(JSON.stringify({ fileId, decisions, completedTransferIds })).digest("hex");

type ReadSheet = Extract<BankSheetResult, { kind: "read" }>;

export interface BankResultFileEntry {
  readonly fileId: string; readonly format: BankResultFormat; readonly status: "pending" | "applied"; readonly rowCount: number;
  readonly uploadedBy: string; readonly uploadedAt: string; readonly appliedBy: string | null; readonly appliedAt: string | null;
}
export interface BankResultRecordedRow {
  readonly rowNumber: number; readonly kind: BankRowDecision["kind"]; readonly reason: string | null; readonly lineIds: readonly string[]; readonly reference: string | null;
}
export interface BankResultFileDetail extends BankResultFileEntry { readonly decisions: readonly BankResultRecordedRow[] }
/** A held row of an applied file, with the lines it names that the reader may settle, each with its transfer and current paid flag. */
export interface BankResultHeldRow {
  readonly fileId: string; readonly format: BankResultFormat; readonly appliedAt: string; readonly rowNumber: number;
  readonly reason: string; readonly reference: string | null;
  readonly lines: readonly { readonly lineId: string; readonly transferId: string; readonly paid: boolean }[];
}
/** A bank result row recorded against a line: held for a person, or a failure the bank reported. */
export interface BankResultLineRow { readonly fileId: string; readonly rowNumber: number; readonly kind: "hold" | "unpay"; readonly reason: string | null; readonly reference: string | null; readonly appliedAt: string }
/** One line of a transfer as the bank results record it: paid with which bank payment, and every held or failed row naming it. */
export interface BankResultTransferLine {
  readonly lineId: string; readonly personId: string; readonly amount: string; readonly currency: string; readonly paid: boolean;
  readonly payment: { readonly reference: string | null; readonly fileId: string; readonly rowNumber: number; readonly recordedAt: string } | null;
  readonly rows: readonly BankResultLineRow[];
}
export interface BankResultTransferStatus { readonly transferId: string; readonly companyId: string; readonly status: string; readonly lines: readonly BankResultTransferLine[] }
const TRANSFER_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
const iso = (v: Date | null) => (v === null ? null : v.toISOString());
interface FileRow { id: string; format: BankResultFormat; status: "pending" | "applied"; row_count: string | number; uploaded_by: string; uploaded_at: Date; applied_by: string | null; applied_at: Date | null }
const entry = (r: FileRow): BankResultFileEntry => ({ fileId: r.id, format: r.format, status: r.status, rowCount: Number(r.row_count),
  uploadedBy: r.uploaded_by, uploadedAt: iso(r.uploaded_at)!, appliedBy: r.applied_by, appliedAt: iso(r.applied_at) });

/** All result-file applies are serialised: recorded confirmations are read and
 * written by one apply at a time. The unique reference index still refuses a race. */
const APPLY_LOCK = 7_350_575;
const ELIGIBLE: ReadonlySet<string> = new Set(["distributing", "complete"]);

/** Stores an uploaded bank result file, then applies it once. Apply runs in one
 * transaction: transfers are locked in id order through the pay lifecycle
 * adapter, the pure plan decides every row, paid flags and confirmations are
 * written, and a distributing transfer with nothing left unpaid is completed. */
export class PostgresBankResultStore {
  constructor(private readonly pool: pg.Pool, private readonly policy: PayLifecyclePolicy,
    private readonly effects: PayLifecycleEffects, private readonly complete: BankResultCompletePort,
    private readonly gate: BankResultFileGate) {}

  async submit(actor: PayLifecycleActor, input: { readonly format: BankResultFormat; readonly contentSha256: string; readonly cells: readonly (readonly BankCell[])[] }): Promise<BankResultSubmit> {
    if (actor.actingAs !== false || !actor.principalId?.trim()) return { kind: "refused", code: "forbidden" };
    if ((input.format !== "aub" && input.format !== "kfh") || !/^[0-9a-f]{64}$/u.test(input.contentSha256)) return { kind: "refused", code: "invalid_input" };
    const sheet = readBankResultSheet(input.format, input.cells);
    if (sheet.kind === "refused") return { kind: "refused", code: sheet.code, ...(sheet.missing ? { missing: sheet.missing } : {}) };
    return this.transaction(async (client): Promise<BankResultSubmit> => {
      // The finance gate comes before the duplicate lookup: an earlier file's id is never disclosed to anyone else.
      if (!await this.gate(client, actor.principalId)) return { kind: "refused", code: "forbidden" };
      const inserted = await client.query(
        `INSERT INTO bank_result_files(id,format,content_sha256,uploaded_by,sheet) VALUES(gen_random_uuid(),$1,$2,$3,$4)
         ON CONFLICT (content_sha256) DO NOTHING RETURNING id`,
        [input.format, input.contentSha256, actor.principalId, JSON.stringify({ rows: sheet.rows, rejected: sheet.rejected })]);
      if (inserted.rows[0]) return { kind: "submitted", fileId: inserted.rows[0].id };
      const existing = await client.query("SELECT id FROM bank_result_files WHERE content_sha256=$1", [input.contentSha256]);
      return { kind: "duplicate_file", fileId: existing.rows[0].id };
    }, () => true);
  }

  /** What applying the file now would do, from the same locked transaction as apply, then rolled back. */
  async preview(actor: PayLifecycleActor, fileId: string): Promise<BankResultApply> { return this.run(actor, fileId, null); }

  /** Applies the file only if the outcome is still the reviewed one (`reviewId` from preview); otherwise nothing is written. */
  async apply(actor: PayLifecycleActor, fileId: string, reviewId: string): Promise<BankResultApply> { return this.run(actor, fileId, reviewId); }

  /** The most recent files, newest first; null without finance file permission. */
  async files(actor: PayLifecycleActor, limit = 50): Promise<readonly BankResultFileEntry[] | null> {
    if (actor.actingAs !== false || !actor.principalId?.trim()) return null;
    return this.transaction(async (client) => !await this.gate(client, actor.principalId) ? null
      : (await client.query(`SELECT id,format,status,uploaded_by,uploaded_at,applied_by,applied_at,jsonb_array_length(sheet->'rows')+jsonb_array_length(sheet->'rejected') AS row_count
        FROM bank_result_files ORDER BY uploaded_at DESC, id LIMIT $1`, [Math.min(Math.max(1, limit), 200)])).rows.map(entry), () => true);
  }

  /** One file, with the decision recorded for each row once it is applied; null without finance file permission. */
  async file(actor: PayLifecycleActor, fileId: string): Promise<BankResultFileDetail | null> {
    if (actor.actingAs !== false || !actor.principalId?.trim() || !UUID.test(fileId)) return null;
    return this.transaction(async (client) => {
      if (!await this.gate(client, actor.principalId)) return null;
      const row = (await client.query(`SELECT id,format,status,uploaded_by,uploaded_at,applied_by,applied_at,jsonb_array_length(sheet->'rows')+jsonb_array_length(sheet->'rejected') AS row_count
        FROM bank_result_files WHERE id=$1`, [fileId])).rows[0];
      if (!row) return null;
      const recorded = (await client.query("SELECT row_number,kind,reason,line_ids,reference FROM bank_result_rows WHERE file_id=$1 ORDER BY row_number", [fileId])).rows;
      // Recorded rows name the lines the APPLYING actor could see; this reader sees only lines on transfers they may settle now.
      const visible = await this.visibleLines(client, actor, [...new Set(recorded.flatMap((r) => r.line_ids as string[]))]);
      const decisions = recorded.map((r) => ({ rowNumber: r.row_number, kind: r.kind, reason: r.reason,
        lineIds: (r.line_ids as string[]).filter((id) => visible.has(id)), reference: r.reference }));
      return { ...entry(row), decisions };
    }, () => true);
  }

  /** Held rows of applied files, newest first, naming only lines the reader may settle now; null without finance file permission. */
  async held(actor: PayLifecycleActor, limit = 200): Promise<readonly BankResultHeldRow[] | null> {
    if (actor.actingAs !== false || !actor.principalId?.trim()) return null;
    return this.transaction(async (client) => {
      if (!await this.gate(client, actor.principalId)) return null;
      const held = (await client.query(`SELECT r.file_id,f.format,f.applied_at,r.row_number,r.reason,r.reference,r.line_ids
        FROM bank_result_rows r JOIN bank_result_files f ON f.id=r.file_id WHERE r.kind='hold'
        ORDER BY f.applied_at DESC, r.file_id, r.row_number LIMIT $1`, [Math.min(Math.max(1, limit), 500)])).rows;
      const visible = await this.visibleLines(client, actor, [...new Set(held.flatMap((r) => r.line_ids as string[]))]);
      const lines = new Map((await client.query("SELECT id,transfer_id,paid FROM pay_transfer_lines WHERE id = ANY($1::text[])", [[...visible]])).rows
        .map((r) => [r.id as string, { lineId: r.id as string, transferId: r.transfer_id as string, paid: r.paid as boolean }]));
      return held.map((r) => ({ fileId: r.file_id, format: r.format, appliedAt: iso(r.applied_at)!, rowNumber: r.row_number, reason: r.reason, reference: r.reference,
        lines: (r.line_ids as string[]).flatMap((id) => (lines.has(id) ? [lines.get(id)!] : [])) }));
    }, () => true);
  }

  /** Every line of one transfer as the bank results record it; null without finance file permission, or
   * when the transfer is missing or the reader may not settle it (the two are not told apart). */
  async transfer(actor: PayLifecycleActor, transferId: string): Promise<BankResultTransferStatus | null> {
    if (actor.actingAs !== false || !actor.principalId?.trim() || !TRANSFER_ID.test(transferId)) return null;
    return this.transaction(async (client) => {
      if (!await this.gate(client, actor.principalId)) return null;
      const t = (await client.query("SELECT id,company_id,status,deleted FROM pay_transfers WHERE id=$1", [transferId])).rows[0];
      if (!t || !await this.policy.authorize(client, actor, { id: t.id, companyId: t.company_id, status: t.status, deleted: t.deleted }, "complete")) return null;
      const lines = (await client.query("SELECT id,person_id,candidate_total::text AS amount,currency_code,paid FROM pay_transfer_lines WHERE transfer_id=$1 ORDER BY id", [transferId])).rows;
      const ids = lines.map((l) => l.id as string);
      const payments = new Map((await client.query("SELECT line_id,reference,file_id,row_number,recorded_at FROM bank_result_confirmations WHERE line_id = ANY($1::text[]) ORDER BY id", [ids])).rows
        .map((r) => [r.line_id as string, { reference: r.reference as string | null, fileId: r.file_id as string, rowNumber: r.row_number as number, recordedAt: iso(r.recorded_at)! }]));
      const rows = new Map<string, BankResultLineRow[]>();
      for (const r of (await client.query(`SELECT u.line_id,r.file_id,r.row_number,r.kind,r.reason,r.reference,f.applied_at
        FROM bank_result_rows r CROSS JOIN LATERAL unnest(r.line_ids) AS u(line_id) JOIN bank_result_files f ON f.id=r.file_id
        WHERE r.kind IN ('hold','unpay') AND u.line_id = ANY($1::text[]) ORDER BY f.applied_at, r.file_id, r.row_number`, [ids])).rows) {
        rows.set(r.line_id, [...rows.get(r.line_id) ?? [], { fileId: r.file_id, rowNumber: r.row_number, kind: r.kind, reason: r.reason, reference: r.reference, appliedAt: iso(r.applied_at)! }]);
      }
      return { transferId: t.id, companyId: t.company_id, status: t.status, lines: lines.map((l) => ({ lineId: l.id, personId: l.person_id, amount: l.amount, currency: l.currency_code,
        paid: l.paid, payment: payments.get(l.id) ?? null, rows: rows.get(l.id) ?? [] })) };
    }, () => true);
  }

  private async run(actor: PayLifecycleActor, fileId: string, reviewId: string | null): Promise<BankResultApply> {
    if (actor.actingAs !== false || !actor.principalId?.trim()) return { kind: "refused", code: "forbidden" };
    if (!UUID.test(fileId)) return { kind: "refused", code: "not_found" };
    return this.transaction(async (client): Promise<BankResultApply> => {
      const planned = await this.applyIn(client, actor, fileId);
      if (planned.kind !== "planned") return planned;
      const review = { decisions: planned.decisions, completedTransferIds: planned.completedTransferIds,
        reviewId: reviewIdOf(fileId, planned.decisions, planned.completedTransferIds) };
      if (reviewId === null) return { kind: "review", ...review };
      if (reviewId !== review.reviewId) return { kind: "changed", ...review };
      return { kind: "applied", ...review };
    }, (result) => result.kind === "applied");
  }

  /** The lines, of those given, on transfers the actor may settle now (policy decided in the caller's transaction). */
  private async visibleLines(client: pg.PoolClient, actor: PayLifecycleActor, lineIds: readonly string[]): Promise<Set<string>> {
    const visible = new Set<string>(), decided = new Map<string, boolean>();
    for (const r of (await client.query("SELECT l.id AS line_id,t.id,t.company_id,t.status,t.deleted FROM pay_transfer_lines l JOIN pay_transfers t ON t.id=l.transfer_id WHERE l.id = ANY($1::text[]) ORDER BY l.id", [lineIds])).rows) {
      if (!decided.has(r.id)) decided.set(r.id, await this.policy.authorize(client, actor, { id: r.id, companyId: r.company_id, status: r.status, deleted: r.deleted }, "complete"));
      if (decided.get(r.id)) visible.add(r.line_id);
    }
    return visible;
  }

  private async transaction<T>(work: (client: pg.PoolClient) => Promise<T>, commit: (result: T) => boolean): Promise<T> {
    const client = await this.pool.connect(); let broken = false;
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query(commit(result) ? "COMMIT" : "ROLLBACK");
      return result;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { broken = true; }
      throw error;
    } finally { client.release(broken); }
  }

  private async applyIn(client: pg.PoolClient, actor: PayLifecycleActor, fileId: string): Promise<Planned> {
    await client.query("SELECT pg_advisory_xact_lock($1)", [APPLY_LOCK]);
    // File level first: without finance permission nothing about the file, or its absence, is shown.
    if (!await this.gate(client, actor.principalId)) return { kind: "refused", code: "forbidden" };
    const file = (await client.query("SELECT status,sheet FROM bank_result_files WHERE id=$1 FOR UPDATE", [fileId])).rows[0];
    if (!file) return { kind: "refused", code: "not_found" };
    if (file.status !== "pending") return { kind: "refused", code: "already_applied" };
    const sheet: ReadSheet = { kind: "read", rows: file.sheet.rows, rejected: file.sheet.rejected };

    // Lock every transfer a row names, in id order, before reading its lines.
    const lineRefs = [...new Set(sheet.rows.flatMap((r) => (r.lineRef === null ? [] : [r.lineRef])))];
    const transferIds = (await client.query("SELECT DISTINCT transfer_id FROM pay_transfer_lines WHERE id = ANY($1::text[]) ORDER BY transfer_id", [lineRefs]))
      .rows.map((r) => r.transfer_id as string);
    const tx = new PostgresTransferLifecycleTransaction(client, this.policy, this.effects);
    const locked = new Map<string, PayLifecycleTransfer>();
    for (const id of transferIds) {
      const transfer = await tx.lockTransfer(id);
      // Only money the company has paid in can be settled; other lines stay unmatched.
      if (transfer && !transfer.deleted && ELIGIBLE.has(transfer.status)) locked.set(id, transfer);
    }
    // Settling a line is part of completing its transfer: the actor must hold that
    // company-scoped permission on every transfer this file could write to.
    for (const transfer of locked.values()) {
      if (!await tx.authorize(actor, transfer, "complete")) return { kind: "refused", code: "forbidden" };
    }
    const lines: BankCandidateLine[] = (await client.query(
      "SELECT id,transfer_id,paid,candidate_total::text AS amount,currency_code FROM pay_transfer_lines WHERE id = ANY($1::text[]) AND transfer_id = ANY($2::text[]) ORDER BY id",
      [lineRefs, [...locked.keys()]])).rows.map((r) => ({
      // No beneficiary account is held on a pay line yet: a row without an echoed id finds no line.
      lineId: r.id, transferId: r.transfer_id, paid: r.paid, paidAmount: r.amount, currency: r.currency_code, beneficiaryAccount: null,
    }));
    const references = [...new Set(sheet.rows.flatMap((r) => (r.outcome === "success" && r.reference !== null ? [r.reference] : [])))];
    const recorded: BankRecordedPayment[] = (await client.query(
      "SELECT line_id,reference,account,amount::text AS amount,currency_code FROM bank_result_confirmations WHERE reference = ANY($1::text[]) ORDER BY id",
      [references])).rows.map((r) => ({ lineId: r.line_id, reference: r.reference, account: r.account, amount: r.amount, currency: r.currency_code }));

    const planned = planBankResult(sheet, lines, recorded);
    const byLine = new Map(lines.map((l) => [l.lineId, l]));
    // Recorded history is global so a replay is caught anywhere, but a decision names only lines the
    // actor may see: the candidates (already authorized above) and lines on transfers they may settle.
    const outside = [...new Set(planned.decisions.flatMap((d) => (d.kind === "hold" ? d.lineIds : [d.lineId])).filter((id) => !byLine.has(id)))];
    const visible = new Set<string>([...byLine.keys(), ...await this.visibleLines(client, actor, outside)]);
    const plan = { transferIds: planned.transferIds, decisions: planned.decisions.map((d): BankRowDecision => {
      if (d.kind === "hold") return { ...d, lineIds: d.lineIds.filter((id) => visible.has(id)) };
      // A replay of a line the actor may not see is held as a conflict, without naming the line.
      if (d.kind === "duplicate" && !visible.has(d.lineId)) return { kind: "hold", rowNumber: d.rowNumber, reason: "reference_conflict", lineIds: [] };
      return d;
    }) };
    const byRow = new Map(sheet.rows.map((r) => [r.rowNumber, r]));
    for (const d of plan.decisions) {
      const row = byRow.get(d.rowNumber);
      await client.query("INSERT INTO bank_result_rows(file_id,row_number,kind,reason,line_ids,reference) VALUES($1,$2,$3,$4,$5,$6)",
        [fileId, d.rowNumber, d.kind, d.kind === "hold" ? d.reason : null, d.kind === "hold" ? d.lineIds : [d.lineId], row?.reference ?? null]);
      if (d.kind !== "pay") continue;
      const line = byLine.get(d.lineId)!;
      const paid = await client.query("UPDATE pay_transfer_lines SET paid=true WHERE id=$1 AND transfer_id=$2 AND NOT paid", [d.lineId, d.transferId]);
      if (paid.rowCount !== 1) throw new Error("bank_result_line_changed");
      await client.query(
        "INSERT INTO bank_result_confirmations(reference,line_id,file_id,row_number,account,amount,currency_code) VALUES($1,$2,$3,$4,$5,$6,$7)",
        [d.reference, d.lineId, fileId, d.rowNumber, row!.account, row!.amount ?? line.paidAmount, row!.currency ?? line.currency]);
    }
    const completed: string[] = [];
    for (const id of plan.transferIds) {
      if (locked.get(id)?.status !== "distributing" || await tx.hasUnpaidLines(id)) continue;
      if (!await this.complete(tx, actor, id)) throw new Error("bank_result_complete_refused");
      completed.push(id);
    }
    await client.query("UPDATE bank_result_files SET status='applied',applied_by=$2,applied_at=clock_timestamp() WHERE id=$1", [fileId, actor.principalId]);
    return { kind: "planned", decisions: plan.decisions, completedTransferIds: completed };
  }
}

/** The lifecycle policy for settling transfers from a bank result file: only `complete`, decided
 * inside the apply transaction on the transfer's company. The actor's grants and the company's
 * ancestor rows are locked FOR SHARE, as a void is, so a grant revoked while the apply waits is seen.
 * `decision` is the billing rule (StudentHub finance on an operator organization above the company). */
export function bankResultLifecyclePolicy(decision: (grants: readonly { org_id: string; role: string; scope: string }[], orgId: string, ancestors: readonly string[]) => boolean): PayLifecyclePolicy {
  return {
    async authorize(client, actor, transfer, action) {
      if (action !== "complete" || actor.actingAs !== false) return false;
      const chain = async () => (await client.query<{ id: string }>(`WITH RECURSIVE chain(id, parent_org_id, depth) AS (
          SELECT id, parent_org_id, 0 FROM organizations WHERE id = $1
          UNION ALL SELECT o.id, o.parent_org_id, c.depth + 1 FROM organizations o JOIN chain c ON o.id = c.parent_org_id WHERE c.depth < 64)
        SELECT id FROM chain ORDER BY depth`, [transfer.companyId])).rows.map((row) => row.id);
      const before = await chain();
      await client.query("SELECT id FROM organizations WHERE id = ANY($1::text[]) ORDER BY id FOR SHARE", [before]);
      const grants = (await client.query<{ org_id: string; role: string; scope: string }>(
        "SELECT org_id, role, scope FROM grants WHERE principal_id = $1 ORDER BY org_id, role, scope FOR SHARE", [actor.principalId])).rows;
      const after = await chain();
      if (after[0] !== transfer.companyId || after.some((id) => !before.includes(id))) return false;
      return decision(grants, transfer.companyId, after.slice(1));
    },
    async unassignedPersonIds() { throw new Error("bank_result_policy_lock_unsupported"); },
  };
}
