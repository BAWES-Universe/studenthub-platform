import { handleProfileEdit, handleProfileEditPage, shownProfileValue } from "../profile-edit-http.js";
import { handleProfileBrowserEdit } from "../profile-browser-edit-http.js";
import { handleLanguagePreference, handleLanguagePreferencePage } from "../language-preference.js";
import { handleBankDetails } from "../bank-details.js";
import { handleProfileRecords } from "../profile-records-http.js";
import type { GatewayRoute } from "./context.js";
import { renderPeopleDirectory, wantsHtml } from "../web-ui.js";
import { handleCivilIdReview } from "../civil-id-review-http.js";

export const civilIdReviewRoute:GatewayRoute={name:"civil-id-review",handle:ctx=>handleCivilIdReview(ctx.request,ctx.response,ctx.login?.civilIdReview,async session=>{if(!ctx.login)return undefined;const result=await ctx.login.profile({sessionId:session});return result.status===200&&typeof result.body?.personId==="string"?result.body.personId:undefined},(status,body)=>ctx.writeHtml(ctx.response,status,ctx.pageDocument("Civil IDs",body),{},true))};

const sessionCookie=(value:string|undefined)=>value?.split(";").map(x=>x.trim()).find(x=>x.startsWith("__Host-studenthub_session="))?.slice(26);
export const peopleDirectoryRoute:GatewayRoute={name:"people-directory",handle:async ctx=>{if(ctx.request.method!=="GET"||ctx.request.url?.split("?",1)[0]!=="/workspace/people")return false;const html=wantsHtml(ctx.request.headers.accept),result=ctx.login?.people?await ctx.login.people.open(sessionCookie(ctx.request.headers.cookie),new URL(ctx.request.url,"http://gateway.invalid").searchParams,html):{status:404 as const,body:{error:"not_found"}};if(result.status===404){ctx.response.writeHead(404,{"content-type":"application/json"});ctx.response.end(JSON.stringify({ok:false,error:"not_found"}));return true}if(html){ctx.writeHtml(ctx.response,result.status,renderPeopleDirectory(result,ctx.login!),{},true);return true}ctx.response.writeHead(result.status,{"content-type":"application/json","cache-control":"no-store",vary:"Accept"});ctx.response.end(JSON.stringify(result.body));return true}};

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
export const bankDetailsRoute: GatewayRoute = { name: "bank-details", handle: (ctx) =>
  handleBankDetails(ctx.request, ctx.response, ctx.login?.bankDetails, ctx.login?.web?.origin) };
export const profileRecordsRoute: GatewayRoute = { name: "profile-records", handle: (ctx) =>
  handleProfileRecords(ctx.request, ctx.response, ctx.profileRecords,
    (status, body) => ctx.writeHtml(ctx.response, status, ctx.pageDocument("Education and experience", body))) };
