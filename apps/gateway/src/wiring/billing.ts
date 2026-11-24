import pg from "pg";
import { PostgresPayHistoryReads, PostgresTransferInvoiceReads, PostgresTransferInvoiceVoids } from "@studenthub/db/billing";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import { transferInvoiceReadDecision, transferInvoiceVoidDecision } from "../../../../packages/billing/src/transfer-invoice-access.js";
import { createInvoicesHttp, type InvoicesHttp } from "../billing/invoices-http.js";
import { invoiceBankInfo } from "../billing/invoice-pdf.js";
import { createPayHistoryHttp, type PayHistoryHttp } from "../billing/pay-history-http.js";
import type { wireAccess } from "./access.js";
import type { Wired, WiringSettings } from "./context.js";

type Access = ReturnType<typeof wireAccess>["services"];

/**
 * Invoices lane: read-only company invoices and their PDFs (I3), and each person's own pay history (F4.9).
 * BILLING_BANK_INFO (JSON) adds the bank block to unpaid invoices. StudentHub's finance users and admins
 * void invoices with credit notes (F4.7) through same-origin posts from the gateway origin. All share one pool.
 */
export function wireBilling(settings: WiringSettings, access: Access, env: Readonly<Record<string, string | undefined>>): Wired<{ readonly invoices: InvoicesHttp; readonly payHistory: PayHistoryHttp }> {
  const bank = invoiceBankInfo(env.BILLING_BANK_INFO);
  const pool = new pg.Pool({ connectionString: settings.databaseUrl });
  const reads = new PostgresTransferInvoiceReads({ pool,
    decision: (rows, orgId, ancestors) => transferInvoiceReadDecision(rows, orgId, ancestors, DEFAULT_OPERATOR_ORG_IDS) });
  const voids = new PostgresTransferInvoiceVoids({ pool });
  const voidReads = new PostgresTransferInvoiceReads({ pool,
    decision: (rows, orgId, ancestors) => transferInvoiceVoidDecision(rows, orgId, ancestors, DEFAULT_OPERATOR_ORG_IDS) });
  const origin = settings.callbackUrl ? new URL(settings.callbackUrl).origin : "";
  return {
    services: {
      invoices: createInvoicesHttp({ sessions: access.loginStore.sessions, reads, ...(bank ? { bank } : {}),
        voids: { reads: voidReads, credit: input => voids.credit(input), origin } }),
      payHistory: createPayHistoryHttp({ sessions: access.loginStore.sessions, reads: new PostgresPayHistoryReads({ pool }) }),
    },
    async close() { await pool.end(); },
  };
}
