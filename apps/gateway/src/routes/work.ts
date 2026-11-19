import { handleWork } from "../work/http.js";
import { handleWorkPages } from "../work/pages.js";
import { handleReviewPages } from "../work/review-pages.js";
import { handleStaffPages } from "../work/staff-pages.js";
import type { GatewayRoute } from "./context.js";

export const workRoute: GatewayRoute = {
  name: "work",
  // Staff screens come before the person's so /work/appeals?as=staff reaches them.
  handle: async (ctx) => await handleWork(ctx.request, ctx.response, ctx.login?.work, ctx.login?.web?.origin)
    || await handleStaffPages(ctx.request, ctx.response, ctx.login?.work, ctx.login?.web?.origin)
    || await handleWorkPages(ctx.request, ctx.response, ctx.login?.work, ctx.login?.web?.origin, ctx.login?.work?.storeNames)
    || handleReviewPages(ctx.request, ctx.response, ctx.login?.work, ctx.login?.web?.origin, undefined, ctx.login?.exports),
};
