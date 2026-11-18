import type { IncomingMessage, ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import type { LoginConfig, LoginDependencies, SessionStore } from "@studenthub/login-contract";
import type { UniverseEmbedStore } from "@studenthub/db/universe";
import { universeEmbedDigest } from "@studenthub/db/universe";
import { createLoginApplication } from "../login-application.js";
import { APP_POLICY, universeEmbedPolicy, writeEmbedResponse, type UniverseEmbedConfig } from "./embed-policy.js";
import { BROWSER_COOKIE, EMBED_COOKIE, SESSION_COOKIE, clearCookie, newReference, readCookie, requestToken, setCookie } from "./embed-cookies.js";
import { HandoffNotCurrentError, handoffBoundStates } from "./embed-login-states.js";
import { completingStores } from "./embed-completion.js";
import { verifyHostAttestation, type HostIdentityConfig, type HostIdentityMapping } from "./host-identity.js";
import { UNIVERSE_EMBED_E2_SCRIPT } from "./embed-script.js";

export const INSTANCE_TTL_SECONDS = 43_200;
export const HANDOFF_TTL_SECONDS = 600;
export const CHALLENGE_TTL_SECONDS = 60;
export const LEASE_SECONDS = 600;
/** The script renews from minute 8 of the 10-minute lease. */
export const RENEW_AFTER_SECONDS = 480;
/** Subtracted from the lease the client is told, to absorb gateway/database clock skew. */
export const LEASE_CLOCK_MARGIN_SECONDS = 5;
export const DONE_PATH = "/universe/embed/done";

export interface EmbedProfileField {
  readonly key: string;
  readonly value: string | number | boolean | null;
  /** Provenance mark, the same freshness kinds My profile shows. */
  readonly source: "imported_snapshot" | "written_by_person" | "derived" | "unavailable";
}

export type EmbedProfileView =
  | { readonly state: "not_linked" | "linked_data_not_ready" | "unavailable_or_conflict" }
  | { readonly state: "populated"; readonly fields: readonly EmbedProfileField[] };

/** Reads through the same OwnProfileReader projection as My profile (no second SQL path). */
export interface EmbedProfileSource {
  read(personId: string): Promise<EmbedProfileView>;
}

export interface UniverseEmbedRuntime {
  readonly store: UniverseEmbedStore;
  /** Live session check (SHU-457 revocation applies here once it lands). */
  readonly sessions: SessionStore;
  /** The separate embed login instance: own callback, own static return. */
  readonly login: { readonly dependencies: LoginDependencies; readonly config: LoginConfig };
  /** Exact https origin of the authorization endpoint the connect form is redirected to. */
  readonly authorizationOrigin: string;
  readonly hostIdentity: HostIdentityConfig;
  readonly mapping: HostIdentityMapping;
  readonly profiles: EmbedProfileSource;
}

type Binding =
  | { readonly kind: "refused"; readonly state: "signed_out" | "start_again" }
  | { readonly kind: "bound"; readonly instanceId: string; readonly personId: string; readonly generation: number;
      readonly verified: boolean; readonly leaseSubjectDigest?: string;
      /** Monotonic (performance.now) time by which the lease read here has ended, counted from before the read. */
      readonly leaseDeadline: number };

const MAX_BODY_BYTES = 8192;

const JSON_TYPE = "application/json";
const HTML_TYPE = "text/html; charset=utf-8";

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function language(request: IncomingMessage): "en" | "ar" {
  return /^\s*ar\b/i.test(String(request.headers["accept-language"] ?? "")) ? "ar" : "en";
}

const PAGE_TEXT = {
  en: { title: "StudentHub in Universe", signIn: "Sign in", signOut: "Sign out", link: "Link your StudentHub account",
    full: "Open StudentHub", open: "Open this in Universe.", done: "You're signed in. Go back to Universe.",
    again: "Start again. Close this tab and open StudentHub from Universe.", loading: "Checking your StudentHub account…",
    paused: "Your StudentHub access is paused, so you can't sign in for now. Your Universe account is not affected. If you think this is a mistake, contact StudentHub support." },
  ar: { title: "StudentHub في Universe", signIn: "تسجيل الدخول", signOut: "تسجيل الخروج", link: "اربط حسابك في StudentHub",
    full: "افتح StudentHub", open: "افتح هذه الصفحة داخل Universe.", done: "تم تسجيل دخولك. عد إلى Universe.",
    again: "ابدأ من جديد. أغلق هذا التبويب وافتح StudentHub من Universe.", loading: "جارٍ التحقق من حسابك في StudentHub…",
    paused: "تم إيقاف وصولك إلى StudentHub مؤقتًا، لذا لا يمكنك تسجيل الدخول الآن. حسابك في Universe غير متأثر. إذا كنت تعتقد أن هذا خطأ، فتواصل مع دعم StudentHub." },
} as const;

function page(lang: "en" | "ar", main: string, script = false, dataset = ""): string {
  const text = PAGE_TEXT[lang];
  return `<!doctype html><html lang="${lang}" dir="${lang === "ar" ? "rtl" : "ltr"}"><head><meta charset="utf-8">`
    + `<meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow">`
    + `<title>${escapeHtml(text.title)}</title><link rel="stylesheet" href="/assets/studenthub.css">`
    + (script ? `<script src="/universe/embed/embed.js" defer></script>` : "")
    + `</head><body${dataset}><main id="main" class="profile-main">${main}</main></body></html>`;
}

function messagePage(lang: "en" | "ar", message: string, extra = ""): string {
  return page(lang, `<h1>${escapeHtml(PAGE_TEXT[lang].title)}</h1><p role="status">${escapeHtml(message)}</p>${extra}`);
}

function sameToken(provided: unknown, expected: string): boolean {
  if (typeof provided !== "string") return false;
  // Compare byte lengths: a multi-byte value of the same character length must refuse, not throw.
  const a = Buffer.from(provided), b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

function singleHeader(request: IncomingMessage, name: string): string | undefined {
  let found: string | undefined;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index]!.toLowerCase() !== name) continue;
    if (found !== undefined) return undefined;
    found = request.rawHeaders[index + 1]!;
  }
  return found;
}

/**
 * Reads at most MAX_BODY_BYTES. Past the cap it stops listening without
 * destroying the socket, so the refusal can still be sent (with Connection:
 * close); Node discards the unread remainder.
 */
function readBody(request: IncomingMessage): Promise<string | undefined> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    let size = 0;
    const done = (value: string | undefined) => {
      request.off("data", onData); request.off("end", onEnd); request.off("error", onError);
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += buffer.length;
      if (size > MAX_BODY_BYTES) { request.pause(); done(undefined); return; }
      chunks.push(buffer);
    };
    const onEnd = () => done(Buffer.concat(chunks).toString("utf8"));
    const onError = () => done(undefined);
    request.on("data", onData); request.on("end", onEnd); request.on("error", onError);
  });
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  if (!/^application\/json(\s*;|$)/i.test(String(request.headers["content-type"] ?? ""))) return undefined;
  const raw = await readBody(request);
  if (raw === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
  } catch { return undefined; }
}

function json(response: ServerResponse, status: number, body: Record<string, unknown>, cookies: readonly string[] = []): void {
  writeEmbedResponse(response, status, JSON.stringify(body), JSON_TYPE, APP_POLICY, cookies.length ? { "set-cookie": cookies } : {});
}

/**
 * E2 behaviour of the closed embed manifest. Answers only the routes listed in
 * `embed-http.ts`; returns false for anything else so the caller's 404 stands.
 */
export async function handleEmbedRuntime(request: IncomingMessage, response: ServerResponse,
  config: UniverseEmbedConfig, runtime: UniverseEmbedRuntime, route: string): Promise<boolean> {
  const lang = language(request);
  const cookies = request.headers.cookie;
  const browser = readCookie(cookies, BROWSER_COOKIE);
  const embedRef = readCookie(cookies, EMBED_COOKIE);
  const sessionId = readCookie(cookies, SESSION_COOKIE);
  const exactOrigin = (): boolean => singleHeader(request, "origin") === config.origin;
  const callbackPath = config.callbackUrl ? new URL(config.callbackUrl).pathname : undefined;

  /** Every profile-bearing or state-changing JSON call: exact Origin (POST) and the per-transaction value. */
  const transactionOk = (requireOrigin: boolean): boolean =>
    embedRef !== undefined && (!requireOrigin || exactOrigin())
    && sameToken(singleHeader(request, "x-studenthub-embed"), requestToken(embedRef));

  async function binding(): Promise<Binding> {
    if (!browser || !embedRef) return { kind: "refused", state: "start_again" };
    const instanceId = await runtime.store.findInstance(embedRef, browser);
    if (!instanceId) return { kind: "refused", state: "start_again" };
    if (!sessionId) return { kind: "refused", state: "signed_out" };
    // Session first, binding and lease last: the lease check is the final await, and
    // readBinding re-checks the live session in the same statement, so neither a lease
    // expiry nor a logout or revocation can land between the checks and the response.
    const session = await runtime.sessions.get(sessionId);
    const readStarted = performance.now();
    const view = await runtime.store.readBinding(instanceId, browser, sessionId);
    if (!view) return { kind: "refused", state: "signed_out" };
    if (!session || session.personId !== view.personId || view.locked) {
      // Session replacement or revocation, or a lock: the binding and lease go,
      // but only the version read here (a concurrent /done may have replaced it).
      await runtime.store.invalidateBinding(instanceId, view.generation);
      return { kind: "refused", state: session ? "start_again" : "signed_out" };
    }
    return { kind: "bound", instanceId, personId: view.personId, generation: view.generation, verified: view.lease !== undefined,
      leaseDeadline: view.lease ? readStarted + view.lease.remainingSeconds * 1000 : readStarted,
      ...(view.lease ? { leaseSubjectDigest: view.lease.hostSubjectDigest } : {}) };
  }

  switch (route) {
    case "GET /universe/embed": {
      // Copied or top-level URL: no profile, no standalone sign-in, no state created.
      const dest = singleHeader(request, "sec-fetch-dest");
      if (dest !== undefined && dest !== "iframe") {
        const text = PAGE_TEXT[lang];
        writeEmbedResponse(response, 200, messagePage(lang, text.open,
          `<p><a href="${escapeHtml(config.mainOrigin)}/profile">${escapeHtml(text.full)}</a></p>`), HTML_TYPE, APP_POLICY);
        return true;
      }
      const set: string[] = [];
      // Browser binding first, so the instance never depends on the login start.
      let browserRef = browser;
      if (!browserRef) { browserRef = newReference(); set.push(setCookie(BROWSER_COOKIE, browserRef)); }
      let ref = embedRef && browser ? embedRef : undefined;
      if (!ref || !await runtime.store.findInstance(ref, browserRef)) {
        ref = newReference();
        await runtime.store.ensureInstance(browserRef, ref, INSTANCE_TTL_SECONDS);
        set.push(setCookie(EMBED_COOKIE, ref));
      }
      const text = PAGE_TEXT[lang];
      const token = requestToken(ref);
      const main = `<h1>${escapeHtml(text.title)}</h1><p id="status" role="status" aria-live="polite">${escapeHtml(text.loading)}</p>`
        + `<section id="profile" aria-labelledby="status" hidden></section>`
        + `<form id="connect" method="post" action="/universe/embed/connect" target="_blank" rel="noopener" hidden>`
        + `<input type="hidden" name="t" value="${escapeHtml(token)}"><button type="submit">${escapeHtml(text.signIn)}</button></form>`
        + `<button id="signout" type="button" hidden>${escapeHtml(text.signOut)}</button>`
        + `<p id="link" hidden><a href="${escapeHtml(config.mainOrigin)}/profile/link-account" target="_blank" rel="noopener">${escapeHtml(text.link)}</a></p>`
        + `<p id="full" hidden><a href="${escapeHtml(config.mainOrigin)}/profile" target="_blank" rel="noopener">${escapeHtml(text.full)}</a></p>`;
      const dataset = ` data-state="loading" data-token="${escapeHtml(token)}" data-hosts="${escapeHtml(config.ancestors.join(" "))}"`;
      writeEmbedResponse(response, 200, page(lang, main, true, dataset), HTML_TYPE, universeEmbedPolicy(config, runtime.authorizationOrigin),
        set.length ? { "set-cookie": set } : {});
      return true;
    }
    case "GET /universe/embed/embed.js":
      writeEmbedResponse(response, 200, UNIVERSE_EMBED_E2_SCRIPT, "text/javascript; charset=utf-8");
      return true;
    case "GET /universe/embed/status": {
      if (!transactionOk(false)) { json(response, 403, { error: "forbidden" }); return true; }
      const bound = await binding();
      if (bound.kind === "refused") { json(response, 200, { state: bound.state }); return true; }
      json(response, 200, { state: bound.verified ? "ready" : "needs_universe" });
      return true;
    }
    case "GET /universe/embed/profile": {
      if (!transactionOk(false)) { json(response, 403, { error: "forbidden" }); return true; }
      const bound = await binding();
      if (bound.kind === "refused") { json(response, 200, { state: bound.state }); return true; }
      if (!bound.verified) { json(response, 200, { state: "needs_universe" }); return true; }
      // The link state is read fresh on every profile response.
      const view = await runtime.profiles.read(bound.personId);
      // The read can outlast the lease or the binding: authorize again before releasing fields.
      const again = await binding();
      if (again.kind === "refused") { json(response, 200, { state: again.state }); return true; }
      // The lease seen by that final read may still end before this response is written
      // (the read's commit and reply take time): its deadline is checked last, synchronously.
      if (!again.verified || again.generation !== bound.generation || again.personId !== bound.personId
        || performance.now() >= again.leaseDeadline) {
        json(response, 200, { state: "needs_universe" }); return true;
      }
      json(response, 200, view.state === "populated" ? { state: view.state, fields: view.fields } : { state: view.state });
      return true;
    }
    case "POST /universe/embed/challenge": {
      if (!transactionOk(true)) { json(response, 403, { error: "forbidden" }); return true; }
      const bound = await binding();
      if (bound.kind === "refused" || !sessionId || !browser) {
        json(response, 200, { state: bound.kind === "refused" ? bound.state : "start_again" }); return true;
      }
      const challenge = newReference();
      if (!await runtime.store.issueChallenge(bound.instanceId, browser, sessionId, challenge, CHALLENGE_TTL_SECONDS)) {
        json(response, 200, { state: "start_again" }); return true;
      }
      json(response, 200, { challenge });
      return true;
    }
    case "POST /universe/embed/identity": {
      if (!transactionOk(true)) { json(response, 403, { error: "forbidden" }); return true; }
      const body = await readJson(request);
      const bound = await binding();
      if (bound.kind === "refused") { json(response, 200, { state: bound.state }); return true; }
      const refuse = async (state: "start_again" | "different_account", close = false) => {
        // A failed verification or renewal invalidates the binding version it checked;
        // a binding renewed or replaced meanwhile (another tab, another /done) stays.
        await runtime.store.invalidateBinding(bound.instanceId, bound.generation);
        writeEmbedResponse(response, 200, JSON.stringify({ state }), JSON_TYPE, APP_POLICY, close ? { connection: "close" } : {});
      };
      // An unreadable body may be an oversized one with bytes still unread: close after the refusal.
      if (!body || Object.keys(body).length !== 1) return refuse("start_again", !body).then(() => true);
      const attestation = await verifyHostAttestation(body.attestation, runtime.hostIdentity);
      if (!attestation.ok) {
        // A replay (a duplicate delivery of an attestation already used) or an unavailable
        // verifier says nothing against the current binding: refuse without invalidating.
        if (attestation.reason === "unavailable") { json(response, 503, { error: "unavailable" }); return true; }
        if (attestation.reason === "replayed") { json(response, 200, { state: "start_again" }); return true; }
        return refuse("start_again").then(() => true);
      }
      const generation = await runtime.store.consumeChallenge(bound.instanceId, attestation.challenge);
      if (generation === undefined || generation !== bound.generation) {
        // A used, expired or older-generation challenge says nothing about the current
        // binding (another tab may have just renewed it): refuse without invalidating.
        json(response, 200, { state: "start_again" }); return true;
      }
      if (bound.leaseSubjectDigest !== undefined && bound.leaseSubjectDigest !== universeEmbedDigest(attestation.subject)) {
        return refuse("different_account").then(() => true);
      }
      if (!await runtime.mapping.matches(attestation.subject, bound.personId)) return refuse("different_account").then(() => true);
      const lease = await runtime.store.writeLease(bound.instanceId, generation, attestation.subject, attestation.issuedAt, LEASE_SECONDS);
      if (!lease) return refuse("start_again").then(() => true);
      // The client clears rendered profile data at this deadline on its own clock,
      // measured from when it sent the request (never later than the server lease).
      // Remaining time by the database clock that enforces the lease, less a small margin.
      const leaseSeconds = Math.max(0, Math.min(LEASE_SECONDS,
        Math.floor(lease.remainingSeconds) - LEASE_CLOCK_MARGIN_SECONDS));
      json(response, 200, { state: "ready", leaseSeconds,
        renewAfterSeconds: leaseSeconds > 60 ? Math.min(RENEW_AFTER_SECONDS, leaseSeconds - 60) : leaseSeconds });
      return true;
    }
    case "POST /universe/embed/connect": {
      // A refusal may leave an unread (oversized) body behind: close the connection after it.
      const startAgain = () => writeEmbedResponse(response, 400, messagePage(lang, PAGE_TEXT[lang].again), HTML_TYPE, APP_POLICY,
        { connection: "close" });
      if (!exactOrigin() || !browser || !embedRef
        || !/^application\/x-www-form-urlencoded(\s*;|$)/i.test(String(request.headers["content-type"] ?? ""))) { startAgain(); return true; }
      const raw = await readBody(request);
      const form = raw === undefined ? undefined : new URLSearchParams(raw);
      if (!form || form.getAll("t").length !== 1 || !sameToken(form.get("t"), requestToken(embedRef))) { startAgain(); return true; }
      const instanceId = await runtime.store.findInstance(embedRef, browser);
      if (!instanceId) { startAgain(); return true; }
      const handoffId = await runtime.store.createHandoff(instanceId, browser, HANDOFF_TTL_SECONDS);
      const application = createLoginApplication({ ...runtime.login.dependencies,
        states: handoffBoundStates(runtime.login.dependencies.states, runtime.store, handoffId) }, runtime.login.config);
      let result;
      try {
        result = await application.start({ browserSessionId: browser, returnTo: `${config.origin}${DONE_PATH}` });
      } catch (error) {
        // Superseded, expired or already bound: no authorization request is issued.
        // Anything else (a store outage) reaches the 503 handler.
        if (error instanceof HandoffNotCurrentError) { startAgain(); return true; }
        throw error;
      }
      const location = result.headers?.location;
      if (result.status !== 302 || typeof location !== "string") { startAgain(); return true; }
      writeEmbedResponse(response, 302, "", HTML_TYPE, APP_POLICY, { location });
      return true;
    }
    case "GET /universe/embed/done": {
      const startAgain = () => writeEmbedResponse(response, 400, messagePage(lang, PAGE_TEXT[lang].again), HTML_TYPE, APP_POLICY);
      if (!browser || !embedRef || !sessionId) { startAgain(); return true; }
      const instanceId = await runtime.store.findInstance(embedRef, browser);
      if (!instanceId) { startAgain(); return true; }
      const session = await runtime.sessions.get(sessionId);
      if (!session) { startAgain(); return true; }
      const personId = await runtime.store.consumeHandoff(instanceId, browser, sessionId);
      if (!personId || personId !== session.personId) {
        if (personId) await runtime.store.invalidateBinding(instanceId);
        startAgain(); return true;
      }
      writeEmbedResponse(response, 200, messagePage(lang, PAGE_TEXT[lang].done), HTML_TYPE, APP_POLICY);
      return true;
    }
    case "POST /logout": {
      if (!transactionOk(true)) { json(response, 403, { error: "forbidden" }); return true; }
      if (browser && embedRef && sessionId) {
        // Only the binding of the session being logged out: a sign-in that replaced it
        // on this instance meanwhile (another /done) keeps its binding.
        const instanceId = await runtime.store.findInstance(embedRef, browser);
        const view = instanceId ? await runtime.store.readBinding(instanceId, browser, sessionId) : undefined;
        if (instanceId && view) await runtime.store.invalidateBinding(instanceId, view.generation);
      }
      // Through the embed login instance, so SHU-457's upstream end applies when it lands.
      if (sessionId) {
        const result = await createLoginApplication(runtime.login.dependencies, runtime.login.config).logout(sessionId);
        if (result.status >= 500) { json(response, 503, { error: "unavailable" }); return true; }
      }
      json(response, 200, { state: "signed_out" }, [clearCookie(SESSION_COOKIE)]);
      return true;
    }
    default:
      break;
  }
  if (callbackPath !== undefined && route === `GET ${callbackPath}`) {
    const startAgain = () => writeEmbedResponse(response, 400, messagePage(lang, PAGE_TEXT[lang].again), HTML_TYPE, APP_POLICY);
    const url = new URL(request.url ?? "/", "https://embed.invalid");
    const state = url.searchParams.getAll("state");
    const code = url.searchParams.getAll("code");
    if (!browser || state.length !== 1 || code.length !== 1 || !state[0] || !code[0]) { startAgain(); return true; }
    const wrapped = completingStores(runtime.login.dependencies.states, runtime.login.dependencies.sessions, runtime.store);
    const application = createLoginApplication({ ...runtime.login.dependencies, ...wrapped }, runtime.login.config);
    const result = await application.callback({ browserSessionId: browser, state: state[0], code: code[0] });
    // A store failure during completion is an outage: rethrown so the request answers 503.
    if (wrapped.failure() !== undefined) throw wrapped.failure();
    // A paused person is told so (as the main login does), not sent to start again.
    if (result.status === 403 && result.body?.error === "access_paused") {
      writeEmbedResponse(response, 403, messagePage(lang, PAGE_TEXT[lang].paused), HTML_TYPE, APP_POLICY); return true;
    }
    const location = result.headers?.location;
    const cookie = result.headers?.["set-cookie"];
    if (result.status !== 302 || location !== `${config.origin}${DONE_PATH}` || typeof cookie !== "string") { startAgain(); return true; }
    writeEmbedResponse(response, 302, "", HTML_TYPE, APP_POLICY, { location, "set-cookie": cookie });
    return true;
  }
  return false;
}

