import type { GatewayRoute } from "./context.js";
import { catalogueRoute } from "./catalogue.js";
import { candidateDocumentsRoute, organizationDocumentsRoute } from "./documents.js";
import { profileEditPageRoute, profileEditRoute, profileBrowserEditRoute, languagePreferencePageRoute, languagePreferenceRoute, bankDetailsRoute, profileRecordsRoute } from "./profile.js";
import { organizationProfileRoute, organizationStatusRoute, organizationCommercialTermsRoute, organizationApprovedToHireRoute, organizationNotesRoute, organizationBrandsRoute, organizationStoresRoute, organizationDeletionRoute, organizationCreationRoute, organizationAccountManagerPageRoute, organizationAccountManagerRoute } from "./organizations.js";
import { payContractsRoute } from "./pay-contracts.js";
import { handleLegacyLink } from "../legacy-link-http.js";
import { handleDocumentsUpload } from "../documents-upload-http.js";
import { handleDocumentsActions } from "../documents-actions-http.js";
import { prepareProfileAvatar } from "../profile-avatar.js";

const documentsUploadRoute: GatewayRoute = { name: "documents-upload", handle: (ctx) =>
  handleDocumentsUpload(ctx.request, ctx.response, ctx.documents, ctx.login) };
const documentsActionsRoute: GatewayRoute = { name: "documents-actions", handle: async (ctx) => {
  prepareProfileAvatar(ctx.request, ctx.documents, ctx.response);
  return handleDocumentsActions(ctx.request, ctx.response, ctx.documents, ctx.login);
} };

const legacyLinkRoute: GatewayRoute = { name: "legacy-link", handle: (ctx) =>
  handleLegacyLink(ctx.request, ctx.response, ctx.login?.legacyLink,
    (status, title, body) => ctx.writeHtml(ctx.response, status, ctx.pageDocument(title, body))) };
import { handleCivilId } from "../civil-id-http.js";
import { handleArea } from "../area-http.js";

const civilIdRoute: GatewayRoute = { name: "civil-id", handle: (ctx) => handleCivilId(ctx.request, ctx.response,
  ctx.login?.civilId, ctx.login?.web?.origin, async (session) => { if (!ctx.login) return undefined;
    const result = await ctx.login.profile({ sessionId: session });
    return result.status === 200 && typeof result.body?.personId === "string" ? result.body.personId : undefined; },
  (status, title, body) => ctx.writeHtml(ctx.response, status, ctx.pageDocument(title, body))) };
const areaRoute: GatewayRoute = { name: "area", handle: (ctx) => handleArea(ctx.request, ctx.response, ctx.login?.area) };

export const ROUTES: readonly GatewayRoute[] = [
  catalogueRoute,
  candidateDocumentsRoute,
  documentsUploadRoute,
  documentsActionsRoute,
  organizationDocumentsRoute,
  profileEditPageRoute,
  profileEditRoute,
  profileBrowserEditRoute,
  languagePreferencePageRoute,
  languagePreferenceRoute,
  bankDetailsRoute,
  organizationProfileRoute,
  organizationStatusRoute,
  organizationCommercialTermsRoute,
  organizationApprovedToHireRoute,
  organizationNotesRoute,
  payContractsRoute,
  organizationBrandsRoute,
  organizationStoresRoute,
  organizationDeletionRoute,
  organizationCreationRoute,
  organizationAccountManagerPageRoute,
  organizationAccountManagerRoute,
  profileRecordsRoute,
  legacyLinkRoute,
  civilIdRoute,
  areaRoute,
];

export { runRoutes } from "./context.js";
