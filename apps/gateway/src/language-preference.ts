import type { IncomingMessage, ServerResponse } from "node:http";

import type { SessionStore } from "@studenthub/login-contract";
import {
  createSafeWrite,
  type ActionToken,
  type FieldPolicy,
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

/**
 * SHU-84: the platform's first write. A signed-in person changes their own
 * language preference through SHU-82's preview → confirm → receipt contract.
 *
 * Nothing here decides who is asking from the request body: the session does.
 * The body names only the new value and, at confirm, the token the preview
 * issued. Write authority is re-derived from principal existence by the store at
 * preview and again inside the commit.
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
    async preview(sessionId, body) {
      const principalId = await principal(sessionId);
      if (!principalId) return { status: 401, body: { error: "unauthorized" } };
      if (!exactKeys(body, ["language"])) return { status: 400, body: { error: "invalid_request" } };
      const value = language(body.language);
      if (!value) return refusal("invalid_value");
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

const FORM_PREVIEW = "/profile/language/preview-page";
const FORM_CONFIRM = "/profile/language/confirm-page";
export type LanguagePreferencePageWriter = (status: number, title: string, body: string) => void;
const escape = (value: string) => value.replace(/[&<>"']/g, c => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[c]!);
async function readForm(request: IncomingMessage, names: readonly string[]): Promise<Record<string,string> | undefined> {
  if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded") || Number(request.headers["content-length"]) > BODY_LIMIT) { request.resume(); return; }
  const chunks: Buffer[]=[]; let size=0;
  for await (const chunk of request.iterator({destroyOnReturn:false})) { const bytes=Buffer.from(chunk); size+=bytes.length; if(size>BODY_LIMIT){request.resume();return;} chunks.push(bytes); }
  const out: Record<string,string>={};
  for(const [key,value] of new URLSearchParams(Buffer.concat(chunks).toString("utf8"))){if(!names.includes(key)||Object.hasOwn(out,key))return;out[key]=value;}
  return Object.keys(out).length===names.length?out:undefined;
}

/** Browser form adapter: all decisions and writes delegate to preview/confirm above. */
export async function handleLanguagePreferencePage(request: IncomingMessage,response:ServerResponse,service:LanguagePreference|undefined,origin:string|undefined,write:LanguagePreferencePageWriter):Promise<boolean>{
  const path=new URL(request.url??"/","http://invalid").pathname;if(path!==FORM_PREVIEW&&path!==FORM_CONFIRM)return false;
  const fail=(status:number)=>write(status,"Language preference",`<main id="main" class="error-page"><h1>Your language wasn’t changed.</h1><p>${status===409?"Your profile changed while you were reviewing. Please try again.":"The change could not be completed. Please try again."}</p><a class="button primary" href="/profile">Back to profile</a></main>`);
  if(request.method!=="POST"){fail(404);return true}if(!service||!origin){fail(503);return true}if(request.headers.origin!==origin||request.headers["sec-fetch-site"]==="cross-site"){request.resume();fail(403);return true}
  try { const session=sessionCookie(request.headers.cookie);
    if(path===FORM_PREVIEW){const values=await readForm(request,["language"]);if(!values){fail(400);return true}const result=await service.preview(session,{language:values.language});if(result.status!==200){fail(result.status);return true}const body=result.body as {token:ActionToken;changes:readonly {before:unknown;after:unknown}[]};const hidden=TOKEN_KEYS.map(key=>`<input type="hidden" name="token.${key}" value="${escape(body.token[key as keyof ActionToken])}">`).join("");const change=body.changes[0]!;const label=(value:unknown)=>value==="en"?"English":value==="ar"?"العربية":"Unavailable";write(200,"Review language preference",`<main id="main" class="profile-main"><h1>Review language change<span class="accent">.</span></h1><p>Language: <strong>${label(change.before)}</strong> → <strong>${label(change.after)}</strong></p><form method="post" action="${FORM_CONFIRM}"><input type="hidden" name="language" value="${escape(values.language!)}">${hidden}<button class="button primary" type="submit">Confirm change</button></form><a class="text-link" href="/profile">Cancel</a></main>`);return true}
    const names=["language",...TOKEN_KEYS.map(key=>`token.${key}`)];const values=await readForm(request,names);if(!values){fail(400);return true}const actionToken=Object.fromEntries(TOKEN_KEYS.map(key=>[key,values[`token.${key}`]]));const result=await service.confirm(session,{language:values.language,token:actionToken});if(result.status!==200){fail(result.status);return true}response.writeHead(303,{location:"/profile","cache-control":"no-store"});response.end();return true;
  } catch {if(!response.headersSent)fail(503);else response.destroy();return true}
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
