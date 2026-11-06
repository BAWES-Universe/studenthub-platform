import { handleCandidateDocuments } from "../candidate-documents-http.js";
import { handleOrganizationDocuments } from "../organization-documents-http.js";
import type { GatewayRoute } from "./context.js";

export const candidateDocumentsRoute: GatewayRoute = {
  name: "candidate-documents",
  handle: (ctx) => handleCandidateDocuments(ctx.request, ctx.response, ctx.documents, ctx.login),
};

export const organizationDocumentsRoute: GatewayRoute = {
  name: "organization-documents",
  handle: (ctx) => handleOrganizationDocuments(ctx.request, ctx.response, ctx.organizationDocuments),
};
