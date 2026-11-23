import { handleCatalogue } from "../catalogue-http.js";
import { handleReferenceDataPage } from "../reference-data-page.js";
import type { GatewayRoute } from "./context.js";

export const catalogueRoute: GatewayRoute = {
  name: "catalogue",
  handle: (ctx) => handleCatalogue(ctx.request, ctx.response, ctx.catalogue, ctx.authz),
};

export const referenceDataPageRoute: GatewayRoute = {
  name: "reference-data-page",
  handle: (ctx) => handleReferenceDataPage(ctx),
};
