/**
 * SHU-58 — gateway authorization decision-audit events.
 *
 * These tests are written to FAIL when the control they describe is removed,
 * not merely to pass while it happens to be present. Each block names the
 * mutation it is meant to catch. The card's acceptance criterion "removing the
 * audit call makes the relevant test fail" is only met if that is actually
 * true, so it was verified by deleting each control and re-running.
 */
import assert from "node:assert/strict";
import test from "node:test";

import { AssertionErrorCode } from "@bawes/actor-assertion";
import type { AuthzStore } from "@studenthub/contracts";

import { authorizeRequest } from "../src/authz-middleware.js";
import {
  createStdoutAuditSink,
  emitAuthorizationAuditEvent,
  type AuthorizationAuditEvent,
  type AuthorizationAuditFailure,
  type AuthorizationAuditSink,
} from "../src/authz-audit.js";
import { createAuthzFixture, TEST_ORG, TEST_SUB } from "./helpers/authz.js";

const FIXED_TIME = new Date("2026-09-06T00:00:00.000Z");

/** A sink that keeps every event so a test can count them, not just inspect one. */
function recordingSink(): { sink: AuthorizationAuditSink; events: AuthorizationAuditEvent[] } {
  const events: AuthorizationAuditEvent[] = [];
  return { sink: { record: (event) => void events.push(event) }, events };
}

async function auditFixture(over: Parameters<typeof createAuthzFixture>[0] = {}) {
  const { sink, events } = recordingSink();
  const failures: AuthorizationAuditFailure[] = [];
  let counter = 0;
  const fixture = await createAuthzFixture({
    auditSink: sink,
    onAuditFailure: (failure) => void failures.push(failure),
    now: () => FIXED_TIME,
    newRequestId: () => `req-${(counter += 1)}`,
    ...over,
  });
  return { ...fixture, events, failures };
}

/** Every store method rejects — the shape of "the database is unreachable". */
function unreachableStore(): AuthzStore {
  const boom = async (): Promise<never> => {
    throw new Error("connection refused: postgres://user:hunter2@db.internal:5432/authz");
  };
  return new Proxy({} as AuthzStore, { get: () => boom });
}

// ---------------------------------------------------------------------------
// Every allow emits exactly one typed event.
// Mutation caught: deleting the emit call in authorizeRequest.
// ---------------------------------------------------------------------------

test("an allowed request emits exactly one allow event correlated by platform principal id", async () => {
  const fixture = await auditFixture();
  const decision = await authorizeRequest(await fixture.mint(), fixture.middleware);

  assert.equal(decision.kind, "allow");
  assert.equal(fixture.events.length, 1, "exactly one event per authorization");
  assert.deepEqual(fixture.events[0], {
    type: "authorization_decision",
    timestamp: "2026-09-06T00:00:00.000Z",
    requestId: "req-1",
    stage: "authorization",
    decision: "allow",
    // The PLATFORM's id from the grants store — not the issuer's `sub`.
    principalId: "p-1",
    orgId: TEST_ORG,
    role: "staff",
  });
});

test("two authorizations emit exactly two events with distinct request ids", async () => {
  // Guards against an emitter that fires once per process, or once per sink.
  const fixture = await auditFixture();
  await authorizeRequest(await fixture.mint(), fixture.middleware);
  await authorizeRequest(undefined, fixture.middleware);

  assert.equal(fixture.events.length, 2);
  assert.notEqual(fixture.events[0]?.requestId, fixture.events[1]?.requestId);
});

// ---------------------------------------------------------------------------
// Every deny reason emits exactly one typed event.
// Mutation caught: a denial branch that returns without auditing.
// ---------------------------------------------------------------------------

test("every denial reason emits exactly one deny event carrying that typed reason", async () => {
  const cases: ReadonlyArray<{
    readonly label: string;
    readonly wire: (f: Awaited<ReturnType<typeof auditFixture>>) => Promise<string | undefined>;
    readonly reason: string;
    readonly status: 401 | 403;
    readonly stage: "authentication" | "authorization";
  }> = [
    { label: "missing", wire: async () => undefined, reason: "missing_assertion", status: 401, stage: "authentication" },
    { label: "empty", wire: async () => "   ", reason: "missing_assertion", status: 401, stage: "authentication" },
    { label: "malformed", wire: async () => "not-an-assertion", reason: AssertionErrorCode.MALFORMED, status: 401, stage: "authentication" },
    { label: "aud", wire: (f) => f.mint({ aud: "studenthub/other/action" }), reason: AssertionErrorCode.AUD_MISMATCH, status: 401, stage: "authentication" },
    { label: "expired", wire: (f) => f.mint({ expOffsetSeconds: -1 }), reason: AssertionErrorCode.EXPIRED, status: 401, stage: "authentication" },
    { label: "unknown issuer", wire: (f) => f.mint({ kid: "rotated-out" }), reason: AssertionErrorCode.UNKNOWN_ISSUER, status: 401, stage: "authentication" },
    // Authentication succeeds; the grants store has no principal for this sub,
    // so the refusal happens at the authorization stage instead.
    { label: "unknown principal", wire: (f) => f.mint({ sub: "stranger@bawes.net" }), reason: "unknown_principal", status: 403, stage: "authorization" },
  ];

  for (const testCase of cases) {
    const fixture = await auditFixture();
    const decision = await authorizeRequest(await testCase.wire(fixture), fixture.middleware);

    assert.equal(decision.kind, "deny", testCase.label);
    assert.equal(fixture.events.length, 1, `${testCase.label}: exactly one event`);
    assert.deepEqual(
      fixture.events[0],
      {
        type: "authorization_decision",
        timestamp: "2026-09-06T00:00:00.000Z",
        requestId: "req-1",
        stage: testCase.stage,
        decision: "deny",
        reason: testCase.reason,
        status: testCase.status,
      },
      testCase.label,
    );
  }
});

test("a replayed assertion is audited as its own denial, not as a second allow", async () => {
  const fixture = await auditFixture();
  const wire = await fixture.mint();
  await authorizeRequest(wire, fixture.middleware);
  const replayed = await authorizeRequest(wire, fixture.middleware);

  assert.equal(replayed.kind === "deny" && replayed.reason, AssertionErrorCode.REPLAYED);
  assert.equal(fixture.events.length, 2);
  assert.equal(fixture.events[0]?.decision, "allow");
  assert.equal(fixture.events[1]?.decision, "deny");
});

// ---------------------------------------------------------------------------
// Dependency failures are audited AND still fail closed unchanged.
// Mutation caught: dropping the dependency emit, or swallowing the rethrow.
// ---------------------------------------------------------------------------

test("a dependency failure emits exactly one dependency event and still propagates", async () => {
  const fixture = await auditFixture({ store: unreachableStore() });
  const wire = await fixture.mint();

  // Behaviour preserved: the error still escapes, so the gateway's existing
  // 503 `authz_unavailable` path is unchanged by auditing.
  await assert.rejects(() => authorizeRequest(wire, fixture.middleware), /connection refused/);

  assert.equal(fixture.events.length, 1, "exactly one event for a dependency refusal");
  assert.deepEqual(fixture.events[0], {
    type: "authorization_decision",
    timestamp: "2026-09-06T00:00:00.000Z",
    requestId: "req-1",
    stage: "dependency",
    decision: "deny",
    reason: "dependency_unavailable",
    status: 503,
  });
});

test("the dependency event never carries the thrown error or its connection string", async () => {
  const fixture = await auditFixture({ store: unreachableStore() });
  const wire = await fixture.mint();
  await assert.rejects(() => authorizeRequest(wire, fixture.middleware));

  const serialized = JSON.stringify(fixture.events);
  assert.equal(serialized.includes("hunter2"), false, "no credential from the error message");
  assert.equal(serialized.includes("db.internal"), false, "no internal hostname");
  assert.equal(serialized.includes("connection refused"), false, "no error text at all");
});

// ---------------------------------------------------------------------------
// The sink can never change, delay, or crash the decision.
// Mutation caught: awaiting the sink, or letting its failure escape.
// ---------------------------------------------------------------------------

test("a synchronously throwing sink changes neither an allow nor a deny", async () => {
  const throwing: AuthorizationAuditSink = {
    record: () => {
      throw new Error("sink exploded");
    },
  };

  const allowed = await auditFixture({ auditSink: throwing });
  assert.equal((await authorizeRequest(await allowed.mint(), allowed.middleware)).kind, "allow");
  assert.deepEqual(allowed.failures, [{ kind: "audit_sink_failure", requestId: "req-1" }]);

  const denied = await auditFixture({ auditSink: throwing });
  assert.equal((await authorizeRequest(undefined, denied.middleware)).kind, "deny");
  assert.deepEqual(denied.failures, [{ kind: "audit_sink_failure", requestId: "req-1" }]);
});

test("a rejecting async sink raises the failure signal without an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const fixture = await auditFixture({
      auditSink: { record: async () => Promise.reject(new Error("sink offline")) },
    });
    const decision = await authorizeRequest(await fixture.mint(), fixture.middleware);
    assert.equal(decision.kind, "allow", "a rejecting sink must not change the verdict");

    // Let the rejection settle and any unhandled-rejection detection run.
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));

    assert.deepEqual(fixture.failures, [{ kind: "audit_sink_failure", requestId: "req-1" }]);
    assert.deepEqual(unhandled, [], "the gateway must not be terminated by a logging failure");
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("a sink that never settles does not delay the decision", async () => {
  // Awaiting the sink would turn a slow log destination into a request-latency
  // denial-of-service. A never-settling promise makes that regression hang.
  const fixture = await auditFixture({ auditSink: { record: () => new Promise<void>(() => {}) } });
  const decision = await authorizeRequest(await fixture.mint(), fixture.middleware);
  assert.equal(decision.kind, "allow");
});

test("a throwing failure handler is contained and still does not change the decision", async () => {
  const fixture = await auditFixture({
    auditSink: {
      record: () => {
        throw new Error("sink exploded");
      },
    },
    onAuditFailure: () => {
      throw new Error("handler exploded too");
    },
  });
  const decision = await authorizeRequest(await fixture.mint(), fixture.middleware);
  assert.equal(decision.kind, "allow");
});

// ---------------------------------------------------------------------------
// Nothing attacker-controlled is ever recorded.
// ---------------------------------------------------------------------------

test("no event on any path contains the assertion, the raw subject, or any email", async () => {
  const fixture = await auditFixture();
  const wires: Array<string | undefined> = [
    undefined,
    "   ",
    "not-an-assertion",
    await fixture.mint({ aud: "studenthub/other/action" }),
    await fixture.mint({ expOffsetSeconds: -1 }),
    await fixture.mint({ kid: "rotated-out" }),
    await fixture.mint({ sub: "stranger@bawes.net" }),
    await fixture.mint(),
  ];
  for (const wire of wires) await authorizeRequest(wire, fixture.middleware);

  assert.equal(fixture.events.length, wires.length, "one event per request, allow or deny");
  const serialized = JSON.stringify(fixture.events);

  // The email-shaped `sub` is the specific thing SHU-58 forbids in plaintext.
  assert.equal(serialized.includes(TEST_SUB), false, "the issuer's sub must never appear");
  assert.equal(serialized.includes("stranger@bawes.net"), false);
  // Nothing email-shaped at all: principal ids, org ids and roles have no "@".
  assert.equal(serialized.includes("@"), false, "no email-shaped value in any event");
  // No part of any signed envelope. Each wire is dot-delimited base64url; a leaked
  // header, payload or signature segment would show up as one of these segments.
  for (const wire of wires) {
    if (wire === undefined) continue;
    for (const segment of wire.split(".")) {
      if (segment.length < 8) continue;
      assert.equal(serialized.includes(segment), false, "no assertion material may be recorded");
    }
  }
});

test("only an allow carries identity; denials carry none", async () => {
  const fixture = await auditFixture();
  await authorizeRequest(await fixture.mint({ sub: "stranger@bawes.net" }), fixture.middleware);
  const [denial] = fixture.events;

  assert.ok(denial);
  assert.equal("principalId" in denial, false);
  assert.equal("orgId" in denial, false);
  assert.equal("role" in denial, false);
});

// ---------------------------------------------------------------------------
// The production default sink.
// ---------------------------------------------------------------------------

test("the stdout sink writes exactly one JSON object per line", () => {
  const lines: string[] = [];
  const sink = createStdoutAuditSink((line) => void lines.push(line));
  const event: AuthorizationAuditEvent = {
    type: "authorization_decision",
    timestamp: FIXED_TIME.toISOString(),
    requestId: "req-1",
    stage: "authorization",
    decision: "allow",
    principalId: "p-1",
    orgId: TEST_ORG,
    role: "staff",
  };

  sink.record(event);
  sink.record(event);

  assert.equal(lines.length, 2);
  for (const line of lines) {
    assert.equal(line.endsWith("\n"), true, "line-delimited so two events never merge");
    assert.deepEqual(JSON.parse(line.trimEnd()), event);
  }
});

test("emitAuthorizationAuditEvent reports failure for a throwing sink and returns normally", () => {
  const failures: AuthorizationAuditFailure[] = [];
  emitAuthorizationAuditEvent(
    {
      record: () => {
        throw new Error("nope");
      },
    },
    {
      type: "authorization_decision",
      timestamp: FIXED_TIME.toISOString(),
      requestId: "req-9",
      stage: "authentication",
      decision: "deny",
      reason: "missing_assertion",
      status: 401,
    },
    (failure) => void failures.push(failure),
  );
  assert.deepEqual(failures, [{ kind: "audit_sink_failure", requestId: "req-9" }]);
});
