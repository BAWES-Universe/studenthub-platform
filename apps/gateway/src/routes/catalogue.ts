import { handleCatalogue } from "../catalogue-http.js";
import type { GatewayRoute } from "./context.js";

export const catalogueRoute: GatewayRoute = {
  name: "catalogue",
  handle: (ctx) => handleCatalogue(ctx.request, ctx.response, ctx.catalogue, ctx.authz),
};
