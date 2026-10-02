// launch-refusal-visibility.test.mjs
//
// A REFUSED launch must be visible. When the supervisor gate is off,
// service/supervisor-service.mjs answers an order with
// `{ ok: false, stage: 'HOLD', reason: 'dispatch disabled' }`. The coordinator's
// supervisor adapter converts that answer into
// `{ stage: 'LAUNCH_UNKNOWN', reason }` (supervisor-dispatch.mjs) — and
// foldLaunchOutcome used to DROP the reason, so the held receipt and the
// dispatch line read only as "outcome unknown": a disabled gate, an ambiguous
// legacy launch and a vanished socket were all indistinguishable to an operator.
//
// These tests pin (1) the carried reason in the receipt notes, (2) the cause on
// the adapter's own transport-fault path, and (3) the invariant that a refused
// launch can never read RUNNING and never mints a run identity.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createReceipt, foldLaunchOutcome } from "../reconcile.mjs";
import { supervisorAdapter } from "../supervisor-dispatch.mjs";
import { createEpisodeHarness } from "./fixture/episode-harness.mjs";

const SHA = "a".repeat(40);
const SECRET = "shu-refusal-visibility-secret-at-least-32-bytes";
const CAUSE_PREFIX = "supervisor configuration unavailable: ";
const NOTE_PREFIX = "launch not acknowledged: ";

function reserved(overrides = {}) {
  const { ok, receipt, errors } = createReceipt({
    issue_id: "SHU-140",
    authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    requested_worker: "codex-builder",
    repo: "BAWES-Universe/studenthub-platform",
    branch: "main",
    target_sha: SHA,
    attempt_id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    ...overrides,
  });
  assert.equal(ok, true, `createReceipt refused: ${(errors ?? []).join("; ")}`);
  return receipt;
}

// Drive the REAL adapter + fold through one injected transport answer.
async function foldTransport(transport) {
  const receipt = reserved();
  const adapter = supervisorAdapter(receipt, { SHU_SUPERVISOR_SECRET: SECRET }, { supervisorTransport: transport });
  const launch = await adapter.launchBuilder({});
  return { receipt, launch, transition: foldLaunchOutcome(receipt, launch, {}) };
}

// --- 1. The refusal reason reaches the receipt note ---------------------------
// The exact answer the supervisor service gives with ENABLE_DISPATCH unset.
// FAILS on main (the note is absent — only "outcome unknown"), PASSES with the fix.
test("a 'dispatch disabled' refusal appears in the receipt note", async () => {
  const { launch, transition } = await foldTransport(async () => ({ ok: false, stage: "HOLD", reason: "dispatch disabled" }));

  assert.equal(launch.stage, "LAUNCH_UNKNOWN", "a not-ok answer is an ambiguous launch, not a hold");
  assert.equal(launch.reason, "dispatch disabled");

  assert.equal(transition.accepted, true);
  assert.equal(transition.receipt.stage, "LAUNCH_UNKNOWN", "the held slot must not move");
  assert.equal(transition.receipt.external_run_id, null);
  assert.ok(
    transition.receipt.notes.includes(`${NOTE_PREFIX}dispatch disabled`),
    `the receipt note must carry the refusal; got ${JSON.stringify(transition.receipt.notes)}`,
  );

  // An operator watching the tick reads the same refusal on the dispatch line.
  assert.equal(
    (await foldTransport(async () => ({ ok: false, stage: "HOLD", reason: "dispatch disabled" }))).transition.receipt.notes
      .filter((n) => n === `${NOTE_PREFIX}dispatch disabled`).length,
    1,
    "exactly one note per refusal",
  );
});

test("the carried reason is deduped across retry ticks and never invented", async () => {
  const { receipt, launch } = await foldTransport(async () => ({ ok: false, stage: "HOLD", reason: "dispatch disabled" }));
  const first = foldLaunchOutcome(receipt, launch, {}).receipt;

  // A retry tick re-reads the same held receipt and repeats the same refusal.
  const retried = foldLaunchOutcome(first, launch, {}).receipt;
  assert.equal(retried.notes.filter((n) => n === `${NOTE_PREFIX}dispatch disabled`).length, 1,
    "a repeated refusal must not grow the audit trail");

  // No reason at all, or a blank one: nothing may be claimed.
  const bare = foldLaunchOutcome(reserved(), { stage: "LAUNCH_UNKNOWN" }, {}).receipt;
  assert.equal(bare.notes.some((n) => n.startsWith(NOTE_PREFIX)), false);
  const blank = foldLaunchOutcome(reserved(), { stage: "LAUNCH_UNKNOWN", reason: "   " }, {}).receipt;
  assert.equal(blank.notes.some((n) => n.startsWith(NOTE_PREFIX)), false);

  // A discovered run is not a refusal: the identity is kept, no refusal note.
  const discovered = foldLaunchOutcome(reserved(), { stage: "LAUNCH_UNKNOWN", reason: "ignored", external_run_id: "run_1", worker_identity: "w-1" }, {}).receipt;
  assert.equal(discovered.stage, "LAUNCH_UNKNOWN");
  assert.equal(discovered.external_run_id, "run_1");
  assert.equal(discovered.notes.some((n) => n.startsWith(NOTE_PREFIX)), false);
});

// --- 2. A transport fault always names a non-empty cause ----------------------
test("a non-Error or empty-code throw still names a non-empty cause", async () => {
  const cases = [
    { thrown: {}, expect: "[object Object]", label: "bare object throw" },
    { thrown: { code: "", message: "" }, expect: "[object Object]", label: "empty code and message" },
    { thrown: undefined, expect: "unknown error", label: "undefined throw" },
    { thrown: "", expect: "unknown error", label: "empty string throw" },
    { thrown: new Error("connect ECONNREFUSED"), expect: "connect ECONNREFUSED", label: "Error message" },
    { thrown: Object.assign(new Error("shadowed"), { code: "ENOENT" }), expect: "ENOENT", label: "Error code wins" },
  ];
  for (const { thrown, expect, label } of cases) {
    const { launch } = await foldTransport(async () => { throw thrown; });
    assert.equal(launch.stage, "LAUNCH_UNKNOWN", label);
    assert.ok(launch.reason.startsWith(CAUSE_PREFIX), `${label}: ${launch.reason}`);
    const cause = launch.reason.slice(CAUSE_PREFIX.length);
    assert.ok(cause.length > 0, `${label}: the cause must never be empty`);
    assert.notEqual(cause, "undefined", `${label}: a non-Error throw must not read as "undefined"`);
    assert.equal(cause, expect, label);
  }
});

// --- 3. A rejected launch can never read as RUNNING ---------------------------
test("a rejected launch can never read as RUNNING", async () => {
  const refusals = [
    async () => ({ ok: false, stage: "HOLD", reason: "dispatch disabled" }),
    async () => ({ ok: false, stage: "HOLD", reason: "supervisor stopping" }),
    async () => { throw Object.assign(new Error("refused"), { code: "ECONNREFUSED" }); },
  ];
  for (const transport of refusals) {
    const { transition } = await foldTransport(transport);
    assert.notEqual(transition.receipt.stage, "RUNNING", "a refusal must never be a run");
    assert.equal(transition.receipt.stage, "LAUNCH_UNKNOWN");
    assert.equal(transition.receipt.external_run_id, null, "a refusal must not mint a run identity");
    assert.equal(transition.receipt.worker_identity, null, "a refusal must not mint a worker identity");
  }

  // Even a bare LAUNCH_UNKNOWN with no reason at all stays held, never RUNNING.
  const bare = foldLaunchOutcome(reserved(), { stage: "LAUNCH_UNKNOWN" }, {});
  assert.equal(bare.receipt.stage, "LAUNCH_UNKNOWN");
  assert.equal(bare.receipt.external_run_id, null);
});

// --- 4. End to end: the dispatch line and the durable receipt both name it ----
// The REAL reconcile tick, the REAL supervisor adapter, a refusing transport.
// Nothing in this test is simulated except the transport answer itself.
// FAILS on main (neither the stdout line nor the durable note carries the reason).
test("end-to-end: a refused launch names itself on the dispatch line and in the durable receipt", async () => {
  const h = createEpisodeHarness({ githubToken: "fake-token" });
  try {
    const { text } = await h.runTick({
      env: { SHU_SUPERVISOR_SECRET: SECRET },
      io: { supervisorTransport: async () => ({ ok: false, stage: "HOLD", reason: "dispatch disabled" }) },
    });

    assert.match(
      text,
      /dispatch: SHU-140 RESERVED -> LAUNCH_UNKNOWN \(external_run_id=null, pause_adapter=false\) — launch not acknowledged: dispatch disabled/,
      `the dispatch line must name the refusal; got:\n${text}`,
    );

    const receipt = h.receipts()[0];
    assert.ok(receipt, "a receipt must have been reserved and persisted");
    assert.equal(receipt.stage, "LAUNCH_UNKNOWN", "the single dispatch slot stays held");
    assert.equal(receipt.external_run_id, null, "a refusal mints no run identity");
    assert.ok(
      receipt.notes.includes(`${NOTE_PREFIX}dispatch disabled`),
      `the durable (Linear) receipt must carry the refusal; got ${JSON.stringify(receipt.notes)}`,
    );
  } finally {
    h.cleanup();
  }
});

// SHU-71: a launch needs room in /tmp for its workspace and the broker's result.
// A short /tmp refuses before reservation, so it costs no slot and no episode,
// and the activation itself stays armed: publication re-reads that status and
// must never be refused for the room its own snapshot takes.
test("SHU71_TMP_FLOOR: a short /tmp refuses the launch visibly before reservation and leaves the activation armed", async () => {
  const h = createEpisodeHarness();
  try {
    const short = await h.runTick({ io: { tmpFreeBytes: () => 300 * 1048576 } });
    assert.equal(short.code, 2, short.text);
    assert.match(short.text, /dispatch: ABORTED before reservation — only 300 MiB free in .+; a launch needs at least 1024 MiB/);
    assert.equal(h.receipts().length, 0, "no slot is reserved");
    assert.deepEqual(h.triggers, { "codex-cli": 0, "claude-code": 0, "hermes-pool": 0 });
    const unreadable = await h.runTick({ io: { tmpFreeBytes: () => null } });
    assert.match(unreadable.text, /dispatch: ABORTED before reservation — free space in .+ could not be read \(fail closed\)/);
    assert.equal(h.receipts().length, 0);
    const roomy = await h.runTick({ io: { tmpFreeBytes: () => 1024 * 1048576 } });
    assert.equal(roomy.code, 0, roomy.text);
    assert.equal(h.receipts().length, 1, "exactly the floor launches");
    assert.equal(h.triggers["codex-cli"], 1);
  } finally { h.cleanup(); }
});
