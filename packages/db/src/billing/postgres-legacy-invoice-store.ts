import type pg from "pg";
import { parseDecimalString, LEGACY_INVOICE_SCALE, type LegacyInvoiceRecord } from "@studenthub/billing";

export interface LegacyInvoiceImportResult {
  readonly inserted: number;
  readonly advanced: number;
  readonly unchanged: number;
  /** Invoice numbers whose frozen fields differ from what is already imported. Nothing is written for them. */
  readonly conflicts: readonly string[];
}

const columns = `invoice_number AS "invoiceNumber", legacy_invoice_id::text AS "legacyInvoiceId",
  transfer_id::text AS "transferId", parent_transfer_id::text AS "parentTransferId", company_id::text AS "companyId",
  to_char(invoice_date, 'YYYY-MM-DD') AS "invoiceDate", status, total::text AS total,
  currency_code AS "currencyCode", deleted`;

type Row = Omit<LegacyInvoiceRecord, "total"> & { total: string };
const toRecord = (row: Row): LegacyInvoiceRecord =>
  Object.freeze({ ...row, total: parseDecimalString(row.total, LEGACY_INVOICE_SCALE) });

const frozenEqual = (left: LegacyInvoiceRecord, right: LegacyInvoiceRecord) =>
  left.legacyInvoiceId === right.legacyInvoiceId && left.transferId === right.transferId
  && left.parentTransferId === right.parentTransferId && left.companyId === right.companyId
  && left.invoiceDate === right.invoiceDate && left.total === right.total && left.currencyCode === right.currencyCode;

/** Re-runnable import of mapped legacy invoices. One transaction per batch: a failure leaves nothing behind. */
export class PostgresLegacyInvoiceStore {
  constructor(readonly pool: pg.Pool) {}

  async importBatch(records: readonly LegacyInvoiceRecord[]): Promise<LegacyInvoiceImportResult> {
    const client = await this.pool.connect();
    let inserted = 0, advanced = 0, unchanged = 0;
    const conflicts: string[] = [];
    try {
      await client.query("BEGIN");
      for (const record of records) {
        const insert = await client.query(
          `INSERT INTO legacy_invoice (invoice_number, legacy_invoice_id, transfer_id, parent_transfer_id, company_id,
             invoice_date, status, total, currency_code, deleted)
           VALUES ($1, $2::bigint, $3::bigint, $4::bigint, $5::bigint, $6::date, $7, $8::numeric, $9, $10)
           ON CONFLICT (invoice_number) DO NOTHING`,
          [record.invoiceNumber, record.legacyInvoiceId, record.transferId, record.parentTransferId, record.companyId,
            record.invoiceDate, record.status, record.total, record.currencyCode, record.deleted],
        );
        if (insert.rowCount === 1) { inserted++; continue; }
        const existing = (await client.query<Row>(`SELECT ${columns} FROM legacy_invoice WHERE invoice_number = $1 FOR UPDATE`,
          [record.invoiceNumber])).rows[0];
        if (!existing) throw new Error("legacy invoice vanished during import");
        const current = toRecord(existing);
        if (!frozenEqual(current, record)
          || (current.status === "paid" && record.status !== "paid") || (current.deleted && !record.deleted)) {
          conflicts.push(record.invoiceNumber);
          continue;
        }
        if (current.status === record.status && current.deleted === record.deleted) { unchanged++; continue; }
        await client.query("UPDATE legacy_invoice SET status = $2, deleted = $3 WHERE invoice_number = $1",
          [record.invoiceNumber, record.status, record.deleted]);
        advanced++;
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
    return Object.freeze({ inserted, advanced, unchanged, conflicts: Object.freeze(conflicts.sort()) });
  }

  async readAll(): Promise<LegacyInvoiceRecord[]> {
    const { rows } = await this.pool.query<Row>(`SELECT ${columns} FROM legacy_invoice ORDER BY legacy_invoice_id`);
    return rows.map(toRecord);
  }

  async findByNumber(invoiceNumber: string): Promise<LegacyInvoiceRecord | undefined> {
    const { rows } = await this.pool.query<Row>(`SELECT ${columns} FROM legacy_invoice WHERE invoice_number = $1`, [invoiceNumber]);
    return rows[0] ? toRecord(rows[0]) : undefined;
  }
}
