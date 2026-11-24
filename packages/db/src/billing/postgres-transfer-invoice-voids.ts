import pg from "pg";
import { databaseUrl } from "../connection.js";
import { allocateInvoiceNumber } from "./numbering.js";
import { TRANSFER_INVOICE_SERIES } from "./postgres-transfer-invoice-effects.js";

/**
 * F4.7: voiding an issued transfer invoice with a credit note (legacy has neither; its
 * regeneration soft-deletes and re-mints). The void is additive: the invoice keeps its number,
 * total, dates and paid status, and a credit note with a new number from the same series
 * reverses it in full on the Kuwait date it is issued. The invoice is then void with reason
 * `credited`, so an admin unlock and relock of its transfer issues a new invoice, with a new
 * number, for the same company.
 *
 * Only an invoice the company can see is credited: a paid one, or an unpaid one while its
 * transfer is locked or payment sent. Who may call this is the caller's decision; the store
 * records the actor and a reason.
 */
export interface TransferInvoiceCredit {
  readonly creditNumber: string;
  readonly invoiceNumber: string;
  readonly orgId: string;
  readonly currencyCode: string;
  readonly creditDate: string;
  readonly total: string;
  readonly reason: string;
  readonly actorId: string;
}
export type TransferInvoiceCreditResult =
  | { readonly kind: "credited"; readonly credit: TransferInvoiceCredit }
  | { readonly kind: "already_credited"; readonly credit: TransferInvoiceCredit }
  /** Missing, or void for another reason (re-issued or its transfer deleted). */
  | { readonly kind: "not_found" }
  /** Unpaid while its transfer is a draft or cancelled: not payable, so nothing to reverse. */
  | { readonly kind: "not_creditable" };

export const CREDIT_REASON_MAX = 500;
const CREDIT = `credit_number AS "creditNumber", invoice_number AS "invoiceNumber", org_id AS "orgId", currency_code AS "currencyCode",
  credit_date::text AS "creditDate", total::text AS total, reason, actor_id AS "actorId"`;

/** The reason as stored: trimmed, 1 to 500 characters, no control characters. */
export function creditReason(reason: unknown): string {
  const value = typeof reason === "string" ? reason.trim() : "";
  // eslint-disable-next-line no-control-regex
  if (value.length === 0 || [...value].length > CREDIT_REASON_MAX || /[\u0000-\u001f\u007f]/.test(value)) throw new RangeError("invalid_reason");
  return value;
}

export class PostgresTransferInvoiceVoids {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /** Credits one invoice in full. A second call for the same invoice answers the first credit note. */
  async credit(input: { actorId: string; invoiceNumber: string; reason: string }): Promise<TransferInvoiceCreditResult> {
    const reason = creditReason(input.reason);
    const client = await this.#pool.connect();
    let destroy = false;
    try {
      await client.query("BEGIN");
      // Transfer row first, then the invoice: the same order as the pay lifecycle, so a void and a
      // lock, payment or delete of the same transfer queue behind each other instead of deadlocking.
      const transferId = (await client.query<{ transfer_id: string }>(
        "SELECT transfer_id FROM transfer_invoice WHERE invoice_number = $1", [input.invoiceNumber])).rows[0]?.transfer_id;
      if (!transferId) { await client.query("ROLLBACK"); return { kind: "not_found" }; }
      const transfer = (await client.query<{ status: string }>("SELECT status FROM pay_transfers WHERE id = $1 FOR UPDATE", [transferId])).rows[0]!;
      const invoice = (await client.query<{ org_id: string; currency_code: string; total: string; status: string; deleted: boolean; void_reason: string | null }>(
        "SELECT org_id, currency_code, total::text AS total, status, deleted, void_reason FROM transfer_invoice WHERE invoice_number = $1 FOR UPDATE",
        [input.invoiceNumber])).rows[0]!;
      if (invoice.void_reason === "credited") {
        const credit = (await client.query<TransferInvoiceCredit>(`SELECT ${CREDIT} FROM transfer_invoice_credit WHERE invoice_number = $1`, [input.invoiceNumber])).rows[0]!;
        await client.query("ROLLBACK");
        return { kind: "already_credited", credit };
      }
      if (invoice.deleted) { await client.query("ROLLBACK"); return { kind: "not_found" }; }
      if (invoice.status !== "paid" && !["locked", "payment_sent"].includes(transfer.status)) { await client.query("ROLLBACK"); return { kind: "not_creditable" }; }
      // The issue day is read only after every lock this credit waits on: the transfer above and the
      // series counter here. now() is fixed at transaction start, so a wait across Kuwait midnight
      // must not date (or number) the credit note on the day before.
      await client.query("SELECT 1 FROM billing_sequence WHERE account_id = $1 FOR UPDATE", [TRANSFER_INVOICE_SERIES.accountId]);
      const today = (await client.query<{ today: string }>("SELECT (clock_timestamp() AT TIME ZONE 'Asia/Kuwait')::date::text AS today")).rows[0]!.today;
      const creditNumber = await allocateInvoiceNumber(client, { ...TRANSFER_INVOICE_SERIES, period: today.slice(0, 7) });
      const credit = (await client.query<TransferInvoiceCredit>(
        `INSERT INTO transfer_invoice_credit (credit_number, invoice_number, org_id, currency_code, credit_date, total, reason, actor_id)
         VALUES ($1, $2, $3, $4, $5::date, $6::numeric, $7, $8) RETURNING ${CREDIT}`,
        [creditNumber, input.invoiceNumber, invoice.org_id, invoice.currency_code, today, invoice.total, reason, input.actorId])).rows[0]!;
      await client.query("UPDATE transfer_invoice SET deleted = true, void_reason = 'credited' WHERE invoice_number = $1", [input.invoiceNumber]);
      await client.query("COMMIT");
      return { kind: "credited", credit };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { destroy = true; }
      throw error;
    } finally {
      client.release(destroy);
    }
  }
}
