import { handleOrganizationProfile } from "../organization-profile.js";
import { handleOrganizationStatus } from "../organization-status.js";
import { handleOrganizationCommercialTerms } from "../organization-commercial-terms.js";
import { handleOrganizationApprovedToHire } from "../organization-approved-to-hire.js";
import { handleOrganizationNotes } from "../organization-notes.js";
import { handleOrganizationBrands } from "../organization-brands.js";
import { handleOrganizationStores } from "../organization-stores.js";
import { handleOrganizationDeletion } from "../organization-deletion.js";
import { handleOrganizationCreation } from "../organization-creation.js";
import { handleOrganizationAccountManager, handleOrganizationAccountManagerPage } from "../organization-account-manager.js";
import type { GatewayRoute } from "./context.js";

export const organizationProfileRoute: GatewayRoute = { name: "organization-profile", handle: (ctx) =>
  handleOrganizationProfile(ctx.request, ctx.response, ctx.login?.organizationProfile, ctx.login?.web?.origin) };
export const organizationStatusRoute: GatewayRoute = { name: "organization-status", handle: (ctx) =>
  handleOrganizationStatus(ctx.request, ctx.response, ctx.login?.organizationStatus, ctx.login?.web?.origin) };
export const organizationCommercialTermsRoute: GatewayRoute = { name: "organization-commercial-terms", handle: (ctx) =>
  handleOrganizationCommercialTerms(ctx.request, ctx.response, ctx.login?.organizationCommercialTerms, ctx.login?.web?.origin) };
export const organizationApprovedToHireRoute: GatewayRoute = { name: "organization-approved-to-hire", handle: (ctx) =>
  handleOrganizationApprovedToHire(ctx.request, ctx.response, ctx.login?.organizationApprovedToHire, ctx.login?.web?.origin) };
export const organizationNotesRoute: GatewayRoute = { name: "organization-notes", handle: (ctx) =>
  handleOrganizationNotes(ctx.request, ctx.response, ctx.login?.organizationNotes, ctx.login?.web?.origin) };
export const organizationBrandsRoute: GatewayRoute = { name: "organization-brands", handle: (ctx) =>
  handleOrganizationBrands(ctx.request, ctx.response, ctx.login?.organizationBrands, ctx.login?.web?.origin) };
export const organizationStoresRoute: GatewayRoute = { name: "organization-stores", handle: (ctx) =>
  handleOrganizationStores(ctx.request, ctx.response, ctx.login?.organizationStores, ctx.login?.web?.origin) };
export const organizationDeletionRoute: GatewayRoute = { name: "organization-deletion", handle: (ctx) =>
  handleOrganizationDeletion(ctx.request, ctx.response, ctx.login?.organizationDeletion, ctx.login?.web?.origin) };
export const organizationCreationRoute: GatewayRoute = { name: "organization-creation", handle: (ctx) =>
  handleOrganizationCreation(ctx.request, ctx.response, ctx.login?.organizationCreation, ctx.login?.web?.origin) };
export const organizationAccountManagerPageRoute: GatewayRoute = { name: "organization-account-manager-page", handle: (ctx) =>
  handleOrganizationAccountManagerPage(ctx.request, ctx.response, ctx.login?.organizationAccountManager, ctx.login?.web?.origin,
    (status, title, body) => ctx.writeHtml(ctx.response, status, status === 401 ? ctx.renderError(401, ctx.login) : ctx.pageDocument(title, body)),
    async (session, orgId) => { const result = await ctx.login?.navigation?.open(session, new URLSearchParams({ org_id: orgId, role: "admin" })); return result?.status === 200 && result.body.active?.orgId === orgId ? result.body.active.organizationName : undefined; }) };
export const organizationAccountManagerRoute: GatewayRoute = { name: "organization-account-manager", handle: (ctx) =>
  handleOrganizationAccountManager(ctx.request, ctx.response, ctx.login?.organizationAccountManager, ctx.login?.web?.origin) };
