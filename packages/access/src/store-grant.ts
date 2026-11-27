import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import { mayOpenAccessAdmin, type HeldGrant } from "./grant-catalogue.js";
import { accessCallerRef, GRANT_TOKEN_TTL_MS, REASON_MAX, REASON_MIN, type GrantToken } from "./grant-change.js";
import { mayManageStoreAccess } from "./store-access.js";

/**
 * Access lane G-02: store manager access given or taken away on the Access
 * pages, for one person and one store, through the same preview and
 * single-use confirm as a role change.
 *
 * The grant is the A4 store_manager_access row, never a row of grants, so it
 * adds no role and no scope. Who may change it is the A4 rule
 * (mayManageStoreAccess) re-read at commit time, and only from the Access
 * pages (mayOpenAccessAdmin), so a company owner keeps using the team page.
 */

export type StoreGrantAction = "grant" | "revoke";

export interface StoreGrantRequest {
  readonly targetPrincipalId: string;
  readonly storeId: string;
  readonly action: StoreGrantAction;
  readonly reason: string;
}

const ID = /^[A-Za-z0-9@._:+-]{1,256}$/;
const STORE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** Validates untrusted form fields into a store change, or undefined. */
export function parseStoreGrant(raw: Readonly<Record<string, unknown>>): StoreGrantRequest | undefined {
  const { targetPrincipalId, storeId, action, reason } = raw;
  if (typeof targetPrincipalId !== "string" || !ID.test(targetPrincipalId)) return undefined;
  if (typeof storeId !== "string" || !STORE_ID.test(storeId)) return undefined;
  if (action !== "grant" && action !== "revoke") return undefined;
  if (typeof reason !== "string") return undefined;
  const trimmed = reason.trim().replace(/\r\n?/g, "\n");
  const length = [...trimmed].length;
  if (length < REASON_MIN || length > REASON_MAX) return undefined;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) return undefined;
  return Object.freeze({ targetPrincipalId, storeId, action, reason: trimmed });
}

export const STORE_GRANT_REFUSALS = [
  "self_change",
  "unknown_person",
  "unknown_store",
  "not_allowed",
  "not_held",
  "paused",
  "token_invalid",
  "token_expired",
  "token_already_used",
  "state_changed",
] as const;
export type StoreGrantRefusal = (typeof STORE_GRANT_REFUSALS)[number];

/** Everything the decision needs, read in one place (inside the transaction for a write). */
export interface StoreGrantSnapshot {
  readonly callerGrants: readonly HeldGrant[];
  readonly targetExists: boolean;
  /** The store with its company, or null when there is no active store of a live company. */
  readonly store: null | { readonly storeId: string; readonly name: string; readonly orgId: string; readonly orgName: string; readonly orgAncestors: readonly string[] };
  /** Whether the target holds live manager access to this store now. */
  readonly held: boolean;
  /** Whether the target's access is paused now: nothing is given while paused (A6). */
  readonly paused: boolean;
}

export type StoreGrantDecision =
  | { readonly kind: "refused"; readonly reason: StoreGrantRefusal }
  | { readonly kind: "unchanged" }
  | { readonly kind: "apply"; readonly before: boolean; readonly after: boolean };

export function decideStoreGrant(
  callerId: string,
  request: StoreGrantRequest,
  snapshot: StoreGrantSnapshot,
  operatorOrgIds: readonly string[] = DEFAULT_OPERATOR_ORG_IDS,
): StoreGrantDecision {
  const refuse = (reason: StoreGrantRefusal): StoreGrantDecision => ({ kind: "refused", reason });
  if (request.targetPrincipalId === callerId) return refuse("self_change");
  if (!mayOpenAccessAdmin(snapshot.callerGrants, operatorOrgIds)) return refuse("not_allowed");
  if (!snapshot.targetExists) return refuse("unknown_person");
  if (!snapshot.store) return refuse("unknown_store");
  if (!mayManageStoreAccess(snapshot.callerGrants, snapshot.store.orgId, snapshot.store.orgAncestors)) return refuse("not_allowed");
  if (request.action === "grant") {
    if (snapshot.held) return { kind: "unchanged" };
    return snapshot.paused ? refuse("paused") : { kind: "apply", before: false, after: true };
  }
  return snapshot.held ? { kind: "apply", before: true, after: false } : refuse("not_held");
}

// --- Single-use token -------------------------------------------------------
// The same token shape as a role change, under its own domain, so a store
// token never verifies as a role token or the other way round. `before` is
// "self" when the person held the store access and "none" when not.

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

/** Digest of the exact store change a person reviewed, reason included. */
export function storeGrantDigest(request: StoreGrantRequest): string {
  return sha256(JSON.stringify(["access-store-grant-change:v1", request.targetPrincipalId, request.storeId, request.action, request.reason]));
}

function storeTokenMac(secret: Buffer, token: Omit<GrantToken, "mac">): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(["access-store-grant-token:v1", token.tokenId, token.callerRef, token.changeDigest,
      token.before, token.issuedAt, token.expiresAt]))
    .digest("hex");
}

export function issueStoreGrantToken(input: {
  readonly secret: Buffer;
  readonly callerId: string;
  readonly request: StoreGrantRequest;
  readonly held: boolean;
  readonly now: Date;
  readonly entropy?: (length: number) => Buffer;
}): GrantToken {
  const body = {
    tokenId: (input.entropy ?? randomBytes)(32).toString("hex"),
    callerRef: accessCallerRef(input.callerId),
    changeDigest: storeGrantDigest(input.request),
    before: input.held ? "self" : "none",
    issuedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + GRANT_TOKEN_TTL_MS).toISOString(),
  } satisfies Omit<GrantToken, "mac">;
  return Object.freeze({ ...body, mac: storeTokenMac(input.secret, body) });
}

/** Issued by us, to this caller, for exactly this store change, and not expired. Single use is the store's. */
export function verifyStoreGrantToken(input: {
  readonly secret: Buffer;
  readonly token: GrantToken;
  readonly callerId: string;
  readonly request: StoreGrantRequest;
  readonly now: Date;
}): { readonly ok: true; readonly held: boolean } | { readonly ok: false; readonly reason: "token_invalid" | "token_expired" } {
  const { token } = input;
  const expected = Buffer.from(storeTokenMac(input.secret, token), "hex");
  const given = Buffer.from(token.mac, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "token_invalid" };
  if (token.callerRef !== accessCallerRef(input.callerId)) return { ok: false, reason: "token_invalid" };
  if (token.changeDigest !== storeGrantDigest(input.request)) return { ok: false, reason: "token_invalid" };
  if (token.before !== "none" && token.before !== "self") return { ok: false, reason: "token_invalid" };
  const expires = Date.parse(token.expiresAt);
  if (!Number.isFinite(expires) || input.now.getTime() >= expires) return { ok: false, reason: "token_expired" };
  return { ok: true, held: token.before === "self" };
}

// --- Service ------------------------------------------------------------------

export interface StoreGrantWriteStore {
  storeSnapshot(callerId: string, request: StoreGrantRequest): Promise<StoreGrantSnapshot>;
  applyStore(input: {
    readonly callerId: string;
    readonly request: StoreGrantRequest;
    readonly tokenId: string;
    readonly expectedHeld: boolean;
    readonly decide: (snapshot: StoreGrantSnapshot) => StoreGrantDecision;
    readonly expiresAt: number;
    readonly now: () => number;
  }): Promise<StoreGrantOutcome>;
}

export type StoreGrantOutcome =
  | { readonly kind: "applied"; readonly before: boolean; readonly after: boolean }
  | { readonly kind: "unchanged" }
  | { readonly kind: "refused"; readonly reason: StoreGrantRefusal };

export type StoreGrantPreview =
  | { readonly ok: true; readonly kind: "unchanged"; readonly store: NonNullable<StoreGrantSnapshot["store"]> }
  | { readonly ok: true; readonly kind: "change"; readonly before: boolean; readonly after: boolean; readonly token: GrantToken; readonly store: NonNullable<StoreGrantSnapshot["store"]> }
  | { readonly ok: false; readonly reason: StoreGrantRefusal };

export interface StoreGrantService {
  preview(callerId: string, request: StoreGrantRequest): Promise<StoreGrantPreview>;
  confirm(callerId: string, request: StoreGrantRequest, token: GrantToken): Promise<StoreGrantOutcome>;
}

export function createStoreGrantService(options: {
  readonly store: StoreGrantWriteStore;
  readonly secret: Buffer;
  readonly now?: () => Date;
  readonly entropy?: (length: number) => Buffer;
  readonly operatorOrgIds?: readonly string[];
}): StoreGrantService {
  const now = options.now ?? (() => new Date());
  const operatorOrgIds = options.operatorOrgIds ?? DEFAULT_OPERATOR_ORG_IDS;
  return {
    async preview(callerId, request) {
      const snapshot = await options.store.storeSnapshot(callerId, request);
      const decision = decideStoreGrant(callerId, request, snapshot, operatorOrgIds);
      if (decision.kind === "refused") return { ok: false, reason: decision.reason };
      const store = snapshot.store!;
      if (decision.kind === "unchanged") return { ok: true, kind: "unchanged", store };
      const token = issueStoreGrantToken({
        secret: options.secret, callerId, request, held: decision.before, now: now(),
        ...(options.entropy ? { entropy: options.entropy } : {}),
      });
      return { ok: true, kind: "change", before: decision.before, after: decision.after, token, store };
    },
    async confirm(callerId, request, token) {
      const verified = verifyStoreGrantToken({ secret: options.secret, token, callerId, request, now: now() });
      if (!verified.ok) return { kind: "refused", reason: verified.reason };
      return options.store.applyStore({
        callerId, request, tokenId: token.tokenId, expectedHeld: verified.held,
        decide: (snapshot) => decideStoreGrant(callerId, request, snapshot, operatorOrgIds),
        expiresAt: Date.parse(token.expiresAt),
        now: () => now().getTime(),
      });
    },
  };
}

/** A store as the Access pages find it: active, of a live company. */
export interface AccessStore {
  readonly storeId: string;
  readonly name: string;
  readonly orgId: string;
  readonly orgName: string;
}

export interface AccessStoreReads {
  /** Active stores of live companies whose name starts with the query, at most 25. */
  findStores(query: string): Promise<readonly AccessStore[]>;
  /** The store manager access a person holds now. */
  storeGrants(principalId: string): Promise<readonly AccessStore[]>;
}
