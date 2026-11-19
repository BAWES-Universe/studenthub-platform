import type { GatewayRoute } from "./context.js";
import { catalogueRoute } from "./catalogue.js";
import { candidateDocumentsRoute, organizationDocumentsRoute } from "./documents.js";
import { profileEditPageRoute, profileEditRoute, profileBrowserEditRoute, languagePreferencePageRoute, languagePreferenceRoute, bankDetailsRoute, profileRecordsRoute, peopleDirectoryRoute, civilIdReviewRoute } from "./profile.js";
import { organizationProfileRoute, organizationStatusRoute, organizationCommercialTermsRoute, organizationApprovedToHireRoute, organizationNotesRoute, organizationBrandsRoute, organizationStoresRoute, organizationDeletionRoute, organizationCreationRoute, organizationAccountManagerPageRoute, organizationAccountManagerRoute } from "./organizations.js";
import { payContractsRoute } from "./pay-contracts.js";
import { recruitChecklistRoute, recruitEmployerViewRoute, recruitFulltimersRoute, recruitInterviewsRoute, recruitInvitationsRoute, recruitJobsRoute, recruitPeopleSearchRoute, recruitPipelineRoute, recruitRequestApplicationsRoute, recruitRequestsRoute } from "./recruit.js";
import { abuseGateRoute, accessRoute, companyContactsRoute, companyTeamRoute, companyRegistrationRoute, staffViewRoute, storeManagerRoute } from "./access.js";
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
import { handleStaffMessages } from "../comms/staff-messages-http.js";
import { handleListExports } from "../reports/list-exports-http.js";
import { handleIdCards } from "../reports/id-cards-http.js";

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
const staffMessagesRoute: GatewayRoute = { name: "staff-messages", handle: (ctx) => handleStaffMessages(ctx.request, ctx.response,
  ctx.login?.staffMessages, ctx.login?.web?.origin, async (session) => { if (!ctx.login) return undefined;
    const result = await ctx.login.profile({ sessionId: session });
    return result.status === 200 && typeof result.body?.personId === "string" ? result.body.personId : undefined; }) };
const listExportsRoute: GatewayRoute = { name: "list-exports", handle: (ctx) => handleListExports(ctx.request, ctx.response,
  async (session) => { if (!ctx.login?.staffMessages) return false;
    const result = await ctx.login.profile({ sessionId: session });
    return result.status === 200 && typeof result.body?.personId === "string" ? ctx.login.staffMessages.isStaff(result.body.personId) : false; }) };
const idCardsRoute: GatewayRoute = { name: "id-cards", handle: (ctx) => handleIdCards(ctx.request, ctx.response,
  ctx.login?.staffMessages?.idCards, ctx.login?.web?.origin, async (session) => { if (!ctx.login) return undefined;
    const result = await ctx.login.profile({ sessionId: session });
    return result.status === 200 && typeof result.body?.personId === "string" ? result.body.personId : undefined; }) };
const areaRoute: GatewayRoute = { name: "area", handle: (ctx) => handleArea(ctx.request, ctx.response, ctx.login?.area) };

import { workRoute } from "./work.js";

export const ROUTES: readonly GatewayRoute[] = [
  abuseGateRoute,
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
  legacyLinkRoute,
  civilIdRoute,
  civilIdSuggestionRoute,
  areaRoute,
  peopleDirectoryRoute,
  civilIdReviewRoute,
  accessRoute,
  staffViewRoute,
  companyRegistrationRoute,
  companyTeamRoute,
  companyContactsRoute,
  storeManagerRoute,
  recruitRequestsRoute,
  recruitPipelineRoute,
  recruitChecklistRoute,
  recruitPeopleSearchRoute,
  recruitInvitationsRoute,
  recruitEmployerViewRoute,
  recruitInterviewsRoute,
  recruitJobsRoute,
  recruitFulltimersRoute,
  recruitRequestApplicationsRoute,
  workRoute,
  staffMessagesRoute,
  listExportsRoute,
  idCardsRoute,
];

export { runRoutes } from "./context.js";
