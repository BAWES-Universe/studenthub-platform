/**
 * The executable SHU-77 source-connection contract.
 *
 * `runSourceConnectionConformance` takes an implementation and returns a report
 * naming every rule it satisfies or breaks. The scenarios are the contract; the
 * implementation in `normalize.ts` is one thing that satisfies them.
 *
 * Two properties of the suite itself matter as much as its coverage, because a
 * conformance suite that cannot fail is worse than none:
 *
 *   - Every scenario is bound by a deliberately broken variant in the test
 *     directory that fails exactly the scenarios naming its disabled rule, and
 *     passes every other one. A scenario nothing can break is not a control.
 *
 *   - The scenarios read behaviour, never a flag. The test directory runs an
 *     implementation that violates the contract with no fault flag set and
 *     requires the suite to reject it.
 *
 * All inputs are synthetic (see `fixtures.ts`). Nothing here reads an export,
 * a credential, a database, or any live system.
 */

import {
  DISCORD_ACCOUNT_ONE,
  DISCORD_ACCOUNT_TWO,
  DISCORD_PROVENANCE,
  GOOGLE_ACCOUNT_ONE,
  GOOGLE_ACCOUNT_TWO,
  GOOGLE_PROVENANCE,
  PERSON_ALPHA,
  PERSON_BETA,
  PERSON_GAMMA,
  PROFILE_CANARY,
  discordRecord,
  googleRecord,
  syntheticProfile,
} from "./fixtures.js";
import { maskIdentifier, personRef } from "./mask.js";
import {
  CONFLICT_KINDS,
  REJECTION_REASONS,
  SOURCE_CONNECTION_CONTRACT_VERSION,
  SUPPORTED_SOURCES,
  type DryRunReport,
  type NormalizationResult,
  type NormalizedSourceConnection,
  type RawSourceRecord,
  type SourceSystem,
} from "./types.js";

/** What an implementation of this contract has to provide. */
export interface SourceConnectionImplementation {
  readonly normalize: (records: readonly RawSourceRecord[]) => NormalizationResult;
  readonly dryRun: (records: readonly RawSourceRecord[]) => DryRunReport;
}

export const SOURCE_CONNECTION_SCENARIOS = [
  "required fields and supported sources are enforced",
  "provenance is mandatory and preserved verbatim",
  "observed-at must be an unambiguous instant",
  "identity is never matched on a mutable profile claim",
  "repeated and duplicated import is idempotent",
  "the latest observation of a triple wins",
  "input order does not change the accepted set",
  "one external identity claimed by several people fails closed",
  "one person claimed inconsistently by one source fails closed",
  "reports carry masked identifiers, never raw ones",
  "profile claims never survive normalization",
  "a dry run reports counts consistent with normalization and leaks nothing",
  "identity keys are exact, never cleaned",
  "distinct identifiers never collide into one candidate",
  "a report carries only closed vocabulary, masks and references",
] as const;

export type SourceConnectionScenario = (typeof SOURCE_CONNECTION_SCENARIOS)[number];

export interface ScenarioResult {
  readonly name: SourceConnectionScenario;
  readonly ok: boolean;
  readonly failures: readonly string[];
}

export interface SourceConnectionConformanceReport {
  readonly ok: boolean;
  readonly contractVersion: typeof SOURCE_CONNECTION_CONTRACT_VERSION;
  readonly results: readonly ScenarioResult[];
}

/** Collects the reasons a scenario failed rather than throwing on the first. */
class Checks {
  readonly failures: string[] = [];

  ok(condition: boolean, message: string): void {
    if (!condition) {
      this.failures.push(message);
    }
  }

  equal(actual: unknown, expected: unknown, message: string): void {
    const gotten = JSON.stringify(actual);
    const wanted = JSON.stringify(expected);
    if (gotten !== wanted) {
      this.failures.push(`${message}: expected ${wanted}, got ${gotten}`);
    }
  }
}

function tripleOf(candidate: NormalizedSourceConnection): string {
  return `${candidate.source}|${candidate.externalId}|${candidate.personId}`;
}

/**
 * The accepted set as identity triples. Scenarios compare on this rather than
 * on the accepted array so that only the two scenarios that own ordering and
 * duplication depend on either.
 */
function uniqueTriples(accepted: readonly NormalizedSourceConnection[]): readonly string[] {
  return [...new Set(accepted.map(tripleOf))].sort((a, b) => a.localeCompare(b));
}

function sortedMasks(rawIds: readonly string[]): readonly string[] {
  return rawIds.map(maskIdentifier).sort((a, b) => a.localeCompare(b));
}

type Scenario = (impl: SourceConnectionImplementation, check: Checks) => void;

/**
 * A record missing any of the five mandatory fields is rejected, and the reason
 * is decided by a fixed rule order rather than by which check happened to run
 * first. Without that order a record failing two rules could report either one,
 * and a rejection count would stop being a stable thing to assert on.
 */
const requiredFields: Scenario = (impl, check) => {
  const records = [
    discordRecord(),
    discordRecord({ source: "slack" }),
    discordRecord({ source: undefined }),
    // Rule order is fixed: an unsupported source is reported even when a later
    // rule would also reject the record.
    discordRecord({ source: "slack", externalId: undefined }),
    discordRecord({ externalId: "   " }),
    discordRecord({ externalId: DISCORD_ACCOUNT_TWO, personId: undefined }),
    discordRecord({ externalId: DISCORD_ACCOUNT_TWO, observedAt: undefined }),
    discordRecord({ source: "  DisCord  ", externalId: DISCORD_ACCOUNT_TWO, personId: PERSON_GAMMA }),
  ];

  const result = impl.normalize(records);

  check.equal(
    result.rejected.map((rejection) => rejection.reason),
    [
      "unsupported_source",
      "unsupported_source",
      "unsupported_source",
      "missing_external_id",
      "missing_person_id",
      "missing_observed_at",
    ],
    "every malformed record is rejected, with a reason fixed by rule order",
  );
  check.equal(
    uniqueTriples(result.accepted),
    [
      `discord|${DISCORD_ACCOUNT_ONE}|${PERSON_ALPHA}`,
      `discord|${DISCORD_ACCOUNT_TWO}|${PERSON_GAMMA}`,
    ],
    "only well-formed records are accepted, and source names are case- and space-insensitive",
  );
};

/**
 * Provenance is where a candidate came from, and it is the only field that lets
 * an operator go back and check a link against its source. A row that arrives
 * without one is rejected rather than imported with an invented origin, and an
 * accepted row carries the string verbatim.
 */
const provenanceRequired: Scenario = (impl, check) => {
  const records = [
    discordRecord(),
    discordRecord({ externalId: DISCORD_ACCOUNT_TWO, provenance: undefined }),
    googleRecord({ provenance: "" }),
    googleRecord({ externalId: GOOGLE_ACCOUNT_TWO, provenance: "   " }),
    googleRecord({
      externalId: GOOGLE_ACCOUNT_TWO,
      personId: PERSON_GAMMA,
      provenance: `  ${GOOGLE_PROVENANCE}  `,
    }),
  ];

  const result = impl.normalize(records);

  check.equal(
    result.rejected.map((rejection) => rejection.reason),
    ["missing_provenance", "missing_provenance", "missing_provenance"],
    "a record with no provenance is rejected, never imported with a guessed origin",
  );

  const discord = result.accepted.find((candidate) => candidate.source === "discord");
  const google = result.accepted.find((candidate) => candidate.source === "google");
  check.equal(discord?.provenance, DISCORD_PROVENANCE, "provenance is carried verbatim");
  check.equal(google?.provenance, GOOGLE_PROVENANCE, "surrounding whitespace is trimmed, not treated as absent");
  check.equal(
    uniqueTriples(result.accepted),
    [
      `discord|${DISCORD_ACCOUNT_ONE}|${PERSON_ALPHA}`,
      `google|${GOOGLE_ACCOUNT_TWO}|${PERSON_GAMMA}`,
    ],
    "only records carrying provenance become candidates",
  );
};

/**
 * `observedAt` decides which duplicate survives, so an ambiguous one is not a
 * cosmetic problem. A timestamp with no offset is local time to `Date`, which
 * would make the surviving row depend on the importing machine's timezone; a
 * date that does not exist is rolled over by `Date.parse` rather than refused,
 * which would move an observation silently. Both are rejected.
 */
const unambiguousObservedAt: Scenario = (impl, check) => {
  const records = [
    // Parsed as LOCAL time by Date, so the surviving duplicate would depend on
    // the importing machine's timezone.
    discordRecord({ observedAt: "2026-01-02T03:04:05" }),
    discordRecord({
      externalId: DISCORD_ACCOUNT_TWO,
      personId: PERSON_GAMMA,
      observedAt: "2026-01-02",
    }),
    googleRecord({ observedAt: "not-a-date" }),
    // Date.parse rolls these over instead of refusing them: 30 February becomes
    // 2 March. An observation silently moved two days is a wrong answer, not a
    // lenient one.
    googleRecord({
      externalId: GOOGLE_ACCOUNT_TWO,
      personId: PERSON_GAMMA,
      observedAt: "2026-02-30T00:00:00Z",
    }),
    discordRecord({ personId: PERSON_GAMMA, observedAt: "2026-13-01T00:00:00Z" }),
    discordRecord({
      externalId: DISCORD_ACCOUNT_TWO,
      personId: PERSON_GAMMA,
      observedAt: "2026-01-02T25:00:00Z",
    }),
    // More fractional precision than `toISOString` can store. Accepting it would
    // silently truncate, and truncation makes two distinct observations equal.
    discordRecord({ personId: PERSON_BETA, observedAt: "2026-01-02T03:04:05.0001Z" }),
    discordRecord({ observedAt: "2026-01-02T03:04:05Z" }),
    googleRecord({ observedAt: "2026-01-02T03:04:05+03:00" }),
    googleRecord({
      externalId: GOOGLE_ACCOUNT_TWO,
      personId: PERSON_GAMMA,
      observedAt: "2026-01-02T03:04:05.123+00:00",
    }),
  ];

  const result = impl.normalize(records);

  check.equal(
    result.rejected.map((rejection) => rejection.reason),
    [
      "malformed_observed_at",
      "malformed_observed_at",
      "malformed_observed_at",
      "malformed_observed_at",
      "malformed_observed_at",
      "malformed_observed_at",
      "malformed_observed_at",
    ],
    "a timestamp without an explicit offset, one that is not a real instant, or one carrying precision that cannot be stored, is rejected",
  );
  check.equal(
    result.accepted.find((candidate) => candidate.externalId === GOOGLE_ACCOUNT_TWO)?.observedAt,
    "2026-01-02T03:04:05.123Z",
    "millisecond precision, which can be stored, is kept",
  );
  check.equal(
    result.accepted.find((candidate) => candidate.source === "discord")?.observedAt,
    "2026-01-02T03:04:05.000Z",
    "an accepted observation is normalized to UTC",
  );
  check.equal(
    result.accepted.find((candidate) => candidate.source === "google")?.observedAt,
    "2026-01-02T00:04:05.000Z",
    "an offset observation is converted to the same instant in UTC",
  );
};

/**
 * The rule SHU-29 exists to protect, checked in both directions: two people
 * sharing every mutable claim must not merge, and one identity carrying
 * differing claims must not split. Only the first direction is the dangerous
 * one, but an implementation that got the second wrong would be keying on
 * profile data just as much.
 */
const neverMatchOnProfile: Scenario = (impl, check) => {
  // Two different people sharing every mutable claim. SHU-29 refuses to match
  // identities on such claims; an importer that matches on them reintroduces
  // exactly what that refusal exists to prevent.
  const shared = syntheticProfile("shared-claimant");
  const collidingClaims = impl.normalize([
    discordRecord({ externalId: DISCORD_ACCOUNT_ONE, personId: PERSON_ALPHA, profile: shared }),
    discordRecord({ externalId: DISCORD_ACCOUNT_TWO, personId: PERSON_BETA, profile: shared }),
  ]);

  check.equal(
    uniqueTriples(collidingClaims.accepted),
    [
      `discord|${DISCORD_ACCOUNT_ONE}|${PERSON_ALPHA}`,
      `discord|${DISCORD_ACCOUNT_TWO}|${PERSON_BETA}`,
    ],
    "identical profile claims across two people never merge, rename, or drop a candidate",
  );
  check.equal(collidingClaims.conflicts.length, 0, "a shared profile claim is not itself a conflict");

  // The mirror case: one identity, differing claims, still one candidate.
  const differingClaims = impl.normalize([
    discordRecord({ profile: syntheticProfile("claim-a") }),
    discordRecord({ profile: syntheticProfile("claim-b") }),
  ]);
  check.equal(
    uniqueTriples(differingClaims.accepted),
    [`discord|${DISCORD_ACCOUNT_ONE}|${PERSON_ALPHA}`],
    "differing profile claims on one identity do not split it into two candidates",
  );

  const withClaimA = impl.normalize([discordRecord({ profile: syntheticProfile("claim-a") })]);
  const withClaimB = impl.normalize([discordRecord({ profile: syntheticProfile("claim-b") })]);
  check.equal(withClaimA, withClaimB, "the profile claims of a record change nothing about its output");
};

/**
 * Re-running an export must not accumulate. Rows collapse on the identity
 * triple, so the same row three times is one candidate, and normalizing the
 * same batch twice gives the same result. This is the one scenario that asserts
 * on exact accepted counts; every other scenario compares unique triples, so
 * that duplication has exactly one control.
 */
const idempotent: Scenario = (impl, check) => {
  const batch = [
    discordRecord(),
    googleRecord(),
    discordRecord(),
    discordRecord({ externalId: DISCORD_ACCOUNT_TWO, personId: PERSON_GAMMA }),
  ];

  const first = impl.normalize(batch);
  const second = impl.normalize(batch);
  check.equal(first, second, "normalizing the same batch twice gives the same result");

  const repeated = impl.normalize([discordRecord(), discordRecord(), discordRecord()]);
  check.equal(repeated.accepted.length, 1, "the same row three times is one candidate, not three");

  check.equal(
    first.accepted.length,
    uniqueTriples(first.accepted).length,
    "no identity triple appears more than once in the accepted set",
  );
  check.equal(
    uniqueTriples(first.accepted),
    [
      `discord|${DISCORD_ACCOUNT_ONE}|${PERSON_ALPHA}`,
      `discord|${DISCORD_ACCOUNT_TWO}|${PERSON_GAMMA}`,
      `google|${GOOGLE_ACCOUNT_ONE}|${PERSON_BETA}`,
    ],
    "a batch with a repeated row yields one candidate per distinct triple",
  );
};

/**
 * The other half of idempotency: when the same triple appears twice, the later
 * observation survives and brings its provenance with it. Checked in both input
 * orders, because an implementation that simply kept the last row it saw would
 * pass one order and fail the other.
 */
const latestObservationWins: Scenario = (impl, check) => {
  const older = discordRecord({
    observedAt: "2026-01-01T00:00:00Z",
    provenance: "synthetic-fixture/discord-export-older",
  });
  const newer = discordRecord({
    observedAt: "2026-03-01T00:00:00Z",
    provenance: "synthetic-fixture/discord-export-newer",
  });

  for (const [label, batch] of [
    ["older row first", [older, newer]],
    ["newer row first", [newer, older]],
  ] as const) {
    const result = impl.normalize(batch);
    const candidate = result.accepted[0];
    check.ok(candidate !== undefined, `${label}: the triple is accepted`);
    check.equal(
      candidate?.observedAt,
      "2026-03-01T00:00:00.000Z",
      `${label}: the later observation survives`,
    );
    check.equal(
      candidate?.provenance,
      "synthetic-fixture/discord-export-newer",
      `${label}: a re-export refreshes provenance rather than regressing it`,
    );
  }

  // Two observations of one triple at the SAME instant. "Keep what is already
  // there" would make the survivor depend on export order, so the tie is broken
  // on the records themselves.
  const tied = [
    discordRecord({ provenance: "synthetic-fixture/discord-export-aaa" }),
    discordRecord({ provenance: "synthetic-fixture/discord-export-zzz" }),
  ];
  const tieForward = impl.normalize(tied).accepted[0]?.provenance;
  const tieReversed = impl.normalize([...tied].reverse()).accepted[0]?.provenance;
  check.equal(tieForward, tieReversed, "an equal-timestamp tie resolves the same way in either order");
};

/**
 * The accepted set is a function of the records, not of the order a donor
 * happened to export them in. Without this, "re-running gives the same result"
 * would hold only for a byte-identical export, which is not what an operator
 * re-running an import actually has.
 */
const orderIndependent: Scenario = (impl, check) => {
  const batch = [
    discordRecord(),
    googleRecord(),
    discordRecord({ externalId: DISCORD_ACCOUNT_TWO, personId: PERSON_GAMMA }),
    googleRecord({ externalId: GOOGLE_ACCOUNT_TWO, personId: PERSON_GAMMA }),
    discordRecord({ personId: PERSON_BETA }),
    // Same triple as the third row, same instant, different provenance: the
    // case where "first one wins" and "last one wins" diverge.
    discordRecord({
      externalId: DISCORD_ACCOUNT_TWO,
      personId: PERSON_GAMMA,
      provenance: "synthetic-fixture/discord-export-zzz",
    }),
  ];

  const forward = impl.normalize(batch);
  const reversed = impl.normalize([...batch].reverse());

  check.equal(
    forward.accepted,
    reversed.accepted,
    "the accepted set does not depend on the order the export happened to be in",
  );
  check.equal(
    forward.conflicts,
    reversed.conflicts,
    "conflict reports do not depend on the order the export happened to be in",
  );
};

/**
 * One external account claimed by two people is unresolvable from the export
 * alone, so NEITHER claim is imported and the dispute is reported. The scenario
 * also checks that an unrelated record in the same batch is still accepted:
 * failing closed means withholding the ambiguous link, not the whole import.
 */
const identityClaimedByMultiplePeople: Scenario = (impl, check) => {
  const result = impl.normalize([
    discordRecord({ personId: PERSON_ALPHA }),
    discordRecord({ personId: PERSON_BETA }),
    googleRecord({ personId: PERSON_GAMMA }),
  ]);

  const claimed = result.conflicts.filter(
    (conflict) => conflict.kind === "external_identity_claimed_by_multiple_people",
  );
  check.equal(claimed.length, 1, "one disputed identity produces exactly one conflict report");
  check.equal(claimed[0]?.source, "discord", "the conflict names the source it came from");
  check.equal(
    claimed[0]?.personRefs,
    [PERSON_ALPHA, PERSON_BETA].map(personRef).sort((a, b) => a.localeCompare(b)),
    "the conflict references every person claiming the identity, in a stable order",
  );
  check.equal(
    claimed[0]?.externalIdMasks,
    sortedMasks([DISCORD_ACCOUNT_ONE]),
    "the conflict identifies the disputed account by mask",
  );
  check.equal(
    uniqueTriples(result.accepted),
    [`google|${GOOGLE_ACCOUNT_ONE}|${PERSON_GAMMA}`],
    "neither claimant is imported, and the unrelated record still is",
  );
};

/**
 * The mirror case: one person claimed by one source under two external ids.
 * Deliberately conservative — `external_identities` permits a person to hold
 * many identities, and two accounts may be legitimate, but an importer cannot
 * tell that from a mis-keyed export row, and a wrong link is permanent while a
 * withheld one is re-runnable. Scoped to a single source: the same person
 * holding one Discord and one Google identity is not a conflict, which this
 * scenario also pins.
 */
const personClaimedInconsistently: Scenario = (impl, check) => {
  const result = impl.normalize([
    discordRecord({ externalId: DISCORD_ACCOUNT_ONE, personId: PERSON_ALPHA }),
    discordRecord({ externalId: DISCORD_ACCOUNT_TWO, personId: PERSON_ALPHA }),
    // One person legitimately holds one identity per source, so this row is not
    // part of the ambiguity.
    googleRecord({ externalId: GOOGLE_ACCOUNT_ONE, personId: PERSON_ALPHA }),
  ]);

  const inconsistent = result.conflicts.filter(
    (conflict) => conflict.kind === "person_claimed_inconsistently",
  );
  check.equal(inconsistent.length, 1, "one inconsistently claimed person produces exactly one conflict report");
  check.equal(inconsistent[0]?.source, "discord", "the conflict is scoped to the source that produced it");
  check.equal(
    inconsistent[0]?.personRefs,
    [personRef(PERSON_ALPHA)],
    "the conflict references the person in dispute",
  );
  check.equal(
    inconsistent[0]?.externalIdMasks,
    sortedMasks([DISCORD_ACCOUNT_ONE, DISCORD_ACCOUNT_TWO]),
    "the conflict lists every competing account by mask, in a stable order",
  );
  check.equal(
    uniqueTriples(result.accepted),
    [`google|${GOOGLE_ACCOUNT_ONE}|${PERSON_ALPHA}`],
    "neither competing account is imported, and the other source is unaffected",
  );
};

/**
 * Rejections and conflicts are the output most likely to be pasted into an
 * issue, a chat message, or a log, and they are about records that failed — so
 * they carry masks, never the identifier itself. Asserted by searching the
 * serialized reports for the raw values, not by checking that a field is named
 * "mask".
 */
const reportsAreMasked: Scenario = (impl, check) => {
  const result = impl.normalize([
    discordRecord({ observedAt: "not-a-date" }),
    discordRecord({ externalId: DISCORD_ACCOUNT_TWO, personId: PERSON_ALPHA }),
    discordRecord({ externalId: DISCORD_ACCOUNT_TWO, personId: PERSON_BETA }),
  ]);

  const serialized = JSON.stringify({ rejected: result.rejected, conflicts: result.conflicts });
  // A person id can be an email address under `sub_mode = user_email`, so it is
  // no safer in a report than an external id is.
  for (const personId of [PERSON_ALPHA, PERSON_BETA]) {
    check.ok(
      !serialized.includes(personId),
      `reports must not contain the raw person id behind ${personRef(personId).slice(0, 8)}...`,
    );
  }
  for (const rawId of [DISCORD_ACCOUNT_ONE, DISCORD_ACCOUNT_TWO]) {
    // The message carries the mask, never the value it is complaining about.
    check.ok(
      !serialized.includes(rawId),
      `reports must not contain the raw identifier behind ${maskIdentifier(rawId)}`,
    );
  }
  check.equal(
    result.rejected.map((rejection) => rejection.externalIdMask),
    sortedMasks([DISCORD_ACCOUNT_ONE]),
    "a rejection identifies its record by mask",
  );
  check.equal(result.conflicts.length, 1, "the disputed identity is reported");
};

/**
 * Mutable claims are carried into normalization and must not come out of it,
 * anywhere: not on a candidate, not in a rejection, not in a conflict. Checked
 * with a canary planted in the input rather than by asserting the absence of a
 * `profile` field, because an implementation that inlined the same value under
 * another name would pass the second check and fail this one.
 */
const profileNeverSurvives: Scenario = (impl, check) => {
  const result = impl.normalize([
    discordRecord(),
    discordRecord({ externalId: DISCORD_ACCOUNT_TWO, personId: PERSON_BETA }),
    discordRecord({ externalId: DISCORD_ACCOUNT_TWO, personId: PERSON_GAMMA }),
    googleRecord({ observedAt: "not-a-date" }),
  ]);

  check.ok(
    !JSON.stringify(result).includes(PROFILE_CANARY),
    "no mutable profile claim from the input appears anywhere in the output",
  );
  for (const candidate of result.accepted) {
    check.equal(
      Object.keys(candidate).sort((a, b) => a.localeCompare(b)),
      ["contractVersion", "externalId", "observedAt", "personId", "provenance", "source"],
      "an accepted candidate carries the contract fields and nothing else",
    );
  }
};

/**
 * A dry run is what someone reads before deciding to import, so it has to agree
 * with the normalization it describes — a count that drifts from the result is
 * worse than no count. It must also be safe to circulate: no raw identifier and
 * no profile claim.
 */
const dryRunIsConsistentAndClean: Scenario = (impl, check) => {
  const records = [
    discordRecord(),
    discordRecord({ externalId: DISCORD_ACCOUNT_TWO, personId: PERSON_BETA }),
    discordRecord({ externalId: DISCORD_ACCOUNT_TWO, personId: PERSON_GAMMA }),
    googleRecord(),
    googleRecord({ externalId: GOOGLE_ACCOUNT_TWO, provenance: undefined }),
  ];

  const result = impl.normalize(records);
  const report = impl.dryRun(records);

  check.equal(report.contractVersion, SOURCE_CONNECTION_CONTRACT_VERSION, "the report names the contract version");
  check.equal(report.accepted, result.accepted.length, "the accepted count matches normalization");
  check.equal(report.rejected, result.rejected.length, "the rejected count matches normalization");
  check.equal(report.conflicts, result.conflicts.length, "the conflict count matches normalization");
  check.equal(report.rejections, result.rejected, "the report carries the same rejections");
  check.equal(report.conflictReports, result.conflicts, "the report carries the same conflicts");

  // A total-only check passes for {discord: 2, google: 0} when the accepted set
  // is one of each, so the split is compared source by source.
  const expectedBySource = Object.fromEntries(
    SUPPORTED_SOURCES.map((source) => [source, 0]),
  ) as Record<SourceSystem, number>;
  for (const candidate of result.accepted) {
    expectedBySource[candidate.source] += 1;
  }
  for (const source of SUPPORTED_SOURCES) {
    check.equal(
      report.bySource[source],
      expectedBySource[source],
      `the ${source} count matches the accepted set`,
    );
  }
  check.equal(
    Object.keys(report.bySource).sort((a, b) => a.localeCompare(b)),
    [...SUPPORTED_SOURCES].sort((a, b) => a.localeCompare(b)),
    "every supported source is reported, including the ones with no candidates",
  );

  const serialized = JSON.stringify(report);
  check.ok(!serialized.includes(PROFILE_CANARY), "a dry run carries no profile claim");
  for (const personId of [PERSON_ALPHA, PERSON_BETA, PERSON_GAMMA]) {
    check.ok(
      !serialized.includes(personId),
      `a dry run carries no raw person id, including the one behind ${personRef(personId).slice(0, 8)}...`,
    );
  }
  for (const rawId of [DISCORD_ACCOUNT_ONE, DISCORD_ACCOUNT_TWO, GOOGLE_ACCOUNT_ONE, GOOGLE_ACCOUNT_TWO]) {
    check.ok(
      !serialized.includes(rawId),
      `a dry run carries no raw identifier, including the one behind ${maskIdentifier(rawId)}`,
    );
  }
};

/**
 * The two identity keys are used verbatim. Cleaning them is not a courtesy: an
 * export row padded to " z " and a genuine row for "z" are different strings,
 * and trimming one into the other merges a link into an account that did not
 * claim it. A key that would need cleaning is malformed, and deciding what to
 * do about it belongs to the mapping adapter, where a human can see it.
 */
const exactIdentityKeys: Scenario = (impl, check) => {
  const result = impl.normalize([
    discordRecord({ externalId: ` ${DISCORD_ACCOUNT_ONE} ` }),
    discordRecord({ externalId: DISCORD_ACCOUNT_TWO, personId: `${PERSON_ALPHA} ` }),
    discordRecord({ externalId: DISCORD_ACCOUNT_TWO, personId: PERSON_GAMMA }),
  ]);

  check.equal(
    result.rejected.map((rejection) => rejection.reason),
    ["malformed_external_id", "malformed_person_id"],
    "an identity key carrying edge whitespace is rejected, not quietly cleaned",
  );
  check.equal(
    uniqueTriples(result.accepted),
    [`discord|${DISCORD_ACCOUNT_TWO}|${PERSON_GAMMA}`],
    "the padded rows do not merge into the identity they would have been cleaned into",
  );

  // Only the EDGES are the problem. What is inside an identifier is the donor's
  // business, and is carried through untouched.
  const inner = impl.normalize([discordRecord({ externalId: "discord-uid-with inner space" })]);
  check.equal(
    inner.accepted[0]?.externalId,
    "discord-uid-with inner space",
    "an identifier is carried verbatim, inner whitespace included",
  );
};

/**
 * Two distinct identity triples must stay two candidates. Joining the parts of
 * a key with a separator collapses them when an identifier contains that
 * separator: ("a b", "c") and ("a", "b c") both render as "a b c", and whichever
 * arrives second is silently dropped. Nothing constrains a donor identifier's
 * characters, so the key encoding cannot assume any are unused.
 */
const distinctIdentifiersNeverCollide: Scenario = (impl, check) => {
  const result = impl.normalize([
    discordRecord({ externalId: "collide-a collide-b", personId: "collide-c" }),
    discordRecord({ externalId: "collide-a", personId: "collide-b collide-c" }),
  ]);

  const triples = uniqueTriples(result.accepted);
  check.equal(triples.length, 2, "two distinct identity triples remain two candidates");
  check.ok(
    triples.includes("discord|collide-a collide-b|collide-c"),
    "the candidate whose external id contains the separator survives",
  );
  check.ok(
    triples.includes("discord|collide-a|collide-b collide-c"),
    "the candidate whose person id contains the separator survives",
  );
  check.equal(result.conflicts.length, 0, "two different people holding two different accounts is not a conflict");
};

/** Every string shape a report is allowed to contain. */
const MASK_SHAPE = /^(?:\*\*\*|.{2}\*\*\*.{2})\(\d+\)$/;
const REF_SHAPE = /^[0-9a-f]{64}$/;

function collectStrings(value: unknown, found: string[]): void {
  if (typeof value === "string") {
    found.push(value);
  } else if (Array.isArray(value)) {
    for (const item of value) {
      collectStrings(item, found);
    }
  } else if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) {
      collectStrings(item, found);
    }
  }
}

/**
 * The structural version of the secrecy rules, and the reason they are not just
 * three canaries.
 *
 * Chasing individual leaks finds the fields you thought of: the profile canary
 * caught `profile`, and a person canary caught `personIds`, but an unsupported
 * `source` was echoed verbatim past both because nobody had thought of it. So
 * this inverts the check. Every string a report contains must match one of the
 * shapes the contract defines -- a closed vocabulary value, a mask, a
 * reference, or the version -- and a field carrying anything else fails without
 * anyone having to guess in advance which field it will be.
 */
const reportsCarryOnlyApprovedShapes: Scenario = (impl, check) => {
  const untrusted = "operator@example.invalid";
  const records = [
    // An unsupported source, shaped like an address a donor might really carry.
    discordRecord({ source: untrusted }),
    discordRecord({ observedAt: "not-a-date" }),
    discordRecord({ externalId: DISCORD_ACCOUNT_TWO, personId: PERSON_ALPHA }),
    discordRecord({ externalId: DISCORD_ACCOUNT_TWO, personId: PERSON_BETA }),
    googleRecord(),
  ];

  const allowed = new Set<string>([
    SOURCE_CONNECTION_CONTRACT_VERSION,
    ...SUPPORTED_SOURCES,
    "unsupported",
    ...REJECTION_REASONS,
    ...CONFLICT_KINDS,
  ]);
  const approved = (value: string): boolean =>
    allowed.has(value) || MASK_SHAPE.test(value) || REF_SHAPE.test(value);

  for (const [label, payload] of [
    ["normalization reports", (() => {
      const result = impl.normalize(records);
      return { rejected: result.rejected, conflicts: result.conflicts };
    })()],
    ["the dry run", impl.dryRun(records)],
  ] as const) {
    const strings: string[] = [];
    collectStrings(payload, strings);
    const unapproved = [...new Set(strings.filter((value) => !approved(value)))];
    check.equal(
      unapproved.map(maskIdentifier),
      [],
      `${label} may contain only closed vocabulary, masks and references`,
    );
  }

  // And the specific case that motivated the rule.
  check.ok(
    !JSON.stringify(impl.dryRun(records)).includes(untrusted),
    "an unrecognized source is never echoed back into a report",
  );
};

const SCENARIO_TABLE: Readonly<Record<SourceConnectionScenario, Scenario>> = {
  "required fields and supported sources are enforced": requiredFields,
  "provenance is mandatory and preserved verbatim": provenanceRequired,
  "observed-at must be an unambiguous instant": unambiguousObservedAt,
  "identity is never matched on a mutable profile claim": neverMatchOnProfile,
  "repeated and duplicated import is idempotent": idempotent,
  "the latest observation of a triple wins": latestObservationWins,
  "input order does not change the accepted set": orderIndependent,
  "one external identity claimed by several people fails closed": identityClaimedByMultiplePeople,
  "one person claimed inconsistently by one source fails closed": personClaimedInconsistently,
  "reports carry masked identifiers, never raw ones": reportsAreMasked,
  "profile claims never survive normalization": profileNeverSurvives,
  "a dry run reports counts consistent with normalization and leaks nothing": dryRunIsConsistentAndClean,
  "identity keys are exact, never cleaned": exactIdentityKeys,
  "distinct identifiers never collide into one candidate": distinctIdentifiersNeverCollide,
  "a report carries only closed vocabulary, masks and references": reportsCarryOnlyApprovedShapes,
};

/**
 * Run every scenario against an implementation. A scenario that throws fails
 * that scenario rather than aborting the run, so one broken rule does not hide
 * the state of the others.
 */
export function runSourceConnectionConformance(
  implementation: SourceConnectionImplementation,
): SourceConnectionConformanceReport {
  const results: ScenarioResult[] = SOURCE_CONNECTION_SCENARIOS.map((name) => {
    const check = new Checks();
    try {
      SCENARIO_TABLE[name](implementation, check);
    } catch (error) {
      check.failures.push(`threw: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { name, ok: check.failures.length === 0, failures: [...check.failures] };
  });

  return {
    ok: results.every((result) => result.ok),
    contractVersion: SOURCE_CONNECTION_CONTRACT_VERSION,
    results,
  };
}

/** The scenarios an implementation failed, in contract order. */
export function failedScenarios(
  report: SourceConnectionConformanceReport,
): readonly SourceConnectionScenario[] {
  return report.results.filter((result) => !result.ok).map((result) => result.name);
}
