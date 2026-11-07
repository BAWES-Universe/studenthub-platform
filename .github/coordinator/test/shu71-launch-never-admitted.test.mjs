// shu71-launch-never-admitted.test.mjs
//
// SHU-495, 2026-11-06T06:47Z: a revise attempt was sent to the supervisor, which
// refused it BRANCH_OCCUPIED before writing any order. The receipt stayed at
// LAUNCH_UNKNOWN with no run id, so it held the issue's slot. Every later tick
// re-sent it and got the same refusal, and when the card was run again in a new
// episode that episode could never dispatch its own first step.
//
// These tests pin what a tick now does with such a receipt: a LAUNCH_UNKNOWN left
// by an EARLIER episode, with no acknowledged run, is asked about over the
// supervisor's status operation only. When the supervisor answers MISSING_CLAIM
// (it holds no order, so nothing ran) the receipt is released to HOLD and is
// never sent again. Any other answer keeps today's behaviour.
import { test } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, chmodSync } from "node:fs";
import {
  LAUNCH_NEVER_ADMITTED,
  otherEpisodeUnacknowledgedLaunch,
  supervisorDisownsLaunch,
} from "../reconcile.mjs";
import { createEpisodeHarness } from "./fixture/episode-harness.mjs";

const T0 = new Date("2026-09-10T12:00:00.000Z");
const at = (ms) => new Date(T0.getTime() + ms);
const MISSING_CLAIM = { ok: false, stage: "HOLD", hold_code: "MISSING_CLAIM", detail_code: "NO_RECORDS", reason: "supervisor holds no record of this attempt" };
// The supervisor's catch-all: records it cannot read. Not proof of absence.
const UNREADABLE = { ok: false, stage: "HOLD", hold_code: "MISSING_CLAIM", reason: "supervisor attempt unavailable" };

// The 06:47Z shape: the supervisor refuses the launch before admitting it, so
// the adapter answers LAUNCH_UNKNOWN with no run id.
function refuseLaunches(h) {
  const adapter = h.adapters["codex-cli"];
  const original = adapter.launchBuilder;
  const sends = [];
  adapter.launchBuilder = async (o) => {
    sends.push(o.attempt_id);
    return { stage: "LAUNCH_UNKNOWN", reason: "branch already owned by an unfinished attempt" };
  };
  return { sends, restore: () => { adapter.launchBuilder = original; } };
}

function rearm(h, activationId) {
  writeFileSync(h.activationPath, JSON.stringify({ ...h.record, activation_id: activationId }, null, 1));
  chmodSync(h.activationPath, 0o600);
}

async function heldLaunch() {
  const h = createEpisodeHarness({ now: T0 });
  const refused = refuseLaunches(h);
  const first = await h.runTick({ now: T0 });
  assert.equal(first.code, 0, first.text);
  const [receipt] = h.receipts();
  assert.equal(receipt.stage, "LAUNCH_UNKNOWN", first.text);
  assert.equal(receipt.external_run_id, null);
  assert.equal(receipt.episode_id, "shu225fixtureactivation");
  return { h, receipt, refused };
}

test("SHU71_NEVER_ADMITTED_PREDICATE: only an earlier episode's unacknowledged launch qualifies", () => {
  const base = { stage: "LAUNCH_UNKNOWN", external_run_id: null, episode_id: "episode-a" };
  assert.equal(otherEpisodeUnacknowledgedLaunch(base, "episode-b"), true);
  assert.equal(otherEpisodeUnacknowledgedLaunch(base, "episode-a"), false, "the armed episode's own launch is resumed, not released");
  assert.equal(otherEpisodeUnacknowledgedLaunch(base, null), false, "with no armed episode nothing is released");
  assert.equal(otherEpisodeUnacknowledgedLaunch({ ...base, external_run_id: "supervisor_x" }, "episode-b"), false, "a discovered run is never released here");
  assert.equal(otherEpisodeUnacknowledgedLaunch({ ...base, episode_id: null }, "episode-b"), false, "an untagged receipt has no ended episode to point at");
  assert.equal(otherEpisodeUnacknowledgedLaunch({ ...base, stage: "RUNNING" }, "episode-b"), false);
  assert.equal(otherEpisodeUnacknowledgedLaunch({ ...base, review_base_sha: "b".repeat(40) }, "episode-b"), false, "a review-only recovery keeps its own path");
  assert.equal(supervisorDisownsLaunch(MISSING_CLAIM), true);
  assert.equal(supervisorDisownsLaunch(UNREADABLE), false, "a bare MISSING_CLAIM may be records the supervisor cannot read");
  assert.equal(supervisorDisownsLaunch({ ok: false, stage: "HOLD", reason: "supervisor configuration unavailable: ECONNREFUSED" }), false, "a transport fault is not an answer");
  assert.equal(supervisorDisownsLaunch({ ok: false, stage: "HOLD", hold_code: "BRANCH_OCCUPIED" }), false);
  assert.equal(supervisorDisownsLaunch({ ok: true, durable: true, stage: "ACCEPTED", hold_code: "MISSING_CLAIM" }), false, "an admitted order is never disowned");
  assert.equal(supervisorDisownsLaunch(null), false);
});

test("SHU71_NEVER_ADMITTED_RELEASE: a new episode releases the launch an earlier one could not get admitted", async () => {
  const { h, receipt, refused } = await heldLaunch();
  try {
    const statusCalls = [];
    h.adapters["codex-cli"].status = async () => { statusCalls.push(1); return MISSING_CLAIM; };
    rearm(h, "shu225fixtureactivation-next");
    const sendsBefore = refused.sends.length;
    const tick = await h.runTick({ now: at(5 * 60_000) });
    assert.equal(tick.code, 0, tick.text);
    assert.match(tick.text, new RegExp(`LAUNCH_UNKNOWN -> HOLD \\(${LAUNCH_NEVER_ADMITTED}, attempt ${receipt.attempt_id}\\)`), tick.text);
    assert.equal(refused.sends.length, sendsBefore, "the old attempt is never sent again");
    assert.equal(statusCalls.length, 1, "the supervisor is asked over status");
    const held = h.receiptFor(receipt.attempt_id);
    assert.equal(held.stage, "HOLD");
    assert.equal(held.external_run_id, null);
    assert.ok(held.timestamps.terminal);
    assert.ok(held.notes.some((n) => n.includes(LAUNCH_NEVER_ADMITTED)), JSON.stringify(held.notes));

    refused.restore();
    const next = await h.runTick({ now: at(6 * 60_000) });
    assert.equal(next.code, 0, next.text);
    const fresh = h.receipts().filter((r) => r.attempt_id !== receipt.attempt_id);
    assert.equal(fresh.length, 1, `the new episode dispatches its own first step:\n${next.text}`);
    assert.equal(fresh[0].episode_id, "shu225fixtureactivation-next");
    assert.equal(fresh[0].stage, "RUNNING");
  } finally { h.cleanup(); }
});

test("SHU71_NEVER_ADMITTED_OWN_EPISODE: inside its own episode the launch is still re-sent, never released", async () => {
  const { h, receipt, refused } = await heldLaunch();
  try {
    let asked = 0;
    h.adapters["codex-cli"].status = async () => { asked += 1; return MISSING_CLAIM; };
    const sendsBefore = refused.sends.length;
    const tick = await h.runTick({ now: at(5 * 60_000) });
    assert.equal(tick.code, 0, tick.text);
    assert.equal(asked, 0, tick.text);
    assert.equal(refused.sends.length, sendsBefore + 1, "the same attempt is re-sent under its own episode");
    assert.equal(h.receiptFor(receipt.attempt_id).stage, "LAUNCH_UNKNOWN");
  } finally { h.cleanup(); }
});

test("SHU71_NEVER_ADMITTED_SUPERVISOR_KNOWS_IT: any answer but a provable absence keeps the receipt held", async () => {
  for (const answer of [
    { ok: true, version: "2.0.0", durable: true, stage: "ACCEPTED", hold_code: "AWAITING_LAUNCH" },
    { ok: false, stage: "HOLD", reason: "supervisor configuration unavailable: ECONNREFUSED" },
    UNREADABLE,
    "throw",
  ]) {
    const { h, receipt } = await heldLaunch();
    try {
      h.adapters["codex-cli"].status = async () => { if (answer === "throw") throw new Error("socket gone"); return answer; };
      rearm(h, "shu225fixtureactivation-next");
      const tick = await h.runTick({ now: at(5 * 60_000) });
      assert.equal(tick.code, 0, tick.text);
      assert.doesNotMatch(tick.text, new RegExp(LAUNCH_NEVER_ADMITTED), JSON.stringify(answer));
      assert.equal(h.receiptFor(receipt.attempt_id).stage, "LAUNCH_UNKNOWN", JSON.stringify(answer));
    } finally { h.cleanup(); }
  }
});

test("SHU71_NEVER_ADMITTED_SUPERVISOR_STATUS: the supervisor says NO_RECORDS only for an attempt it refused and never admitted", async (t) => {
  const { mkdtempSync, rmSync, writeFileSync: write, mkdirSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { EventEmitter } = await import("node:events");
  const { DurableSupervisor, signedSupervisorRequest } = await import("../supervisor.mjs");
  const secret = "shu71-never-admitted-secret-at-least-32-bytes";
  const order = { version: "1.0.0", role: "build", runtime: "hermes-pool", issue_id: "SHU-495",
    authorization_ref: "SHU-495", attempt_id: "8c9ee8af-247a-4806-8e07-3806e07e0003",
    target_sha: "a".repeat(40), repo: "example/repo", branch: "coordinator/SHU-495", task_context: "revise" };
  const dir = mkdtempSync(join(tmpdir(), "shu71-never-admitted-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const spawned = [];
  const supervisor = new DurableSupervisor({ stateDir: dir, secret, schedule: () => {}, probeProcess: () => true,
    spawnWorker: () => { const child = Object.assign(new EventEmitter(), { pid: 7001, processStartToken: "fixture" }); spawned.push(child); return child; } });
  t.after(() => spawned.forEach((c) => c.emit("exit", 1)));
  // The status order carries no cwd; the submitted one did.
  const ask = (o = order) => supervisor.status(signedSupervisorRequest(o, secret, "status"));

  // Lost or never-written state: no intent at all is not proof of anything.
  const lost = ask();
  assert.equal(lost.hold_code, "MISSING_CLAIM");
  assert.equal(lost.detail_code, undefined, "an empty store may be lost state");

  // An intent still waiting to launch is one recover() would admit: not refused.
  supervisor.store.intend({ ...order, cwd: "/srv/shu/worktrees/x" }, new Date().toISOString(), "AWAITING_LAUNCH");
  assert.equal(ask().detail_code, undefined, "AWAITING_LAUNCH is not a refusal");

  // The 06:47Z shape: the intent held BRANCH_OCCUPIED, no order, no run.
  supervisor.store.holdIntent({ ...order, cwd: "/srv/shu/worktrees/x" }, "BRANCH_OCCUPIED");
  const refused = ask();
  assert.equal(refused.ok, false);
  assert.equal(refused.hold_code, "MISSING_CLAIM");
  assert.equal(refused.detail_code, "NO_RECORDS");
  assert.equal(supervisorDisownsLaunch(refused), true);
  assert.equal(supervisorDisownsLaunch(ask({ ...order, target_sha: "b".repeat(40) })), false, "a different binding is not this attempt");

  // AMBIGUOUS_LAUNCH is set after a spawn was attempted: its records may be lost, not absent.
  supervisor.store.holdIntent({ ...order, cwd: "/srv/shu/worktrees/x" }, "AMBIGUOUS_LAUNCH");
  assert.equal(ask().detail_code, undefined, "partial state loss after a spawn attempt is not absence");
  supervisor.store.holdIntent({ ...order, cwd: "/srv/shu/worktrees/x" }, "BRANCH_OCCUPIED");

  // Fenced from supervisor recovery: a held intent is never admitted by recover().
  supervisor.recover();
  assert.equal(supervisorDisownsLaunch(ask()), true, "recover() admitted nothing");
  assert.equal(spawned.length, 0);

  // A record that exists but cannot be read is the catch-all, never NO_RECORDS.
  const paths = supervisor.store.paths(order.attempt_id);
  mkdirSync(paths.run);
  const unreadable = ask();
  assert.equal(unreadable.hold_code, "MISSING_CLAIM");
  assert.equal(unreadable.detail_code, undefined);
  rmSync(paths.run, { recursive: true });
  write(paths.order, "{");
  assert.equal(supervisorDisownsLaunch(ask()), false, "a corrupt order is not an absent one");
  rmSync(paths.order);

  // An admitted attempt answers with its stage.
  const other = { ...order, attempt_id: "9c9ee8af-247a-4806-8e07-3806e07e0004", branch: "coordinator/SHU-496" };
  const admitted = await supervisor.submit(signedSupervisorRequest(other, secret));
  assert.notEqual(admitted.ok, false, JSON.stringify(admitted));
  const known = ask(other);
  assert.equal(known.ok, true, JSON.stringify(known));
  assert.equal(supervisorDisownsLaunch(known), false);
});
