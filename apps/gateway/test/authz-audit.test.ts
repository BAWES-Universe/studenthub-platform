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
  MAX_PENDING_AUDIT_BYTES,
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

test("a sink with a throwing then accessor cannot change the authorization decision", async () => {
  const fixture = await auditFixture({
    auditSink: {
      record: () =>
        Object.defineProperty({}, "then", {
          get: () => {
            throw new Error("hostile then accessor");
          },
        }) as Promise<void>,
    },
  });

  const decision = await authorizeRequest(await fixture.mint(), fixture.middleware);
  assert.equal(decision.kind, "allow");
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(fixture.failures, [{ kind: "audit_sink_failure", requestId: "req-1" }]);
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

test("a rejecting async failure handler cannot create an unhandled rejection", async () => {
  const unhandled: unknown[] = [];
  const onUnhandled = (reason: unknown): void => void unhandled.push(reason);
  process.on("unhandledRejection", onUnhandled);
  try {
    const fixture = await auditFixture({
      auditSink: {
        record: () => {
          throw new Error("sink exploded");
        },
      },
      onAuditFailure: async () => Promise.reject(new Error("failure handler rejected")),
    });
    const decision = await authorizeRequest(await fixture.mint(), fixture.middleware);
    assert.equal(decision.kind, "allow");

    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(unhandled, []);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
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

/**
 * MUTATION: delete the `guardStream(stream)` call in `createStdoutAuditSink`.
 *
 * Sentry rated this CRITICAL and the thread was marked "Resolved in 6c07fd1",
 * but that commit only contained the async failure handler — the stream was
 * never guarded. Auditing is on by default (`authz-middleware.ts`), so every
 * authorization decision writes to stdout; under a log pipeline that closes the
 * read end, an unhandled `'error'` event terminates the gateway.
 *
 * This asserts the guard is installed on the stream the sink actually writes
 * to. A broken pipe is asynchronous, so no try/catch inside `record` can stand
 * in for it — the listener is the only thing that prevents the crash.
 */
test("the default stdout sink guards its stream against asynchronous write errors", () => {
  const listeners: Array<(...args: unknown[]) => void> = [];
  let written = "";
  const fake = {
    write: (line: string) => { written += line; return true; },
    on(eventName: string, handler: (...args: unknown[]) => void) {
      if (eventName === "error") listeners.push(handler);
      return this;
    },
  } as unknown as NodeJS.WritableStream;

  const sink = createStdoutAuditSink(undefined, fake);
  assert.equal(listeners.length, 1, "an unguarded audit stream can terminate the gateway on EPIPE");

  sink.record({
    type: "authorization_decision",
    timestamp: FIXED_TIME.toISOString(),
    requestId: "req-epipe",
    stage: "authorization",
    decision: "allow",
    principalId: "principal-1",
    orgId: TEST_ORG,
    role: "inspector",
  });
  assert.match(written, /"requestId":"req-epipe"/, "the guard must not stop the sink writing");

  // The handler must swallow rather than rethrow: there is nowhere to report a
  // logging failure to, and re-raising here reintroduces the crash.
  assert.doesNotThrow(() => listeners[0]!(new Error("EPIPE")));
});

/**
 * The same stream is guarded once however many sinks are built over it, so a
 * process constructing several middlewares does not leak listeners or trip
 * Node's max-listeners warning.
 */
test("the stream guard is installed once per stream, not once per sink", () => {
  let errorListeners = 0;
  const fake = {
    write: () => true,
    on(eventName: string) { if (eventName === "error") errorListeners += 1; return this; },
  } as unknown as NodeJS.WritableStream;

  createStdoutAuditSink(undefined, fake);
  createStdoutAuditSink(undefined, fake);
  createStdoutAuditSink(undefined, fake);
  assert.equal(errorListeners, 1);
});

/** An injected write is the test seam and must not touch the real stdout. */
test("an injected write is used verbatim and leaves the default stream alone", () => {
  const lines: string[] = [];
  const sink = createStdoutAuditSink((line) => void lines.push(line));
  sink.record({
    type: "authorization_decision",
    timestamp: FIXED_TIME.toISOString(),
    requestId: "req-injected",
    stage: "authentication",
    decision: "deny",
    reason: "missing_assertion",
    status: 401,
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /"requestId":"req-injected"/);
});

/**
 * MUTATION: remove the cap check, or drop the record's own bytes from it.
 *
 * CodeRabbit, on head 3a83f79: the sink discarded `write()`'s return value, so a
 * slow log consumer let the stream buffer grow one line per authorization
 * decision until the process ran out of memory. Same class as the EPIPE guard —
 * auditing does not change the decision, it kills the process making them.
 *
 * The drop is signalled rather than silent: `record` throws, which routes into
 * the containment `emitAuthorizationAuditEvent` already has, so the operator
 * sees `audit_sink_failure` with the request id instead of a missing line.
 *
 * Codex, on head 9312a35: the check read only what the stream already held, so
 * the record that crossed the cap was written anyway and reported nothing —
 * the bound settled at cap plus one line. The pair of boundary tests below pins
 * both sides, because a cap that also refuses records which fit drops audit
 * output for no reason.
 */
function backpressuredStream(pending: number): NodeJS.WritableStream {
  return {
    writableLength: pending,
    write: () => false,
    on() { return this; },
  } as unknown as NodeJS.WritableStream;
}

test("a backpressured audit stream drops the record instead of growing without bound", () => {
  const sink = createStdoutAuditSink(undefined, backpressuredStream(4 * 1024 * 1024));
  const failures: AuthorizationAuditFailure[] = [];
  emitAuthorizationAuditEvent(
    sink,
    {
      type: "authorization_decision",
      timestamp: FIXED_TIME.toISOString(),
      requestId: "req-backpressure",
      stage: "authorization",
      decision: "allow",
      principalId: "principal-1",
      orgId: TEST_ORG,
      role: "inspector",
    },
    (failure) => void failures.push(failure),
  );
  // Contained, signalled, and carrying nothing but the request id.
  assert.deepEqual(failures, [{ kind: "audit_sink_failure", requestId: "req-backpressure" }]);
});

/**
 * A stream parked just under the cap, recording what it is asked to write.
 * `writableLength` stays put: nothing drains, and the point of the test is what
 * the sink decides BEFORE writing.
 */
function stalledStream(pending: number): { stream: NodeJS.WritableStream; written: string[] } {
  const written: string[] = [];
  const stream = {
    writableLength: pending,
    write: (line: string) => { written.push(line); return false; },
    on() { return this; },
  } as unknown as NodeJS.WritableStream;
  return { stream, written };
}

/**
 * The boundary itself. Checking only what the stream already holds lets the
 * crossing record through, so the buffer settles at the cap plus one line and
 * the write that broke the bound is the one that reports nothing.
 */
test("the record that would cross the cap is refused, not written", () => {
  const line = `${JSON.stringify({
    type: "authorization_decision",
    timestamp: FIXED_TIME.toISOString(),
    requestId: "req-crosses-cap",
    stage: "authorization",
    decision: "allow",
    principalId: "principal-1",
    orgId: TEST_ORG,
    role: "inspector",
  })}\n`;
  // One byte of headroom: the stream fits everything except this record.
  const { stream, written } = stalledStream(MAX_PENDING_AUDIT_BYTES - Buffer.byteLength(line, "utf8") + 1);

  const failures: AuthorizationAuditFailure[] = [];
  emitAuthorizationAuditEvent(
    createStdoutAuditSink(undefined, stream),
    {
      type: "authorization_decision",
      timestamp: FIXED_TIME.toISOString(),
      requestId: "req-crosses-cap",
      stage: "authorization",
      decision: "allow",
      principalId: "principal-1",
      orgId: TEST_ORG,
      role: "inspector",
    },
    (failure) => void failures.push(failure),
  );

  assert.deepEqual(written, [], "the crossing record must never reach the stream");
  assert.deepEqual(failures, [{ kind: "audit_sink_failure", requestId: "req-crosses-cap" }]);
});

/**
 * The other side of the same boundary. A cap that also refuses records which
 * fit would drop audit output for no reason, so the exact fit must go through.
 */
test("the record that exactly fills the cap is still written", () => {
  const line = `${JSON.stringify({
    type: "authorization_decision",
    timestamp: FIXED_TIME.toISOString(),
    requestId: "req-exact-fit",
    stage: "authorization",
    decision: "allow",
    principalId: "principal-1",
    orgId: TEST_ORG,
    role: "inspector",
  })}\n`;
  const { stream, written } = stalledStream(MAX_PENDING_AUDIT_BYTES - Buffer.byteLength(line, "utf8"));

  const failures: AuthorizationAuditFailure[] = [];
  emitAuthorizationAuditEvent(
    createStdoutAuditSink(undefined, stream),
    {
      type: "authorization_decision",
      timestamp: FIXED_TIME.toISOString(),
      requestId: "req-exact-fit",
      stage: "authorization",
      decision: "allow",
      principalId: "principal-1",
      orgId: TEST_ORG,
      role: "inspector",
    },
    (failure) => void failures.push(failure),
  );

  assert.deepEqual(failures, [], "a record that fits must not be dropped");
  assert.equal(written.length, 1);
  assert.match(written[0]!, /"requestId":"req-exact-fit"/);
});

test("an audit stream under the cap still writes", () => {
  const written: string[] = [];
  const stream = {
    writableLength: 1024,
    write: (line: string) => { written.push(line); return true; },
    on() { return this; },
  } as unknown as NodeJS.WritableStream;

  const failures: AuthorizationAuditFailure[] = [];
  emitAuthorizationAuditEvent(
    createStdoutAuditSink(undefined, stream),
    {
      type: "authorization_decision",
      timestamp: FIXED_TIME.toISOString(),
      requestId: "req-under-cap",
      stage: "authentication",
      decision: "deny",
      reason: "missing_assertion",
      status: 401,
    },
    (failure) => void failures.push(failure),
  );
  assert.deepEqual(failures, [], "a healthy stream must not be treated as backpressured");
  assert.equal(written.length, 1);
  assert.match(written[0]!, /"requestId":"req-under-cap"/);
});

/** A stream that does not report depth must not be assumed backpressured. */
test("a stream without writableLength is written to, not dropped", () => {
  const written: string[] = [];
  const stream = {
    write: (line: string) => { written.push(line); return true; },
    on() { return this; },
  } as unknown as NodeJS.WritableStream;

  createStdoutAuditSink(undefined, stream).record({
    type: "authorization_decision",
    timestamp: FIXED_TIME.toISOString(),
    requestId: "req-no-length",
    stage: "authentication",
    decision: "deny",
    reason: "missing_assertion",
    status: 401,
  });
  assert.equal(written.length, 1);
});
