import { handleInvoices } from "../billing/invoices-http.js";
import { handlePayHistory } from "../billing/pay-history-http.js";
import { handleBankResults } from "../billing/bank-results-http.js";
import { handleFinanceTransfers } from "../billing/finance-transfers-http.js";
import type { GatewayRoute } from "./context.js";

/** Company invoices (I3), each person's own pay history (F4.9) and StudentHub finance's bank result files (F5) and transfers (A-18); each handler answers only its own paths. */
export const invoicesRoute: GatewayRoute = {
  name: "invoices",
  handle: async (ctx) => await handleInvoices(ctx.request, ctx.response, ctx.login?.invoices)
    || await handlePayHistory(ctx.request, ctx.response, ctx.login?.payHistory)
    || await handleBankResults(ctx.request, ctx.response, ctx.login?.bankResults)
    || handleFinanceTransfers(ctx.request, ctx.response, ctx.login?.financeTransfers),
};
