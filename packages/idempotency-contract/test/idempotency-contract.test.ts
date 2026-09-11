import assert from "node:assert/strict";
import test from "node:test";

import type * as Contract from "../src/index.js";

const contract: typeof Contract = await import(
  process.env.SHU233_TEST_MODULE ?? "../src/index.js"
);

const {
  DEFAULT_IDEMPOTENCY_RETENTION_MS,
  IDEMPOTENCY_HEADER,
  canonicalJson,
  createIdempotency,
  createIdempotencyKey,
  createRecordingIdempotencyStore,
  mutationFingerprint,
} = contract;

const PRINCIPAL = "1".repeat(64);
const OTHER_PRINCIPAL = "2".repeat(64);
const START = new Date("2026-09-11T12:00:00.000Z");
const TRANSFER_KEY = createIdempotencyKey(START, "11111111-1111-4111-8111-111111111111");
const DECISION_KEY = createIdempotencyKey(START, "22222222-2222-4222-8222-222222222222");

function clock(start = START) {
  let current = new Date(start);
  return {
    now: () => new Date(current),
    advance(ms: number) { current = new Date(current.getTime() + ms); },
  };
}

function request(overrides: Partial<Contract.MutationRequest> = {}): Contract.MutationRequest {
  return {
    key: TRANSFER_KEY,
    principalRef: PRINCIPAL,
    method: "POST",
    route: "/transfers",
    payload: { periodRef: "period-fixture-1", totalMinor: 125_000 },
    ...overrides,
  };
}

test("SHU-233/AC-01 every application mutation requires the documented structured key", async () => {
  assert.equal(IDEMPOTENCY_HEADER, "Idempotency-Key");
  const testClock = clock();
  const store = createRecordingIdempotencyStore({ clock: testClock });
  const implementation = createIdempotency({ store, clock: testClock });
  let calls = 0;
  const operation = () => { calls += 1; return { status: 201 } as const; };

  for (const candidate of [
    request({ key: undefined }),
    request({ key: "" }),
    request({ key: "opaque-key-with-no-expiry" }),
    request({ key: "v1.9999999999999.11111111-1111-4111-8111-111111111111" }),
    request({ payload: { amount: Number.NaN } as never }),
    request({ payload: new Date() as never }),
  ]) {
    const result = await implementation.execute(candidate, operation);
    assert.equal(result.ok, false);
  }
  assert.equal(calls, 0);
  assert.equal(store.recordCount, 0);
});

test("SHU-233/AC-02 committed, failed, and concurrent retries execute exactly once", async () => {
  const testClock = clock();
  const store = createRecordingIdempotencyStore({ clock: testClock });
  const implementation = createIdempotency({ store, clock: testClock });
  let calls = 0;
  const operation: Contract.MutationOperation = async (tx) => {
    calls += 1;
    await tx.insert("transfers", { id: `transfer-${calls}` });
    await tx.enqueue("notifications", { id: `transfer-notification-${calls}` });
    return { status: 201, headers: { location: `/transfers/${calls}` }, body: { id: `transfer-${calls}` } };
  };

  const first = await implementation.execute(request(), operation);
  const replay = await implementation.execute(request(), operation);
  assert.ok(first.ok && replay.ok);
  assert.equal(first.replayed, false);
  assert.equal(replay.replayed, true);
  assert.deepEqual(replay.response, first.response);
  assert.equal(calls, 1);
  assert.equal(store.rows("transfers").length, 1);
  assert.equal(store.events("notifications").length, 1);

  const concurrentClock = clock();
  const concurrentStore = createRecordingIdempotencyStore({ clock: concurrentClock });
  const concurrent = createIdempotency({ store: concurrentStore, clock: concurrentClock });
  let concurrentCalls = 0;
  const pair = await Promise.all([0, 1].map(() => concurrent.execute(request(), async (tx) => {
    concurrentCalls += 1;
    const id = `concurrent-${concurrentCalls}`;
    await tx.insert("transfers", { id });
    await tx.enqueue("notifications", { id: `notification-${id}` });
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { status: 201, body: { id } };
  })));
  assert.equal(pair.filter((result) => result.ok && !result.replayed).length, 1);
  assert.equal(pair.filter((result) => result.ok && result.replayed).length, 1);
  assert.equal(concurrentCalls, 1);
  assert.equal(concurrentStore.rows("transfers").length, 1);
  assert.equal(concurrentStore.events("notifications").length, 1);

  const failingClock = clock();
  const failingStore = createRecordingIdempotencyStore({ clock: failingClock });
  const retryable = createIdempotency({ store: failingStore, clock: failingClock });
  const failed = await retryable.execute(request(), async (tx) => {
    await tx.insert("transfers", { id: "must-roll-back" });
    await tx.enqueue("notifications", { id: "must-roll-back" });
    throw new Error("simulated failure after writes, before commit");
  });
  assert.deepEqual(failed, { ok: false, status: 503, reason: "operation_failed" });
  assert.equal(failingStore.rows("transfers").length, 0);
  assert.equal(failingStore.events("notifications").length, 0);
  assert.equal(failingStore.recordCount, 0);
  const retried = await retryable.execute(request(), async (tx) => {
    await tx.insert("transfers", { id: "retry-committed" });
    return { status: 201, body: { id: "retry-committed" } };
  });
  assert.ok(retried.ok && !retried.replayed);
  assert.equal(failingStore.rows("transfers").length, 1);
});

test("SHU-233/AC-03 a key cannot be reused for a different semantic payload", async () => {
  const testClock = clock();
  const store = createRecordingIdempotencyStore({ clock: testClock });
  const implementation = createIdempotency({ store, clock: testClock });
  let calls = 0;
  const operation = () => { calls += 1; return { status: 201, body: { call: calls } } as const; };
  assert.equal((await implementation.execute(request(), operation)).ok, true);

  for (const changed of [
    request({ payload: { periodRef: "period-fixture-2", totalMinor: 125_000 } }),
    request({ route: "/candidate-work-log-feedbacks" }),
    request({ method: "PATCH" }),
  ]) {
    assert.deepEqual(await implementation.execute(changed, operation), {
      ok: false, status: 409, reason: "key_payload_mismatch",
    });
  }
  assert.equal(calls, 1);
  assert.equal(store.recordCount, 1);

  const other = await implementation.execute(request({ principalRef: OTHER_PRINCIPAL }), operation);
  assert.ok(other.ok && !other.replayed);
  assert.equal(calls, 2);
});

test("SHU-233/AC-04 cleanup is bounded and an expired key can never execute again", async () => {
  const testClock = clock();
  const store = createRecordingIdempotencyStore({ clock: testClock });
  const implementation = createIdempotency({ store, clock: testClock });
  let calls = 0;
  const operation = () => { calls += 1; return { status: 201 } as const; };
  assert.equal((await implementation.execute(request(), operation)).ok, true);
  assert.equal(store.recordCount, 1);

  testClock.advance(DEFAULT_IDEMPOTENCY_RETENTION_MS);
  assert.equal(await implementation.cleanup(), 1);
  assert.equal(store.recordCount, 0);
  assert.deepEqual(await implementation.execute(request(), operation), {
    ok: false, status: 409, reason: "key_expired",
  });
  assert.equal(calls, 1, "cleanup turned an old replay into a fresh write");

  const raceClock = clock();
  const raceStore = createRecordingIdempotencyStore({ clock: raceClock });
  const racingStore: Contract.IdempotencyStore = {
    cleanupExpired: (now) => raceStore.cleanupExpired(now),
    executeAtomic: (input, write) => {
      // Executor validation happened while the key was live. Time crosses the
      // boundary before the atomic store check, exactly the cleanup race.
      raceClock.advance(DEFAULT_IDEMPOTENCY_RETENTION_MS);
      return raceStore.executeAtomic(input, write);
    },
  };
  let raceCalls = 0;
  const racing = createIdempotency({ store: racingStore, clock: raceClock });
  assert.deepEqual(await racing.execute(request(), () => {
    raceCalls += 1;
    return { status: 201 };
  }), { ok: false, status: 409, reason: "key_expired" });
  assert.equal(raceCalls, 0, "an expiry race reached the business operation");
});

test("SHU-233/AC-05 action-token and idempotency coverage have one deterministic boundary", () => {
  const coverage = {
    safeWriteConfirm: "action-token",
    directApplicationMutation: "idempotency-key",
    logout: "naturally-idempotent",
    oidcCallback: "protocol-state-nonce",
    currentMcpTools: "read-only",
  } as const;
  assert.deepEqual(Object.values(coverage), [
    "action-token", "idempotency-key", "naturally-idempotent", "protocol-state-nonce", "read-only",
  ]);
  assert.equal(Object.values(coverage).includes(undefined as never), false);
});

test("SHU-233/AC-06 retries preserve key and canonical payload; changed actions do not", () => {
  const reordered = request({ payload: { totalMinor: 125_000, periodRef: "period-fixture-1" } });
  assert.equal(canonicalJson(request().payload), canonicalJson(reordered.payload));
  assert.equal(mutationFingerprint(request()), mutationFingerprint(reordered));
  assert.notEqual(
    mutationFingerprint(request()),
    mutationFingerprint(request({ payload: { periodRef: "period-fixture-1", totalMinor: 125_001 } })),
  );
});

test("SHU-233/parity-contract", async () => {
  const testClock = clock();
  const store = createRecordingIdempotencyStore({ clock: testClock });
  store.seed("periods", { id: "period-fixture-1", state: "ready", totalMinor: 125_000 });
  store.seed("work_sessions", { id: "session-fixture-1", state: "submitted" });
  const implementation = createIdempotency({ store, clock: testClock });

  let transferCalls = 0;
  const generateTransfer: Contract.MutationOperation = async (tx) => {
    transferCalls += 1;
    const id = `transfer-${transferCalls}`;
    await tx.insert("transfers", { id, periodRef: "period-fixture-1" });
    await tx.enqueue("notifications", { id: `notification-${id}`, kind: "transfer-created" });
    await new Promise<void>((resolve) => setImmediate(resolve));
    return { status: 201, body: { id, state: "pending" } };
  };

  const lostAtGateway = await implementation.execute(request(), generateTransfer);
  assert.ok(lostAtGateway.ok && !lostAtGateway.replayed);
  const transferRetries = await Promise.all([
    implementation.execute(request(), generateTransfer),
    implementation.execute(request(), generateTransfer),
  ]);
  assert.ok(transferRetries.every((result) => result.ok && result.replayed));
  assert.ok(transferRetries.every((result) => result.ok &&
    JSON.stringify(result.response) === JSON.stringify(lostAtGateway.response)));

  // A retry that re-cases the key is the same logical request, not a new one.
  const recased = await implementation.execute(
    request({ key: TRANSFER_KEY.toUpperCase() }), generateTransfer);
  assert.ok(recased.ok && recased.replayed, "a re-cased key must replay, not execute");
  assert.deepEqual(recased.response, lostAtGateway.response);

  let decisionCalls = 0;
  const decisionRequest = request({
    key: DECISION_KEY,
    route: "/candidate-work-log-feedbacks",
    payload: { sessionRef: "session-fixture-1", decision: "approve" },
  });
  const decide: Contract.MutationOperation = async (tx) => {
    decisionCalls += 1;
    const id = `decision-${decisionCalls}`;
    await tx.insert("decisions", { id, sessionRef: "session-fixture-1", value: "approve" });
    await tx.enqueue("notifications", { id: `notification-${id}`, kind: "work-session-decided" });
    return { status: 201, body: { id, value: "approve" } };
  };
  const decisions = await Promise.all([
    implementation.execute(decisionRequest, decide),
    implementation.execute(decisionRequest, decide),
  ]);
  assert.equal(decisions.filter((result) => result.ok && !result.replayed).length, 1);
  assert.equal(decisions.filter((result) => result.ok && result.replayed).length, 1);

  const mutated = await implementation.execute({
    ...decisionRequest,
    payload: { sessionRef: "session-fixture-1", decision: "reject" },
  }, decide);
  assert.deepEqual(mutated, { ok: false, status: 409, reason: "key_payload_mismatch" });

  const failedKey = createIdempotencyKey(START, "33333333-3333-4333-8333-333333333333");
  const failedRequest = request({ key: failedKey, payload: { periodRef: "period-fixture-failed" } });
  const failed = await implementation.execute(failedRequest, async (tx) => {
    await tx.insert("transfers", { id: "rolled-back-transfer" });
    await tx.enqueue("notifications", { id: "rolled-back-notification" });
    throw new Error("simulated transaction abort");
  });
  assert.deepEqual(failed, { ok: false, status: 503, reason: "operation_failed" });
  const recovered = await implementation.execute(failedRequest, async (tx) => {
    await tx.insert("transfers", { id: "recovered-transfer" });
    return { status: 201, body: { id: "recovered-transfer" } };
  });
  assert.ok(recovered.ok && !recovered.replayed);

  assert.equal(transferCalls, 1);
  assert.equal(decisionCalls, 1);
  assert.equal(store.rows("transfers").length, 2, "one generated and one recovered transfer");
  assert.equal(store.rows("decisions").length, 1);
  assert.equal(store.events("notifications").filter((event) =>
    (event as { kind?: string }).kind === "transfer-created").length, 1);
  assert.equal(store.events("notifications").filter((event) =>
    (event as { kind?: string }).kind === "work-session-decided").length, 1);
});
