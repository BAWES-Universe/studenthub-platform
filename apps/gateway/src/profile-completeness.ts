import { deriveProfileCompleteness, type OwnProfileProjection } from "@studenthub/profile";
import { currentProfileAvatar } from "./profile-avatar.js";
import { addNotificationBell, profileDocument, wantsHtml } from "./web-ui.js";
import type { GatewayRouteContext } from "./routes/context.js";
import type { OriginChoices } from "./profile-edit-http.js";

const cookie = (header: string | undefined): string | undefined => header?.split(";").map(v => v.trim())
  .find(v => v.startsWith("__Host-studenthub_session="))?.split("=")[1];

export async function handleProfileCompleteness(ctx: GatewayRouteContext): Promise<boolean> {
  if (ctx.request.method !== "GET" || new URL(ctx.request.url ?? "/", "http://gateway.invalid").pathname !== "/profile") return false;
  if (!ctx.login?.web) return false;
  const html = wantsHtml(ctx.request.headers.accept), session = cookie(ctx.request.headers.cookie);
  try {
    const requested = new URL(ctx.request.url ?? "/", "http://gateway.invalid").searchParams.get("person_id") ?? undefined;
    const auth = await ctx.login.profile({ sessionId: session, personId: requested });
    if (auth.status !== 200 || typeof auth.body?.personId !== "string") {
      if (html) ctx.writeHtml(ctx.response, auth.status, ctx.renderError(auth.status, ctx.login));
      else { ctx.response.writeHead(auth.status, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept" }); ctx.response.end(JSON.stringify(auth.body)); }
      return true;
    }
    const personId = auth.body.personId;
    const own = await ctx.login.web.profiles.readOwn({ requesterPrincipalId: personId, targetPersonId: requested ?? personId });
    if (own.kind !== "found") {
      const status = own.kind === "not_found" ? 404 : 503;
      const body = { error: own.kind === "not_found" ? "profile_not_found" : "profile_unavailable" };
      if (html) ctx.writeHtml(ctx.response, status, ctx.renderError(status, ctx.login));
      else { ctx.response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept" }); ctx.response.end(JSON.stringify(body)); }
      return true;
    }
    const cached = currentProfileAvatar();
    const reads = await Promise.allSettled([
      ctx.authz.store.getPrincipal(personId),
      ctx.profileRecords?.service.background(personId),
      cached ? Promise.resolve(cached.documents) : session && ctx.documents ? ctx.documents.list(session) : undefined,
      ctx.login.profileEdit?.choices?.(),
    ]);
    const value = <T>(index:number):T|undefined => reads[index]?.status === "fulfilled" ? reads[index].value as T|undefined : undefined;
    const principal=value<Awaited<ReturnType<typeof ctx.authz.store.getPrincipal>>>(0), background=value<Awaited<ReturnType<NonNullable<typeof ctx.profileRecords>["service"]["background"]>>>(1);
    const documents=value<readonly {readonly type:string}[]>(2), choices=value<OriginChoices>(3);
    const nationality = own.profile.fields.nationality;
    const nationalityId = nationality.state === "available" ? nationality.editValue : undefined;
    const countries = Array.isArray(choices?.countries) ? choices.countries : [];
    const country = countries.find(value => value.id === nationalityId);
    const profile = deriveProfileCompleteness(own.profile, {
      emailPresent: typeof principal?.email === "string" && principal.email.trim().length > 0,
      documents: documents ?? [], educationPresent: (background?.education.length ?? 0) > 0,
      skillPresent: (background?.skill.length ?? 0) > 0, nationalityCode: country?.code,
      sourcesAvailable: reads.every(read => read.status === "fulfilled") && !!principal && !!background && !!documents && !!choices,
    });
    if (html) {
      const notice = await ctx.login.browserEdit?.notice(session, ctx.request.headers.cookie);
      const renderedLogin = ctx.login.profileEdit && choices ? { ...ctx.login, profileEdit: { ...ctx.login.profileEdit, choices: async () => choices } } : ctx.login;
      const page = await profileDocument({ status: 200, body: profile }, renderedLogin, notice?.notice, ctx.documents !== undefined);
      let rendered = page.html;
      try { rendered = addNotificationBell(rendered, await ctx.login.notifications?.count(session) ?? 0); }
      catch { rendered = addNotificationBell(rendered, 0); }
      ctx.writeHtml(ctx.response, page.status, rendered, notice?.clearCookie ? { "set-cookie": notice.clearCookie } : {}); return true;
    }
    ctx.response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept" });
    ctx.response.end(JSON.stringify(profile)); return true;
  } catch {
    const unavailable = { error: "profile_unavailable" };
    if (html) ctx.writeHtml(ctx.response, 503, ctx.renderError(503, ctx.login));
    else { ctx.response.writeHead(503, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept" }); ctx.response.end(JSON.stringify(unavailable)); }
    return true;
  }
}
