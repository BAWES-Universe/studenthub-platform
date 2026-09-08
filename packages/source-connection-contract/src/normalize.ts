/**
 * Normalization for the SHU-77 source-connection import contract.
 *
 * This module produces CANDIDATE identity links and conflict reports. It never
 * writes, never reads live data, and never resolves a conflict on its own.
 *
 * Three properties hold by construction, and each is bound by a named scenario
 * in `conformance.ts`:
 *
 *   1. Nothing is matched, keyed, or joined on a mutable profile claim. The
 *      only keys are `source`, `externalId` and `personId`. A donor export can
 *      carry any profile fields it likes; they are dropped at the boundary.
 *
 *   2. Import is idempotent. Records collapse on the
 *      (source, externalId, personId) triple, later `observedAt` refreshing the
 *      surviving candidate, and accepted output is sorted, so re-running an
 *      export -- or re-running it with its rows shuffled -- yields exactly the
 *      same accepted set.
 *
 *   3. Ambiguity fails closed in both directions. If one external identity is
 *      claimed by more than one person, or one person is claimed by one source
 *      under more than one external id, then NEITHER side is accepted. A
 *      withheld candidate can be re-imported after a human resolves it; a wrong
 *      identity link is permanent.
 */

import {
  SOURCE_CONNECTION_CONTRACT_VERSION,
  SUPPORTED_SOURCES,
  type ConflictReport,
  type DryRunReport,
  type NormalizationResult,
  type NormalizedSourceConnection,
  type RawSourceRecord,
  type RejectedRecord,
  type RejectionReason,
  type SourceSystem,
} from "./types.js";
import { maskIdentifier, personRef } from "./mask.js";

export { maskIdentifier, personRef } from "./mask.js";

/**
 * An ISO-8601 instant with an EXPLICIT offset. A timezone-less timestamp such
 * as "2026-01-02T03:04:05" is parsed by `Date` as local time, so the same
 * export would order its duplicates differently depending on which machine ran
 * the import, and ordering is what decides which duplicate survives. Such a
 * value is rejected rather than guessed at.
 *
 * The fraction is capped at three digits because that is all `toISOString` can
 * represent. Accepting "…00.0001Z" and storing "…00.000Z" would make two
 * distinct observations indistinguishable, and since `observedAt` decides which
 * duplicate survives, the survivor would then be decided by input order. That
 * is the same silent coercion as the calendar rollover below, so it is refused
 * the same way. An operator whose export carries microseconds decides
 * deliberately, in the mapping adapter, what to do with them.
 */
const INSTANT_PATTERN =
  /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

/** Days in a month, using the UTC calendar so no local timezone is involved. */
function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isSupportedSource(value: string): value is SourceSystem {
  return (SUPPORTED_SOURCES as readonly string[]).includes(value);
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

/**
 * Convert an explicit-offset ISO-8601 instant to its UTC representation, or
 * return null if the value is not one.
 */
function toUtcInstant(value: string): string | null {
  const match = INSTANT_PATTERN.exec(value);
  if (match === null) {
    return null;
  }

  // `Date.parse` rolls an impossible date over rather than rejecting it:
  // "2026-02-30T00:00:00Z" parses cleanly as 2 March. Silently moving an
  // observation two days is the same class of guess this contract refuses
  // everywhere else, so the calendar is checked before the value is trusted.
  const [, year, month, day, hour, minute, second] = match.map(Number);
  if (
    year === undefined ||
    month === undefined ||
    day === undefined ||
    hour === undefined ||
    minute === undefined ||
    second === undefined
  ) {
    return null;
  }
  if (month < 1 || month > 12) {
    return null;
  }
  if (day < 1 || day > daysInMonth(year, month)) {
    return null;
  }
  if (hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return new Date(parsed).toISOString();
}

type NormalizeOutcome =
  | { readonly ok: true; readonly value: NormalizedSourceConnection }
  | { readonly ok: false; readonly rejection: RejectedRecord };

/**
 * Validate a single raw record. The rule order is fixed so that a record
 * failing several rules always reports the same reason, which is what makes a
 * rejection count a stable thing to assert on.
 */
function normalizeOne(raw: RawSourceRecord): NormalizeOutcome {
  const source = text(raw.source).toLowerCase();
  const rawExternalId = typeof raw.externalId === "string" ? raw.externalId : "";
  const externalId = rawExternalId.trim();
  const externalIdMask = maskIdentifier(externalId);

  const reject = (reason: RejectionReason): NormalizeOutcome => ({
    ok: false,
    rejection: {
      reason,
      externalIdMask,
      source: isSupportedSource(source) ? source : "unsupported",
    },
  });

  if (!isSupportedSource(source)) {
    return reject("unsupported_source");
  }
  if (externalId === "") {
    return reject("missing_external_id");
  }
  // `source` is a fixed vocabulary and `provenance` is a label, so normalizing
  // their whitespace is safe. The two identity keys are not: trimming " z " to
  // "z" would silently merge a padded donor row into a different account's
  // identity. An identifier that needs cleaning is malformed, and cleaning it is
  // the mapping adapter's decision to make explicitly, not this contract's to
  // make silently.
  if (externalId !== rawExternalId) {
    return reject("malformed_external_id");
  }
  const rawPersonId = typeof raw.personId === "string" ? raw.personId : "";
  const personId = rawPersonId.trim();
  if (personId === "") {
    return reject("missing_person_id");
  }
  if (personId !== rawPersonId) {
    return reject("malformed_person_id");
  }
  const provenance = text(raw.provenance);
  if (provenance === "") {
    return reject("missing_provenance");
  }
  const observedRaw = text(raw.observedAt);
  if (observedRaw === "") {
    return reject("missing_observed_at");
  }
  const observedAt = toUtcInstant(observedRaw);
  if (observedAt === null) {
    return reject("malformed_observed_at");
  }

  return {
    ok: true,
    value: {
      contractVersion: SOURCE_CONNECTION_CONTRACT_VERSION,
      source,
      externalId,
      personId,
      provenance,
      observedAt,
    },
  };
}

/*
 * The three grouping keys. All use a structured encoding rather than a
 * delimiter join, because an identifier may legitimately contain the delimiter:
 * `"discord a b c"` is both (externalId "a b", personId "c") and (externalId
 * "a", personId "b c"), and a Map keyed that way silently drops one of two
 * distinct candidates. Nothing constrains a donor identifier's character set,
 * and this contract does not get to assume one.
 */

/** The identity side of the link: which external account. */
function identityKey(candidate: NormalizedSourceConnection): string {
  return JSON.stringify([candidate.source, candidate.externalId]);
}

/** The person side of the link, scoped to one source. */
function personKey(candidate: NormalizedSourceConnection): string {
  return JSON.stringify([candidate.source, candidate.personId]);
}

/** The full identity triple: the unit an import collapses duplicates onto. */
function tripleKey(candidate: NormalizedSourceConnection): string {
  return JSON.stringify([candidate.source, candidate.externalId, candidate.personId]);
}

function compareCandidates(
  left: NormalizedSourceConnection,
  right: NormalizedSourceConnection,
): number {
  return (
    left.source.localeCompare(right.source) ||
    left.externalId.localeCompare(right.externalId) ||
    left.personId.localeCompare(right.personId)
  );
}

/**
 * Which of two observations of one triple survives.
 *
 * Ordering on `observedAt` alone is a partial order: two rows can share a
 * timestamp and differ in provenance, and "keep the one already there" would
 * then make the survivor depend on the order the donor happened to export in.
 * Provenance breaks the tie, so the accepted set stays a function of the
 * records rather than of their sequence.
 */
function supersedes(
  candidate: NormalizedSourceConnection,
  existing: NormalizedSourceConnection,
): boolean {
  if (candidate.observedAt !== existing.observedAt) {
    return candidate.observedAt > existing.observedAt;
  }
  return candidate.provenance > existing.provenance;
}

function sortedUnique(values: Iterable<string>): readonly string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

/**
 * Normalize a batch of raw source-connection records into accepted candidates,
 * rejections, and conflicts requiring human resolution.
 */
export function normalizeSourceConnections(
  records: readonly RawSourceRecord[],
): NormalizationResult {
  const rejected: RejectedRecord[] = [];
  const byTriple = new Map<string, NormalizedSourceConnection>();

  for (const raw of records) {
    const outcome = normalizeOne(raw);
    if (!outcome.ok) {
      rejected.push(outcome.rejection);
      continue;
    }
    const key = tripleKey(outcome.value);
    const existing = byTriple.get(key);
    // Idempotency: the same triple seen twice is one candidate. The later
    // observation wins, so a re-export refreshes provenance rather than
    // duplicating it or regressing it to an older row.
    if (existing === undefined || supersedes(outcome.value, existing)) {
      byTriple.set(key, outcome.value);
    }
  }

  const candidates = [...byTriple.values()];

  const personsByIdentity = new Map<string, Set<string>>();
  const identitiesByPerson = new Map<string, Set<string>>();
  for (const candidate of candidates) {
    const persons = personsByIdentity.get(identityKey(candidate)) ?? new Set<string>();
    persons.add(candidate.personId);
    personsByIdentity.set(identityKey(candidate), persons);

    const identities = identitiesByPerson.get(personKey(candidate)) ?? new Set<string>();
    identities.add(candidate.externalId);
    identitiesByPerson.set(personKey(candidate), identities);
  }

  const poisonedIdentities = new Set<string>();
  const poisonedPersons = new Set<string>();
  const conflicts: ConflictReport[] = [];

  for (const candidate of candidates) {
    const key = identityKey(candidate);
    if (poisonedIdentities.has(key)) {
      continue;
    }
    const persons = personsByIdentity.get(key);
    if (persons === undefined || persons.size < 2) {
      continue;
    }
    poisonedIdentities.add(key);
    conflicts.push({
      kind: "external_identity_claimed_by_multiple_people",
      source: candidate.source,
      externalIdMasks: [maskIdentifier(candidate.externalId)],
      personRefs: sortedUnique([...persons].map(personRef)),
    });
  }

  for (const candidate of candidates) {
    const key = personKey(candidate);
    if (poisonedPersons.has(key)) {
      continue;
    }
    const identities = identitiesByPerson.get(key);
    if (identities === undefined || identities.size < 2) {
      continue;
    }
    poisonedPersons.add(key);
    conflicts.push({
      kind: "person_claimed_inconsistently",
      source: candidate.source,
      externalIdMasks: sortedUnique([...identities].map(maskIdentifier)),
      personRefs: [personRef(candidate.personId)],
    });
  }

  const accepted = candidates
    .filter(
      (candidate) =>
        !poisonedIdentities.has(identityKey(candidate)) &&
        !poisonedPersons.has(personKey(candidate)),
    )
    .sort(compareCandidates);

  conflicts.sort(
    (left, right) =>
      left.kind.localeCompare(right.kind) ||
      left.source.localeCompare(right.source) ||
      left.externalIdMasks.join(",").localeCompare(right.externalIdMasks.join(",")) ||
      left.personRefs.join(",").localeCompare(right.personRefs.join(",")),
  );

  return { accepted, rejected, conflicts };
}

/**
 * Summarize what an import WOULD do. A dry run is the artifact most likely to
 * be pasted into an issue, a pull request, or a chat message, so it carries
 * counts, reasons and masked identifiers, never a raw external identifier and
 * never a profile claim.
 */
export function summarizeNormalization(result: NormalizationResult): DryRunReport {
  const bySource = Object.fromEntries(
    SUPPORTED_SOURCES.map((source) => [source, 0]),
  ) as Record<SourceSystem, number>;
  for (const candidate of result.accepted) {
    bySource[candidate.source] += 1;
  }

  return {
    contractVersion: SOURCE_CONNECTION_CONTRACT_VERSION,
    accepted: result.accepted.length,
    rejected: result.rejected.length,
    conflicts: result.conflicts.length,
    bySource,
    rejections: result.rejected,
    conflictReports: result.conflicts,
  };
}

/** Normalize a batch and summarize it in one step. */
export function dryRun(records: readonly RawSourceRecord[]): DryRunReport {
  return summarizeNormalization(normalizeSourceConnections(records));
}
