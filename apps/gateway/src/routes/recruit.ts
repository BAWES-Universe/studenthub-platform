import { handleRecruitChecklist } from "../recruit/checklist-http.js";
import { handleRecruitPipeline } from "../recruit/pipeline-http.js";
import { handleRecruitRequests } from "../recruit/requests-http.js";
import { handleRecruitPeopleSearch } from "../recruit/search-http.js";
import { handleRecruitInvitations } from "../recruit/invitations-http.js";
import { handleRecruitEmployerView } from "../recruit/employer-view-http.js";
import { wantsHtml } from "../web-ui.js";
import type { GatewayRoute } from "./context.js";

export const recruitRequestsRoute: GatewayRoute = { name: "recruit-requests", handle: (ctx) =>
  handleRecruitRequests(ctx.request, ctx.response, ctx.login?.recruitRequests, ctx.login?.web?.origin,
    (status, title, body) => ctx.writeHtml(ctx.response, status, status === 401 ? ctx.renderError(401, ctx.login) : ctx.pageDocument(title, body)),
    wantsHtml(ctx.request.headers.accept)) };
export const recruitPipelineRoute: GatewayRoute = { name: "recruit-pipeline", handle: (ctx) =>
  handleRecruitPipeline(ctx.request, ctx.response, ctx.login?.recruitPipeline, ctx.login?.web?.origin,
    (status, title, body) => ctx.writeHtml(ctx.response, status, status === 401 ? ctx.renderError(401, ctx.login) : ctx.pageDocument(title, body)),
    wantsHtml(ctx.request.headers.accept)) };
export const recruitChecklistRoute: GatewayRoute = { name: "recruit-checklist", handle: (ctx) =>
  handleRecruitChecklist(ctx.request, ctx.response, ctx.login?.recruitChecklist, ctx.login?.web?.origin,
    (status, title, body) => ctx.writeHtml(ctx.response, status, status === 401 ? ctx.renderError(401, ctx.login) : ctx.pageDocument(title, body)),
    wantsHtml(ctx.request.headers.accept)) };
export const recruitPeopleSearchRoute: GatewayRoute = { name: "recruit-people-search", handle: (ctx) =>
  handleRecruitPeopleSearch(ctx.request, ctx.response, ctx.login?.recruitPeopleSearch,
    (status, title, body) => ctx.writeHtml(ctx.response, status, status === 401 ? ctx.renderError(401, ctx.login) : ctx.pageDocument(title, body)),
    wantsHtml(ctx.request.headers.accept)) };
export const recruitInvitationsRoute: GatewayRoute = { name: "recruit-invitations", handle: (ctx) =>
  handleRecruitInvitations(ctx.request, ctx.response, ctx.login?.recruitInvitations, ctx.login?.web?.origin,
    (status, title, body) => ctx.writeHtml(ctx.response, status, status === 401 ? ctx.renderError(401, ctx.login) : ctx.pageDocument(title, body)),
    wantsHtml(ctx.request.headers.accept)) };
// Document links come from the candidate documents store the gateway already holds (no gateway index change).
export const recruitEmployerViewRoute: GatewayRoute = { name: "recruit-employer-view", handle: (ctx) =>
  handleRecruitEmployerView(ctx.request, ctx.response, ctx.documents ? ctx.login?.recruitEmployerView?.withDocuments(ctx.documents) : ctx.login?.recruitEmployerView,
    (status, title, body) => ctx.writeHtml(ctx.response, status, status === 401 ? ctx.renderError(401, ctx.login) : ctx.pageDocument(title, body)),
    wantsHtml(ctx.request.headers.accept)) };
