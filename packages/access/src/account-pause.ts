import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import { mayOpenAccessAdmin, type HeldGrant } from "./grant-catalogue.js";
import { REASON_MAX, REASON_MIN } from "./grant-change.js";

/**
 * Access lane A6: staff pause and resume a person's StudentHub access.
 *
 * Pausing takes every grant and every live store grant away in one
 * transaction (each with its audit and event rows), keeps the exact set on
 * the pause row, ends the person's sessions and refuses new ones; resuming
 * gives back what can still be given (a deleted company or a removed store is
 * left out and listed). Grants stay keyed by principal, so an email address
 * later reused by another Universe identity inherits nothing.
 */

export type PauseAction = "pause" | "resume";

export interface PauseRequest {
  readonly targetPrincipalId: string;
  readonly action: PauseAction;
  readonly reason: string;
}

export type PauseRefusal =
  | "self_change"
  | "unknown_person"
  | "not_allowed"
  | "already_paused"
  | "not_paused";

export interface PauseSnapshot {
  readonly callerGrants: readonly HeldGrant[];
  readonly targetExists: boolean;
  readonly targetGrants: readonly HeldGrant[];
  readonly paused: boolean;
}

export type PauseDecision = { readonly kind: "apply" } | { readonly kind: "refused"; readonly reason: PauseRefusal };

const ID = /^[A-Za-z0-9@._:+-]{1,256}$/;

/** Validates untrusted form fields into a pause or resume request, or undefined. */
export function parsePauseRequest(raw: Readonly<Record<string, unknown>>): PauseRequest | undefined {
  const { targetPrincipalId, action, reason } = raw;
  if (typeof targetPrincipalId !== "string" || !ID.test(targetPrincipalId)) return undefined;
  if (action !== "pause" && action !== "resume") return undefined;
  if (typeof reason !== "string") return undefined;
  const trimmed = reason.trim().replace(/\r\n?/g, "\n");
  const length = [...trimmed].length;
  if (length < REASON_MIN || length > REASON_MAX) return undefined;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) return undefined;
  return Object.freeze({ targetPrincipalId, action, reason: trimmed });
}

const isOperatorAdmin = (grants: readonly HeldGrant[], operatorOrgIds: readonly string[]) =>
  grants.some((grant) => operatorOrgIds.includes(grant.orgId) && grant.role === "admin");
const holdsOperatorRole = (grants: readonly HeldGrant[], operatorOrgIds: readonly string[]) =>
  grants.some((grant) => operatorOrgIds.includes(grant.orgId) && (grant.role === "admin" || grant.role === "staff"));

/** Who may pause or resume whom: operator staff or admin; only an operator admin for someone who holds an operator role; never oneself. */
export function mayPauseAccount(
  callerId: string,
  targetPrincipalId: string,
  callerGrants: readonly HeldGrant[],
  targetGrants: readonly HeldGrant[],
  operatorOrgIds: readonly string[] = DEFAULT_OPERATOR_ORG_IDS,
): boolean {
  if (callerId === targetPrincipalId) return false;
  if (!mayOpenAccessAdmin(callerGrants, operatorOrgIds)) return false;
  return !holdsOperatorRole(targetGrants, operatorOrgIds) || isOperatorAdmin(callerGrants, operatorOrgIds);
}

export function decidePause(
  callerId: string,
  request: PauseRequest,
  snapshot: PauseSnapshot,
  operatorOrgIds: readonly string[] = DEFAULT_OPERATOR_ORG_IDS,
): PauseDecision {
  if (callerId === request.targetPrincipalId) return { kind: "refused", reason: "self_change" };
  if (!mayOpenAccessAdmin(snapshot.callerGrants, operatorOrgIds)) return { kind: "refused", reason: "not_allowed" };
  if (!snapshot.targetExists) return { kind: "refused", reason: "unknown_person" };
  if (request.action === "pause" && snapshot.paused) return { kind: "refused", reason: "already_paused" };
  if (request.action === "resume" && !snapshot.paused) return { kind: "refused", reason: "not_paused" };
  // On resume the held grants are empty; the suspended set is checked by the store's snapshot.
  if (!mayPauseAccount(callerId, request.targetPrincipalId, snapshot.callerGrants, snapshot.targetGrants, operatorOrgIds)) {
    return { kind: "refused", reason: "not_allowed" };
  }
  return { kind: "apply" };
}

export interface SuspendedGrant {
  readonly orgId: string;
  readonly role: string;
  readonly scope: string;
}

export interface SuspendedStoreGrant {
  readonly orgId: string;
  readonly storeId: string;
}

export interface AccountPause {
  readonly pausedAt: string;
  readonly pausedBy: { readonly principalId: string; readonly displayName: string | null };
  readonly reason: string;
  readonly grants: readonly SuspendedGrant[];
  readonly storeGrants: readonly SuspendedStoreGrant[];
}

export type PauseOutcome =
  | { readonly kind: "paused"; readonly grants: number; readonly storeGrants: number }
  | { readonly kind: "resumed"; readonly restored: number; readonly leftOut: number }
  | { readonly kind: "refused"; readonly reason: PauseRefusal };

/** The Postgres side: one transaction per change, deciding on what it read under the locks. */
export interface AccountPauseStore {
  apply(input: {
    readonly callerId: string;
    readonly request: PauseRequest;
    readonly decide: (snapshot: PauseSnapshot) => PauseDecision;
    readonly requestId?: string;
  }): Promise<PauseOutcome>;
  /** The live pause of one person, or null. */
  pause(principalId: string): Promise<AccountPause | null>;
  /** Which of these people are paused, in one read. */
  paused(principalIds: readonly string[]): Promise<ReadonlySet<string>>;
}

export interface AccountPauseService {
  change(callerId: string, request: PauseRequest, requestId?: string): Promise<PauseOutcome>;
}

export function createAccountPauseService(options: {
  readonly store: Pick<AccountPauseStore, "apply">;
  readonly operatorOrgIds?: readonly string[];
}): AccountPauseService {
  const operatorOrgIds = options.operatorOrgIds ?? DEFAULT_OPERATOR_ORG_IDS;
  return {
    change(callerId, request, requestId) {
      return options.store.apply({
        callerId, request,
        decide: (snapshot) => decidePause(callerId, request, snapshot, operatorOrgIds),
        ...(requestId ? { requestId } : {}),
      });
    },
  };
}
