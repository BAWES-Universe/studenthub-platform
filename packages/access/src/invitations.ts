import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { isGrantScope, type GrantScope, type Role } from "@studenthub/contracts";
import { grantCovers, type GrantOption, type HeldGrant } from "./grant-catalogue.js";
import { STORE_MANAGER, decideStoreAccessChange } from "./store-access.js";

/**
 * Access lane A2: a company owner invites people to the team by email. The
 * grant is created only when the invitee, signed in with Universe under the
 * invited address, accepts. Pure rules here; the store does the transaction.
 */

export const INVITABLE_ROLES: readonly Role[] = Object.freeze(["org-owner", "recruiter", "finance"]);
export const INVITATION_TTL_MS = 7 * 24 * 60 * 60 * 1000;
export const MAX_PENDING_INVITATIONS = 50;
export const INVITATION_ACCEPTED_REASON = "Invitation accepted";
export const MEMBER_REMOVED_REASON = "Removed from the team by an owner";

/**
 * What an org-owner may give on a company through the Team page: org-owner,
 * recruiter and finance, at no wider scope than the owner's own covering
 * grant (a self-scoped owner invites at self scope only).
 */
export function teamCatalogue(callerGrants: readonly HeldGrant[], orgId: string, ancestors: readonly string[]): readonly GrantOption[] {
  const owners = callerGrants.filter((grant) => grant.role === "org-owner" && grantCovers(grant, orgId, ancestors));
  if (owners.length === 0) return Object.freeze([]);
  // A subtree grant on the company itself or on an ancestor reaches the company's sub-companies.
  const subtree = owners.some((grant) => grant.scope === "subtree");
  const scopes: readonly GrantScope[] = Object.freeze(subtree ? ["self", "subtree"] : ["self"]);
  return Object.freeze(INVITABLE_ROLES.map((role) => Object.freeze({ role, scopes })));
}

/** Whether `callerGrants` let the caller see the Team page read-only (operator staff or admin covering it). */
export function teamReadOnly(callerGrants: readonly HeldGrant[], orgId: string, ancestors: readonly string[]): boolean {
  return callerGrants.some((grant) => (grant.role === "staff" || grant.role === "admin") && grantCovers(grant, orgId, ancestors));
}

const EMAIL = /^[^\s@<>"']{1,64}@[^\s@<>"']{1,189}\.[^\s@<>"'.]{1,63}$/;

/** Trimmed, lower-cased, at most 254 characters, one @ and a dotted domain; else undefined. */
export function normalizeInvitationEmail(raw: unknown): string | undefined {
  if (typeof raw !== "string") return undefined;
  const value = raw.trim().toLowerCase();
  if (value.length > 254 || !EMAIL.test(value)) return undefined;
  return value;
}

/** Compares a principal's current Universe email with the invited address. */
export function emailMatches(principalEmail: string | null | undefined, invited: string): boolean {
  const current = normalizeInvitationEmail(principalEmail ?? "");
  if (!current) return false;
  const left = Buffer.from(current, "utf8"), right = Buffer.from(invited, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/** 32 random bytes, base64url (43 characters). Only the SHA-256 hex is stored. */
export function newInvitationToken(entropy: (length: number) => Buffer = randomBytes): { readonly token: string; readonly tokenHash: string } {
  const token = entropy(32).toString("base64url");
  return { token, tokenHash: hashInvitationToken(token) };
}

export function hashInvitationToken(token: string): string {
  return createHash("sha256").update(`studenthub:invitation:v1\0${token}`, "utf8").digest("hex");
}

export function isInvitationTokenShape(value: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(value);
}

export const INVITATION_REFUSALS = [
  "not_owner",
  "role_not_allowed",
  "unknown_organization",
  "duplicate_invitation",
  "too_many_invitations",
  "already_member",
  "not_found",
  "last_owner",
  "unknown_store",
] as const;
export type InvitationRefusal = (typeof INVITATION_REFUSALS)[number];

export interface InviteSnapshot {
  readonly callerGrants: readonly HeldGrant[];
  readonly orgLive: boolean;
  readonly orgAncestors: readonly string[];
  readonly pendingCount: number;
  readonly duplicatePending: boolean;
  /** A4: the named store of a store manager invitation, as read in the transaction. */
  readonly store?: null | { readonly orgId: string; readonly status: string };
}

export function decideInvite(orgId: string, input: { readonly role: string; readonly scope: string; readonly storeId?: string | null }, snapshot: InviteSnapshot):
  { readonly kind: "ok" } | { readonly kind: "refused"; readonly reason: InvitationRefusal } {
  if (!snapshot.orgLive) return { kind: "refused", reason: "unknown_organization" };
  const right = input.storeId || input.role === STORE_MANAGER
    ? decideStoreInviterRight(snapshot.callerGrants, orgId, snapshot.orgAncestors, input, snapshot.store ?? null)
    : decideInviterRight(snapshot.callerGrants, orgId, snapshot.orgAncestors, input);
  return right ??
    (snapshot.duplicatePending ? { kind: "refused", reason: "duplicate_invitation" }
      : snapshot.pendingCount >= MAX_PENDING_INVITATIONS ? { kind: "refused", reason: "too_many_invitations" }
        : { kind: "ok" });
}

/** Null when the grants still allow giving `role` at `scope` on `orgId` (also re-checked at acceptance). */
export function decideInviterRight(
  grants: readonly HeldGrant[],
  orgId: string,
  ancestors: readonly string[],
  input: { readonly role: string; readonly scope: string },
): { readonly kind: "refused"; readonly reason: InvitationRefusal } | null {
  const options = teamCatalogue(grants, orgId, ancestors);
  if (options.length === 0) return { kind: "refused", reason: "not_owner" };
  if (!isGrantScope(input.scope) || !options.some((option) => option.role === input.role && (option.scopes as readonly string[]).includes(input.scope))) {
    return { kind: "refused", reason: "role_not_allowed" };
  }
  return null;
}

/** A4: a store manager offer names one active store of this company, at self scope, from an owner, staff or admin. */
export function decideStoreInviterRight(
  grants: readonly HeldGrant[],
  orgId: string,
  ancestors: readonly string[],
  input: { readonly role: string; readonly scope: string; readonly storeId?: string | null },
  store: null | { readonly orgId: string; readonly status: string },
): { readonly kind: "refused"; readonly reason: InvitationRefusal } | null {
  if (input.role !== STORE_MANAGER || !input.storeId || input.scope !== "self") return { kind: "refused", reason: "role_not_allowed" };
  const decision = decideStoreAccessChange(orgId, { callerGrants: grants, orgLive: true, orgAncestors: ancestors, store });
  if (decision.kind === "refused") return { kind: "refused", reason: decision.reason === "not_allowed" ? "not_owner" : "unknown_store" };
  return null;
}

export type AcceptOutcome =
  | { readonly kind: "accepted"; readonly orgId: string; readonly role: string; readonly scope: GrantScope }
  | { readonly kind: "already_held"; readonly orgId: string }
  | { readonly kind: "invalid" }
  | { readonly kind: "wrong_address" };

export interface AcceptSnapshot {
  readonly invitation: null | {
    readonly orgId: string; readonly role: string; readonly scope: GrantScope; readonly email: string;
    readonly invitedBy: string; readonly expiresAt: Date; readonly usedAt: Date | null; readonly revokedAt: Date | null;
    /** A4: set for a store manager invitation. */
    readonly storeId?: string | null;
  };
  /** A4: the invitation's store as read in the transaction. */
  readonly store?: null | { readonly orgId: string; readonly status: string };
  readonly now: Date;
  readonly orgLive: boolean;
  readonly orgAncestors: readonly string[];
  readonly principalEmail: string | null;
  readonly inviterGrants: readonly HeldGrant[];
}

/**
 * The accept decision, run inside the store's transaction. Every way a link
 * can be dead (unknown, used, revoked, expired, company gone, inviter no
 * longer an owner) is one answer, "invalid", so links cannot be probed.
 */
export function decideAccept(snapshot: AcceptSnapshot): { readonly kind: "accept" } | { readonly kind: "invalid" } | { readonly kind: "wrong_address" } {
  const invitation = snapshot.invitation;
  if (!invitation || invitation.usedAt || invitation.revokedAt || snapshot.now.getTime() >= invitation.expiresAt.getTime()) return { kind: "invalid" };
  if (!snapshot.orgLive) return { kind: "invalid" };
  const right = invitation.storeId
    ? decideStoreInviterRight(snapshot.inviterGrants, invitation.orgId, snapshot.orgAncestors, invitation, snapshot.store ?? null)
    : decideInviterRight(snapshot.inviterGrants, invitation.orgId, snapshot.orgAncestors, invitation);
  if (right) return { kind: "invalid" };
  if (!emailMatches(snapshot.principalEmail, invitation.email)) return { kind: "wrong_address" };
  return { kind: "accept" };
}

export interface RemoveSnapshot {
  readonly callerGrants: readonly HeldGrant[];
  readonly orgLive: boolean;
  readonly orgAncestors: readonly string[];
  /** The target's grants held directly on this company. */
  readonly targetGrants: readonly { readonly role: string; readonly scope: GrantScope }[];
  /** Number of org-owner grants held directly on this company. */
  readonly ownerCount: number;
}

/**
 * An owner removes a member: every grant the member holds directly on this
 * company, never a grant elsewhere (a parent's or a child's stays). The last
 * owner of the company stays, checked in the store's transaction under a
 * per-company lock.
 */
export function decideRemove(orgId: string, snapshot: RemoveSnapshot):
  { readonly kind: "remove"; readonly roles: readonly string[] } | { readonly kind: "refused"; readonly reason: InvitationRefusal } {
  if (!snapshot.orgLive) return { kind: "refused", reason: "unknown_organization" };
  if (teamCatalogue(snapshot.callerGrants, orgId, snapshot.orgAncestors).length === 0) return { kind: "refused", reason: "not_owner" };
  if (snapshot.targetGrants.length === 0) return { kind: "refused", reason: "not_found" };
  if (snapshot.targetGrants.some((grant) => grant.role === "org-owner") && snapshot.ownerCount <= 1) {
    return { kind: "refused", reason: "last_owner" };
  }
  return { kind: "remove", roles: snapshot.targetGrants.map((grant) => grant.role) };
}
