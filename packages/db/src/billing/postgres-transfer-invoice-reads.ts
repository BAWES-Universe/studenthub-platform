import pg from "pg";
import { databaseUrl } from "../connection.js";
import { organizationLive } from "../organization-liveness.js";
import { candidateWorked } from "./postgres-pay-history-reads.js";

/**
 * Read side of transfer invoices for the company invoices page and the invoice/receipt PDF (I3).
 *
 * A reader asks for one organization. The decision sees the reader's grants and that
 * organization's ancestors; a refused, missing or deleted organization all answer null, so a
 * reader cannot tell them apart. An allowed reader sees the live (not voided) invoices billed to
 * the organization, and to each organization below it that the reader's grants also cover (legacy
 * `filterCurrentCompany` shows a parent all its sub-companies; here that takes a subtree grant).
 */
type Grant = { org_id: string; role: string; scope: string };
export type TransferInvoiceReadDecision = (rows: readonly Grant[], orgId: string, ancestors: readonly string[]) => boolean;

export interface TransferInvoiceListEntry {
  readonly invoiceNumber: string;
  readonly transferId: string;
  readonly orgId: string;
  readonly companyName: string;
  readonly currencyCode: string;
  readonly invoiceDate: string;
  readonly total: string;
  readonly lineCount: number;
  readonly status: "unpaid" | "paid";
  /** Kuwait date the payment was received, for a paid invoice. */
  readonly paidOn: string | null;
  /** The credit note that voided this invoice (F4.7), and its date; null while the invoice stands. */
  readonly creditNumber: string | null;
  readonly creditedOn: string | null;
}
export interface TransferInvoiceDocument extends TransferInvoiceListEntry {
  readonly periodStart: string;
  readonly periodEnd: string;
}
export interface TransferInvoicePage { readonly orgId: string; readonly name: string; readonly invoices: readonly TransferInvoiceListEntry[] }

/**
 * One movement on a statement: an invoice issued (adds to the balance), a payment received for one
 * or a credit note voiding one (each takes it off). A credit note's `invoiceNumber` is the invoice it reverses.
 */
export interface TransferStatementEntry {
  readonly date: string;
  readonly kind: "invoice" | "payment" | "credit";
  readonly invoiceNumber: string;
  /** The credit note's own number, for a credit; null otherwise. */
  readonly creditNumber: string | null;
  readonly orgId: string;
  readonly companyName: string;
  readonly currencyCode: string;
  readonly amount: string;
}
export interface TransferStatementTotals { readonly opening: string; readonly invoiced: string; readonly paid: string; readonly credited: string; readonly closing: string }
export interface TransferStatementMember extends TransferStatementTotals { readonly orgId: string; readonly companyName: string }
export interface TransferStatementCurrency extends TransferStatementTotals { readonly currencyCode: string; readonly members: readonly TransferStatementMember[] }
/**
 * F4.8: the account statement of a company and the sub-companies the reader may see, for the
 * Kuwait dates `from` to `to` inclusive. Opening is what was owed before `from`; closing is what
 * was owed at the end of `to`, so a statement ending today closes on the current balance.
 */
export interface TransferStatement {
  readonly orgId: string;
  readonly name: string;
  readonly from: string;
  readonly to: string;
  readonly currencies: readonly TransferStatementCurrency[];
  readonly entries: readonly TransferStatementEntry[];
}

/**
 * O-13: a company's transfers as the company sees them (legacy company `TransferController::actionList` and
 * `actionView`). Same readers and the same per-company tree as the invoices. A company sees what it pays: the
 * company total per line, and the worked time behind it. The candidate's total, rates and the rest of the
 * calculation stay behind (legacy company `TransferCandidate::fields` unsets them too).
 */
export type CompanyTransferStatus = "draft" | "locked" | "payment_sent" | "distributing" | "complete" | "cancelled";
export interface CompanyTransferEntry {
  readonly transferId: string;
  readonly orgId: string;
  readonly companyName: string;
  readonly periodStart: string;
  readonly periodEnd: string;
  readonly currencyCode: string;
  readonly status: CompanyTransferStatus;
  readonly lineCount: number;
  /** What the company owes for the transfer: the sum of its lines' company totals. */
  readonly companyTotal: string;
  readonly paymentReceivedOn: string | null;
}
export interface CompanyTransferPage { readonly orgId: string; readonly name: string; readonly transfers: readonly CompanyTransferEntry[] }
export interface CompanyTransferLine {
  readonly lineId: string;
  readonly personName: string;
  readonly storeName: string;
  /** Worked time for a line generated from an hourly contract; null otherwise. */
  readonly worked: { readonly hours: string; readonly minutes: number } | null;
  readonly companyTotal: string;
  readonly paid: boolean;
}
export interface CompanyTransferDetail extends CompanyTransferEntry { readonly lines: readonly CompanyTransferLine[] }

const NAME = (alias: string, profile: string) => `COALESCE(NULLIF(btrim(${profile}.name_en), ''), ${alias}.name)`;
const ENTRY = `i.invoice_number AS "invoiceNumber", i.transfer_id AS "transferId", i.org_id AS "orgId", ${NAME("o", "p")} AS "companyName",
  i.currency_code AS "currencyCode", i.invoice_date::text AS "invoiceDate", i.total::text AS total, i.line_count AS "lineCount", i.status,
  (i.paid_at AT TIME ZONE 'Asia/Kuwait')::date::text AS "paidOn", c.credit_number AS "creditNumber", c.credit_date::text AS "creditedOn"`;
/*
 * Only locked and payment-sent transfers make an unpaid invoice due. After an admin unlock the transfer is a
 * draft again and its amounts can change, and a cancelled transfer is never paid, so their
 * unpaid invoices are neither listed nor served: they are not payable. A relock re-issues or
 * keeps them (`PostgresTransferInvoiceEffects`), and a paid invoice is always shown as a receipt.
 * A credited invoice (F4.7) was shown when it was credited, so it stays, with its credit note, whatever
 * its transfer does next; an invoice voided for any other reason is gone.
 */
const FROM = `FROM transfer_invoice i JOIN organizations o ON o.id = i.org_id LEFT JOIN organization_profiles p ON p.org_id = i.org_id
  JOIN pay_transfers t ON t.id = i.transfer_id LEFT JOIN transfer_invoice_credit c ON c.invoice_number = i.invoice_number
  WHERE (NOT i.deleted OR i.void_reason = 'credited') AND i.org_id = ANY($1::text[])
    AND (i.status = 'paid' OR t.status IN ('locked', 'payment_sent') OR i.void_reason = 'credited')`;

/*
 * Statement movements come from the same documents the invoices page shows (FROM above): an invoice
 * counts on its issue date, its payment on the Kuwait date it was received, its credit note on the
 * credit note's date. Nothing is read from
 * live pay lines, so a past window keeps its figures when later invoices are issued or paid.
 */
const MOVEMENTS = `WITH docs AS (SELECT i.invoice_number, i.org_id, ${NAME("o", "p")} AS company, i.currency_code, i.total, i.invoice_date,
    CASE WHEN i.status = 'paid' THEN (i.paid_at AT TIME ZONE 'Asia/Kuwait')::date END AS paid_on, c.credit_number, c.credit_date ${FROM}),
  moves AS (SELECT invoice_date AS on_date, 'invoice' AS kind, invoice_number, NULL::text AS credit_number, org_id, company, currency_code, total AS amount FROM docs
    UNION ALL SELECT paid_on, 'payment', invoice_number, NULL, org_id, company, currency_code, -total FROM docs WHERE paid_on IS NOT NULL
    UNION ALL SELECT credit_date, 'credit', invoice_number, credit_number, org_id, company, currency_code, -total FROM docs WHERE credit_number IS NOT NULL)`;

const TRANSFER = `t.id AS "transferId", t.company_id AS "orgId", ${NAME("o", "p")} AS "companyName",
  t.period_start::text AS "periodStart", t.period_end::text AS "periodEnd", t.currency_code AS "currencyCode", t.status,
  (SELECT count(*)::int FROM pay_transfer_lines l WHERE l.transfer_id = t.id) AS "lineCount",
  (SELECT COALESCE(sum(l.company_total), 0)::numeric(40,3)::text FROM pay_transfer_lines l WHERE l.transfer_id = t.id) AS "companyTotal",
  t.payment_received_on::text AS "paymentReceivedOn"`;
const TRANSFERS = `FROM pay_transfers t JOIN organizations o ON o.id = t.company_id LEFT JOIN organization_profiles p ON p.org_id = t.company_id
  WHERE NOT t.deleted AND t.company_id = ANY($1::text[])`;

export class PostgresTransferInvoiceReads {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  readonly #decision: TransferInvoiceReadDecision;
  constructor(options: { connectionString?: string; pool?: pg.Pool; decision: TransferInvoiceReadDecision }) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
    this.#decision = options.decision;
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /**
   * The organizations in `orgId`'s tree whose invoices the reader may see, or null when the
   * reader may not read `orgId` itself. Each company below is decided on its own, with its
   * own ancestor chain, so a self grant on a parent does not reach its sub-companies; a
   * subtree grant above, or a grant on the sub-company itself, does.
   */
  async #visible(principalId: string, orgId: string): Promise<readonly string[] | null> {
    if (!await organizationLive(this.#pool, orgId)) return null;
    const [grants, ancestors, tree] = await Promise.all([
      this.#pool.query<Grant>("SELECT org_id, role, scope FROM grants WHERE principal_id = $1", [principalId]),
      this.#pool.query<{ id: string }>(`WITH RECURSIVE chain AS (SELECT id, parent_org_id FROM organizations WHERE id = $1
          UNION SELECT o.id, o.parent_org_id FROM organizations o JOIN chain c ON c.parent_org_id = o.id) SELECT id FROM chain WHERE id <> $1`, [orgId]),
      // Each sub-company with the chain from orgId down to its parent; the cycle guard keeps a malformed parent loop finite.
      this.#pool.query<{ id: string; path: string[] }>(`WITH RECURSIVE tree(id, path) AS (SELECT $1::text, ARRAY[]::text[]
          UNION ALL SELECT o.id, t.path || t.id FROM organizations o JOIN tree t ON o.parent_org_id = t.id WHERE NOT o.id = ANY(t.path || t.id))
        SELECT t.id, t.path FROM tree t WHERE NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = t.id)`, [orgId]),
    ]);
    const above = ancestors.rows.map(row => row.id);
    if (!this.#decision(grants.rows, orgId, above)) return null;
    return tree.rows.filter(node => node.id === orgId || this.#decision(grants.rows, node.id, [...[...node.path].reverse(), ...above])).map(node => node.id);
  }

  /** The organization's invoices and its sub-companies', newest first; null when the reader may not see them. */
  async listForOrganization(principalId: string, orgId: string): Promise<TransferInvoicePage | null> {
    const visible = await this.#visible(principalId, orgId);
    if (!visible) return null;
    const [organization, invoices] = await Promise.all([
      this.#pool.query<{ name: string }>(`SELECT ${NAME("o", "p")} AS name FROM organizations o LEFT JOIN organization_profiles p ON p.org_id = o.id WHERE o.id = $1`, [orgId]),
      this.#pool.query<TransferInvoiceListEntry>(`SELECT ${ENTRY} ${FROM} ORDER BY i.invoice_date DESC, i.issued_at DESC, i.invoice_number DESC`, [visible]),
    ]);
    return { orgId, name: organization.rows[0]?.name ?? orgId, invoices: invoices.rows };
  }

  /** The statement for `from`..`to` (ISO dates, `from` <= `to`); null when the reader may not see the organization. */
  async statement(principalId: string, orgId: string, from: string, to: string): Promise<TransferStatement | null> {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to) || from > to) throw new RangeError("invalid_window");
    const visible = await this.#visible(principalId, orgId);
    if (!visible) return null;
    const name = (await this.#pool.query<{ name: string }>(
      `SELECT ${NAME("o", "p")} AS name FROM organizations o LEFT JOIN organization_profiles p ON p.org_id = o.id WHERE o.id = $1`, [orgId])).rows[0]?.name ?? orgId;
    // One statement, so one snapshot: the opening balances and the movements always come from the same documents.
    // Amounts stay unbounded numeric at scale 3 (invoice totals are numeric(18,3), and sums can exceed that).
    const rows = (await this.#pool.query<{ row: "opening" | "move"; date: string | null; kind: "invoice" | "payment" | "credit" | null; invoiceNumber: string | null;
      creditNumber: string | null; orgId: string; companyName: string; currencyCode: string; amount: string }>(`${MOVEMENTS}
      SELECT 'opening' AS row, NULL AS date, NULL AS kind, NULL AS "invoiceNumber", NULL AS "creditNumber", org_id AS "orgId", min(company) AS "companyName",
        currency_code AS "currencyCode", sum(amount)::text AS amount, NULL::date AS sort_date, NULL::int AS sort_kind
      FROM moves WHERE on_date < $2::date GROUP BY currency_code, org_id
      UNION ALL
      SELECT 'move', on_date::text, kind, invoice_number, credit_number, org_id, company, currency_code, abs(amount)::text, on_date,
        CASE kind WHEN 'invoice' THEN 0 WHEN 'payment' THEN 1 ELSE 2 END
      FROM moves WHERE on_date BETWEEN $2::date AND $3::date
      ORDER BY sort_date NULLS FIRST, sort_kind, "invoiceNumber"`, [visible, from, to])).rows;
    const members = new Map<string, { currencyCode: string; orgId: string; companyName: string; opening: bigint; invoiced: bigint; paid: bigint; credited: bigint }>();
    const member = (row: (typeof rows)[number]) => {
      const key = JSON.stringify([row.currencyCode, row.orgId]);
      let m = members.get(key);
      if (!m) members.set(key, m = { currencyCode: row.currencyCode, orgId: row.orgId, companyName: row.companyName, opening: 0n, invoiced: 0n, paid: 0n, credited: 0n });
      return m;
    };
    const entries: TransferStatementEntry[] = [];
    for (const row of rows) {
      const m = member(row);
      if (row.row === "opening") { m.opening = toFils(row.amount); continue; }
      if (row.kind === "invoice") m.invoiced += toFils(row.amount);
      else if (row.kind === "payment") m.paid += toFils(row.amount);
      else m.credited += toFils(row.amount);
      entries.push({ date: row.date!, kind: row.kind!, invoiceNumber: row.invoiceNumber!, creditNumber: row.creditNumber, orgId: row.orgId, companyName: row.companyName, currencyCode: row.currencyCode, amount: row.amount });
    }
    const currencies = new Map<string, TransferStatementMember[]>();
    const totals = new Map<string, { opening: bigint; invoiced: bigint; paid: bigint; credited: bigint }>();
    for (const m of [...members.values()].sort((a, b) => a.currencyCode.localeCompare(b.currencyCode) || a.orgId.localeCompare(b.orgId))) {
      const closing = m.opening + m.invoiced - m.paid - m.credited;
      currencies.set(m.currencyCode, [...(currencies.get(m.currencyCode) ?? []), { orgId: m.orgId, companyName: m.companyName,
        opening: fromFils(m.opening), invoiced: fromFils(m.invoiced), paid: fromFils(m.paid), credited: fromFils(m.credited), closing: fromFils(closing) }]);
      const t = totals.get(m.currencyCode) ?? { opening: 0n, invoiced: 0n, paid: 0n, credited: 0n };
      totals.set(m.currencyCode, { opening: t.opening + m.opening, invoiced: t.invoiced + m.invoiced, paid: t.paid + m.paid, credited: t.credited + m.credited });
    }
    return { orgId, name, from, to, entries, currencies: [...currencies].map(([currencyCode, list]) => {
      const t = totals.get(currencyCode)!;
      return { currencyCode, members: list, opening: fromFils(t.opening), invoiced: fromFils(t.invoiced), paid: fromFils(t.paid), credited: fromFils(t.credited),
        closing: fromFils(t.opening + t.invoiced - t.paid - t.credited) };
    }) };
  }

  /** The company's transfers and its visible sub-companies', newest period first; null when the reader may not see the company. */
  async companyTransfers(principalId: string, orgId: string): Promise<CompanyTransferPage | null> {
    const visible = await this.#visible(principalId, orgId);
    if (!visible) return null;
    const [organization, transfers] = await Promise.all([
      this.#pool.query<{ name: string }>(`SELECT ${NAME("o", "p")} AS name FROM organizations o LEFT JOIN organization_profiles p ON p.org_id = o.id WHERE o.id = $1`, [orgId]),
      this.#pool.query<CompanyTransferEntry>(`SELECT ${TRANSFER} ${TRANSFERS} ORDER BY t.period_end DESC, t.period_start DESC, t.id DESC`, [visible]),
    ]);
    return { orgId, name: organization.rows[0]?.name ?? orgId, transfers: transfers.rows };
  }

  /** One transfer of a company the reader may see, with the company's side of each line; null otherwise. */
  async companyTransfer(principalId: string, orgId: string, transferId: string): Promise<CompanyTransferDetail | null> {
    const visible = await this.#visible(principalId, orgId);
    if (!visible) return null;
    const transfer = (await this.#pool.query<CompanyTransferEntry>(`SELECT ${TRANSFER} ${TRANSFERS} AND t.id = $2`, [visible, transferId])).rows[0];
    if (!transfer) return null;
    const lines = (await this.#pool.query<{ lineId: string; personName: string; storeName: string; calculation: unknown; companyTotal: string; paid: boolean }>(
      `SELECT l.id AS "lineId", COALESCE(NULLIF(btrim(pp.display_name), ''), NULLIF(btrim(pr.display_name), ''), l.person_id) AS "personName",
         s.name AS "storeName", l.calculation, l.company_total::text AS "companyTotal", l.paid
       FROM pay_transfer_lines l JOIN principals pr ON pr.id = l.person_id LEFT JOIN person_profiles pp ON pp.principal_id = l.person_id
         JOIN organization_stores s ON s.id = l.store_id
       WHERE l.transfer_id = $1 ORDER BY "personName", l.id`, [transfer.transferId])).rows;
    return { ...transfer, lines: lines.map(({ calculation, ...line }) => {
      const worked = candidateWorked(calculation);
      return { ...line, worked: worked && { hours: worked.hours, minutes: worked.minutes } };
    }) };
  }

  /** One live, paid, payable or credited invoice billed inside what the reader may see, with its transfer's period; null otherwise. */
  async document(principalId: string, orgId: string, invoiceNumber: string): Promise<TransferInvoiceDocument | null> {
    const visible = await this.#visible(principalId, orgId);
    if (!visible) return null;
    return (await this.#pool.query<TransferInvoiceDocument>(
      `SELECT ${ENTRY}, t.period_start::text AS "periodStart", t.period_end::text AS "periodEnd"
         ${FROM} AND i.invoice_number = $2`,
      [visible, invoiceNumber])).rows[0] ?? null;
  }
}

/** A scale-3 decimal as whole fils, exactly, at any size. */
function toFils(amount: string): bigint {
  const m = /^(-?)(\d+)\.(\d{3})$/.exec(amount);
  if (!m) throw new RangeError("invalid_amount");
  return (m[1] ? -1n : 1n) * (BigInt(m[2]!) * 1000n + BigInt(m[3]!));
}
function fromFils(fils: bigint): string {
  const abs = fils < 0n ? -fils : fils;
  return `${fils < 0n ? "-" : ""}${abs / 1000n}.${String(abs % 1000n).padStart(3, "0")}`;
}
