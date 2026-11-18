import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import type { HeldGrant } from "./grant-catalogue.js";
import { REASON_MAX, REASON_MIN } from "./grant-change.js";
import { mayPauseAccount } from "./account-pause.js";

/**
 * Access lane A9: staff view a person's account as they see it, read-only,
 * for a fixed 15 minutes, with a reason.
 *
 * Read-only by construction: staff never hold a session as the person, so no
 * write (finance, grants or anything else) can be made in their name. Every
 * view records both identities, and the person sees "StudentHub staff viewed
 * your account on <date>" on their own Access page.
 */

export const STAFF_VIEW_SECONDS = 15 * 60;

export interface StaffViewRequest {
  readonly targetPrincipalId: string;
  readonly reason: string;
}

const ID = /^[A-Za-z0-9@._:+-]{1,256}$/;

export function parseStaffViewRequest(raw: Readonly<Record<string, unknown>>): StaffViewRequest | undefined {
  const { targetPrincipalId, reason } = raw;
  if (typeof targetPrincipalId !== "string" || !ID.test(targetPrincipalId) || typeof reason !== "string") return undefined;
  const trimmed = reason.trim().replace(/\r\n?/g, "\n");
  const length = [...trimmed].length;
  if (length < REASON_MIN || length > REASON_MAX) return undefined;
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(trimmed)) return undefined;
  return Object.freeze({ targetPrincipalId, reason: trimmed });
}

/** The same rule as pausing: operator staff or admin; only an admin for someone holding an operator role; never oneself. */
export function mayViewAs(
  callerId: string,
  targetPrincipalId: string,
  callerGrants: readonly HeldGrant[],
  targetGrants: readonly HeldGrant[],
  operatorOrgIds: readonly string[] = DEFAULT_OPERATOR_ORG_IDS,
): boolean {
  return mayPauseAccount(callerId, targetPrincipalId, callerGrants, targetGrants, operatorOrgIds);
}

export interface StaffView {
  readonly id: string;
  readonly staffPrincipalId: string;
  readonly targetPrincipalId: string;
  readonly reason: string;
  readonly startedAt: string;
  readonly expiresAt: string;
}

/** A view is open from its start until 15 minutes later, never after. */
export function viewOpen(view: Pick<StaffView, "startedAt" | "expiresAt">, now: Date): boolean {
  const start = Date.parse(view.startedAt), end = Date.parse(view.expiresAt);
  return start <= now.getTime() && now.getTime() < end && end - start <= STAFF_VIEW_SECONDS * 1000;
}

export interface StaffViewStore {
  /**
   * Records a new view (who, whom, why, until when), deciding with `mayStart`
   * on both people's grants as read inside the write's transaction. Null when refused.
   */
  start(staffPrincipalId: string, request: StaffViewRequest,
    mayStart: (callerGrants: readonly HeldGrant[], targetGrants: readonly HeldGrant[]) => boolean): Promise<StaffView | null>;
  /** The staff member's latest view of this person that is still open, if any. */
  open(staffPrincipalId: string, targetPrincipalId: string): Promise<StaffView | null>;
  /** When StudentHub staff viewed this person's account, newest first (no staff names). */
  viewedOn(targetPrincipalId: string): Promise<readonly string[]>;
  /** The grants a principal holds, for the rule above. */
  grantsOf(principalId: string): Promise<readonly HeldGrant[]>;
}
