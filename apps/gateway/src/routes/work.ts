import { handleWork } from "../work/http.js";
import type { GatewayRoute } from "./context.js";

export const workRoute: GatewayRoute = {
  name: "work",
  handle: (ctx) => handleWork(ctx.request, ctx.response, ctx.login?.work, ctx.login?.web?.origin),
};
