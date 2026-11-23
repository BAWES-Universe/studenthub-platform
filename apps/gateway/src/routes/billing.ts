import { handleInvoices } from "../billing/invoices-http.js";
import { handlePayHistory } from "../billing/pay-history-http.js";
import type { GatewayRoute } from "./context.js";

/** Company invoices (I3) and each person's own pay history (F4.9); each handler answers only its own paths. */
export const invoicesRoute: GatewayRoute = {
  name: "invoices",
  handle: async (ctx) => await handleInvoices(ctx.request, ctx.response, ctx.login?.invoices)
    || handlePayHistory(ctx.request, ctx.response, ctx.login?.payHistory),
};
