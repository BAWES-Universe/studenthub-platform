import type { IncomingMessage, ServerResponse } from "node:http";

import type { SessionStore } from "@studenthub/login-contract";
import type {
  ActionToken, Receipt, RejectionReason, SafeWriteClock, SafeWriteSecret, SafeWriteStore,
} from "@studenthub/safe-write-contract";
import {
  buildSelfEditWrite, candidateProfileRecordRef, normalizeSelfEdit, selfEditValueCheck, SELF_EDIT_FIELDS,
  type AgeRule, type SelfEditField, type SelfEditReferences,
} from "@studenthub/profile";
import { principalAuditRef } from "@studenthub/db";

/**
 * SHU-143 (S2): a signed-in candidate changes one of their own profile fields
 * through the SHU-82 preview → confirm → receipt contract. The session decides
 * whose profile changes; the body carries only the field, its new value and, at
 * confirm, the token the preview issued.
 */
export interface CandidateProfileStore {
  forPrincipal(principalId: string): SafeWriteStore;
  referencesFor(principalId: string): SelfEditReferences;
  readReceipt(principalId: string, receiptRef: string): Promise<Receipt | null>;
}

export type CandidateProfileResult =
  | { readonly status: 200; readonly body: unknown }
  | { readonly status: 400 | 401 | 403 | 404 | 409 | 503; readonly body: { readonly error: string } };

export interface CandidateProfileService {
  preview(sessionId: string | undefined, body: unknown): Promise<CandidateProfileResult>;
  confirm(sessionId: string | undefined, body: unknown): Promise<CandidateProfileResult>;
  receipt(sessionId: string | undefined, receiptRef: string): Promise<CandidateProfileResult>;
}

const TOKEN_KEYS = ["changeSetDigest", "expectedBeforeDigest", "expiresAt", "issuedAt", "mac", "principalRef", "tokenId"];

function exactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function token(value: unknown): ActionToken | undefined {
  if (!exactKeys(value, TOKEN_KEYS)) return undefined;
  return TOKEN_KEYS.every((key) => typeof value[key] === "string") ? value as unknown as ActionToken : undefined;
}

function refusal(reason: RejectionReason): CandidateProfileResult {
  const status = reason === "not_own_record" ? 403
    : reason === "receipt_failed" ? 503
      : reason.startsWith("token_") || reason === "state_changed" ? 409
        : 400;
  return { status, body: { error: reason } };
}

const utcToday = () => new Date().toISOString().slice(0, 10);

export function createCandidateProfile(ports: {
  readonly sessions: Pick<SessionStore, "get">;
  readonly store: CandidateProfileStore;
  readonly secret: SafeWriteSecret;
  readonly ageRule?: AgeRule;
  readonly today?: () => string;
  readonly clock?: SafeWriteClock;
}): CandidateProfileService {
  const today = ports.today ?? utcToday;
  const check = (principalId: string) => selfEditValueCheck(ports.store.referencesFor(principalId), {
    today, ...(ports.ageRule ? { ageRule: ports.ageRule } : {}),
  });
  const writer = (principalId: string) => buildSelfEditWrite({
    store: ports.store.forPrincipal(principalId), secret: ports.secret, check: check(principalId),
    ...(ports.clock ? { clock: ports.clock } : {}),
  });
  // Fail at construction, not on the first request, if the key is too short or the age rule is malformed.
  selfEditValueCheck({ activeCatalogueItem: async () => false, available: async () => false }, {
    today, ...(ports.ageRule ? { ageRule: ports.ageRule } : {}),
  });
  buildSelfEditWrite({
    store: { readField: () => null, ownedRecord: () => null, commit: () => ({ ok: false, reason: "not_own_record" }) },
    secret: ports.secret, check: async () => undefined,
  });

  async function principal(sessionId: string | undefined): Promise<string | undefined> {
    const session = sessionId ? await ports.sessions.get(sessionId) : undefined;
    return session?.personId;
  }

  /** The canonical change, or the typed reason a form shows. Never echoes the value. */
  async function change(principalId: string, body: Record<string, unknown>):
    Promise<{ ok: true; field: SelfEditField; value: string } | { ok: false; result: CandidateProfileResult }> {
    const field = body.field;
    if (typeof field !== "string" || !(SELF_EDIT_FIELDS as readonly string[]).includes(field)) {
      return { ok: false, result: { status: 400, body: { error: "invalid_request" } } };
    }
    const value = normalizeSelfEdit(field as SelfEditField, body.value);
    if (value === undefined) return { ok: false, result: { status: 400, body: { error: "invalid_value" } } };
    const problem = await check(principalId)(field as SelfEditField, value);
    if (problem) return { ok: false, result: { status: problem === "already_taken" ? 409 : 400, body: { error: problem } } };
    return { ok: true, field: field as SelfEditField, value };
  }

  return {
    async preview(sessionId, body) {
      const principalId = await principal(sessionId);
      if (!principalId) return { status: 401, body: { error: "unauthorized" } };
      if (!exactKeys(body, ["field", "value"])) return { status: 400, body: { error: "invalid_request" } };
      const input = await change(principalId, body);
      if (!input.ok) return input.result;
      const result = await writer(principalId).preview({
        principalRef: principalAuditRef(principalId),
        change: { personRef: candidateProfileRecordRef(principalId), field: input.field, value: input.value },
      });
      if (!result.ok) return refusal(result.reason);
      return { status: 200, body: { changes: result.changes, token: result.token } };
    },

    async confirm(sessionId, body) {
      const principalId = await principal(sessionId);
      if (!principalId) return { status: 401, body: { error: "unauthorized" } };
      if (!exactKeys(body, ["field", "value", "token"])) return { status: 400, body: { error: "invalid_request" } };
      const input = await change(principalId, body);
      if (!input.ok) return input.result;
      const actionToken = token(body.token);
      if (!actionToken) return refusal("token_not_issued");
      const result = await writer(principalId).confirm({
        principalRef: principalAuditRef(principalId),
        token: actionToken,
        change: { personRef: candidateProfileRecordRef(principalId), field: input.field, value: input.value },
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

const PREVIEW = "/candidate/profile/preview";
const CONFIRM = "/candidate/profile/confirm";
const RECEIPT = /^\/candidate\/profile\/receipts\/([0-9a-f]{64})$/;
/** The introduction is up to 5,000 code points, up to four bytes each, plus the token. */
const BODY_LIMIT = 24_576;

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
 * same-origin JSON only, as for the language preference and bank details.
 */
export async function handleCandidateProfile(
  request: IncomingMessage,
  response: ServerResponse,
  service: CandidateProfileService | undefined,
  origin: string | undefined,
): Promise<boolean> {
  const path = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
  const receiptRef = RECEIPT.exec(path)?.[1];
  if (path !== PREVIEW && path !== CONFIRM && receiptRef === undefined) return false;
  const send = (result: CandidateProfileResult): void => {
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
    // Dependency messages and submitted values never reach an error body.
    if (!response.headersSent) send({ status: 503, body: { error: "safe_write_unavailable" } });
    else response.destroy();
  }
  return true;
}
