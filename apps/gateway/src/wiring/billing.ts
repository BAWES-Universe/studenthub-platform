import { PostgresTransferInvoiceReads } from "@studenthub/db/billing";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import { transferInvoiceReadDecision } from "../../../../packages/billing/src/transfer-invoice-access.js";
import { createInvoicesHttp, type InvoicesHttp } from "../billing/invoices-http.js";
import { invoiceBankInfo } from "../billing/invoice-pdf.js";
import type { wireAccess } from "./access.js";
import type { Wired, WiringSettings } from "./context.js";

type Access = ReturnType<typeof wireAccess>["services"];

/** Invoices lane I3: read-only company invoices and their PDFs. BILLING_BANK_INFO (JSON) adds the bank block to unpaid invoices. */
export function wireBilling(settings: WiringSettings, access: Access, env: Readonly<Record<string, string | undefined>>): Wired<{ readonly invoices: InvoicesHttp }> {
  const bank = invoiceBankInfo(env.BILLING_BANK_INFO);
  const reads = new PostgresTransferInvoiceReads({ connectionString: settings.databaseUrl,
    decision: (rows, orgId, ancestors) => transferInvoiceReadDecision(rows, orgId, ancestors, DEFAULT_OPERATOR_ORG_IDS) });
  return {
    services: { invoices: createInvoicesHttp({ sessions: access.loginStore.sessions, reads, ...(bank ? { bank } : {}) }) },
    async close() { await reads.close(); },
  };
}
