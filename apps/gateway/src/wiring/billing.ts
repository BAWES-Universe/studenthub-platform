import pg from "pg";
import { PostgresBankResultStore, PostgresFinanceTransferReads, PostgresPayHistoryReads, PostgresTransferInvoiceEffects, PostgresTransferInvoiceReads, PostgresTransferInvoiceVoids, bankResultLifecyclePolicy, operatorFinanceGate } from "@studenthub/db/billing";
import { TransferLifecycleService } from "../../../../packages/payroll/src/transfer-lifecycle.js";
import { TRANSFER_INVOICE_VOID_ROLE } from "../../../../packages/billing/src/transfer-invoice-access.js";
import { createBankResultsHttp, type BankResultsHttp } from "../billing/bank-results-http.js";
import { createFinanceTransfersHttp, type FinanceTransfersHttp } from "../billing/finance-transfers-http.js";
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
 * BILLING_BANK_RESULTS_APPLY=on switches on applying bank result files (off by default until native
 * AUB/KFH files are checked). BILLING_BANK_INFO (JSON) adds the bank block to unpaid invoices. StudentHub's finance users
 * void invoices with credit notes (F4.7) through same-origin posts from the gateway origin. All share one pool.
 */
export function wireBilling(settings: WiringSettings, access: Access, env: Readonly<Record<string, string | undefined>>): Wired<{ readonly invoices: InvoicesHttp; readonly payHistory: PayHistoryHttp; readonly bankResults: BankResultsHttp; readonly financeTransfers: FinanceTransfersHttp }> {
  const bank = invoiceBankInfo(env.BILLING_BANK_INFO);
  const pool = new pg.Pool({ connectionString: settings.databaseUrl });
  const reads = new PostgresTransferInvoiceReads({ pool,
    decision: (rows, orgId, ancestors) => transferInvoiceReadDecision(rows, orgId, ancestors, DEFAULT_OPERATOR_ORG_IDS) });
  const voidDecision = (rows: Parameters<typeof transferInvoiceVoidDecision>[0], orgId: string, ancestors: readonly string[]) =>
    transferInvoiceVoidDecision(rows, orgId, ancestors, DEFAULT_OPERATOR_ORG_IDS);
  // The page shows the void form through voidReads; the store decides again inside the credit's transaction.
  const voids = new PostgresTransferInvoiceVoids({ pool, decision: voidDecision });
  const voidReads = new PostgresTransferInvoiceReads({ pool, decision: voidDecision });
  const origin = settings.callbackUrl ? new URL(settings.callbackUrl).origin : "";
  // F5 bank result files: StudentHub finance settles transfers; the same rule as a void, decided again
  // per transfer inside the apply, and `complete` runs through the pay lifecycle on the same lock.
  const bankPolicy = bankResultLifecyclePolicy(voidDecision);
  const bankEffects = new PostgresTransferInvoiceEffects();
  // Only transitionInTransaction is used, on the apply's own locked transaction; a standalone transition is refused.
  const lifecycle = new TransferLifecycleService({ transaction: async () => { throw new Error("bank_results_use_the_apply_transaction"); } }, () => new Date());
  const fileGate = operatorFinanceGate(DEFAULT_OPERATOR_ORG_IDS, TRANSFER_INVOICE_VOID_ROLE);
  const bankStore = new PostgresBankResultStore(pool, bankPolicy, bankEffects,
    async (tx, actor, transferId) => (await lifecycle.transitionInTransaction(tx, actor, transferId, "complete")).kind === "changed",
    fileGate);
  // The page shows itself only to the same central file authority the store enforces.
  const operatorFinance = async (viewer: string) => {
    const client = await pool.connect();
    try { return await fileGate(client, viewer); } finally { client.release(); }
  };
  return {
    services: {
      invoices: createInvoicesHttp({ sessions: access.loginStore.sessions, reads, ...(bank ? { bank } : {}),
        voids: { reads: voidReads, credit: input => voids.credit(input), origin } }),
      bankResults: createBankResultsHttp({ sessions: access.loginStore.sessions, store: bankStore, allowed: operatorFinance, origin,
        // Off until native AUB/KFH result files are checked (see bank-results-http.ts); only the exact value "on" enables it.
        applyEnabled: env.BILLING_BANK_RESULTS_APPLY === "on" }),
      // A-18: StudentHub finance's transfers, behind the same central gate and per-company settle rule as the bank result files.
      financeTransfers: createFinanceTransfersHttp({ sessions: access.loginStore.sessions, reads: new PostgresFinanceTransferReads(pool, fileGate, voidDecision) }),
      payHistory: createPayHistoryHttp({ sessions: access.loginStore.sessions, reads: new PostgresPayHistoryReads({ pool }) }),
    },
    async close() { await pool.end(); },
  };
}
