import type { GatewayRoute } from "./context.js";
import { catalogueRoute } from "./catalogue.js";
import { candidateDocumentsRoute, organizationDocumentsRoute } from "./documents.js";
import { profileEditPageRoute, profileEditRoute, profileBrowserEditRoute, languagePreferencePageRoute, languagePreferenceRoute, bankDetailsRoute, profileRecordsRoute, civilIdReviewRoute } from "./profile.js";
import { organizationProfileRoute, organizationStatusRoute, organizationCommercialTermsRoute, organizationApprovedToHireRoute, organizationNotesRoute, organizationBrandsRoute, organizationStoresRoute, organizationDeletionRoute, organizationCreationRoute, organizationAccountManagerPageRoute, organizationAccountManagerRoute } from "./organizations.js";
import { payContractsRoute } from "./pay-contracts.js";
import { handleLegacyLink } from "../legacy-link-http.js";
import { handleDocumentsUpload } from "../documents-upload-http.js";
import { handleDocumentsActions } from "../documents-actions-http.js";
import { prepareProfileAvatar } from "../profile-avatar.js";

const documentsUploadRoute: GatewayRoute = { name: "documents-upload", handle: (ctx) =>
  handleDocumentsUpload(ctx.request, ctx.response, ctx.documents, ctx.login) };
const documentsActionsRoute: GatewayRoute = { name: "documents-actions", handle: (ctx) =>
  handleDocumentsActions(ctx.request, ctx.response, ctx.documents, ctx.login) };
const profileAvatarRoute: GatewayRoute = { name: "profile-avatar", handle: async (ctx) => {
  await prepareProfileAvatar(ctx.request, ctx.response, ctx.documents); return false;
} };

const legacyLinkRoute: GatewayRoute = { name: "legacy-link", handle: (ctx) =>
  handleLegacyLink(ctx.request, ctx.response, ctx.login?.legacyLink,
    (status, title, body) => ctx.writeHtml(ctx.response, status, ctx.pageDocument(title, body))) };
import { handleCivilId } from "../civil-id-http.js";
import { handleCivilIdSuggestion } from "../civil-id-suggestion-http.js";
import { handleArea } from "../area-http.js";

const civilIdRoute: GatewayRoute = { name: "civil-id", handle: (ctx) => handleCivilId(ctx.request, ctx.response,
  ctx.login?.civilId, ctx.login?.web?.origin, async (session) => { if (!ctx.login) return undefined;
    const result = await ctx.login.profile({ sessionId: session });
    return result.status === 200 && typeof result.body?.personId === "string" ? result.body.personId : undefined; },
  (status, title, body) => ctx.writeHtml(ctx.response, status, ctx.pageDocument(title, body))) };
const civilIdSuggestionRoute: GatewayRoute = { name: "civil-id-suggestion", handle: (ctx) => handleCivilIdSuggestion(ctx.request, ctx.response,
  ctx.login?.civilIdSuggestion, ctx.login?.web?.origin, async (session) => { if (!ctx.login) return undefined;
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
  profileAvatarRoute,
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
  civilIdReviewRoute,
  legacyLinkRoute,
  civilIdRoute,
  civilIdSuggestionRoute,
  areaRoute,
];

export { runRoutes } from "./context.js";
