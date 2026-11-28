import { handleProfileEdit, handleProfileEditPage, shownProfileValue } from "../profile-edit-http.js";
import { handleProfileBrowserEdit } from "../profile-browser-edit-http.js";
import { handleLanguagePreference, handleLanguagePreferencePage } from "../language-preference.js";
import { handleBankDetails, handleBankDetailsPage } from "../bank-details.js";
import { handleProfileRecords } from "../profile-records-http.js";
import type { GatewayRoute } from "./context.js";
import { renderPeopleDirectory, renderPersonDetail, renderPersonDocuments, wantsHtml } from "../web-ui.js";
import { openPersonDocument, personDocuments } from "../person-documents.js";
import { handleCivilIdReview } from "../civil-id-review-http.js";
import { writeNotFound } from "../shell/error-pages.js";
export { personLifecycleRoute } from "../person-lifecycle.js";

const sessionCookie=(value:string|undefined)=>value?.split(";").map(x=>x.trim()).find(x=>x.startsWith("__Host-studenthub_session="))?.slice(26);
export const peopleDirectoryRoute:GatewayRoute={name:"people-directory",handle:async ctx=>{if(ctx.request.method!=="GET"||ctx.request.url?.split("?",1)[0]!=="/workspace/people")return false;const html=wantsHtml(ctx.request.headers.accept),result=ctx.login?.people?await ctx.login.people.open(sessionCookie(ctx.request.headers.cookie),new URL(ctx.request.url,"http://gateway.invalid").searchParams,html):{status:404 as const,body:{error:"not_found"}};if(result.status===404){writeNotFound(ctx.request,ctx.response);return true}if(html){ctx.writeHtml(ctx.response,result.status,renderPeopleDirectory(result,ctx.login!),{},true);return true}ctx.response.writeHead(result.status,{"content-type":"application/json","cache-control":"no-store",vary:"Accept"});ctx.response.end(JSON.stringify(result.body));return true}};
export const civilIdReviewRoute:GatewayRoute={name:"civil-id-review",handle:ctx=>handleCivilIdReview(ctx.request,ctx.response,ctx.login?.civilIdReview,ctx.login?.web?.origin,async session=>{if(!ctx.login)return undefined;const result=await ctx.login.profile({sessionId:session});return result.status===200&&typeof result.body?.personId==="string"?result.body.personId:undefined},(title,body)=>ctx.pageDocument(title,body))};

export const profileEditPageRoute: GatewayRoute = { name: "profile-edit-page", handle: (ctx) =>
  handleProfileEditPage(ctx.request, ctx.response, ctx.login?.profileEdit, ctx.login?.web?.origin,
    (status, title, body) => ctx.writeHtml(ctx.response, status, status === 401 ? ctx.renderError(401, ctx.login) : ctx.pageDocument(title, body)),
    async (sessionId, fieldName) => {
      if (!sessionId || !ctx.login?.web) return undefined;
      const authorized = await ctx.login.profile({ sessionId });
      const personId = authorized.status === 200 ? authorized.body?.personId : undefined;
      if (typeof personId !== "string") return undefined;
      const result = await ctx.login.web.profiles.readOwn({ requesterPrincipalId: personId, targetPersonId: personId });
      const shown = result.kind === "found" ? result.profile.fields[fieldName] : undefined;
      return shown ? shownProfileValue(shown) : undefined;
    }) };

export const profileEditRoute: GatewayRoute = { name: "profile-edit", handle: (ctx) =>
  handleProfileEdit(ctx.request, ctx.response, ctx.login?.profileEdit, ctx.login?.web?.origin) };

export const profileBrowserEditRoute: GatewayRoute = { name: "profile-browser-edit", handle: (ctx) =>
  handleProfileBrowserEdit(ctx.request, ctx.response, ctx.login?.browserEdit, ctx.login?.web?.origin,
    (status, title, body, language) => ctx.writeHtml(ctx.response, status, ctx.pageDocument(title, body, language))) };

export const languagePreferencePageRoute: GatewayRoute = { name: "language-preference-page", handle: (ctx) =>
  handleLanguagePreferencePage(ctx.request, ctx.response, ctx.login?.preferences, ctx.login?.web?.origin,
    (status, title, body, language, historyGuard) => ctx.writeHtml(ctx.response, status,
      status === 401 && language === "en" ? ctx.renderError(401, ctx.login) : ctx.pageDocument(title, body, language, historyGuard), {}, historyGuard),
    async (sessionId) => {
      if (!sessionId || !ctx.login?.web) return undefined;
      const authorized = await ctx.login.profile({ sessionId });
      const personId = authorized.status === 200 ? authorized.body?.personId : undefined;
      if (typeof personId !== "string") return undefined;
      const result = await ctx.login.web.profiles.readOwn({ requesterPrincipalId: personId, targetPersonId: personId });
      const field = result.kind === "found" ? result.profile.fields.language : undefined;
      return field?.state === "available" ? field.value : undefined;
    }) };

export const languagePreferenceRoute: GatewayRoute = { name: "language-preference", handle: (ctx) =>
  handleLanguagePreference(ctx.request, ctx.response, ctx.login?.preferences, ctx.login?.web?.origin) };
export const bankDetailsRoute: GatewayRoute = { name: "bank-details", handle: async (ctx) =>
  await handleBankDetailsPage(ctx.request, ctx.response, ctx.login?.bankDetails, ctx.login?.web?.origin,
    (status, title, body) => ctx.writeHtml(ctx.response, status, status === 401 ? ctx.renderError(401, ctx.login) : ctx.pageDocument(title, body)))
  || handleBankDetails(ctx.request, ctx.response, ctx.login?.bankDetails, ctx.login?.web?.origin) };
export const profileRecordsRoute: GatewayRoute = { name: "profile-records", handle: (ctx) =>
  handleProfileRecords(ctx.request, ctx.response, ctx.profileRecords,
    (status, body) => ctx.writeHtml(ctx.response, status, ctx.pageDocument("Education and experience", body))) };
const PERSON_PAGE=/^\/workspace\/people\/([^/]+)$/;
/** GET /workspace/people/<person>: one person for operator staff and admin; everyone else gets the unknown-path 404. */
export const personDetailRoute:GatewayRoute={name:"person-detail",handle:async ctx=>{
  const match=ctx.request.method==="GET"||ctx.request.method==="HEAD"?PERSON_PAGE.exec(ctx.request.url?.split("?",1)[0]??""):null;if(!match)return false;
  let principalId:string|undefined;try{principalId=decodeURIComponent(match[1]!)}catch{principalId=undefined}
  const query=new URL(ctx.request.url!,"http://gateway.invalid").searchParams;
  const result=principalId!==undefined&&query.size===0&&ctx.login?.people?.person?await ctx.login.people.person(sessionCookie(ctx.request.headers.cookie),principalId):{status:404 as const,body:{error:"not_found"}};
  if(result.status===404){writeNotFound(ctx.request,ctx.response);return true}
  if(wantsHtml(ctx.request.headers.accept)){ctx.writeHtml(ctx.response,result.status,renderPersonDetail(result,ctx.login!),{},true);return true}
  ctx.response.writeHead(result.status,{"content-type":"application/json","cache-control":"no-store",vary:"Accept"});ctx.response.end(JSON.stringify(result.body));return true}};
const PERSON_DOCUMENTS=/^\/workspace\/people\/([^/]+)\/documents$/,PERSON_DOCUMENT_OPEN=/^\/workspace\/people\/([^/]+)\/documents\/([^/]+)\/open$/;
const decoded=(segment:string)=>{try{return decodeURIComponent(segment)}catch{return undefined}};
/**
 * True when the request has no body; the open form has no fields. Stops counting past 1 KiB but never
 * destroys the request, so the refusal still reaches the client; the caller lets the rest drain.
 */
function emptyBody(request:import("node:http").IncomingMessage):Promise<boolean>{
  return new Promise(resolve=>{let size=0;
    const done=(empty:boolean)=>{request.off("data",data).off("end",end).off("error",failed);resolve(empty)};
    const data=(chunk:Buffer)=>{size+=chunk.length;if(size>1024)done(false)},end=()=>done(size===0),failed=()=>done(false);
    request.on("data",data).on("end",end).on("error",failed)})}
/**
 * A-03. GET /workspace/people/<person>/documents lists one person's documents (type, state, format, size; no contents).
 * POST /workspace/people/<person>/documents/<type>/open issues a short signed link to the existing staff delivery.
 * Operator staff and admin only; everyone else, a bad id or no such person gets the unknown-path 404.
 */
export const personDocumentsRoute:GatewayRoute={name:"person-documents",handle:async ctx=>{
  const method=ctx.request.method,url=new URL(ctx.request.url??"/","http://gateway.invalid");
  const list=method==="GET"||method==="HEAD"?PERSON_DOCUMENTS.exec(url.pathname):null,open=method==="POST"?PERSON_DOCUMENT_OPEN.exec(url.pathname):null;
  if(!list&&!open)return false;
  const session=sessionCookie(ctx.request.headers.cookie),staffDocuments=ctx.login?.civilIdReview?.staffDocuments;
  if(list){
    const principalId=decoded(list[1]!);
    const result=principalId!==undefined&&url.search===""?await personDocuments(ctx.login?.people,staffDocuments,session,principalId):{status:404 as const,body:{error:"not_found"}};
    if(result.status===404){writeNotFound(ctx.request,ctx.response);return true}
    if(wantsHtml(ctx.request.headers.accept)){ctx.writeHtml(ctx.response,result.status,renderPersonDocuments(result,ctx.login!),{},true);return true}
    ctx.response.writeHead(result.status,{"content-type":"application/json","cache-control":"no-store",vary:"Accept"});ctx.response.end(JSON.stringify(result.body));return true;
  }
  // Same origin, checked before the session or the body is read.
  const origin=ctx.login?.web?.origin;
  if(!origin||ctx.request.headers.origin!==origin||ctx.request.headers["sec-fetch-site"]==="cross-site"){ctx.request.resume();ctx.writeHtml(ctx.response,403,ctx.pageDocument("Documents","<main><h1>Documents</h1><p>This document must be opened from StudentHub itself.</p></main>"));return true}
  const principalId=decoded(open![1]!),type=decoded(open![2]!);
  if(principalId===undefined||type===undefined||url.search!==""||!await emptyBody(ctx.request)){ctx.request.resume();ctx.response.setHeader("connection","close");writeNotFound(ctx.request,ctx.response);return true}
  const result=await openPersonDocument(ctx.login?.people,staffDocuments,session,principalId,type);
  if(result.status===303){ctx.response.writeHead(303,{location:result.location,"cache-control":"no-store","referrer-policy":"no-referrer"});ctx.response.end();return true}
  if(result.status===404){writeNotFound(ctx.request,ctx.response);return true}
  ctx.writeHtml(ctx.response,result.status,ctx.renderError(result.status,ctx.login),{},true);return true}};
