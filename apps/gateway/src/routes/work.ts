import { handleWork } from "../work/http.js";
import { handleWorkPages } from "../work/pages.js";
import type { GatewayRoute } from "./context.js";

export const workRoute: GatewayRoute = {
  name: "work",
  handle: async (ctx) => await handleWork(ctx.request, ctx.response, ctx.login?.work, ctx.login?.web?.origin)
    || handleWorkPages(ctx.request, ctx.response, ctx.login?.work, ctx.login?.web?.origin, ctx.login?.work?.storeNames),
};
