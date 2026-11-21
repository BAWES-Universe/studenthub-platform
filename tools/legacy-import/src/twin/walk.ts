/**
 * Walks each journey for a sample of people and builds the private-safe report.
 *
 * For each person: read the legacy sheet from the refreshed copy, open the same pages on
 * the new app signed in as the same person, read the new sheet, compare. Any failure is
 * recorded as a fixed code and never as its message, because a message can carry a value.
 */

import { compareSheets, type Explanation } from "./compare.js";
import type { Journey, JourneyContext, LegacyReader } from "./journey.js";
import { assertPrivate, outcomeOf, type JourneyResult, type PersonOutcome, type TwinReport, type WalkCode } from "./report.js";

/** The new app, as one person sees it. */
export interface NewApp {
  /** The platform person for a legacy id, or undefined when that person is not linked yet. */
  personFor(legacyId: string, persona: Journey["persona"]): Promise<string | undefined>;
  /** Final HTML of each path, signed in as `personId`, in order. Throws `WalkFailure` on failure. */
  open(personId: string, paths: readonly string[]): Promise<readonly string[]>;
}

export class WalkFailure extends Error {
  constructor(readonly code: WalkCode) { super(code); }
}

export interface WalkOptions {
  readonly revision: string;
  readonly limit: number;
  readonly minimumPeople: number;
  readonly explanations: readonly Explanation[];
  readonly now: () => Date;
}

export async function walk(journeys: readonly Journey[], legacy: LegacyReader, app: NewApp, ctx: JourneyContext, options: WalkOptions): Promise<TwinReport> {
  const startedAt = options.now().toISOString();
  const results: JourneyResult[] = [];
  for (const journey of journeys) {
    const people: PersonOutcome[] = [];
    let ids: readonly string[];
    try {
      ids = await journey.people(legacy, ctx, options.limit);
    } catch {
      results.push({ journey: journey.id, screens: journey.screens, people: [] });
      continue;
    }
    for (const legacyId of ids) people.push(await walkOne(journey, legacyId, legacy, app, ctx, options.explanations));
    results.push({ journey: journey.id, screens: journey.screens, people });
  }
  const report: TwinReport = { schemaVersion: 1, revision: options.revision, startedAt, finishedAt: options.now().toISOString(), minimumPeople: options.minimumPeople, journeys: results };
  assertPrivate(report);
  return report;
}

async function walkOne(journey: Journey, legacyId: string, legacy: LegacyReader, app: NewApp, ctx: JourneyContext, explanations: readonly Explanation[]): Promise<PersonOutcome> {
  const error = (code: WalkCode): PersonOutcome => ({ legacyId, outcome: "error", code });
  let legacySheet;
  try { legacySheet = await journey.legacySheet(legacy, legacyId, ctx); } catch { return error("legacy_read_failed"); }
  let personId: string | undefined;
  try { personId = await app.personFor(legacyId, journey.persona); } catch { return error("persona_unlinked"); }
  if (!personId) return error("persona_unlinked");
  let paths: readonly string[];
  try { paths = journey.pages(ctx, legacySheet); } catch { return error("legacy_read_failed"); }
  let html: readonly string[];
  try { html = await app.open(personId, paths); } catch (e) { return error(e instanceof WalkFailure ? e.code : "page_failed"); }
  if (html.length !== paths.length) return error("page_failed");
  let nextSheet;
  try { nextSheet = journey.newSheet(paths.map((path, i) => ({ path, html: html[i]! })), ctx); } catch { return error("extract_failed"); }
  const comparison = compareSheets(journey.id, legacySheet, nextSheet, explanations);
  return { legacyId, outcome: outcomeOf(comparison), ...comparison };
}
