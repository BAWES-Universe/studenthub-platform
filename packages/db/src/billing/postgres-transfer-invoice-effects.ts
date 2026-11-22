import type pg from "pg";
import { allocateInvoiceNumber } from "./numbering.js";
import type { PayLifecycleEffects } from "../payroll/postgres-transfer-lifecycle-store.js";

/**
 * One platform-wide series for transfer invoices, as legacy has one global
 * invoice series. `SH-YYYY-MM-000001` can never collide with an imported
 * `LEGACY-<id>` number, and the prefix is permanently bound to this account.
 */
export const TRANSFER_INVOICE_SERIES = Object.freeze({ accountId: "studenthub-transfers", accountPrefix: "SH" });

export interface TransferInvoice {
  readonly invoiceNumber: string;
  readonly transferId: string;
  readonly orgId: string;
  readonly currencyCode: string;
  readonly invoiceDate: string;
  readonly total: string;
  readonly lineCount: number;
  readonly status: "unpaid" | "paid";
  readonly deleted: boolean;
  readonly voidReason: "reissued" | "transfer_deleted" | null;
}

interface Group { readonly org_id: string; readonly in_tree: boolean; readonly line_count: number; readonly total: string; readonly lines_hash: string }

const EMPTY_HASH = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

/**
 * Billing side of the pay transfer lifecycle. Every method runs on the caller's
 * client inside the lifecycle transaction that already holds the transfer row
 * lock, so issuing, paying and voiding commit or roll back with the state change.
 */
export class PostgresTransferInvoiceEffects implements PayLifecycleEffects {
  /** Draft -> locked. Issues one invoice per billed company; on a relock reuses an
   * unchanged invoice and voids and re-issues one whose lines changed. */
  async ensureChildrenAndInvoices(client: pg.PoolClient, transferId: string): Promise<void> {
    const transfer = (await client.query<{ company_id: string; currency_code: string; today: string }>(
      `SELECT company_id, currency_code, (now() AT TIME ZONE 'Asia/Kuwait')::date::text AS today
         FROM pay_transfers WHERE id = $1 AND NOT deleted`, [transferId])).rows[0];
    if (!transfer) throw new Error("transfer_invoice_transfer_missing");
    // The billed company of a line is the company that owns its store. The
    // recursive UNION de-duplicates, so a malformed parent cycle still ends.
    const groups = (await client.query<Group>(
      `WITH RECURSIVE tree(id) AS (
         SELECT $2::text UNION SELECT o.id FROM organizations o JOIN tree ON o.parent_org_id = tree.id)
       SELECT s.org_id, s.org_id IN (SELECT id FROM tree) AS in_tree, count(*)::int AS line_count,
              sum(l.company_total)::numeric(18,3)::text AS total,
              encode(sha256(convert_to(string_agg(l.id || ':' || l.company_total::text, ',' ORDER BY l.id), 'UTF8')), 'hex') AS lines_hash
         FROM pay_transfer_lines l JOIN organization_stores s ON s.id = l.store_id
        WHERE l.transfer_id = $1 GROUP BY s.org_id ORDER BY s.org_id`,
      [transferId, transfer.company_id])).rows;
    if (groups.some(group => !group.in_tree)) throw new Error("transfer_invoice_line_outside_company");
    // Legacy issues an invoice even for a transfer without lines.
    const wanted: readonly Group[] = groups.length > 0 ? groups
      : [{ org_id: transfer.company_id, in_tree: true, line_count: 0, total: "0.000", lines_hash: EMPTY_HASH }];
    const live = new Map((await client.query<{ invoice_number: string; org_id: string; lines_hash: string }>(
      `SELECT invoice_number, org_id, lines_hash FROM transfer_invoice
        WHERE transfer_id = $1 AND NOT deleted ORDER BY invoice_number`, [transferId])).rows
      .map(row => [row.org_id, row] as const));
    const wantedOrgs = new Set(wanted.map(group => group.org_id));
    for (const [orgId, row] of live) {
      if (!wantedOrgs.has(orgId)) await this.voidInvoice(client, row.invoice_number, "reissued");
    }
    for (const group of wanted) {
      const existing = live.get(group.org_id);
      if (existing?.lines_hash === group.lines_hash) continue;
      if (existing) await this.voidInvoice(client, existing.invoice_number, "reissued");
      const invoiceNumber = await allocateInvoiceNumber(client, { ...TRANSFER_INVOICE_SERIES, period: transfer.today.slice(0, 7) });
      await client.query(
        `INSERT INTO transfer_invoice (invoice_number, transfer_id, org_id, currency_code, invoice_date, total, line_count, lines_hash)
         VALUES ($1, $2, $3, $4, $5::date, $6::numeric, $7, $8)`,
        [invoiceNumber, transferId, group.org_id, transfer.currency_code, transfer.today, group.total, group.line_count, group.lines_hash]);
    }
  }

  /** Payment received: every live invoice of the transfer, parent and children. */
  async markInvoicesPaid(client: pg.PoolClient, transferId: string): Promise<void> {
    const live = await client.query(
      "SELECT 1 FROM transfer_invoice WHERE transfer_id = $1 AND NOT deleted FOR UPDATE", [transferId]);
    if (live.rowCount === 0) throw new Error("transfer_invoice_missing");
    await client.query(
      "UPDATE transfer_invoice SET status = 'paid', paid_at = now() WHERE transfer_id = $1 AND NOT deleted AND status = 'unpaid'",
      [transferId]);
  }

  /** Transfer soft delete: its invoices are voided, never removed. A paid invoice refuses. */
  async softDeleteGroup(client: pg.PoolClient, transferId: string): Promise<void> {
    await client.query(
      "UPDATE transfer_invoice SET deleted = true, void_reason = 'transfer_deleted' WHERE transfer_id = $1 AND NOT deleted",
      [transferId]);
  }

  private async voidInvoice(client: pg.PoolClient, invoiceNumber: string, reason: "reissued"): Promise<void> {
    await client.query("UPDATE transfer_invoice SET deleted = true, void_reason = $2 WHERE invoice_number = $1", [invoiceNumber, reason]);
  }
}

const columns = `invoice_number AS "invoiceNumber", transfer_id AS "transferId", org_id AS "orgId",
  currency_code AS "currencyCode", invoice_date::text AS "invoiceDate", total::text AS total,
  line_count AS "lineCount", status, deleted, void_reason AS "voidReason"`;

type Queryable = Pick<pg.Pool | pg.PoolClient, "query">;

/** Every invoice of a transfer, voided ones included, oldest number first. */
export async function listTransferInvoices(db: Queryable, transferId: string): Promise<readonly TransferInvoice[]> {
  return (await db.query<TransferInvoice>(
    `SELECT ${columns} FROM transfer_invoice WHERE transfer_id = $1 ORDER BY issued_at, invoice_number`, [transferId])).rows;
}

/** Legacy `TransferCandidate::getInvoiceNumber`: the live invoice of the company
 * that owns the line's store. Every line has one once its transfer is locked. */
export async function transferInvoiceForLine(db: Queryable, lineId: string): Promise<TransferInvoice | undefined> {
  return (await db.query<TransferInvoice>(
    `SELECT ${columns} FROM transfer_invoice i
      WHERE NOT i.deleted AND (i.transfer_id, i.org_id) = (
        SELECT l.transfer_id, s.org_id FROM pay_transfer_lines l JOIN organization_stores s ON s.id = l.store_id WHERE l.id = $1)`,
    [lineId])).rows[0];
}
