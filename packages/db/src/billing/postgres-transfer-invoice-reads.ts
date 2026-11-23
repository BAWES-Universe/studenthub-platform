import pg from "pg";
import { databaseUrl } from "../connection.js";
import { organizationLive } from "../organization-liveness.js";

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
}
export interface TransferInvoiceDocument extends TransferInvoiceListEntry {
  readonly periodStart: string;
  readonly periodEnd: string;
}
export interface TransferInvoicePage { readonly orgId: string; readonly name: string; readonly invoices: readonly TransferInvoiceListEntry[] }

/** One movement on a statement: an invoice issued (adds to the balance) or a payment received for one (takes it off). */
export interface TransferStatementEntry {
  readonly date: string;
  readonly kind: "invoice" | "payment";
  readonly invoiceNumber: string;
  readonly orgId: string;
  readonly companyName: string;
  readonly currencyCode: string;
  readonly amount: string;
}
export interface TransferStatementTotals { readonly opening: string; readonly invoiced: string; readonly paid: string; readonly closing: string }
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

const NAME = (alias: string, profile: string) => `COALESCE(NULLIF(btrim(${profile}.name_en), ''), ${alias}.name)`;
const ENTRY = `i.invoice_number AS "invoiceNumber", i.transfer_id AS "transferId", i.org_id AS "orgId", ${NAME("o", "p")} AS "companyName",
  i.currency_code AS "currencyCode", i.invoice_date::text AS "invoiceDate", i.total::text AS total, i.line_count AS "lineCount", i.status,
  (i.paid_at AT TIME ZONE 'Asia/Kuwait')::date::text AS "paidOn"`;
/*
 * Only locked and payment-sent transfers make an unpaid invoice due. After an admin unlock the transfer is a
 * draft again and its amounts can change, and a cancelled transfer is never paid, so their
 * unpaid invoices are neither listed nor served: they are not payable. A relock re-issues or
 * keeps them (`PostgresTransferInvoiceEffects`), and a paid invoice is always shown as a receipt.
 */
const FROM = `FROM transfer_invoice i JOIN organizations o ON o.id = i.org_id LEFT JOIN organization_profiles p ON p.org_id = i.org_id
  JOIN pay_transfers t ON t.id = i.transfer_id
  WHERE NOT i.deleted AND i.org_id = ANY($1::text[]) AND (i.status = 'paid' OR t.status IN ('locked', 'payment_sent'))`;

/*
 * Statement movements come from the same documents the invoices page shows (FROM above): an invoice
 * counts on its issue date, its payment on the Kuwait date it was received. Nothing is read from
 * live pay lines, so a past window keeps its figures when later invoices are issued or paid.
 */
const MOVEMENTS = `WITH docs AS (SELECT i.invoice_number, i.org_id, ${NAME("o", "p")} AS company, i.currency_code, i.total, i.invoice_date,
    CASE WHEN i.status = 'paid' THEN (i.paid_at AT TIME ZONE 'Asia/Kuwait')::date END AS paid_on ${FROM}),
  moves AS (SELECT invoice_date AS on_date, 'invoice' AS kind, invoice_number, org_id, company, currency_code, total AS amount FROM docs
    UNION ALL SELECT paid_on, 'payment', invoice_number, org_id, company, currency_code, -total FROM docs WHERE paid_on IS NOT NULL)`;

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
    const [organization, members, entries] = await Promise.all([
      this.#pool.query<{ name: string }>(`SELECT ${NAME("o", "p")} AS name FROM organizations o LEFT JOIN organization_profiles p ON p.org_id = o.id WHERE o.id = $1`, [orgId]),
      this.#pool.query<TransferStatementMember & { currencyCode: string }>(`${MOVEMENTS}
        SELECT currency_code AS "currencyCode", org_id AS "orgId", min(company) AS "companyName",
          COALESCE(sum(amount) FILTER (WHERE on_date < $2::date), 0)::numeric(14,3)::text AS opening,
          COALESCE(sum(amount) FILTER (WHERE kind = 'invoice' AND on_date BETWEEN $2::date AND $3::date), 0)::numeric(14,3)::text AS invoiced,
          COALESCE(-sum(amount) FILTER (WHERE kind = 'payment' AND on_date BETWEEN $2::date AND $3::date), 0)::numeric(14,3)::text AS paid,
          COALESCE(sum(amount), 0)::numeric(14,3)::text AS closing
        FROM moves WHERE on_date <= $3::date GROUP BY currency_code, org_id ORDER BY currency_code, org_id`, [visible, from, to]),
      this.#pool.query<TransferStatementEntry>(`${MOVEMENTS}
        SELECT on_date::text AS date, kind, invoice_number AS "invoiceNumber", org_id AS "orgId", company AS "companyName", currency_code AS "currencyCode",
          abs(amount)::numeric(14,3)::text AS amount
        FROM moves WHERE on_date BETWEEN $2::date AND $3::date ORDER BY on_date, kind, invoice_number`, [visible, from, to]),
    ]);
    const currencies = new Map<string, TransferStatementMember[]>();
    for (const { currencyCode, ...member } of members.rows) currencies.set(currencyCode, [...(currencies.get(currencyCode) ?? []), member]);
    return { orgId, name: organization.rows[0]?.name ?? orgId, from, to, entries: entries.rows,
      currencies: [...currencies].map(([currencyCode, list]) => ({ currencyCode, members: list,
        opening: fils(list.map(m => m.opening)), invoiced: fils(list.map(m => m.invoiced)), paid: fils(list.map(m => m.paid)), closing: fils(list.map(m => m.closing)) })) };
  }

  /** One live, paid or payable invoice billed inside what the reader may see, with its transfer's period; null otherwise. */
  async document(principalId: string, orgId: string, invoiceNumber: string): Promise<TransferInvoiceDocument | null> {
    const visible = await this.#visible(principalId, orgId);
    if (!visible) return null;
    return (await this.#pool.query<TransferInvoiceDocument>(
      `SELECT ${ENTRY}, t.period_start::text AS "periodStart", t.period_end::text AS "periodEnd"
         ${FROM} AND i.invoice_number = $2`,
      [visible, invoiceNumber])).rows[0] ?? null;
  }
}

/** Exact sum of three-decimal amounts, in fils. */
function fils(amounts: readonly string[]): string {
  const total = amounts.reduce((n, a) => {
    const m = /^(-?)(\d+)\.(\d{3})$/.exec(a);
    if (!m) throw new RangeError("invalid_amount");
    return n + (m[1] ? -1n : 1n) * (BigInt(m[2]!) * 1000n + BigInt(m[3]!));
  }, 0n);
  const abs = total < 0n ? -total : total;
  return `${total < 0n ? "-" : ""}${abs / 1000n}.${String(abs % 1000n).padStart(3, "0")}`;
}
