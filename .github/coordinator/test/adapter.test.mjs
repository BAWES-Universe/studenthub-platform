// Adapter tests — mocked network. The workspace-agents adapter's response mapping
// is the contract: 202+run -> RUNNING + external_run_id stored immediately +
// granular adapter_status; 5xx/transport -> LAUNCH_UNKNOWN; completed + validated
// callback -> COMPLETED; completed without callback -> HOLD; failed -> FAILED;
// quota/access -> FAILED + pause_adapter.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  launchBuilder,
  monitorRun,
  validateCallbackEvidence,
  buildTriggerHeaders,
} from "../adapters/workspace-agents.mjs";
import { launchIdempotencyKey } from "../reconcile.mjs";

const SHA = "d".repeat(40);
const SHA2 = "e".repeat(40);
const ATTEMPT = "11111111-2222-4333-8444-555555555555";
const TRIGGER = "wa_trigger_001";
const TOKEN = "secret-token"; // test fixture only — never a real secret

function mockFetch(status, body, { throws = false } = {}) {
  return async () => {
    if (throws) throw new Error("ECONNRESET");
    return {
      status,
      ok: status >= 200 && status < 300,
      json: async () => body,
    };
  };
}

function capturedFetch() {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    return { status: 202, ok: true, json: async () => ({ id: "apirun_abc123", status: "queued" }) };
  };
  impl.calls = calls;
  return impl;
}

test("launch 202 + agent_trigger_run_id -> RUNNING, external_run_id stored immediately", async () => {
  const out = await launchBuilder({
    issue_id: "SHU-50",
    authorization_ref: "SHU-50",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    task_context: "ctx",
    api_trigger_id: TRIGGER,
    token: TOKEN,
    fetchImpl: mockFetch(202, { conversation_url: "https://chatgpt.com/c/xyz", agent_trigger_run_id: "apirun_xyz" }),
  });
  assert.equal(out.stage, "RUNNING");
  assert.equal(out.external_run_id, "apirun_xyz"); // stored IMMEDIATELY
  assert.equal(out.adapter_status, "queued"); // accepted and waiting to start
  assert.equal(out.worker_identity, undefined, "identity only comes from the poll's agent_id");
  assert.equal(out.ok, true);
});

test("launch 202 without run id -> LAUNCH_UNKNOWN (never fabricate a run)", async () => {
  const out = await launchBuilder({
    issue_id: "SHU-50",
    authorization_ref: "SHU-50",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    task_context: "ctx",
    api_trigger_id: TRIGGER,
    token: TOKEN,
    fetchImpl: mockFetch(202, { status: "queued" }), // no id field
  });
  assert.equal(out.stage, "LAUNCH_UNKNOWN");
  assert.equal(out.external_run_id, undefined);
});

test("launch transport failure -> LAUNCH_UNKNOWN (outcome unknowable; slot held)", async () => {
  const out = await launchBuilder({
    issue_id: "SHU-50",
    authorization_ref: "SHU-50",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    task_context: "ctx",
    api_trigger_id: TRIGGER,
    token: TOKEN,
    fetchImpl: mockFetch(500, {}, { throws: true }),
  });
  assert.equal(out.stage, "LAUNCH_UNKNOWN");
  assert.match(out.reason, /transport failure/);
});

test("launch 5xx -> LAUNCH_UNKNOWN", async () => {
  const out = await launchBuilder({
    issue_id: "SHU-50",
    authorization_ref: "SHU-50",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    task_context: "ctx",
    api_trigger_id: TRIGGER,
    token: TOKEN,
    fetchImpl: mockFetch(503, {}),
  });
  assert.equal(out.stage, "LAUNCH_UNKNOWN");
  assert.match(out.reason, /503/);
});

test("launch 429/quota -> FAILED + pause_adapter=true", async () => {
  const out = await launchBuilder({
    issue_id: "SHU-50",
    authorization_ref: "SHU-50",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    task_context: "ctx",
    api_trigger_id: TRIGGER,
    token: TOKEN,
    fetchImpl: mockFetch(429, {}),
  });
  assert.equal(out.stage, "FAILED");
  assert.equal(out.pause_adapter, true);
  assert.equal(out.error_kind, "quota");
});

test("launch 403/access -> FAILED + pause_adapter=true", async () => {
  for (const status of [401, 403]) {
    const out = await launchBuilder({
      issue_id: "SHU-50",
      authorization_ref: "SHU-50",
      attempt_id: ATTEMPT,
      target_sha: SHA,
      task_context: "ctx",
      api_trigger_id: TRIGGER,
      token: TOKEN,
      fetchImpl: mockFetch(status, {}),
    });
    assert.equal(out.stage, "FAILED");
    assert.equal(out.pause_adapter, true);
    assert.equal(out.error_kind, "access");
  }
});

test("launch without token or trigger id -> LAUNCH_UNKNOWN (never sends unauthenticated)", async () => {
  const noToken = await launchBuilder({
    issue_id: "SHU-50", authorization_ref: "SHU-50", attempt_id: ATTEMPT, target_sha: SHA,
    task_context: "ctx", api_trigger_id: TRIGGER, token: "",
  });
  assert.equal(noToken.stage, "LAUNCH_UNKNOWN");
  const noTrigger = await launchBuilder({
    issue_id: "SHU-50", authorization_ref: "SHU-50", attempt_id: ATTEMPT, target_sha: SHA,
    task_context: "ctx", api_trigger_id: "", token: TOKEN,
  });
  assert.equal(noTrigger.stage, "LAUNCH_UNKNOWN");
});

test("trigger request shape: endpoint, headers (beta + Idempotency-Key), body references the authorized contract", async () => {
  const fetchImpl = capturedFetch();
  await launchBuilder({
    issue_id: "SHU-50",
    authorization_ref: "SHU-50",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    task_context: "build the thing",
    api_trigger_id: TRIGGER,
    token: TOKEN,
    fetchImpl,
  });
  assert.equal(fetchImpl.calls.length, 1);
  const { url, opts } = fetchImpl.calls[0];
  assert.equal(url, `https://api.chatgpt.com/v1/workspace_agents/${TRIGGER}/trigger`);
  assert.equal(opts.method, "POST");
  assert.equal(opts.headers["OpenAI-Beta"], "workspace_agent_runs=v1");
  assert.equal(opts.headers["Content-Type"], "application/json");
  assert.equal(opts.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(opts.headers["Idempotency-Key"], launchIdempotencyKey({ attempt_id: ATTEMPT, target_sha: SHA }));
  const body = JSON.parse(opts.body);
  assert.equal(body.conversation_key, "studenthub:SHU-50:builder");
  assert.equal(typeof body.input, "string", "the documented field is input, not prompt");
  assert.ok(!("prompt" in body), "prompt is NOT part of the trigger contract");
  assert.match(body.input, /Authorized contract ref: SHU-50/);
  assert.match(body.input, /Bound head: d{40}/);
});

test("buildTriggerHeaders carries the launch Idempotency-Key (LAUNCH_UNKNOWN stage embedded)", () => {
  const h = buildTriggerHeaders({ token: TOKEN, attempt_id: ATTEMPT, target_sha: SHA });
  assert.equal(h["Idempotency-Key"], `${ATTEMPT}:LAUNCH_UNKNOWN:${SHA}`);
});

test("monitor: run completed WITH validated callback -> COMPLETED", async () => {
  const out = await monitorRun({
    run_id: "apirun_1",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    current_head: SHA,
    evidence: { links: ["https://github.com/BAWES-Universe/studenthub-platform/pull/55"], attempt_id: ATTEMPT, target_sha: SHA },
    token: TOKEN,
    fetchImpl: mockFetch(200, { id: "apirun_1", status: "completed" }),
  });
  assert.equal(out.stage, "COMPLETED");
  assert.equal(out.adapter_status, "completed");
  assert.deepEqual(out.evidence_links, ["https://github.com/BAWES-Universe/studenthub-platform/pull/55"]);
});

test("monitor: run completed WITHOUT callback (or stale callback) -> HOLD, never COMPLETED", async () => {
  const none = await monitorRun({
    run_id: "apirun_2",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    evidence: null,
    token: TOKEN,
    fetchImpl: mockFetch(200, { id: "apirun_2", status: "completed" }),
  });
  assert.equal(none.stage, "HOLD");
  assert.equal(none.adapter_status, "completed");
  // stale head: callback matches receipt sha but the branch has moved
  const stale = await monitorRun({
    run_id: "apirun_3",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    current_head: SHA2,
    evidence: { links: ["https://github.com/x/pull/1"], attempt_id: ATTEMPT, target_sha: SHA },
    token: TOKEN,
    fetchImpl: mockFetch(200, { id: "apirun_3", status: "completed" }),
  });
  assert.equal(stale.stage, "HOLD");
  // mismatched attempt id
  const mismatch = await monitorRun({
    run_id: "apirun_4",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    evidence: { links: ["https://github.com/x/pull/1"], attempt_id: "22222222-3333-4444-8555-666666666666", target_sha: SHA },
    token: TOKEN,
    fetchImpl: mockFetch(200, { id: "apirun_4", status: "completed" }),
  });
  assert.equal(mismatch.stage, "HOLD");
});

test("monitor: run status queued/in_progress/suspended -> RUNNING with granular status", async () => {
  for (const status of ["queued", "in_progress", "suspended"]) {
    const out = await monitorRun({
      run_id: "apirun_5",
      attempt_id: ATTEMPT,
      target_sha: SHA,
      token: TOKEN,
      fetchImpl: mockFetch(200, { id: "apirun_5", status }),
    });
    assert.equal(out.stage, "RUNNING");
    assert.equal(out.adapter_status, status);
  }
});

test("monitor: run failed -> FAILED with upstream error code", async () => {
  const out = await monitorRun({
    run_id: "apirun_6",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    token: TOKEN,
    fetchImpl: mockFetch(200, { id: "apirun_6", status: "failed", last_error: { code: "EXEC_TIMEOUT" } }),
  });
  assert.equal(out.stage, "FAILED");
  assert.equal(out.error_code, "EXEC_TIMEOUT");
});

test("monitor: 429/quota -> FAILED + pause_adapter=true", async () => {
  const out = await monitorRun({
    run_id: "apirun_7",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    token: TOKEN,
    fetchImpl: mockFetch(429, {}),
  });
  assert.equal(out.stage, "FAILED");
  assert.equal(out.pause_adapter, true);
});

test("monitor: transient poll failures (5xx / network / unparseable) -> UNCHANGED (never release the slot)", async () => {
  for (const fetchImpl of [
    mockFetch(503, {}),
    mockFetch(500, {}, { throws: true }),
    mockFetch(200, "not json"),
  ]) {
    const out = await monitorRun({
      run_id: "apirun_8",
      attempt_id: ATTEMPT,
      target_sha: SHA,
      token: TOKEN,
      fetchImpl,
    });
    assert.equal(out.stage, "UNCHANGED");
    assert.equal(out.adapter_status, undefined);
  }
});

test("validateCallbackEvidence: strict attempt_id + target_sha + current_head binding", () => {
  const good = { links: ["https://github.com/x/pull/1"], attempt_id: ATTEMPT, target_sha: SHA };
  assert.equal(validateCallbackEvidence({ evidence: good, attempt_id: ATTEMPT, target_sha: SHA }), true);
  assert.equal(validateCallbackEvidence({ evidence: good, attempt_id: ATTEMPT, target_sha: SHA, current_head: SHA }), true);
  assert.equal(validateCallbackEvidence({ evidence: good, attempt_id: ATTEMPT, target_sha: SHA, current_head: SHA2 }), false, "old PASS on moved head is stale");
  assert.equal(validateCallbackEvidence({ evidence: { ...good, attempt_id: "other" }, attempt_id: ATTEMPT, target_sha: SHA }), false);
  assert.equal(validateCallbackEvidence({ evidence: { ...good, target_sha: SHA2 }, attempt_id: ATTEMPT, target_sha: SHA }), false);
  assert.equal(validateCallbackEvidence({ evidence: { links: [], attempt_id: ATTEMPT, target_sha: SHA }, attempt_id: ATTEMPT, target_sha: SHA }), false, "no links = no evidence");
  assert.equal(validateCallbackEvidence({ evidence: null, attempt_id: ATTEMPT, target_sha: SHA }), false);
});
