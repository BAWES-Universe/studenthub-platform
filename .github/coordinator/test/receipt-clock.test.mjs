import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createReceipt, nextReceiptState, foldLaunchOutcome } from "../reconcile.mjs";
import { createEpisodeHarness } from "./fixture/episode-harness.mjs";

const EPOCHS = ["2020-01-01T12:00:00.000Z", "2030-01-01T12:00:00.000Z"];
function reserved(at) {
  const result = createReceipt({ issue_id: "SHU-229", authorization_ref: "SHU-229",
    requested_worker: "codex-builder", repo: "BAWES-Universe/studenthub-platform",
    branch: "coordinator/test", target_sha: "a".repeat(40), reserved_at: at });
  assert.equal(result.ok, true);
  return result.receipt;
}
function assertClock(receipt, at) {
  assert.equal(receipt.last_activity, at, "receipt activity must follow injected clock");
  for (const [key, stamp] of Object.entries(receipt.timestamps)) {
    if (stamp !== null && key !== "reserved") assert.equal(stamp, at, `${key} must follow injected clock`);
  }
}

for (const at of EPOCHS) {
  test(`SHU-229: every synchronous fold outcome honours clock (${at.slice(0,4)})`, () => {
    const receipt = reserved(at), ctx = { now: () => new Date(at) };
    const identity = { external_run_id: "codexrun_clock", worker_identity: "codex:clock" };
    const outcomes = [
      { stage: "RUNNING", ...identity },
      { stage: "LAUNCH_UNKNOWN", ...identity },
      { stage: "HOLD", pause_adapter: true, reason: "broker refused", ...identity },
      { stage: "HOLD", ...identity },
      { stage: "FAILED", error_code: "TEST_FAILURE", ...identity },
      { stage: "COMPLETED", ...identity, callback: { attempt_id: receipt.attempt_id, target_sha: receipt.target_sha,
        stage: "BUILD_READY", links: ["https://example.invalid/evidence"] } },
    ];
    for (const outcome of outcomes) {
      const folded = foldLaunchOutcome(receipt, outcome, ctx);
      assert.equal(folded.accepted, true, JSON.stringify(outcome));
      assertClock(folded.receipt, at);
    }
    const explicit = "2019-01-01T00:00:00.000Z";
    assertClock(nextReceiptState(receipt, { type: "launch", at: explicit }, ctx).receipt, explicit);
  });

  test(`SHU-229: main recovery stamps its own tick (${at.slice(0,4)})`, async () => {
    const now = new Date(at), h = createEpisodeHarness({ now });
    try {
      h.adapters["codex-cli"].launchBuilder = async () => ({ stage: "LAUNCH_UNKNOWN", external_run_id: "codexrun_clock", worker_identity: "codex:clock" });
      await h.runTick();
      assert.equal(h.receipts().at(-1).stage, "LAUNCH_UNKNOWN");
      assertClock(h.receipts().at(-1), at);
      const next = new Date(now.getTime() + 1000);
      h.adapters["codex-cli"].launchBuilder = async () => ({ stage: "HOLD", pause_adapter: true, reason: "recovery held" });
      await h.runTick({ now: next });
      const held = h.receipts().at(-1);
      assert.equal(held.stage, "HOLD");
      assert.equal(held.last_activity, next.toISOString(), "recovery must use the new injected tick");
      assert.equal(held.timestamps.terminal, next.toISOString());
      assert.equal(held.timestamps.reserved, at, "recovery must retain reservation history");
    } finally { h.cleanup(); }
  });

  test(`SHU-229: preparation HOLD uses injected clock (${at.slice(0,4)})`, async () => {
    const h = createEpisodeHarness({ now: new Date(at) });
    try {
      await h.runTick({ io: { prepareWorkspace: () => { throw new Error("synthetic preparation refusal"); } } });
      const held = h.receipts().at(-1);
      assert.equal(held.stage, "HOLD"); assertClock(held, at);
      assert.equal(h.launched.length, 0);
    } finally { h.cleanup(); }
  });
}

test("SHU-229: absent injection keeps real clock fallback", () => {
  const before = Date.now(), receipt = reserved(undefined);
  const result = nextReceiptState(receipt, { type: "launch" });
  for (const stamp of [receipt.timestamps.reserved, result.receipt.last_activity, result.receipt.timestamps.launch]) {
    assert.ok(Date.parse(stamp) >= before && Date.parse(stamp) <= Date.now());
  }
});

const mutations = [
  ["transition clock", "const at = () => nowIso(event.at ?? ctx.now?.());", "const at = () => nowIso(event.at);", "single-run-activation.test.mjs", "ONE authorization.*2030", "coordinator receipt must use injected clock"],
  ["reservation clock", "reserved_at: nowIso(io.now?.()),", "", "single-run-activation.test.mjs", "ONE authorization.*2030", "receipt timestamps must use injected clock"],
  ["recovery clock", "foldLaunchOutcome(receipt, launch, { ...recoveryCtx, now: io.now })", "foldLaunchOutcome(receipt, launch, recoveryCtx)", "receipt-clock.test.mjs", "main recovery.*2030", "recovery must use the new injected tick"],
];
for (const [name, before, after, file, pattern, assertion] of mutations) {
  test(`SHU-229 mutation: ${name}`, () => {
    const dir = fs.mkdtempSync(join(tmpdir(), "shu229-mutation-"));
    try {
      fs.cpSync(new URL("../", import.meta.url), dir, { recursive: true });
      const target = join(dir, "reconcile.mjs"), original = fs.readFileSync(target, "utf8");
      assert.equal(original.split(before).length, 2);
      fs.writeFileSync(target, original.replace(before, after));
      const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
      const result = spawnSync(process.execPath, ["--test", `--test-name-pattern=${pattern}`, join(dir, "test", file)],
        { env, encoding: "utf8", timeout: 20000 });
      assert.equal(result.status, 1, result.stdout + result.stderr);
      assert.match(result.stdout + result.stderr, /AssertionError/);
      assert.ok((result.stdout + result.stderr).includes(assertion), result.stdout + result.stderr);
    } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  });
}
