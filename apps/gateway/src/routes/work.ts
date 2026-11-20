import { handleWork } from "../work/http.js";
import { handleWorkPages } from "../work/pages.js";
import { handleReviewPages } from "../work/review-pages.js";
import { handleStaffPages } from "../work/staff-pages.js";
import { handleMyWorkPages, handleStaffTimePages } from "../work/staff-time-pages.js";
import { handleStandupPages } from "../work/standup-pages.js";
import type { GatewayRoute } from "./context.js";

export const workRoute: GatewayRoute = {
  name: "work",
  // Staff screens come before the person's so /work/appeals?as=staff reaches them.
  handle: async (ctx) => await handleWork(ctx.request, ctx.response, ctx.login?.work, ctx.login?.web?.origin)
    || await handleMyWorkPages(ctx.request, ctx.response, ctx.login?.work, ctx.login?.web?.origin)
    || await handleStaffTimePages(ctx.request, ctx.response, ctx.login?.work)
    || await handleStandupPages(ctx.request, ctx.response, ctx.login?.work, ctx.login?.web?.origin)
    || await handleStaffPages(ctx.request, ctx.response, ctx.login?.work, ctx.login?.web?.origin)
    || await handleWorkPages(ctx.request, ctx.response, ctx.login?.work, ctx.login?.web?.origin, ctx.login?.work?.storeNames)
    || handleReviewPages(ctx.request, ctx.response, ctx.login?.work, ctx.login?.web?.origin),
};
