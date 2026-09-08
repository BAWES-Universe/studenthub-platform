import assert from "node:assert/strict";
import test from "node:test";

import {
  DISCORD_ACCOUNT_ONE,
  PROFILE_CANARY,
  SOURCE_CONNECTION_CONTRACT_VERSION,
  SOURCE_CONNECTION_SCENARIOS,
  discordRecord,
  dryRun,
  failedScenarios,
  googleRecord,
  maskIdentifier,
  normalizeSourceConnections,
  runSourceConnectionConformance,
  type SourceConnectionScenario,
} from "../src/index.js";
import {
  emptyImplementation,
  makeFaultyImplementation,
  passthroughImplementation,
  type SourceConnectionFaults,
} from "./faulty-implementations.js";

const REAL_IMPLEMENTATION = { normalize: normalizeSourceConnections, dryRun };

function scenario(index: number): SourceConnectionScenario {
  const name = SOURCE_CONNECTION_SCENARIOS[index];
  assert.ok(name !== undefined, `scenario ${index} exists`);
  return name;
}

test("the real implementation satisfies every scenario in the contract", () => {
  const report = runSourceConnectionConformance(REAL_IMPLEMENTATION);
  assert.deepEqual(failedScenarios(report), [], JSON.stringify(report.results, null, 2));
  assert.equal(report.ok, true);
  assert.equal(report.contractVersion, SOURCE_CONNECTION_CONTRACT_VERSION);
  assert.deepEqual(
    report.results.map((result) => result.name),
    [...SOURCE_CONNECTION_SCENARIOS],
  );
  assert.equal(new Set(SOURCE_CONNECTION_SCENARIOS).size, SOURCE_CONNECTION_SCENARIOS.length);
});

test("the fixtures actually carry what the sensitive-output scenarios look for", () => {
  // Without this, the canary and raw-identifier assertions could pass simply
  // because the value was never in the input to begin with.
  for (const record of [discordRecord(), googleRecord()]) {
    assert.ok(
      JSON.stringify(record).includes(PROFILE_CANARY),
      "every synthetic record carries the profile canary in its input",
    );
  }
  assert.ok(JSON.stringify(discordRecord()).includes(DISCORD_ACCOUNT_ONE));
});

/**
 * The rule each fault disables, and every scenario that rule holds up. A fault
 * that fails more scenarios than it declares has stopped being surgical; one
 * that fails fewer means a scenario is not reading the behaviour it names.
 */
const FAULT_EXPECTATIONS: ReadonlyArray<
  readonly [keyof SourceConnectionFaults, readonly SourceConnectionScenario[]]
> = [
  ["acceptMalformedRecords", [scenario(0)]],
  ["defaultMissingProvenance", [scenario(1)]],
  ["coerceNaiveObservedAt", [scenario(2)]],
  ["matchOnProfileEmail", [scenario(3)]],
  ["emitDuplicateRows", [scenario(4)]],
  ["keepEarliestObservation", [scenario(5)]],
  ["emitInInputOrder", [scenario(6)]],
  ["acceptIdentityClaimedByMultiplePeople", [scenario(7)]],
  ["acceptPersonClaimedInconsistently", [scenario(8)]],
  ["unmaskedRejections", [scenario(9), scenario(11)]],
  ["unmaskedConflicts", [scenario(7), scenario(8), scenario(9), scenario(11)]],
  ["leakProfileInAccepted", [scenario(3), scenario(10)]],
  ["dryRunEmitsRawRecords", [scenario(11)]],
  ["cleanIdentityKeys", [scenario(12)]],
  ["collidingTripleKey", [scenario(13)]],
  ["acceptSubMillisecondPrecision", [scenario(2)]],
  ["firstObservationOnTie", [scenario(5), scenario(6)]],
  ["misattributeBySource", [scenario(11)]],
];

test("the fault wrapper with no fault set satisfies the contract", () => {
  // The control for every mutation below: if the wrapper itself broke a rule,
  // a fault's failures could not be attributed to the fault.
  const report = runSourceConnectionConformance(makeFaultyImplementation({}));
  assert.deepEqual(failedScenarios(report), [], JSON.stringify(report.results, null, 2));
});

for (const [fault, expected] of FAULT_EXPECTATIONS) {
  test(`disabling ${fault} fails exactly ${expected.length} scenario(s)`, () => {
    const report = runSourceConnectionConformance(makeFaultyImplementation({ [fault]: true }));
    assert.deepEqual(
      failedScenarios(report),
      expected,
      `${fault}: ${JSON.stringify(
        report.results.filter((result) => !result.ok),
        null,
        2,
      )}`,
    );
  });
}

test("every scenario is bound by at least one fault", () => {
  const covered = new Set(FAULT_EXPECTATIONS.flatMap(([, scenarios]) => scenarios));
  const unbound = SOURCE_CONNECTION_SCENARIOS.filter((name) => !covered.has(name));
  assert.deepEqual(unbound, [], "a scenario no fault can break is not a control");
});

test("the suite rejects implementations that break the contract with no fault flag set", () => {
  // Anti-circularity: the scenarios must read behaviour, not a flag they were
  // handed. Neither implementation below sets any flag.
  const passthrough = runSourceConnectionConformance(passthroughImplementation);
  assert.equal(passthrough.ok, false);
  for (const index of [0, 4, 7, 8, 10]) {
    assert.ok(
      failedScenarios(passthrough).includes(scenario(index)),
      `an implementation that validates nothing fails: ${scenario(index)}`,
    );
  }

  const empty = runSourceConnectionConformance(emptyImplementation);
  assert.equal(empty.ok, false);
  assert.ok(
    failedScenarios(empty).length >= 8,
    "an implementation that imports nothing fails most of the contract",
  );
});

test("masking is total and never reveals the identifier it stands for", () => {
  assert.equal(maskIdentifier(""), "***(0)");
  assert.equal(maskIdentifier("abc"), "***(3)");
  assert.equal(maskIdentifier("abcdef"), "***(6)");
  assert.equal(maskIdentifier("abcdefg"), "ab***fg(7)");
  assert.equal(maskIdentifier(DISCORD_ACCOUNT_ONE), "di***01(30)");

  for (const value of ["", "a", "abcdef", "abcdefg", DISCORD_ACCOUNT_ONE]) {
    const masked = maskIdentifier(value);
    assert.ok(
      value.length < 4 || !masked.includes(value),
      "a mask never contains the value it stands for",
    );
    const revealed = masked.replace("***", "").replace(/\(\d+\)$/, "");
    assert.ok(
      revealed.length <= 4,
      "a mask reveals at most two characters on each side of the elision",
    );
  }
});

test("a dry run is derived from the same normalization it reports on", () => {
  const records = [
    discordRecord(),
    discordRecord({ personId: "person-beta" }),
    googleRecord({ provenance: undefined }),
  ];
  const result = normalizeSourceConnections(records);
  const report = dryRun(records);

  assert.equal(report.accepted, result.accepted.length);
  assert.equal(report.rejected, result.rejected.length);
  assert.equal(report.conflicts, result.conflicts.length);
  assert.deepEqual(report.bySource, { discord: 0, google: 0 });
  assert.equal(report.conflicts, 1, "the disputed discord identity is reported");
  assert.equal(report.rejected, 1, "the record with no provenance is rejected");

  // The all-zero case above says nothing about per-source attribution, so count
  // a batch that actually imports something.
  const clean = dryRun([
    discordRecord(),
    discordRecord({ externalId: "discord-uid-000000000000000999", personId: "person-beta" }),
    googleRecord(),
  ]);
  assert.deepEqual(clean.bySource, { discord: 2, google: 1 });
  assert.equal(clean.accepted, 3);
  assert.equal(clean.rejected, 0);
  assert.equal(clean.conflicts, 0);
});
