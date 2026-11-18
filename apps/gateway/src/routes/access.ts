import type { GatewayRoute } from "./context.js";
import { handleAccess } from "../access/admin-access.js";

/** Access lane: /admin/access pages and the person's own /profile/access list. */
export const accessRoute: GatewayRoute = { name: "access", handle: (ctx) =>
  handleAccess(ctx.request, ctx.response, ctx.login?.access, ctx.login?.web?.origin,
    (status, title, body) => ctx.writeHtml(ctx.response, status, ctx.pageDocument(title, body, undefined, true), {}, true)) };
