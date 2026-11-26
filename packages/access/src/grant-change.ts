import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { isGrantScope, isRole, type GrantScope, type Role } from "@studenthub/contracts";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import { catalogueAllows, grantCatalogue, isOperatorOrg, mayOpenAccessAdmin, type HeldGrant } from "./grant-catalogue.js";

/**
 * Access lane A1: one grant change (give or take away one role on one
 * organization), its decision, and the single-use token between the preview
 * a person reads and the confirm they press.
 */

export type GrantAction = "grant" | "revoke";

export interface GrantChangeRequest {
  readonly targetPrincipalId: string;
  readonly orgId: string;
  readonly role: Role;
  readonly scope: GrantScope;
  readonly action: GrantAction;
  readonly reason: string;
}

export const REASON_MIN = 3;
export const REASON_MAX = 500;
export const GRANT_TOKEN_TTL_MS = 15 * 60 * 1000;
const ID = /^[A-Za-z0-9@._:+-]{1,256}$/;

/** Validates untrusted form fields into a change request, or undefined. */
export function parseGrantChange(raw: Readonly<Record<string, unknown>>): GrantChangeRequest | undefined {
  const { targetPrincipalId, orgId, role, scope, action, reason } = raw;
  if (typeof targetPrincipalId !== "string" || !ID.test(targetPrincipalId)) return undefined;
  if (typeof orgId !== "string" || !ID.test(orgId)) return undefined;
  if (!isRole(role) || !isGrantScope(scope)) return undefined;
  if (action !== "grant" && action !== "revoke") return undefined;
  if (typeof reason !== "string") return undefined;
  const trimmed = reason.trim().replace(/\r\n?/g, "\n");
  const length = [...trimmed].length;
  if (length < REASON_MIN || length > REASON_MAX) return undefined;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) return undefined;
  return Object.freeze({ targetPrincipalId, orgId, role, scope, action, reason: trimmed });
}

export const GRANT_REFUSALS = [
  "self_change",
  "unknown_person",
  "unknown_organization",
  "not_allowed",
  "not_held",
  "last_admin",
  "token_invalid",
  "token_expired",
  "token_already_used",
  "state_changed",
] as const;
export type GrantRefusal = (typeof GRANT_REFUSALS)[number];

/** Everything the decision needs, read in one place (inside the transaction for a write). */
export interface GrantSnapshot {
  readonly callerGrants: readonly HeldGrant[];
  readonly targetExists: boolean;
  readonly orgLive: boolean;
  readonly orgAncestors: readonly string[];
  /** Scope of the target's current grant for (org, role), or null. */
  readonly current: GrantScope | null;
  /** Number of admin grants held directly on the organization. */
  readonly adminCount: number;
  /** G-02: every grant the target holds, read with `current` and `orgAncestors`, for the review page's effect. */
  readonly targetGrants?: readonly HeldGrant[];
}

export type GrantDecision =
  | { readonly kind: "refused"; readonly reason: GrantRefusal }
  | { readonly kind: "unchanged" }
  | { readonly kind: "apply"; readonly before: GrantScope | null; readonly after: GrantScope | null };

export function decideGrantChange(
  callerId: string,
  request: GrantChangeRequest,
  snapshot: GrantSnapshot,
  operatorOrgIds: readonly string[] = DEFAULT_OPERATOR_ORG_IDS,
): GrantDecision {
  const refuse = (reason: GrantRefusal): GrantDecision => ({ kind: "refused", reason });
  // No self-escalation, and no self-removal either: another admin does it.
  if (request.targetPrincipalId === callerId) return refuse("self_change");
  // The right to use the Access pages at all is re-read here, at commit time:
  // a company grant left over after the operator grant is gone grants nothing.
  if (!mayOpenAccessAdmin(snapshot.callerGrants, operatorOrgIds)) return refuse("not_allowed");
  if (!snapshot.targetExists) return refuse("unknown_person");
  if (!snapshot.orgLive) return refuse("unknown_organization");
  const options = grantCatalogue({
    callerGrants: snapshot.callerGrants,
    targetOrgId: request.orgId,
    targetAncestors: snapshot.orgAncestors,
    operatorOrgIds,
  });
  if (request.action === "grant") {
    if (!catalogueAllows(options, request.role, request.scope)) return refuse("not_allowed");
    // Already held at this scope or wider: nothing to do, nothing recorded.
    if (snapshot.current === request.scope || snapshot.current === "subtree") return { kind: "unchanged" };
    return { kind: "apply", before: snapshot.current, after: request.scope };
  }
  if (snapshot.current === null) return refuse("not_held");
  // Taking a grant away needs the same right as giving it at its current scope.
  if (!catalogueAllows(options, request.role, snapshot.current)) return refuse("not_allowed");
  if (request.role === "admin" && isOperatorOrg(request.orgId, operatorOrgIds) && snapshot.adminCount <= 1) {
    return refuse("last_admin");
  }
  return { kind: "apply", before: snapshot.current, after: null };
}

// --- Single-use token -------------------------------------------------------

export type GrantState = GrantScope | "none";

export interface GrantToken {
  readonly tokenId: string;
  readonly callerRef: string;
  readonly changeDigest: string;
  readonly before: GrantState;
  readonly issuedAt: string;
  readonly expiresAt: string;
  readonly mac: string;
}

export const GRANT_TOKEN_KEYS = ["tokenId", "callerRef", "changeDigest", "before", "issuedAt", "expiresAt", "mac"] as const;

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export function accessCallerRef(callerId: string): string {
  return sha256(`studenthub:access-caller:v1\0${callerId}`);
}

/** Digest of the exact change a person reviewed, reason included. */
export function grantChangeDigest(request: GrantChangeRequest): string {
  return sha256(JSON.stringify(["access-grant-change:v1", request.targetPrincipalId, request.orgId,
    request.role, request.scope, request.action, request.reason]));
}

function tokenMac(secret: Buffer, token: Omit<GrantToken, "mac">): string {
  return createHmac("sha256", secret)
    .update(JSON.stringify(["access-grant-token:v1", token.tokenId, token.callerRef, token.changeDigest,
      token.before, token.issuedAt, token.expiresAt]))
    .digest("hex");
}

export function issueGrantToken(input: {
  readonly secret: Buffer;
  readonly callerId: string;
  readonly request: GrantChangeRequest;
  readonly before: GrantScope | null;
  readonly now: Date;
  readonly entropy?: (length: number) => Buffer;
}): GrantToken {
  const tokenId = (input.entropy ?? randomBytes)(32).toString("hex");
  const body = {
    tokenId,
    callerRef: accessCallerRef(input.callerId),
    changeDigest: grantChangeDigest(input.request),
    before: input.before ?? "none",
    issuedAt: input.now.toISOString(),
    expiresAt: new Date(input.now.getTime() + GRANT_TOKEN_TTL_MS).toISOString(),
  } satisfies Omit<GrantToken, "mac">;
  return Object.freeze({ ...body, mac: tokenMac(input.secret, body) });
}

/** Parses untrusted token fields. */
export function parseGrantToken(raw: Readonly<Record<string, unknown>>): GrantToken | undefined {
  const values: Record<string, string> = {};
  for (const key of GRANT_TOKEN_KEYS) {
    const value = raw[key];
    if (typeof value !== "string" || value.length === 0 || value.length > 128) return undefined;
    values[key] = value;
  }
  if (!/^[0-9a-f]{64}$/.test(values.tokenId!) || !/^[0-9a-f]{64}$/.test(values.mac!)) return undefined;
  if (values.before !== "none" && values.before !== "self" && values.before !== "subtree") return undefined;
  return Object.freeze(values as unknown as GrantToken);
}

/**
 * Checks the token was issued by us, to this caller, for exactly this change,
 * and has not expired. Single use is enforced by the store, which records the
 * token id with the change in the same transaction.
 */
export function verifyGrantToken(input: {
  readonly secret: Buffer;
  readonly token: GrantToken;
  readonly callerId: string;
  readonly request: GrantChangeRequest;
  readonly now: Date;
}): { readonly ok: true; readonly before: GrantScope | null } | { readonly ok: false; readonly reason: "token_invalid" | "token_expired" } {
  const { token } = input;
  const expected = Buffer.from(tokenMac(input.secret, token), "hex");
  const given = Buffer.from(token.mac, "hex");
  if (expected.length !== given.length || !timingSafeEqual(expected, given)) return { ok: false, reason: "token_invalid" };
  if (token.callerRef !== accessCallerRef(input.callerId)) return { ok: false, reason: "token_invalid" };
  if (token.changeDigest !== grantChangeDigest(input.request)) return { ok: false, reason: "token_invalid" };
  const expires = Date.parse(token.expiresAt);
  if (!Number.isFinite(expires) || input.now.getTime() >= expires) return { ok: false, reason: "token_expired" };
  return { ok: true, before: token.before === "none" ? null : token.before };
}
