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
  /** The decision that approved it (W-4); null for imported or staff-corrected sessions. */
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

/** The read port the pay lane consumes. Results are ordered by orgId, personId, assignmentId. */
export interface PayableWorkSource {
  payableInputs(query: PayableQuery): Promise<readonly PayableInput[]>;
}

/** Legacy's floor-per-unit display: 3h 25m 9s from 12309 seconds. */
export function splitSeconds(total: number): { readonly hours: number; readonly minutes: number; readonly seconds: number } {
  if (!Number.isSafeInteger(total) || total < 0) throw new RangeError("seconds must be a non-negative integer");
  return { hours: Math.floor(total / 3600), minutes: Math.floor((total % 3600) / 60), seconds: total % 60 };
}
