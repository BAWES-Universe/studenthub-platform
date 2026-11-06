import type { IncomingMessage, ServerResponse } from "node:http";

import type { SessionStore } from "@studenthub/login-contract";
import {
  createSafeWrite,
  type ActionToken,
  type FieldPolicy,
  type FieldChange,
  type Receipt,
  type RejectionReason,
  type SafeWriteClock,
  type SafeWriteImplementation,
  type SafeWriteSecret,
  type SafeWriteStore,
} from "@studenthub/safe-write-contract";
import {
  LANGUAGE_FIELD, LANGUAGES, personRecordRef, safeWritePrincipalRef,
} from "@studenthub/db";
import type { ProfileLanguage } from "./ui/profile-copy.js";

/**
 * SHU-84: the platform's first write. A signed-in person changes their own
 * language preference through SHU-82's preview → confirm → receipt contract.
 *
 * Nothing here decides who is asking from the request body: the session does.
 * The body names only the new value and, at confirm, the token the preview
 * issued. Personal-profile ownership is re-derived from the principal by the
 * store at preview and again inside the commit.
 */
export const LANGUAGE_POLICY: FieldPolicy = Object.freeze({
  allowed: Object.freeze([LANGUAGE_FIELD]),
  maxValueLength: 2,
});

/** What the contract builder needs. The runtime and the conformance run share it. */
export interface SafeWriteBuildInput {
  readonly store: SafeWriteStore;
  readonly secret: SafeWriteSecret;
  readonly policy: FieldPolicy;
  readonly clock?: SafeWriteClock;
  readonly tokenLifetimeMs?: number;
}

/** The one place a safe write is built, so conformance runs against what serves. */
export function buildSafeWrite(input: SafeWriteBuildInput): SafeWriteImplementation {
  return createSafeWrite(input);
}

export interface LanguagePreferenceStore {
  forPrincipal(principalId: string): SafeWriteStore;
  readReceipt(principalId: string, receiptRef: string): Promise<Receipt | null>;
}

export type LanguagePreferenceResult =
  | { readonly status: 200; readonly body: unknown }
  | { readonly status: 400 | 401 | 403 | 404 | 409 | 503; readonly body: { readonly error: string } };

export interface LanguagePreference {
  validatePreview(sessionId: string | undefined, body: unknown): Promise<LanguagePreferenceResult>;
  preview(sessionId: string | undefined, body: unknown): Promise<LanguagePreferenceResult>;
  confirm(sessionId: string | undefined, body: unknown): Promise<LanguagePreferenceResult>;
  receipt(sessionId: string | undefined, receiptRef: string): Promise<LanguagePreferenceResult>;
}

const INERT_STORE: SafeWriteStore = Object.freeze({
  readField: () => null,
  ownedRecord: () => null,
  commit: () => ({ ok: false, reason: "not_own_record" }) as const,
});

const TOKEN_KEYS = ["changeSetDigest", "expectedBeforeDigest", "expiresAt", "issuedAt", "mac", "principalRef", "tokenId"];

function refusal(reason: RejectionReason): LanguagePreferenceResult {
  const status = reason === "not_own_record" ? 403
    : reason === "receipt_failed" ? 503
      : reason.startsWith("token_") || reason === "state_changed" ? 409
        : 400;
  return { status, body: { error: reason } };
}

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  return actual.length === keys.length && actual.every((key, index) => key === [...keys].sort()[index]);
}

function language(value: unknown): string | undefined {
  return typeof value === "string" && (LANGUAGES as readonly string[]).includes(value) ? value : undefined;
}

// Keep both preview entry points on one strict parser so native validation
// and JSON preview cannot drift on unknown keys or invalid language values.
function previewLanguage(body: unknown): string | LanguagePreferenceResult {
  if (!exactKeys(body, ["language"])) return { status: 400, body: { error: "invalid_request" } };
  const value = language(body.language);
  return value ?? refusal("invalid_value");
}

function token(value: unknown): ActionToken | undefined {
  if (!exactKeys(value, TOKEN_KEYS)) return undefined;
  return TOKEN_KEYS.every((key) => typeof value[key] === "string") ? value as unknown as ActionToken : undefined;
}

export function createLanguagePreference(ports: {
  readonly sessions: Pick<SessionStore, "get">;
  readonly store: LanguagePreferenceStore;
  readonly secret: SafeWriteSecret;
  readonly clock?: SafeWriteClock;
}): LanguagePreference {
  // Fail at construction, not on the first request, if the key is too short.
  // The inert store is never called: building only validates the secret.
  buildSafeWrite({ store: INERT_STORE, secret: ports.secret, policy: LANGUAGE_POLICY });

  async function principal(sessionId: string | undefined): Promise<string | undefined> {
    const session = sessionId ? await ports.sessions.get(sessionId) : undefined;
    return session?.personId;
  }

  function writer(principalId: string): SafeWriteImplementation {
    return buildSafeWrite({
      store: ports.store.forPrincipal(principalId), secret: ports.secret, policy: LANGUAGE_POLICY,
      ...(ports.clock ? { clock: ports.clock } : {}),
    });
  }

  return {
    // Native POST validates the request before redirecting, without issuing a
    // throwaway token. The GET review reauthenticates and previews current state.
    async validatePreview(sessionId, body) {
      const principalId = await principal(sessionId);
      if (!principalId) return { status: 401, body: { error: "unauthorized" } };
      const value = previewLanguage(body);
      if (typeof value !== "string") return value;
      return { status: 200, body: { language: value } };
    },

    async preview(sessionId, body) {
      const principalId = await principal(sessionId);
      if (!principalId) return { status: 401, body: { error: "unauthorized" } };
      const value = previewLanguage(body);
      if (typeof value !== "string") return value;
      const result = await writer(principalId).preview({
        principalRef: safeWritePrincipalRef(principalId),
        change: { personRef: personRecordRef(principalId), field: LANGUAGE_FIELD, value },
      });
      if (!result.ok) return refusal(result.reason);
      return { status: 200, body: { changes: result.changes, token: result.token } };
    },

    async confirm(sessionId, body) {
      const principalId = await principal(sessionId);
      if (!principalId) return { status: 401, body: { error: "unauthorized" } };
      if (!exactKeys(body, ["language", "token"])) return { status: 400, body: { error: "invalid_request" } };
      const value = language(body.language);
      if (!value) return refusal("invalid_value");
      const actionToken = token(body.token);
      if (!actionToken) return refusal("token_not_issued");
      const result = await writer(principalId).confirm({
        principalRef: safeWritePrincipalRef(principalId),
        token: actionToken,
        change: { personRef: personRecordRef(principalId), field: LANGUAGE_FIELD, value },
      });
      if (!result.ok) return refusal(result.reason);
      return { status: 200, body: { receipt: result.receipt } };
    },

    async receipt(sessionId, receiptRef) {
      const principalId = await principal(sessionId);
      if (!principalId) return { status: 401, body: { error: "unauthorized" } };
      const receipt = await ports.store.readReceipt(principalId, receiptRef);
      // Another person's receipt and no receipt at all are the same answer.
      if (!receipt) return { status: 404, body: { error: "receipt_not_found" } };
      return { status: 200, body: { receipt } };
    },
  };
}

const PREVIEW = "/profile/language/preview";
const CONFIRM = "/profile/language/confirm";
const RECEIPT = /^\/profile\/receipts\/([0-9a-f]{64})$/;
const BODY_LIMIT = 4096;

function sessionCookie(header: string | undefined): string | undefined {
  for (const item of header?.split(";") ?? []) {
    const [key, ...value] = item.trim().split("=");
    const candidate = value.join("=");
    if (key === "__Host-studenthub_session" && /^[A-Za-z0-9_-]{43}$/.test(candidate)) return candidate;
  }
  return undefined;
}

async function readJson(request: IncomingMessage): Promise<{ ok: true; value: unknown } | { ok: false }> {
  if (Number(request.headers["content-length"]) > BODY_LIMIT) { request.resume(); return { ok: false }; }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk);
    size += bytes.length;
    if (size > BODY_LIMIT) { request.resume(); return { ok: false }; }
    chunks.push(bytes);
  }
  try {
    return { ok: true, value: JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown };
  } catch {
    return { ok: false };
  }
}

/**
 * Mounted by createGatewayServer. Returns false for any other path. Writes are
 * same-origin JSON only: the exact configured Origin is required, and Host or
 * forwarded headers are never authority.
 */
export async function handleLanguagePreference(
  request: IncomingMessage,
  response: ServerResponse,
  service: LanguagePreference | undefined,
  origin: string | undefined,
): Promise<boolean> {
  const path = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
  const receiptRef = RECEIPT.exec(path)?.[1];
  if (path !== PREVIEW && path !== CONFIRM && receiptRef === undefined) return false;
  const send = (result: LanguagePreferenceResult): void => {
    response.writeHead(result.status, {
      "content-type": "application/json", "cache-control": "no-store",
      "x-content-type-options": "nosniff", "referrer-policy": "no-referrer",
    });
    response.end(JSON.stringify(result.body));
  };
  try {
    if (!service || !origin) { send({ status: 503, body: { error: "safe_write_unavailable" } }); return true; }
    const sessionId = sessionCookie(request.headers.cookie);
    if (receiptRef !== undefined) {
      if (request.method !== "GET") { send({ status: 404, body: { error: "not_found" } }); return true; }
      send(await service.receipt(sessionId, receiptRef));
      return true;
    }
    if (request.method !== "POST") { send({ status: 404, body: { error: "not_found" } }); return true; }
    if (request.headers.origin !== origin || request.headers["sec-fetch-site"] === "cross-site") {
      request.resume();
      send({ status: 403, body: { error: "origin_rejected" } });
      return true;
    }
    if (request.headers["content-type"] !== "application/json") {
      request.resume();
      send({ status: 400, body: { error: "invalid_request" } });
      return true;
    }
    const body = await readJson(request);
    if (!body.ok) { send({ status: 400, body: { error: "invalid_request" } }); return true; }
    send(path === PREVIEW ? await service.preview(sessionId, body.value) : await service.confirm(sessionId, body.value));
  } catch {
    // Dependency messages never reach the client.
    if (!response.headersSent) send({ status: 503, body: { error: "safe_write_unavailable" } });
    else response.destroy();
  }
  return true;
}

const FORM_PREVIEW = "/profile/language/preview";
const FORM_CONFIRM = "/profile/language/confirm";
const FORM_REVIEW = "/profile/language/review";
export type LanguagePreferencePageWriter = (status: number, title: string, body: string, language: ProfileLanguage, historyGuard?: boolean) => void;

const ENGLISH_PAGE_COPY = {
  title: "Language preference",
  reviewTitle: "Review language",
  reviewHeading: "Review language change",
  language: "Language",
  english: "English",
  arabic: "Arabic",
  unavailable: "Unavailable",
  confirm: "Confirm change",
  cancel: "Cancel",
  back: "Back to My profile",
  notChanged: "Your language wasn’t changed.",
  conflict: "Your profile changed while you were reviewing. Open it again and retry.",
  serviceUnavailable: "The profile service is unavailable. Please try again in a moment.",
  noLongerAvailable: "This change is no longer available.",
  signIn: "Sign in again to continue safely.",
  sessionEnded: "Your session may have ended. Open your profile to sign in again.",
  unknownHeading: "Your language change wasn’t confirmed.",
  unknownOutcome: "We couldn’t confirm whether your language was changed. Open your profile to check before trying again.",
} as const;

const LANGUAGE_PAGE_COPY: Readonly<Record<ProfileLanguage, Readonly<Record<keyof typeof ENGLISH_PAGE_COPY, string>>>> = {
  en: ENGLISH_PAGE_COPY,
  ar: {
    title: "تفضيل اللغة",
    reviewTitle: "مراجعة اللغة",
    reviewHeading: "مراجعة تغيير اللغة",
    language: "اللغة",
    english: "الإنجليزية",
    arabic: "العربية",
    unavailable: "غير متاح",
    confirm: "تأكيد التغيير",
    cancel: "إلغاء",
    back: "العودة إلى ملفي الشخصي",
    notChanged: "لم يتم تغيير لغتك.",
    conflict: "تغيّر ملفك الشخصي أثناء المراجعة. افتحه مجددًا وأعد المحاولة.",
    serviceUnavailable: "خدمة الملف الشخصي غير متاحة. يرجى المحاولة مجددًا بعد قليل.",
    noLongerAvailable: "لم يعد هذا التغيير متاحًا.",
    signIn: "سجّل الدخول مجددًا للمتابعة بأمان.",
    sessionEnded: "ربما انتهت جلستك. افتح ملفك الشخصي لتسجيل الدخول مجددًا.",
    unknownHeading: "لم يتم تأكيد تغيير اللغة.",
    unknownOutcome: "تعذّر التأكد مما إذا كانت لغتك قد تغيّرت. افتح ملفك الشخصي للتحقق قبل المحاولة مجددًا.",
  },
};

function html(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

async function readForm(request: IncomingMessage, allowed: readonly string[]): Promise<Record<string, string> | undefined> {
  if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")
    || Number(request.headers["content-length"]) > BODY_LIMIT) { request.resume(); return undefined; }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > BODY_LIMIT) { request.resume(); return undefined; }
    chunks.push(bytes);
  }
  const result: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString("utf8"))) {
    if (!allowed.includes(key) || Object.hasOwn(result, key)) return undefined;
    result[key] = value;
  }
  return Object.keys(result).length === allowed.length ? result : undefined;
}

function pageError(write: LanguagePreferencePageWriter, status: number, locale: ProfileLanguage = "en", unknownOutcome = false): void {
  const copy = LANGUAGE_PAGE_COPY[locale];
  const heading = unknownOutcome ? copy.unknownHeading : status === 401 ? copy.signIn : copy.notChanged;
  const message = unknownOutcome ? copy.unknownOutcome : status === 401 ? copy.sessionEnded
    : status === 409 ? copy.conflict : status === 503 ? copy.serviceUnavailable : copy.noLongerAvailable;
  // The gateway retains its existing sign-in page for the initial English 401.
  write(status, copy.title, status === 401 && locale === "en" ? "" : `<main id="main" class="error-page"><h1>${html(heading)}</h1><p>${html(message)}</p><a class="button primary" href="/profile">${html(copy.back)}</a></main>`, locale);
}

/** Native browser flow; all preview and commit decisions remain in the JSON service. */
export async function handleLanguagePreferencePage(
  request: IncomingMessage, response: ServerResponse, service: LanguagePreference | undefined,
  origin: string | undefined, write: LanguagePreferencePageWriter,
  shownLanguage?: (sessionId: string | undefined) => Promise<string | undefined>,
): Promise<boolean> {
  const url = new URL(request.url ?? "/", "http://gateway.invalid");
  const path = url.pathname;
  if (path === FORM_REVIEW) {
    // A replayable GET navigation carries only the closed target value, never
    // an action token. Every visit revalidates the session and current profile.
    response.setHeader("cache-control", "no-store");
    if (request.method !== "GET") { request.resume(); pageError(write, 404); return true; }
    const parameters = [...url.searchParams];
    const target = parameters.length === 1 && parameters[0]?.[0] === "language"
      ? language(parameters[0][1]) : undefined;
    const sessionId = sessionCookie(request.headers.cookie);
    let before: ProfileLanguage | undefined;
    let shownLanguageFailed = false;
    try {
      if (sessionId) {
        try {
          const shown = await shownLanguage?.(sessionId);
          if (shown === "en" || shown === "ar") before = shown;
        } catch { shownLanguageFailed = true; }
      }
      const locale: ProfileLanguage = before ?? "en";
      // Trusted locale applies to refusals too; lookup failures must not hide
      // malformed input, unavailable configuration, or service authorization.
      if (!target) { pageError(write, 400, locale); return true; }
      if (!service || !origin) { pageError(write, 503, locale); return true; }
      const result = await service.preview(sessionId, { language: target });
      if (result.status !== 200) { pageError(write, result.status, locale); return true; }
      if (shownLanguageFailed) { pageError(write, 503, locale); return true; }
      const body = result.body as { changes: readonly FieldChange[]; token: ActionToken };
      const copy = LANGUAGE_PAGE_COPY[locale];
      if (before === target || body.changes.some((change) => change.field === LANGUAGE_FIELD && change.before === target)) {
        write(200, copy.title, `<main id="main" class="profile-main"><h1>${html(copy.notChanged)}</h1><a class="button primary" href="/profile">${html(copy.back)}</a></main>`, locale);
        return true;
      }
      const hidden = TOKEN_KEYS.map((key) => `<input type="hidden" name="token.${key}" value="${html(body.token[key as keyof ActionToken])}">`).join("");
      // Language codes are a closed enum, not person-supplied display text.
      // Unknown values never become interface copy, HTML, or document metadata.
      const label = (value: string | undefined) => html(value === "en" ? copy.english : value === "ar" ? copy.arabic : copy.unavailable);
      write(200, copy.reviewTitle, `<main id="main" class="profile-main"><h1>${html(copy.reviewHeading)}<span class="accent">.</span></h1><p>${html(copy.language)}: <strong>${label(before)}</strong> ${locale === "ar" ? "←" : "→"} <strong>${label(target)}</strong></p><form method="post" action="${FORM_CONFIRM}"><input type="hidden" name="language" value="${html(target)}">${hidden}<button class="button primary" type="submit">${html(copy.confirm)}</button></form><a class="text-link" href="/profile">${html(copy.cancel)}</a></main>`, locale, true);
    } catch { if (!response.headersSent) pageError(write, 503, before ?? "en"); else response.destroy(); }
    return true;
  }
  if (path !== FORM_PREVIEW && path !== FORM_CONFIRM) return false;
  // These URLs are shared with the JSON API. Only native browser form posts
  // belong to this adapter; JSON continues to the existing route unchanged.
  if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) return false;
  if (request.method !== "POST") { pageError(write, 404); return true; }
  const sessionId = sessionCookie(request.headers.cookie);
  let before: ProfileLanguage | undefined;
  // Only the session-authorized own-profile projection selects interface copy.
  // Neither the proposed new language nor browser preferences are authority.
  // A failed lookup must not mask service errors or change a redirect.
  // Review GET checks its own fresh lookup before rendering a successful preview.
  if (sessionId && origin && request.headers.origin === origin && request.headers["sec-fetch-site"] !== "cross-site") {
    try {
      const shown = await shownLanguage?.(sessionId);
      if (shown === "en" || shown === "ar") before = shown;
    } catch { /* The authorized service result remains authoritative. */ }
  }
  const locale: ProfileLanguage = before ?? "en";
  const fail = (status: number, unknownOutcome = false) => pageError(write, status, locale, unknownOutcome);
  if (!service || !origin) { fail(503); return true; }
  if (request.headers.origin !== origin || request.headers["sec-fetch-site"] === "cross-site") { request.resume(); fail(403); return true; }
  let confirming = false;
  try {
    if (path === FORM_PREVIEW) {
      const values = await readForm(request, ["language"]); if (!values) { fail(400); return true; }
      const result = await service.validatePreview(sessionId, { language: values.language });
      if (result.status !== 200) { fail(result.status); return true; }
      // Even an injected service cannot turn the redirect into an open target.
      const target = language(values.language);
      if (!target) { fail(400); return true; }
      response.writeHead(303, { location: `${FORM_REVIEW}?language=${target}`, "cache-control": "no-store" });
      response.end();
      return true;
    }
    const names = ["language", ...TOKEN_KEYS.map((key) => `token.${key}`)];
    const values = await readForm(request, names); if (!values) { fail(400); return true; }
    const actionToken = Object.fromEntries(TOKEN_KEYS.map((key) => [key, values[`token.${key}`]]));
    confirming = true;
    const result = await service.confirm(sessionId, { language: values.language, token: actionToken });
    if (result.status !== 200) { fail(result.status, result.status === 503); return true; }
    response.writeHead(303, { location: "/profile", "cache-control": "no-store" }); response.end(); return true;
  } catch { if (!response.headersSent) fail(503, confirming); else response.destroy(); return true; }
}
