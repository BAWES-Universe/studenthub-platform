/**
 * Compares a legacy sheet with the new sheet for the same person and journey.
 *
 * Every path is one of: matched (same value on both sides), explained (it differs, and a
 * recorded decision says why), or a regression (it differs and nothing explains it).
 * The result carries paths, kinds and decision citations only, never a value.
 */

import { citesDecision as citesDecisionRecord } from "../../../release-matrix/src/matrix.js";
import { FACT_PATH, type FactSheet, type FactValue } from "./facts.js";

export type DiffKind = "differs" | "missing" | "extra";

/**
 * A recorded reason why a path may differ. `path` is a fact path where `[*]` matches any
 * one key. `kinds` limits which differences it explains. `decision` cites the record the
 * same way a release-matrix waiver does: `contracts/decisions-<date>.md` or
 * `PR #393 comment <id>` (a decision agreed on the desk).
 */
export interface Explanation {
  readonly journey: string;
  readonly path: string;
  readonly kinds: readonly DiffKind[];
  readonly decision: string;
}

export interface Comparison {
  readonly matched: number;
  readonly explained: readonly { readonly path: string; readonly kind: DiffKind; readonly decision: string }[];
  readonly regressions: readonly { readonly path: string; readonly kind: DiffKind }[];
}

/** The whole string must be one citation, so an explanation cannot smuggle a value. */
export function citesDecision(decision: string): boolean {
  return /^(?:contracts\/decisions-[\w-]+\.md|PR #\d+ comment \d+)$/.test(decision) && citesDecisionRecord(decision);
}

/** Refuses an explanation that cites no record, names an unknown journey or has a malformed path. */
export function validateExplanations(explanations: readonly Explanation[], journeys: readonly string[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  for (const [i, e] of explanations.entries()) {
    const where = `explanation ${i}`;
    if (!journeys.includes(e.journey)) problems.push(`${where}: unknown journey`);
    if (!citesDecision(e.decision)) problems.push(`${where}: cites no decision record`);
    if (e.kinds.length === 0 || e.kinds.some((k) => !["differs", "missing", "extra"].includes(k))) problems.push(`${where}: bad kinds`);
    if (!FACT_PATH.test(e.path.replaceAll("[*]", "[1]"))) problems.push(`${where}: bad path`);
    const key = `${e.journey} ${e.path}`;
    if (seen.has(key)) problems.push(`${where}: duplicate path for journey`);
    seen.add(key);
  }
  return problems;
}

function pattern(path: string): RegExp {
  const escaped = path.split("[*]").map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(String.raw`\[[^\]]+\]`);
  return new RegExp(`^${escaped}$`);
}

export function compareSheets(journey: string, legacy: FactSheet, next: FactSheet, explanations: readonly Explanation[]): Comparison {
  const mine = explanations.filter((e) => e.journey === journey).map((e) => ({ ...e, re: pattern(e.path) }));
  const paths = [...new Set([...legacy.keys(), ...next.keys()])].sort();
  let matched = 0;
  const explained: { path: string; kind: DiffKind; decision: string }[] = [];
  const regressions: { path: string; kind: DiffKind }[] = [];
  for (const path of paths) {
    const inLegacy = legacy.has(path), inNext = next.has(path);
    let kind: DiffKind | null;
    if (inLegacy && inNext) kind = same(legacy.get(path)!, next.get(path)!) ? null : "differs";
    else kind = inLegacy ? "missing" : "extra";
    if (kind === null) { matched++; continue; }
    const why = mine.find((e) => e.kinds.includes(kind!) && e.re.test(path));
    if (why) explained.push({ path, kind, decision: why.decision });
    else regressions.push({ path, kind });
  }
  return { matched, explained, regressions };
}

function same(a: FactValue, b: FactValue): boolean {
  return a === b;
}
