import type { GatewayRoute } from "./context.js";
import { handleAccess } from "../access/admin-access.js";
import { handleCompanyTeam } from "../access/company-team.js";
import { handleCompanyContacts } from "../access/company-contacts.js";
import { handleStoreManager } from "../access/store-manager.js";
import { handleAbuseGate } from "../access/abuse-gate.js";
import { handleStaffView } from "../access/staff-view.js";
import { handleCompanyRegistration } from "../access/company-registration.js";
import { profileDocument } from "../web-ui.js";

/** Access lane: /admin/access pages and the person's own /profile/access list. */
export const accessRoute: GatewayRoute = { name: "access", handle: (ctx) =>
  handleAccess(ctx.request, ctx.response, ctx.login?.access, ctx.login?.web?.origin,
    (status, title, body) => ctx.writeHtml(ctx.response, status, ctx.pageDocument(title, body, undefined, true), {}, true)) };

/** Access lane A2: a company's Team page, invitations, and the signed-in return to a link. */
export const companyTeamRoute: GatewayRoute = { name: "company-team", handle: (ctx) =>
  handleCompanyTeam(ctx.request, ctx.response, ctx.login?.team, ctx.login?.web,
    (status, title, body) => ctx.writeHtml(ctx.response, status, ctx.pageDocument(title, body, undefined, true), {}, true)) };

/** Access lane A3: a company's contacts without access. */
export const companyContactsRoute: GatewayRoute = { name: "company-contacts", handle: (ctx) =>
  handleCompanyContacts(ctx.request, ctx.response, ctx.login?.contacts, ctx.login?.web?.origin,
    (status, title, body) => ctx.writeHtml(ctx.response, status, ctx.pageDocument(title, body, undefined, true), {}, true)) };

/** Access lane A4: a store manager's own stores, never a sibling store or the company. */
export const storeManagerRoute: GatewayRoute = { name: "store-manager", handle: (ctx) =>
  handleStoreManager(ctx.request, ctx.login?.storeManager,
    (status, title, body) => ctx.writeHtml(ctx.response, status, ctx.pageDocument(title, body, undefined, true), {}, true)) };

/** Access lane A8: the address block list and per-person limits, before every other route. */
export const abuseGateRoute: GatewayRoute = { name: "abuse-gate", handle: (ctx) =>
  handleAbuseGate(ctx.request, ctx.response, ctx.login?.abuse, ctx.login?.web?.origin, /text\/html/.test(String(ctx.request.headers.accept ?? "")),
    (status, title, body, headers) => ctx.writeHtml(ctx.response, status, ctx.pageDocument(title, body, undefined, true), headers ?? {}, true)) };

/** Access lane A9: staff view a person's account read-only for 15 minutes. */
export const staffViewRoute: GatewayRoute = { name: "staff-view", handle: (ctx) => {
  const login = ctx.login, ports = login?.staffView, profiles = login?.web?.profiles;
  return handleStaffView(ctx.request, ctx.response, ports && profiles ? {
    ...ports,
    render: async (targetPrincipalId) => {
      const own = await profiles.readOwn({ requesterPrincipalId: targetPrincipalId, targetPersonId: targetPrincipalId });
      if (own.kind !== "found") return undefined;
      const page = await profileDocument({ status: 200, body: own.profile as never }, login as never);
      return page.status === 200 ? page.html : undefined;
    },
  } : ports, ctx.login?.web?.origin,
  (status, title, body) => ctx.writeHtml(ctx.response, status, ctx.pageDocument(title, body, undefined, true), { "cache-control": "no-store" }, true));
} };

/** Access lane A7: a company signs up and staff approve it. */
export const companyRegistrationRoute: GatewayRoute = { name: "company-registration", handle: (ctx) =>
  handleCompanyRegistration(ctx.request, ctx.response, ctx.login?.registrations, ctx.login?.web?.origin,
    (status, title, body) => ctx.writeHtml(ctx.response, status, ctx.pageDocument(title, body, undefined, true), { "cache-control": "no-store" }, true),
    ctx.login?.web?.returnTo) };
