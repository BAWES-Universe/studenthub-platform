import { handleRecruitRequests } from "../recruit/requests-http.js";
import { wantsHtml } from "../web-ui.js";
import type { GatewayRoute } from "./context.js";

export const recruitRequestsRoute: GatewayRoute = { name: "recruit-requests", handle: (ctx) =>
  handleRecruitRequests(ctx.request, ctx.response, ctx.login?.recruitRequests, ctx.login?.web?.origin,
    (status, title, body) => ctx.writeHtml(ctx.response, status, status === 401 ? ctx.renderError(401, ctx.login) : ctx.pageDocument(title, body)),
    wantsHtml(ctx.request.headers.accept)) };
