import type { IncomingMessage, ServerResponse } from "node:http";

import type { SessionStore } from "@studenthub/login-contract";
import type {
  ActionToken, Receipt, RejectionReason, SafeWriteClock, SafeWriteSecret, SafeWriteStore,
} from "@studenthub/safe-write-contract";
import {
  BANK_DETAILS_FIELD, BankDetailError, bankDetailsPrincipalRef, bankDetailsRecordRef, bankDetailsValue,
  buildBankDetailsWrite, catalogueBankDetailsCheck, normalizeBankDetails, parseBankDetailsValue,
  type BankDetails, type FinanceReferenceResolver,
} from "@studenthub/pay-contracts";

/**
 * SHU-182 (F1): a signed-in candidate changes their own bank details through
 * the SHU-82 preview → confirm → receipt contract. The session decides whose
 * details change; the body carries only the new bank, IBAN and beneficiary
 * name, and at confirm the token the preview issued.
 */
export interface BankDetailsStore {
  forPrincipal(principalId: string): SafeWriteStore;
  readReceipt(principalId: string, receiptRef: string): Promise<Receipt | null>;
}

export type BankDetailsResult =
  | { readonly status: 200; readonly body: unknown }
  | { readonly status: 400 | 401 | 403 | 404 | 409 | 503; readonly body: { readonly error: string } };

export interface BankDetailsService {
  preview(sessionId: string | undefined, body: unknown): Promise<BankDetailsResult>;
  confirm(sessionId: string | undefined, body: unknown): Promise<BankDetailsResult>;
  receipt(sessionId: string | undefined, receiptRef: string): Promise<BankDetailsResult>;
}

const DETAIL_KEYS = ["bankId", "beneficiaryName", "iban"];
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

function refusal(reason: RejectionReason): BankDetailsResult {
  const status = reason === "not_own_record" ? 403
    : reason === "receipt_failed" ? 503
      : reason.startsWith("token_") || reason === "state_changed" ? 409
        : 400;
  return { status, body: { error: reason } };
}

/** The typed input error, so a form can say which part is wrong. */
function details(raw: Record<string, unknown>): { ok: true; value: BankDetails } | { ok: false; result: BankDetailsResult } {
  try {
    return { ok: true, value: normalizeBankDetails({ bankId: raw.bankId, iban: raw.iban, beneficiaryName: raw.beneficiaryName }) };
  } catch (error) {
    if (error instanceof BankDetailError && error.status === 400) return { ok: false, result: { status: 400, body: { error: error.code } } };
    throw error;
  }
}

/** The person's own details, shown back to them as a typed object rather than the stored JSON. */
function shown(value: string | null): BankDetails | null {
  if (value === null) return null;
  const parsed = parseBankDetailsValue(value);
  if (!parsed) throw new Error("unreadable bank details value");
  return parsed;
}

export function createBankDetails(ports: {
  readonly sessions: Pick<SessionStore, "get">;
  readonly store: BankDetailsStore;
  readonly banks: FinanceReferenceResolver;
  readonly secret: SafeWriteSecret;
  readonly clock?: SafeWriteClock;
}): BankDetailsService {
  const check = catalogueBankDetailsCheck(ports.banks);
  const writer = (principalId: string) => buildBankDetailsWrite({
    store: ports.store.forPrincipal(principalId), secret: ports.secret, check,
    ...(ports.clock ? { clock: ports.clock } : {}),
  });
  // Fail at construction, not on the first request, if the key is too short.
  buildBankDetailsWrite({
    store: { readField: () => null, ownedRecord: () => null, commit: () => ({ ok: false, reason: "not_own_record" }) },
    secret: ports.secret, check,
  });

  async function principal(sessionId: string | undefined): Promise<string | undefined> {
    const session = sessionId ? await ports.sessions.get(sessionId) : undefined;
    return session?.personId;
  }

  return {
    async preview(sessionId, body) {
      const principalId = await principal(sessionId);
      if (!principalId) return { status: 401, body: { error: "unauthorized" } };
      if (!exactKeys(body, DETAIL_KEYS)) return { status: 400, body: { error: "invalid_request" } };
      const input = details(body);
      if (!input.ok) return input.result;
      const result = await writer(principalId).preview({
        principalRef: bankDetailsPrincipalRef(principalId),
        change: { personRef: bankDetailsRecordRef(principalId), field: BANK_DETAILS_FIELD, value: bankDetailsValue(input.value) },
      });
      if (!result.ok) return refusal(result.reason);
      const change = result.changes[0]!;
      return { status: 200, body: { before: shown(change.before), after: shown(change.after), token: result.token } };
    },

    async confirm(sessionId, body) {
      const principalId = await principal(sessionId);
      if (!principalId) return { status: 401, body: { error: "unauthorized" } };
      if (!exactKeys(body, [...DETAIL_KEYS, "token"])) return { status: 400, body: { error: "invalid_request" } };
      const input = details(body);
      if (!input.ok) return input.result;
      const actionToken = token(body.token);
      if (!actionToken) return refusal("token_not_issued");
      const result = await writer(principalId).confirm({
        principalRef: bankDetailsPrincipalRef(principalId),
        token: actionToken,
        change: { personRef: bankDetailsRecordRef(principalId), field: BANK_DETAILS_FIELD, value: bankDetailsValue(input.value) },
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

const PREVIEW = "/candidate/bank-details/preview";
const CONFIRM = "/candidate/bank-details/confirm";
const RECEIPT = /^\/candidate\/bank-details\/receipts\/([0-9a-f]{64})$/;
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
 * same-origin JSON only, as for the language preference.
 */
export async function handleBankDetails(
  request: IncomingMessage,
  response: ServerResponse,
  service: BankDetailsService | undefined,
  origin: string | undefined,
): Promise<boolean> {
  const path = new URL(request.url ?? "/", "http://gateway.invalid").pathname;
  const receiptRef = RECEIPT.exec(path)?.[1];
  if (path !== PREVIEW && path !== CONFIRM && receiptRef === undefined) return false;
  const send = (result: BankDetailsResult): void => {
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
    // Dependency messages, and the bank details themselves, never reach an error body.
    if (!response.headersSent) send({ status: 503, body: { error: "safe_write_unavailable" } });
    else response.destroy();
  }
  return true;
}
