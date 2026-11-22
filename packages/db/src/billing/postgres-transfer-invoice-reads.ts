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

const NAME = (alias: string, profile: string) => `COALESCE(NULLIF(btrim(${profile}.name_en), ''), ${alias}.name)`;
const ENTRY = `i.invoice_number AS "invoiceNumber", i.transfer_id AS "transferId", i.org_id AS "orgId", ${NAME("o", "p")} AS "companyName",
  i.currency_code AS "currencyCode", i.invoice_date::text AS "invoiceDate", i.total::text AS total, i.line_count AS "lineCount", i.status,
  (i.paid_at AT TIME ZONE 'Asia/Kuwait')::date::text AS "paidOn"`;
const FROM = `FROM transfer_invoice i JOIN organizations o ON o.id = i.org_id LEFT JOIN organization_profiles p ON p.org_id = i.org_id
  WHERE NOT i.deleted AND i.org_id = ANY($1::text[])`;

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

  /** One live invoice billed inside the organization's tree, with its transfer's period; null otherwise. */
  async document(principalId: string, orgId: string, invoiceNumber: string): Promise<TransferInvoiceDocument | null> {
    const visible = await this.#visible(principalId, orgId);
    if (!visible) return null;
    return (await this.#pool.query<TransferInvoiceDocument>(
      `SELECT ${ENTRY}, t.period_start::text AS "periodStart", t.period_end::text AS "periodEnd"
         ${FROM.replace("WHERE", "JOIN pay_transfers t ON t.id = i.transfer_id WHERE")} AND i.invoice_number = $2`,
      [visible, invoiceNumber])).rows[0] ?? null;
  }
}
