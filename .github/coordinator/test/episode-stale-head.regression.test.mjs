// SHU-225 BLOCK regression (Opus, PR #69).
//
// episode-harness.mjs runs the original dedicated tests with GITHUB_TOKEN="", so
// live-head verification is short-circuited. These tests run the same episode
// with a token configured, matching the production workflow.
import { test } from "node:test";
import assert from "node:assert/strict";
import { main } from "../reconcile.mjs";
import { createEpisodeHarness, SHA_INPUT, SHA_WRITE } from "./fixture/episode-harness.mjs";

const NOW = new Date("2026-09-10T12:00:00.000Z");

function withGithub(h, headRef) {
  const fetchImpl = async (url, opts) => {
    const u = String(url);
    if (u.includes("api.github.com")) {
      if (/\/branches\//.test(u)) return { status: 200, ok: true, json: async () => ({ commit: { sha: headRef.value } }) };
      const c = /\/commits\/([0-9a-f]{40})$/.exec(u);
      if (c) return { status: 200, ok: true, json: async () => ({ sha: c[1] }) };
      return { status: 404, ok: false, json: async () => ({}) };
    }
    return h.fetchImpl(url, opts);
  };
  return async () => {
    const out = [];
    const code = await main(["--activation", h.activationPath], {
      ENABLE_DISPATCH: "true",
      LINEAR_API_TOKEN: "tok",
      GITHUB_TOKEN: "ghtok",
      DISPATCH_TARGET_SHA: SHA_INPUT,
    }, {
      configPath: h.configPath,
      skipActivationPreflight: true,
      now: () => NOW,
      gitHead: h.record.coordinator_revision,
      stdout: (s) => out.push(s),
      fetchDurable: true,
      pollRuns: true,
      adapterModules: h.adapters,
      fetchImpl,
    });
    return { code, text: out.join("\n") };
  };
}

test("R1: a successor is never LAUNCHED bound to a head the coordinator has verified as stale", async () => {
  const h = createEpisodeHarness();
  const head = { value: SHA_INPUT };
  const tick = withGithub(h, head);
  try {
    await tick();
    const build = h.launched[0];
    h.completeRun(build.run_id);
    h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
    await tick();
    const t3 = await tick();

    const refusedAsStale = /FORGED or stale/.test(t3.text);
    const launched = h.launched[1] ?? null;
    if (refusedAsStale) {
      assert.equal(launched, null,
        `successor launched (lane=${launched?.lane}, head=${launched?.target_sha}) after the same tick refused it as FORGED or stale`);
    }
    if (launched) {
      assert.equal(launched.target_sha, head.value,
        "a launched successor must be bound to the verified live branch head");
    }
  } finally {
    h.cleanup();
  }
});

test("R2: one armed activation cannot launch an unbounded series of runs", async () => {
  const h = createEpisodeHarness();
  const head = { value: SHA_INPUT };
  const tick = withGithub(h, head);
  try {
    await tick();
    const build = h.launched[0];
    head.value = SHA_WRITE;
    h.completeRun(build.run_id);
    h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
    await tick();

    for (let round = 0; round < 8; round += 1) {
      await tick();
      const last = h.launched[h.launched.length - 1];
      if (!last || last === build) break;
      h.completeRun(last.run_id);
      h.postCallback({ attemptId: last.attempt_id, stage: "PASS", targetSha: last.target_sha });
      await tick();
    }
    assert.ok(h.launched.length <= 4,
      `one activation launched ${h.launched.length} runs: ${h.launched.map((l) => `${l.lane}@${l.target_sha.slice(0, 8)}`).join(", ")}`);
  } finally {
    h.cleanup();
  }
});

test("R3: an unreadable live branch head refuses before lifecycle or successor writes", async () => {
  const h = createEpisodeHarness();
  try {
    // Establish a valid terminal write without GitHub, then enable the production
    // token path while making the branch endpoint unreadable.
    await h.runTick();
    const build = h.launched[0];
    h.completeRun(build.run_id);
    h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
    await h.runTick();
    const writesBefore = h.comments.length;
    const launchesBefore = h.launched.length;
    const fetchImpl = async (url, opts) => {
      if (String(url).includes("api.github.com")) return { status: 503, ok: false, json: async () => ({}) };
      return h.fetchImpl(url, opts);
    };
    const out = [];
    const code = await main(["--activation", h.activationPath], {
      ENABLE_DISPATCH: "true", LINEAR_API_TOKEN: "tok", GITHUB_TOKEN: "ghtok", DISPATCH_TARGET_SHA: SHA_INPUT,
    }, {
      configPath: h.configPath, skipActivationPreflight: true, now: () => NOW,
      gitHead: h.record.coordinator_revision, stdout: (s) => out.push(s), fetchDurable: true,
      pollRuns: true, adapterModules: h.adapters, fetchImpl,
    });
    assert.equal(code, 2);
    assert.match(out.join("\n"), /live branch head could not be verified/);
    assert.equal(h.comments.length, writesBefore, "refusal writes no receipt or directive");
    assert.equal(h.launched.length, launchesBefore, "refusal launches nothing");
  } finally {
    h.cleanup();
  }
});

test("R4: a branch move after selection is rechecked before RESERVED", async () => {
  const h = createEpisodeHarness();
  try {
    await h.runTick();
    const build = h.launched[0];
    h.completeRun(build.run_id);
    h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
    await h.runTick();

    let branchReads = 0;
    const fetchImpl = async (url, opts) => {
      const u = String(url);
      if (u.includes("api.github.com") && /\/branches\//.test(u)) {
        branchReads += 1;
        const sha = branchReads < 3 ? SHA_WRITE : "c".repeat(40);
        return { status: 200, ok: true, json: async () => ({ commit: { sha } }) };
      }
      return h.fetchImpl(url, opts);
    };
    const out = [];
    const code = await main(["--activation", h.activationPath], {
      ENABLE_DISPATCH: "true", LINEAR_API_TOKEN: "tok", GITHUB_TOKEN: "ghtok", DISPATCH_TARGET_SHA: SHA_INPUT,
    }, {
      configPath: h.configPath, skipActivationPreflight: true, now: () => NOW,
      gitHead: h.record.coordinator_revision, stdout: (s) => out.push(s), fetchDurable: true,
      pollRuns: true, adapterModules: h.adapters, fetchImpl,
    });
    assert.equal(branchReads, 3, "head is checked again at the reservation boundary");
    assert.equal(code, 2);
    assert.match(out.join("\n"), /ABORTED before reservation/);
    assert.equal(h.launched.length, 1, "the moved-head successor is not launched");
    assert.equal(h.receipts().filter((r) => r.requested_worker === "claude-verifier").length, 0, "no successor reservation is persisted");
  } finally {
    h.cleanup();
  }
});

// R5 — SHU-225 BLOCK regression #2 (Opus, PR #69 @ ddfab84).
//
// R2 no longer exercises the case it was written for: its branch head never moves,
// so the episode is refused at the stale-head boundary and only one run is ever
// launched. This drives the HONEST push flow — every live-head check succeeds — and
// discards the review's verdict for a reason that has nothing to do with heads.
//
// I7 (SHU-225): "at most one successor per (issue_id, predecessor attempt_id)".
async function runEpisode(discard) {
  const h = createEpisodeHarness({ githubToken: "ghtok" });
  await h.runTick();
  const build = h.launched[0];
  h.branchHead.value = SHA_WRITE;
  h.postCallback({ attemptId: build.attempt_id, stage: "BUILD_READY", targetSha: SHA_INPUT, resultSha: SHA_WRITE });
  h.completeRun(build.run_id);
  await h.runTick();
  assert.equal(h.receiptFor(build.attempt_id).stage, "COMPLETED", "precondition: the pushed build folds cleanly");

  for (let round = 0; round < 8; round += 1) {
    const before = h.launched.length;
    await h.runTick();
    if (h.launched.length === before) break;
    const last = h.launched[h.launched.length - 1];
    discard(h, last);
    h.completeRun(last.run_id);
    await h.runTick();
  }
  const ledger = h.launched.map((l) => `${l.lane}@${l.target_sha.slice(0, 8)}`).join(", ");
  const total = h.launched.length;
  h.cleanup();
  return { total, ledger };
}

test("R5: a review whose verdict is discarded is not relaunched without limit (worker posted no callback)", async () => {
  const { total, ledger } = await runEpisode(() => {});
  assert.ok(total <= 4, `one armed activation launched ${total} runs: ${ledger}`);
  assert.equal(total, 2, "the ambiguous review HOLD is not retried from the older build");
});

test("R5b: ... nor when the callback carries an unusable stage", async () => {
  const { total, ledger } = await runEpisode((h, last) => {
    h.postCallback({ attemptId: last.attempt_id, stage: "NOT_A_STAGE", targetSha: last.target_sha });
  });
  assert.ok(total <= 4, `one armed activation launched ${total} runs: ${ledger}`);
  assert.equal(total, 2, "an unusable review verdict is not retried from the older build");
});
