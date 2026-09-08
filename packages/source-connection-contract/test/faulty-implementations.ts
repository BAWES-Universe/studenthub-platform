/**
 * Deliberately broken implementations of the SHU-77 source-connection contract.
 *
 * Each fault flag disables exactly one rule the contract states, by wrapping the
 * real implementation and either relaxing its input or corrupting its output.
 * Wrapping rather than reimplementing is deliberate: it keeps every fault
 * surgical, so "this fault fails exactly these scenarios" is a claim about the
 * scenario, not about a second, differently broken normalizer.
 *
 * The suite requires three things of this file, and all three are asserted in
 * `source-connection-contract.test.ts`:
 *
 *   - With NO fault set, the wrapper passes every scenario. Otherwise a fault's
 *     failures could not be attributed to the fault.
 *   - Each fault fails exactly its declared set of scenarios, and passes all the
 *     others.
 *   - The two implementations at the end break the contract with no flag set at
 *     all, and the suite must still reject them. A harness that reads flags
 *     rather than behaviour would let them through.
 *
 * Nothing here is wired into anything but the tests.
 */

import {
  SOURCE_CONNECTION_CONTRACT_VERSION,
  SUPPORTED_SOURCES,
  maskIdentifier,
  normalizeSourceConnections,
  summarizeNormalization,
  type DryRunReport,
  type NormalizationResult,
  type NormalizedSourceConnection,
  type RawSourceRecord,
  type SourceConnectionImplementation,
  type SourceSystem,
} from "../src/index.js";

export interface SourceConnectionFaults {
  /** Fills in a missing source, external id, person id, or observation time. */
  readonly acceptMalformedRecords?: boolean;
  /** Invents an origin for a record that arrived without one. */
  readonly defaultMissingProvenance?: boolean;
  /** Treats a timezone-less timestamp as UTC instead of rejecting it. */
  readonly coerceNaiveObservedAt?: boolean;
  /** Merges people who share a mutable profile claim. */
  readonly matchOnProfileEmail?: boolean;
  /** Emits one row per input occurrence instead of one per identity triple. */
  readonly emitDuplicateRows?: boolean;
  /** Keeps the first observation of a triple rather than the latest. */
  readonly keepEarliestObservation?: boolean;
  /** Emits candidates in the order the export happened to be in. */
  readonly emitInInputOrder?: boolean;
  /** Imports both claimants of a disputed external identity. */
  readonly acceptIdentityClaimedByMultiplePeople?: boolean;
  /** Imports every competing account of an inconsistently claimed person. */
  readonly acceptPersonClaimedInconsistently?: boolean;
  /** Puts raw external identifiers into rejection reports. */
  readonly unmaskedRejections?: boolean;
  /** Puts raw external identifiers into conflict reports. */
  readonly unmaskedConflicts?: boolean;
  /** Carries the donor's mutable profile claims into accepted candidates. */
  readonly leakProfileInAccepted?: boolean;
  /** Attaches the raw input rows to the dry-run report. */
  readonly dryRunEmitsRawRecords?: boolean;
}

const STRICT_INSTANT =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const NAIVE_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?$/;
const NAIVE_DATE = /^\d{4}-\d{2}-\d{2}$/;

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function tripleOf(source: string, externalId: string, personId: string): string {
  return `${source}|${externalId}|${personId}`;
}

function candidateTriple(candidate: NormalizedSourceConnection): string {
  return tripleOf(candidate.source, candidate.externalId, candidate.personId);
}

function rawTriple(record: RawSourceRecord): string {
  return tripleOf(str(record.source).toLowerCase(), str(record.externalId), str(record.personId));
}

function sortCandidates(
  candidates: readonly NormalizedSourceConnection[],
): NormalizedSourceConnection[] {
  return [...candidates].sort(
    (left, right) =>
      left.source.localeCompare(right.source) ||
      left.externalId.localeCompare(right.externalId) ||
      left.personId.localeCompare(right.personId),
  );
}

function profileEmail(record: RawSourceRecord): string | undefined {
  const value = record.profile?.["email"];
  return typeof value === "string" ? value : undefined;
}

/**
 * Relax the INPUT so the real implementation accepts what the contract says it
 * must reject. Used by the faults that disable a validation rule: filling a
 * missing field in is indistinguishable, from the normalizer's side, from an
 * implementation that never required it.
 */
function preprocess(
  records: readonly RawSourceRecord[],
  faults: SourceConnectionFaults,
): RawSourceRecord[] {
  return records.map((record, index) => {
    let next = record;

    if (faults.acceptMalformedRecords) {
      const known = (SUPPORTED_SOURCES as readonly string[]).includes(
        str(next.source).toLowerCase(),
      );
      next = {
        ...next,
        source: known ? next.source : "discord",
        externalId: str(next.externalId) === "" ? `synthesized-external-id-${index}` : next.externalId,
        personId: str(next.personId) === "" ? `synthesized-person-${index}` : next.personId,
        observedAt: str(next.observedAt) === "" ? "2026-01-01T00:00:00Z" : next.observedAt,
      };
    }

    if (faults.defaultMissingProvenance && str(next.provenance) === "") {
      next = { ...next, provenance: "unknown-export" };
    }

    if (faults.coerceNaiveObservedAt) {
      const observed = str(next.observedAt);
      if (NAIVE_DATE_TIME.test(observed)) {
        next = { ...next, observedAt: `${observed}Z` };
      } else if (NAIVE_DATE.test(observed)) {
        next = { ...next, observedAt: `${observed}T00:00:00Z` };
      }
    }

    return next;
  });
}

/**
 * Normalize each partition on its own and union the results. Splitting on
 * `personId` hides the "one identity, several people" conflict; splitting on
 * `externalId` hides the "one person, several accounts" one. Conflicts and
 * rejections still come from the whole-batch run, so only the accepted set
 * changes.
 */
function unionOverPartitions(
  records: readonly RawSourceRecord[],
  keyOf: (record: RawSourceRecord) => string,
): NormalizationResult {
  const whole = normalizeSourceConnections(records);
  const partitions = new Map<string, RawSourceRecord[]>();
  for (const record of records) {
    const key = keyOf(record);
    const bucket = partitions.get(key) ?? [];
    bucket.push(record);
    partitions.set(key, bucket);
  }

  const byTriple = new Map<string, NormalizedSourceConnection>();
  for (const bucket of partitions.values()) {
    for (const candidate of normalizeSourceConnections(bucket).accepted) {
      byTriple.set(candidateTriple(candidate), candidate);
    }
  }

  return {
    accepted: sortCandidates([...byTriple.values()]),
    rejected: whole.rejected,
    conflicts: whole.conflicts,
  };
}

/**
 * Corrupt the OUTPUT of the real implementation. Used by the faults that break
 * a rule the normalizer applies after validation: deduplication, ordering,
 * conflict withholding, masking, and profile exclusion.
 */
function postprocess(
  result: NormalizationResult,
  records: readonly RawSourceRecord[],
  faults: SourceConnectionFaults,
): NormalizationResult {
  let accepted: NormalizedSourceConnection[] = [...result.accepted];
  let rejected = [...result.rejected];
  let conflicts = [...result.conflicts];

  if (faults.matchOnProfileEmail) {
    const canonicalByEmail = new Map<string, string>();
    const overrideByPerson = new Map<string, string>();
    for (const record of records) {
      const email = profileEmail(record);
      const personId = str(record.personId);
      if (email === undefined || personId === "") {
        continue;
      }
      const canonical = canonicalByEmail.get(email) ?? personId;
      canonicalByEmail.set(email, canonical);
      overrideByPerson.set(personId, canonical);
    }
    const byTriple = new Map<string, NormalizedSourceConnection>();
    for (const candidate of accepted) {
      const merged: NormalizedSourceConnection = {
        ...candidate,
        personId: overrideByPerson.get(candidate.personId) ?? candidate.personId,
      };
      byTriple.set(candidateTriple(merged), merged);
    }
    accepted = sortCandidates([...byTriple.values()]);
  }

  if (faults.keepEarliestObservation) {
    accepted = accepted.map((candidate) => {
      let earliest = candidate;
      for (const record of records) {
        if (rawTriple(record) !== candidateTriple(candidate)) {
          continue;
        }
        const observed = str(record.observedAt);
        if (!STRICT_INSTANT.test(observed)) {
          continue;
        }
        const iso = new Date(Date.parse(observed)).toISOString();
        if (iso < earliest.observedAt) {
          earliest = { ...candidate, observedAt: iso, provenance: str(record.provenance) };
        }
      }
      return earliest;
    });
  }

  if (faults.emitDuplicateRows) {
    accepted = accepted.flatMap((candidate) => [candidate, candidate]);
  }

  if (faults.emitInInputOrder) {
    const firstIndex = new Map<string, number>();
    records.forEach((record, index) => {
      const key = rawTriple(record);
      if (!firstIndex.has(key)) {
        firstIndex.set(key, index);
      }
    });
    accepted = [...accepted].sort(
      (left, right) =>
        (firstIndex.get(candidateTriple(left)) ?? 0) - (firstIndex.get(candidateTriple(right)) ?? 0),
    );
  }

  if (faults.unmaskedRejections) {
    const rawRejectedIds = records
      .filter((record) => normalizeSourceConnections([record]).rejected.length === 1)
      .map((record) => str(record.externalId));
    rejected = rejected.map((rejection, index) => ({
      ...rejection,
      externalIdMask: rawRejectedIds[index] || rejection.externalIdMask,
    }));
  }

  if (faults.unmaskedConflicts) {
    const rawByMask = new Map<string, string>();
    for (const record of records) {
      const externalId = str(record.externalId);
      if (externalId !== "") {
        rawByMask.set(maskIdentifier(externalId), externalId);
      }
    }
    conflicts = conflicts.map((conflict) => ({
      ...conflict,
      externalIdMasks: conflict.externalIdMasks.map((mask) => rawByMask.get(mask) ?? mask),
    }));
  }

  if (faults.leakProfileInAccepted) {
    accepted = accepted.map((candidate) => {
      const origin = records.find((record) => rawTriple(record) === candidateTriple(candidate));
      return { ...candidate, profile: origin?.profile } as unknown as NormalizedSourceConnection;
    });
  }

  return { accepted, rejected, conflicts };
}

/**
 * Build an implementation that breaks exactly the rules named by `faults`.
 *
 * With no fault set this is the real implementation and must satisfy the whole
 * contract; that is the control every mutation below is measured against. `dryRun`
 * is derived from THIS `normalize` via the real `summarizeNormalization`, so a
 * fault's counts stay self-consistent and only the fault under test can move a
 * scenario.
 */
export function makeFaultyImplementation(
  faults: SourceConnectionFaults = {},
): SourceConnectionImplementation {
  const normalize = (records: readonly RawSourceRecord[]): NormalizationResult => {
    const input = preprocess(records, faults);
    let result: NormalizationResult;
    if (faults.acceptIdentityClaimedByMultiplePeople) {
      result = unionOverPartitions(input, (record) => str(record.personId));
    } else if (faults.acceptPersonClaimedInconsistently) {
      result = unionOverPartitions(input, (record) => str(record.externalId));
    } else {
      result = normalizeSourceConnections(input);
    }
    return postprocess(result, input, faults);
  };

  const dryRun = (records: readonly RawSourceRecord[]): DryRunReport => {
    const report = summarizeNormalization(normalize(records));
    if (faults.dryRunEmitsRawRecords) {
      return { ...report, records } as unknown as DryRunReport;
    }
    return report;
  };

  return { normalize, dryRun };
}

/**
 * An implementation that validates nothing and detects nothing, with no fault
 * flag set. The suite must reject it on behaviour alone.
 */
export const passthroughImplementation: SourceConnectionImplementation = {
  normalize: (records: readonly RawSourceRecord[]): NormalizationResult => ({
    accepted: records.map(
      (record) =>
        ({
          contractVersion: SOURCE_CONNECTION_CONTRACT_VERSION,
          source: (str(record.source).toLowerCase() || "discord") as SourceSystem,
          externalId: str(record.externalId),
          personId: str(record.personId),
          provenance: str(record.provenance),
          observedAt: str(record.observedAt),
          profile: record.profile,
        }) as unknown as NormalizedSourceConnection,
    ),
    rejected: [],
    conflicts: [],
  }),
  dryRun: (records: readonly RawSourceRecord[]): DryRunReport =>
    summarizeNormalization(passthroughImplementation.normalize(records)),
};

/** An implementation that imports nothing and reports nothing, with no fault flag set. */
export const emptyImplementation: SourceConnectionImplementation = {
  normalize: (): NormalizationResult => ({ accepted: [], rejected: [], conflicts: [] }),
  dryRun: (): DryRunReport =>
    summarizeNormalization({ accepted: [], rejected: [], conflicts: [] }),
};
