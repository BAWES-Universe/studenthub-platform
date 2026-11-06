import { handlePayContracts } from "../pay-contracts-http.js";
import type { GatewayRoute } from "./context.js";

export const payContractsRoute: GatewayRoute = {
  name: "pay-contracts",
  handle: (ctx) => handlePayContracts(ctx.request, ctx.response, ctx.login?.payContracts, ctx.login?.web?.origin),
};
