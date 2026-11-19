// W-2 seam: approved work, read by the pay lane (packages/payroll).
//
// This module only describes and reads hours. It never computes money: the pay
// lane owns rates, arithmetic and rounding (SHU-208). The seam is a read port so
// pay replay can run against a legacy-backed implementation before the new
// work tables hold real data, and switch to the Postgres one later with no
// change on the pay side.
//
// Differences from legacy's hours export (staff TransferController
// actionApprovedWorkLog), each a fix under the 10-27 rule:
// - legacy filtered by the person's CURRENT store, so hours at an earlier store
//   in the same month dropped out: lines are keyed by assignment;
// - legacy summed `candidate_working_date.total_time` on days marked approved,
//   which included rejected sessions: only approved sessions count;
// - a staff correction replaces its original (D-WK3: no re-approval, reason
//   required), so only sessions in force count.
// Legacy's display split (floor hours, minutes, seconds) is a view of
// `approvedSeconds`; `splitSeconds` reproduces it for the replay.

import type { IsoDate } from "./common.js";

export const PAYABLE_INPUT_VERSION = "studenthub.work.payable-input.v1" as const;

/** One approved session in force, the unit the pay lane dedupes on. */
export interface PayableSession {
  readonly sessionId: string;
  readonly workDate: IsoDate;
  readonly durationSeconds: number;
  readonly source: "timer" | "manual" | "correction" | "import";
  /** When set, this session replaced that one (D-WK3 correction); the original is not payable. */
  readonly correctsSessionId: string | null;
  /**
   * The first session of this session's correction chain: itself for an original,
   * A for both B and C in A → B → C. It never changes, so the pay lane joins a
   * replacement to whatever it paid in that chain, however often it was corrected.
   */
  readonly lineageRootId: string;
  /** The decision that approved it (W-4, or the staff member's own approval of a W-6 correction); null for imported sessions. */
  readonly decisionId: string | null;
  /** Last change to status or existence; lets the pay lane find work changed after a run. */
  readonly changedAt: string;
}

/** Approved work of one assignment in one period. */
export interface PayableInput {
  readonly version: typeof PAYABLE_INPUT_VERSION;
  readonly assignmentId: string;
  readonly personId: string;
  readonly orgId: string;
  readonly storeId: string;
  /** The F1 contract recorded on the assignment; null means legacy's contract-less (manual rate) path. */
  readonly payContractId: string | null;
  readonly period: { readonly start: IsoDate; readonly end: IsoDate };
  readonly approvedSeconds: number;
  /** Shown for audit, never paid. */
  readonly pendingSeconds: number;
  readonly rejectedSeconds: number;
  /** Sessions still open at read time; excluded, reported as a warning. */
  readonly openSessions: number;
  readonly sessions: readonly PayableSession[];
}

export interface PayableQuery {
  /** Inclusive Asia/Kuwait dates on `workDate`. */
  readonly period: { readonly start: IsoDate; readonly end: IsoDate };
  /** A company and, when `includeSubtree`, its sub-companies. Omit for every company. */
  readonly orgId?: string;
  readonly includeSubtree?: boolean;
  readonly personId?: string;
  readonly payContractId?: string;
}

/** The session a correction chain resolves to now, wherever its work date moved. */
export interface PayableLineageSession {
  readonly sessionId: string;
  readonly assignmentId: string;
  readonly orgId: string;
  readonly workDate: IsoDate;
  readonly durationSeconds: number | null;
  readonly status: "pending" | "approved" | "rejected";
  readonly decisionId: string | null;
  readonly changedAt: string;
}

/** One correction chain, read by its root (`PayableSession.lineageRootId`). */
export interface PayableLineage {
  readonly rootId: string;
  /** Every session of the chain from the root, oldest first; only the last can be in force. */
  readonly sessionIds: readonly string[];
  /** The chain's session in force now; null when it was discarded. Pay only `approved` with an end. */
  readonly inForce: PayableLineageSession | null;
}

/** The read port the pay lane consumes. Results are ordered by orgId, personId, assignmentId. */
export interface PayableWorkSource {
  payableInputs(query: PayableQuery): Promise<readonly PayableInput[]>;
  /**
   * Resolves correction chains by root, outside any period, so a session paid in
   * a finalized run can be followed after a correction moved it to another
   * period or out of approval. Unknown roots are left out; ordered by rootId.
   */
  lineage(rootIds: readonly string[]): Promise<readonly PayableLineage[]>;
}

/** Legacy's floor-per-unit display: 3h 25m 9s from 12309 seconds. */
export function splitSeconds(total: number): { readonly hours: number; readonly minutes: number; readonly seconds: number } {
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError("seconds must be a non-negative integer");
  return { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60 };
}
