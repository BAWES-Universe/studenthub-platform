// shu71-stranded-reservation.test.mjs
//
// SHU-71 run 9: two reservations were written and never launched. The tick that
// wrote each one stopped before the launch intent (LAUNCH_UNKNOWN), nothing ever
// moved them on, and together they held max_dispatch=2 until the coordinator
// could start nothing at all. Every later tick reported CAPACITY_FULL.
//
// A RESERVED receipt provably started no worker: LAUNCH_UNKNOWN is written before
// any adapter is reached. These tests pin what a later tick now does with one:
// inside the armed episode it is launched again under the SAME attempt for a
// bounded window; outside that (another episode, or too old, or its bound head
// moved) it is released to HOLD with reason code RESERVATION_UNLAUNCHED.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  createReceipt,
  nextReceiptState,
  strandedReservationAction,
  RESERVATION_UNLAUNCHED,
  STRANDED_RESERVATION_MS,
  RESERVATION_RESUME_WINDOW_MS,
} from "../reconcile.mjs";
import { createEpisodeHarness } from "./fixture/episode-harness.mjs";

const T0 = new Date("2026-09-10T12:00:00.000Z");
const at = (ms) => new Date(T0.getTime() + ms);

function reserved(overrides = {}) {
  const { ok, receipt, errors } = createReceipt({
    issue_id: "SHU-140",
    authorization_ref: "FIXTURE-OPUS-CONTRACT-20260905",
    requested_worker: "codex-builder",
    repo: "BAWES-Universe/studenthub-platform",
    branch: "coordinator/SHU-140",
    target_sha: "a".repeat(40),
    episode_id: "episode-a",
    reserved_at: T0.toISOString(),
    ...overrides,
  });
  assert.equal(ok, true, (errors ?? []).join("; "));
  return receipt;
}

// The run-9 shape: the reservation is written, then Linear rate-limits the very
// next read, so the tick ends (exit 0, HOLD=LINEAR_RATE_LIMITED) before it can
// write the launch intent.
function strandAfterReservation(h) {
  let reservedWritten = false;
  let tripped = false;
  return async (url, opts) => {
    if (!tripped && !String(url).includes("api.github.com")) {
      const { query, variables } = JSON.parse(opts.body);
      if (query.includes("commentCreate") && String(variables.body ?? "").includes('"stage": "RESERVED"')) reservedWritten = true;
      else if (reservedWritten && query.includes("CoordinatorIssueComments")) {
        tripped = true;
        return { status: 429, ok: false, headers: { get: () => null }, json: async () => ({ errors: [{ message: "rate limit exceeded" }] }) };
      }
    }
    return h.fetchImpl(url, opts);
  };
}

async function strandedHarness(options = {}) {
  const h = createEpisodeHarness({ now: T0, ...options });
  const stranded = await h.runTick({ now: T0, io: { fetchImpl: strandAfterReservation(h) } });
  assert.equal(stranded.code, 0, stranded.text);
  assert.match(stranded.text, /HOLD=LINEAR_RATE_LIMITED/);
  const [receipt] = h.receipts();
  assert.equal(receipt.stage, "RESERVED", "the run-9 state: a reservation and no launch intent");
  assert.equal(h.launched.length, 0);
  return { h, receipt };
}

test("SHU71_STRANDED_ACTION: only an old RESERVED receipt is stranded, and only its own episode resumes it", () => {
  const r = reserved();
  const opts = (ms, episodeId = "episode-a") => ({ now: at(ms), episodeId });
  assert.equal(strandedReservationAction(r, opts(STRANDED_RESERVATION_MS - 1)), null, "a reservation from this tick is not stranded");
  assert.equal(strandedReservationAction(r, opts(STRANDED_RESERVATION_MS)), "resume");
  assert.equal(strandedReservationAction(r, opts(RESERVATION_RESUME_WINDOW_MS - 1)), "resume");
  assert.equal(strandedReservationAction(r, opts(RESERVATION_RESUME_WINDOW_MS)), "release", "the resume window is bounded");
  assert.equal(strandedReservationAction(r, opts(STRANDED_RESERVATION_MS, "episode-b")), "release", "another episode's reservation is released");
  assert.equal(strandedReservationAction(r, opts(STRANDED_RESERVATION_MS, null)), "release", "with no armed episode nothing resumes");
  const launched = nextReceiptState(r, { type: "launch" }, { now: () => T0 }).receipt;
  assert.equal(strandedReservationAction(launched, opts(RESERVATION_RESUME_WINDOW_MS * 4)), null, "a launched attempt is never stranded");
});

test("SHU71_STRANDED_RELEASE_EVENT: release_unlaunched holds only a RESERVED receipt and names the reason", () => {
  const released = nextReceiptState(reserved(), { type: "release_unlaunched", reason: "never launched" }, { now: () => at(STRANDED_RESERVATION_MS) });
  assert.equal(released.accepted, true);
  assert.equal(released.receipt.stage, "HOLD");
  assert.equal(released.receipt.external_run_id, null);
  assert.equal(released.receipt.timestamps.launch, null);
  assert.ok(released.receipt.timestamps.terminal);
  assert.ok(released.receipt.notes.some((n) => n.includes(RESERVATION_UNLAUNCHED)), JSON.stringify(released.receipt.notes));
  const launched = nextReceiptState(reserved(), { type: "launch" }, { now: () => T0 }).receipt;
  assert.equal(nextReceiptState(launched, { type: "release_unlaunched" }).accepted, false, "a launch intent may have reached a worker");
});

test("SHU71_STRANDED_RESUME: a later tick launches the stranded reservation under the same attempt", async () => {
  const { h, receipt } = await strandedHarness();
  try {
    const early = await h.runTick({ now: at(30_000) });
    assert.equal(h.launched.length, 0, `a reservation younger than one tick is left alone:\n${early.text}`);
    assert.equal(h.receipts().length, 1, "and no second reservation is written beside it");

    const later = await h.runTick({ now: at(STRANDED_RESERVATION_MS + 30_000) });
    assert.equal(later.code, 0, later.text);
    assert.match(later.text, new RegExp(`dispatch: resuming reservation ${receipt.attempt_id} on SHU-140`));
    assert.equal(h.launched.length, 1, later.text);
    assert.equal(h.launched[0].attempt_id, receipt.attempt_id, "the same attempt, never a new one");
    const all = h.receipts();
    assert.equal(all.length, 1, "no second reservation");
    assert.equal(all[0].stage, "RUNNING");
  } finally { h.cleanup(); }
});

test("SHU71_STRANDED_RELEASE: past the resume window the reservation is released and frees its slot", async () => {
  const { h, receipt } = await strandedHarness();
  try {
    const tick = await h.runTick({ now: at(RESERVATION_RESUME_WINDOW_MS + 1_000) });
    assert.equal(tick.code, 0, tick.text);
    assert.match(tick.text, new RegExp(`lifecycle: SHU-140 RESERVED -> HOLD \\(${RESERVATION_UNLAUNCHED}, attempt ${receipt.attempt_id}\\)`));
    assert.match(tick.text, /dispatch: DEFERRED/);
    assert.equal(h.launched.length, 0);
    const held = h.receiptFor(receipt.attempt_id);
    assert.equal(held.stage, "HOLD");
    assert.equal(held.external_run_id, null);
  } finally { h.cleanup(); }
});

test("SHU71_STRANDED_OTHER_EPISODE: a new episode releases the reservation an earlier one left behind", async () => {
  const { h, receipt } = await strandedHarness();
  try {
    // The run-10 shape: the record is re-armed under a new activation id.
    const { writeFileSync, chmodSync } = await import("node:fs");
    writeFileSync(h.activationPath, JSON.stringify({ ...h.record, activation_id: "shu225fixtureactivation-next" }, null, 1));
    chmodSync(h.activationPath, 0o600);
    const tick = await h.runTick({ now: at(STRANDED_RESERVATION_MS + 1_000) });
    assert.match(tick.text, new RegExp(`RESERVED -> HOLD \\(${RESERVATION_UNLAUNCHED}, attempt ${receipt.attempt_id}\\)`), tick.text);
    assert.equal(h.receiptFor(receipt.attempt_id).stage, "HOLD");
    assert.equal(h.launched.length, 0, "the old episode's attempt is never launched");
  } finally { h.cleanup(); }
});

test("SHU71_STRANDED_HEAD_MOVED: a stranded reservation whose bound head moved is released, not launched", async () => {
  const { h, receipt } = await strandedHarness({ githubToken: "fake-token" });
  try {
    h.branchHead.value = "e".repeat(40);
    const tick = await h.runTick({ now: at(STRANDED_RESERVATION_MS + 1_000) });
    assert.match(tick.text, /RESERVED -> HOLD \(RESERVATION_UNLAUNCHED, attempt .+\) — bound head moved/, tick.text);
    assert.equal(h.launched.length, 0);
    assert.equal(h.receiptFor(receipt.attempt_id).stage, "HOLD");
  } finally { h.cleanup(); }
});

test("SHU71_TICK_LOGS: the production tick writes its decision lines to the journal", async () => {
  const { coordinatorEntry } = await import("../service/coordinator-tick.mjs");
  const { ACTIVATION_FILE } = await import("../service/credential-delivery.mjs");
  const lines = [];
  const seen = [];
  const tick = (_args, _env, io) => { seen.push(io); io?.stdout?.("dispatch: a decision line"); return 0; };
  assert.equal(await coordinatorEntry(["--activation", ACTIVATION_FILE], { ENABLE_DISPATCH: "true" }, { tick, stdout: (l) => lines.push(l) }), 0);
  assert.deepEqual(lines, ["dispatch: a decision line"], "the tick receives a line writer");
  const logged = [];
  const original = console.log;
  console.log = (line) => logged.push(line);
  try {
    assert.equal(await coordinatorEntry(["--activation", ACTIVATION_FILE], { ENABLE_DISPATCH: "true" }, { tick }), 0);
  } finally { console.log = original; }
  assert.deepEqual(logged, ["dispatch: a decision line"], "with no writer given, the lines go to stdout (the journal)");
});
