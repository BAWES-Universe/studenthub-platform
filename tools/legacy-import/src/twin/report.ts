/**
 * The walk report and the rule that turns it into closed `verified` gates.
 *
 * A report holds journeys, legacy person ids, counts, fact paths, difference kinds,
 * decision citations and fixed codes. `assertPrivate` re-checks every string in it
 * against those shapes before it is written, so a value can never ride out in a path,
 * a code or an id, whatever an extractor did.
 */

import { citesEvidence } from "../../../release-matrix/src/matrix.js";
import { citesDecision, type Comparison, type DiffKind } from "./compare.js";
import { FACT_PATH } from "./facts.js";

/** Why a person could not be walked. Fixed words only. */
export const WALK_CODES = [
  "persona_unlinked", "sign_in_failed", "page_failed", "extract_failed", "legacy_read_failed", "timeout",
] as const;
export type WalkCode = (typeof WALK_CODES)[number];

export type PersonOutcome =
  | ({ readonly legacyId: string; readonly outcome: "match" | "explained" | "regression" } & Comparison)
  | { readonly legacyId: string; readonly outcome: "error"; readonly code: WalkCode };

export interface JourneyResult {
  readonly journey: string;
  readonly screens: readonly string[];
  readonly people: readonly PersonOutcome[];
}

export interface TwinReport {
  readonly schemaVersion: 1;
  /** The platform revision walked (a 40-character commit). */
  readonly revision: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly minimumPeople: number;
  readonly journeys: readonly JourneyResult[];
}

export function outcomeOf(c: Comparison): "match" | "explained" | "regression" {
  return c.regressions.length > 0 ? "regression" : c.explained.length > 0 ? "explained" : "match";
}

export type JourneyVerdict =
  | { readonly verdict: "verified"; readonly walked: number }
  | { readonly verdict: "open"; readonly reason: "regression" | "error" | "too_few_people"; readonly walked: number };

/**
 * A journey is verified when at least `minimumPeople` people were walked, none of them
 * showed an unexplained difference, and no walk failed. A person who could not be walked
 * (for example not linked yet) is an error, never a silent skip.
 */
export function verdictOf(result: JourneyResult, minimumPeople: number): JourneyVerdict {
  const walked = result.people.filter((p) => p.outcome !== "error").length;
  if (result.people.some((p) => p.outcome === "regression")) return { verdict: "open", reason: "regression", walked };
  if (result.people.some((p) => p.outcome === "error")) return { verdict: "open", reason: "error", walked };
  if (walked < minimumPeople) return { verdict: "open", reason: "too_few_people", walked };
  return { verdict: "verified", walked };
}

const LEGACY_ID = /^\d{1,20}$/;
const SCREEN = /^[A-Z]-\d{2}$/;
const JOURNEY = /^[a-z][a-z0-9-]{1,40}$/;
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;
const KINDS: readonly DiffKind[] = ["differs", "missing", "extra"];

/** Throws `twin.report.notPrivate` naming the field (never its value) that broke the rule. */
export function assertPrivate(report: TwinReport): void {
  const fail = (field: string): never => { throw new Error(`twin.report.notPrivate: ${field}`); };
  const keys = (o: object, allowed: readonly string[], field: string) => { for (const k of Object.keys(o)) if (!allowed.includes(k)) fail(`${field}.${k}`); };
  keys(report, ["schemaVersion", "revision", "startedAt", "finishedAt", "minimumPeople", "journeys"], "report");
  if (report.schemaVersion !== 1) fail("schemaVersion");
  if (!/^[0-9a-f]{40}$/.test(report.revision)) fail("revision");
  if (!ISO.test(report.startedAt)) fail("startedAt");
  if (!ISO.test(report.finishedAt)) fail("finishedAt");
  if (!Number.isInteger(report.minimumPeople) || report.minimumPeople < 1) fail("minimumPeople");
  for (const j of report.journeys) {
    keys(j, ["journey", "screens", "people"], "journey");
    if (!JOURNEY.test(j.journey)) fail("journey");
    if (j.screens.length === 0 || !j.screens.every((s) => SCREEN.test(s))) fail("screens");
    for (const p of j.people) {
      if (!LEGACY_ID.test(p.legacyId)) fail("legacyId");
      if (p.outcome === "error") {
        keys(p, ["legacyId", "outcome", "code"], "person");
        if (!(WALK_CODES as readonly string[]).includes(p.code)) fail("code");
        continue;
      }
      keys(p, ["legacyId", "outcome", "matched", "explained", "regressions"], "person");
      if (!["match", "explained", "regression"].includes(p.outcome)) fail("outcome");
      if (!Number.isInteger(p.matched) || p.matched < 0) fail("matched");
      for (const e of p.explained) {
        keys(e, ["path", "kind", "decision"], "explained");
        if (!FACT_PATH.test(e.path)) fail("explained.path");
        if (!KINDS.includes(e.kind)) fail("explained.kind");
        if (!citesDecision(e.decision)) fail("explained.decision");
      }
      for (const r of p.regressions) {
        keys(r, ["path", "kind"], "regression");
        if (!FACT_PATH.test(r.path)) fail("regression.path");
        if (!KINDS.includes(r.kind)) fail("regression.kind");
      }
      if (p.outcome !== outcomeOf(p)) fail("outcome");
    }
  }
}

interface GateState { readonly state: string; readonly evidence?: string; readonly note?: string }
interface ScreenRowLike { readonly gates: Readonly<Record<string, GateState>> }

export interface GateChange {
  readonly screen: string;
  readonly journey: string;
  readonly change: "closed" | "already_closed" | "built_open" | "not_verified";
}

/**
 * Closes `verified` on each screen of each verified journey, citing `evidence` (where the
 * report was published: `PR #n comment <id>` or a run URL). A screen whose `built` gate is
 * still open is left alone: a walk cannot verify a page the matrix does not call built.
 * A screen shared by several journeys closes only when every journey naming it is verified.
 * Returns the new screens object and what happened to each screen; the input is unchanged.
 */
export function closeVerified<T extends ScreenRowLike>(screens: Readonly<Record<string, T>>, report: TwinReport, evidence: string): { screens: Record<string, T>; changes: GateChange[] } {
  if (!citesEvidence(evidence) || /[\r\n]/.test(evidence)) throw new Error("twin.gate.evidenceUnsourced");
  assertPrivate(report);
  const out: Record<string, T> = { ...screens };
  const changes: GateChange[] = [];
  const verdicts = new Map(report.journeys.map((j) => [j.journey, verdictOf(j, report.minimumPeople)]));
  for (const j of report.journeys) {
    for (const screen of j.screens) {
      const row = out[screen];
      if (!row) throw new Error("twin.gate.unknownScreen");
      const naming = report.journeys.filter((other) => other.screens.includes(screen));
      if (!naming.every((other) => verdicts.get(other.journey)!.verdict === "verified")) { changes.push({ screen, journey: j.journey, change: "not_verified" }); continue; }
      if (row.gates.built?.state !== "done") { changes.push({ screen, journey: j.journey, change: "built_open" }); continue; }
      if (row.gates.verified?.state === "done") { changes.push({ screen, journey: j.journey, change: "already_closed" }); continue; }
      const walked = naming.map((other) => `${other.journey} (${(verdicts.get(other.journey) as { walked: number }).walked} people)`).join(", ");
      out[screen] = { ...row, gates: { ...row.gates, verified: { state: "done", evidence: `legacy twin walk at ${report.revision.slice(0, 12)}: ${walked}; ${evidence}` } } };
      changes.push({ screen, journey: j.journey, change: "closed" });
    }
  }
  return { screens: out, changes };
}
