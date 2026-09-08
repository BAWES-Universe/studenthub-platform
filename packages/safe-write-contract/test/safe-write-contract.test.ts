import assert from "node:assert/strict";
import test from "node:test";

import {
  OWNER_PERSON_REF,
  OWNER_PRINCIPAL_REF,
  PROFILE_CANARY,
  SAFE_WRITE_CONTRACT_VERSION,
  SAFE_WRITE_SCENARIOS,
  TEST_POLICY,
  TEST_SECRET,
  changeSetDigest,
  createClock,
  createRecordingStore,
  createSafeWrite,
  failedScenarios,
  runSafeWriteConformance,
  type SafeWriteFactory,
  type SafeWriteScenario,
} from "../src/index.js";
import {
  inertFactory,
  makeFaultyFactory,
  passthroughFactory,
  type SafeWriteFaults,
} from "./faulty-implementations.js";

const REAL_FACTORY: SafeWriteFactory = (input) => createSafeWrite(input);

function scenario(index: number): SafeWriteScenario {
  const name = SAFE_WRITE_SCENARIOS[index];
  assert.ok(name !== undefined, `scenario ${index} exists`);
  return name;
}

test("the real implementation satisfies every scenario in the contract", () => {
  const report = runSafeWriteConformance(REAL_FACTORY);
  assert.deepEqual(failedScenarios(report), [], JSON.stringify(report.results, null, 2));
  assert.equal(report.ok, true);
  assert.equal(report.contractVersion, SAFE_WRITE_CONTRACT_VERSION);
  assert.equal(new Set(SAFE_WRITE_SCENARIOS).size, SAFE_WRITE_SCENARIOS.length);
});

test("the fixtures carry what the sensitive-output scenarios look for", () => {
  // Without this the "must not appear in the receipt" checks could pass simply
  // because the value was never in the store to begin with.
  const store = createRecordingStore();
  assert.equal(store.readField(OWNER_PERSON_REF, "display_name"), PROFILE_CANARY);
  assert.ok(TEST_POLICY.allowed.includes("display_name"));
});

test("the change-set digest is stable under key order and sensitive to every part", () => {
  const base = { personRef: OWNER_PERSON_REF, field: "display_name", value: "A" };
  const reordered = { value: "A", field: "display_name", personRef: OWNER_PERSON_REF };
  assert.equal(changeSetDigest(base), changeSetDigest(reordered));
  for (const mutation of [
    { ...base, value: "B" },
    { ...base, field: "pronouns" },
    { ...base, personRef: "0".repeat(64) },
  ]) {
    assert.notEqual(changeSetDigest(base), changeSetDigest(mutation));
  }
});

/**
 * The rule each fault disables, and every scenario that rule holds up. A fault
 * failing more than it declares has stopped being surgical; one failing fewer
 * means a scenario is not reading the behaviour it names.
 */
const FAULT_EXPECTATIONS: ReadonlyArray<readonly [keyof SafeWriteFaults, readonly SafeWriteScenario[]]> = [
  // A preview that writes also defeats the failed-receipt rule: by confirm
  // time the record has already changed. Both failures are real, so both are
  // declared rather than the fault being narrowed to flatter the table.
  ["previewWritesEagerly", [scenario(0), scenario(8)]],
  ["hideBeforeValue", [scenario(1)]],
  ["confirmWritesDifferentValue", [scenario(2)]],
  ["confirmIgnoresChangeSet", [scenario(3)]],
  ["reusableTokens", [scenario(4)]],
  ["ignoreExpiry", [scenario(5)]],
  ["ignoreTokenPrincipal", [scenario(6)]],
  ["inheritPreviewAuthorization", [scenario(7)]],
  ["commitBeforeReceipt", [scenario(8)]],
  ["receiptEchoesValue", [scenario(9)]],
  // Free-text reasons break every scenario that reads a refusal's reason, which
  // is four of them. Declared as measured rather than narrowed to look tidy.
  ["freeTextRefusals", [scenario(10), scenario(11), scenario(12), scenario(13)]],
  ["acceptAnyField", [scenario(10), scenario(11)]],
  ["previewAllowsForeignRecord", [scenario(10), scenario(12)]],
  ["trimValues", [scenario(10), scenario(13)]],
  ["spendTokenOnFailure", [scenario(14)]],
  ["acceptForgedTokens", [scenario(15)]],
];

test("the fault wrapper with no fault set satisfies the contract", () => {
  // The control for every mutation below: if the wrapper itself broke a rule,
  // a fault's failures could not be attributed to the fault.
  const report = runSafeWriteConformance(makeFaultyFactory({}));
  assert.deepEqual(failedScenarios(report), [], JSON.stringify(report.results, null, 2));
});

for (const [fault, expected] of FAULT_EXPECTATIONS) {
  test(`disabling ${fault} fails exactly ${expected.length} scenario(s)`, () => {
    const report = runSafeWriteConformance(makeFaultyFactory({ [fault]: true }));
    assert.deepEqual(
      failedScenarios(report),
      expected,
      `${fault}: ${JSON.stringify(report.results.filter((result) => !result.ok), null, 2)}`,
    );
  });
}

test("every scenario is bound by at least one fault", () => {
  const covered = new Set(FAULT_EXPECTATIONS.flatMap(([, scenarios]) => scenarios));
  const unbound = SAFE_WRITE_SCENARIOS.filter((name) => !covered.has(name));
  assert.deepEqual(unbound, [], "a scenario no fault can break is not a control");
});

test("the suite rejects implementations that break the contract with no fault flag set", () => {
  // Anti-circularity: the scenarios must read behaviour, not a flag they were
  // handed. Neither implementation below sets any flag.
  const passthrough = runSafeWriteConformance(passthroughFactory);
  assert.equal(passthrough.ok, false);
  for (const index of [3, 4, 6, 9, 11]) {
    assert.ok(
      failedScenarios(passthrough).includes(scenario(index)),
      `an implementation that validates nothing fails: ${scenario(index)}`,
    );
  }

  const inert = runSafeWriteConformance(inertFactory);
  assert.equal(inert.ok, false);
  assert.ok(
    failedScenarios(inert).length >= 8,
    "an implementation that writes nothing fails most of the contract",
  );
});

test("a spent token stays spent across a later failed confirm", () => {
  // Regression guard for the deliberate asymmetry in createSafeWrite: a token
  // is spent on success and NOT spent when the receipt fails, so a person can
  // retry a write that never happened without being locked out.
  const store = createRecordingStore();
  const clock = createClock();
  const implementation = createSafeWrite({ store, secret: TEST_SECRET, policy: TEST_POLICY, clock });
  const change = { personRef: OWNER_PERSON_REF, field: "display_name", value: "Chosen Name" };
  const preview = implementation.preview({ change, principalRef: OWNER_PRINCIPAL_REF });
  assert.ok(preview.ok);
  const first = implementation.confirm({ token: preview.token, change, principalRef: OWNER_PRINCIPAL_REF });
  assert.ok(first.ok);
  const replay = implementation.confirm({ token: preview.token, change, principalRef: OWNER_PRINCIPAL_REF });
  assert.equal(replay.ok, false);
  assert.equal(replay.ok === false && replay.reason, "token_already_used");

  const failing = createRecordingStore({ failCommit: true });
  const retryable = createSafeWrite({ store: failing, secret: TEST_SECRET, policy: TEST_POLICY, clock: createClock() });
  const secondPreview = retryable.preview({ change, principalRef: OWNER_PRINCIPAL_REF });
  assert.ok(secondPreview.ok);
  const failed = retryable.confirm({ token: secondPreview.token, change, principalRef: OWNER_PRINCIPAL_REF });
  assert.equal(failed.ok, false);
  assert.equal(failed.ok === false && failed.reason, "receipt_failed");
  const retried = retryable.confirm({ token: secondPreview.token, change, principalRef: OWNER_PRINCIPAL_REF });
  assert.equal(retried.ok === false && retried.reason, "receipt_failed", "a failed write must remain retryable");
});
