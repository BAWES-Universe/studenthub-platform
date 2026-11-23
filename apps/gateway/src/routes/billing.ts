import { handleInvoices } from "../billing/invoices-http.js";
import type { GatewayRoute } from "./context.js";

export const invoicesRoute: GatewayRoute = {
  name: "invoices",
  handle: (ctx) => handleInvoices(ctx.request, ctx.response, ctx.login?.invoices),
};
