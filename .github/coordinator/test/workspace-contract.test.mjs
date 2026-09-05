// Workspace Agents contract tests — the EXACT official wire shapes (GPT/Codex
// review: API-contract findings). Every assertion pins a documented field,
// header, URL or state mapping so a drift from the upstream contract fails here
// first, in CI, with no real token or network.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  launchBuilder,
  monitorRun,
  buildTriggerHeaders,
  API_BASE,
  BETA_HEADER,
} from "../adapters/workspace-agents.mjs";
import { launchIdempotencyKey } from "../reconcile.mjs";

const SHA = "c".repeat(40);
const ATTEMPT = "11111111-2222-4333-8444-555555555555";
const TRIGGER = "agtch_wa_001";
const TOKEN = "test-token";

function capture() {
  const calls = [];
  const impl = async (url, opts) => {
    calls.push({ url, opts });
    // Official 202 shape: { conversation_url, agent_trigger_run_id }.
    return { status: 202, ok: true, json: async () => ({ conversation_url: "https://chatgpt.com/c/wa_1", agent_trigger_run_id: "apirun_wa_1" }) };
  };
  impl.calls = calls;
  return impl;
}

test("trigger request matches the official wire contract exactly", async () => {
  const fetchImpl = capture();
  const out = await launchBuilder({
    issue_id: "SHU-77",
    authorization_ref: "SHU-77",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    task_context: "deterministic dispatch pilot",
    api_trigger_id: TRIGGER,
    token: TOKEN,
    fetchImpl,
  });
  assert.equal(out.stage, "RUNNING");
  assert.equal(out.external_run_id, "apirun_wa_1"); // agent_trigger_run_id stored immediately
  assert.equal(out.adapter_status, "queued"); // accepted, waiting to start; poll refines
  assert.equal(out.conversation_url, "https://chatgpt.com/c/wa_1");

  const call = fetchImpl.calls[0];
  assert.equal(call.url, `${API_BASE}/v1/workspace_agents/${TRIGGER}/trigger`);
  assert.equal(call.opts.method, "POST");
  assert.equal(call.opts.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(call.opts.headers["OpenAI-Beta"], BETA_HEADER);
  assert.equal(call.opts.headers["Content-Type"], "application/json");
  // Idempotency-Key: <attempt_id>:LAUNCH_UNKNOWN:<target_sha> — stable, never
  // derived from the mutable RESERVED stage (a key change would double-launch).
  assert.equal(
    call.opts.headers["Idempotency-Key"],
    `${ATTEMPT}:LAUNCH_UNKNOWN:${SHA}`,
    "Idempotency-Key must embed the immutable attempt + bound head",
  );

  const body = JSON.parse(call.opts.body);
  assert.equal(body.conversation_key, "studenthub:SHU-77:builder");
  assert.equal(typeof body.input, "string", "the documented field is input, not prompt");
  assert.ok(!("prompt" in body), "prompt is NOT part of the trigger contract");
  assert.ok(body.input.includes("Authorized contract ref: SHU-77"));
  assert.ok(body.input.includes(SHA), "task context always carries the bound head");
  assert.ok(body.input.includes(`Attempt: ${ATTEMPT}`), "the work order carries the attempt id (valid callbacks must echo it)");
  assert.ok(body.input.includes("coordinator-callback v1"), "the work order carries the callback contract");
});

test("buildTriggerHeaders produces the documented header set", () => {
  const h = buildTriggerHeaders({ token: TOKEN, attempt_id: ATTEMPT, target_sha: SHA });
  assert.deepEqual(Object.keys(h).sort(), ["Authorization", "Content-Type", "Idempotency-Key", "OpenAI-Beta"]);
  assert.equal(h["OpenAI-Beta"], "workspace_agent_runs=v1");
});

test("retry after LAUNCH_UNKNOWN reuses a byte-identical Idempotency-Key", async () => {
  const keys = [];
  const first = await launchBuilder({
    issue_id: "SHU-77",
    authorization_ref: "SHU-77",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    task_context: "x",
    api_trigger_id: TRIGGER,
    token: TOKEN,
    fetchImpl: async () => {
      throw new Error("ECONNRESET");
    },
  });
  assert.equal(first.stage, "LAUNCH_UNKNOWN");
  keys.push(launchIdempotencyKey({ attempt_id: ATTEMPT, target_sha: SHA }));

  const fetchImpl = capture();
  await launchBuilder({
    issue_id: "SHU-77",
    authorization_ref: "SHU-77",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    task_context: "x",
    api_trigger_id: TRIGGER,
    token: TOKEN,
    fetchImpl,
  });
  keys.push(fetchImpl.calls[0].opts.headers["Idempotency-Key"]);
  assert.equal(keys[0], keys[1], "the retry must reproduce the first attempt's key exactly");
});

test("monitorRun polls the documented runs endpoint with bearer + beta headers", async () => {
  const fetchImpl = capture();
  const out = await monitorRun({
    run_id: "apirun_wa_1",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    token: TOKEN,
    api_trigger_id: TRIGGER,
    fetchImpl,
  });
  assert.ok(out, "monitorRun returns a normalized stage");
  const call = fetchImpl.calls[0];
  assert.equal(call.url, `${API_BASE}/v1/workspace_agents/${TRIGGER}/runs/apirun_wa_1`);
  assert.equal(call.opts.method, "GET");
  assert.equal(call.opts.headers.Authorization, `Bearer ${TOKEN}`);
  assert.equal(call.opts.headers["OpenAI-Beta"], BETA_HEADER);
});

test("202 with run id but no parseable body -> LAUNCH_UNKNOWN (never a phantom run)", async () => {
  const out = await launchBuilder({
    issue_id: "SHU-77",
    authorization_ref: "SHU-77",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    task_context: "x",
    api_trigger_id: TRIGGER,
    token: TOKEN,
    fetchImpl: async () => ({ status: 202, ok: true, json: async () => ({}) }),
  });
  assert.equal(out.stage, "LAUNCH_UNKNOWN");
  assert.equal(out.external_run_id, undefined);
});

test("poll response maps the documented statuses and surfaces agent_id as worker_identity", async () => {
  // queued/in_progress/suspended -> RUNNING with the granular status retained.
  for (const status of ["queued", "in_progress", "suspended"]) {
    const out = await monitorRun({
      run_id: "apirun_poll_1",
      attempt_id: ATTEMPT,
      target_sha: SHA,
      token: TOKEN,
      api_trigger_id: TRIGGER,
      fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ object: "workspace_agent.trigger_run", id: "apirun_poll_1", status, agent_id: "agt_poll_1", api_trigger_id: TRIGGER, conversation_url: "https://chatgpt.com/c/poll_1", error: null }) }),
    });
    assert.equal(out.stage, "RUNNING");
    assert.equal(out.adapter_status, status);
    assert.equal(out.worker_identity, "agt_poll_1", "agent_id from the poll is the worker identity — never fabricated");
  }
  // completed + validated callback -> COMPLETED with agent identity.
  const done = await monitorRun({
    run_id: "apirun_poll_2",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    current_head: SHA,
    evidence: { links: ["https://github.com/BAWES-Universe/studenthub-platform/pull/55"], attempt_id: ATTEMPT, target_sha: SHA, stage: "BUILD_READY" },
    token: TOKEN,
    api_trigger_id: TRIGGER,
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ object: "workspace_agent.trigger_run", id: "apirun_poll_2", status: "completed", agent_id: "agt_poll_2", conversation_url: "https://chatgpt.com/c/poll_2", error: null }) }),
  });
  assert.equal(done.stage, "COMPLETED");
  assert.equal(done.worker_identity, "agt_poll_2");
  assert.equal(done.conversation_url, "https://chatgpt.com/c/poll_2");
  // failed -> FAILED with the documented error.code.
  const failed = await monitorRun({
    run_id: "apirun_poll_3",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    token: TOKEN,
    api_trigger_id: TRIGGER,
    fetchImpl: async () => ({ status: 200, ok: true, json: async () => ({ object: "workspace_agent.trigger_run", id: "apirun_poll_3", status: "failed", agent_id: "agt_poll_3", error: { code: "run_failed" } }) }),
  });
  assert.equal(failed.stage, "FAILED");
  assert.equal(failed.error_code, "run_failed");
  assert.equal(failed.adapter_status, "failed");
});

test("quota/access walls FAIL and demand an adapter pause", async () => {
  for (const [status, kind] of [[429, "quota"], [401, "access"], [403, "access"]]) {
    const out = await launchBuilder({
      issue_id: "SHU-77",
      authorization_ref: "SHU-77",
      attempt_id: ATTEMPT,
      target_sha: SHA,
      task_context: "x",
      api_trigger_id: TRIGGER,
      token: TOKEN,
      fetchImpl: async () => ({ status, ok: false, json: async () => ({}) }),
    });
    assert.equal(out.stage, "FAILED");
    assert.equal(out.error_kind, kind);
    assert.equal(out.pause_adapter, true, `${status} must pause the adapter`);
    assert.equal(out.error_code, `HTTP_${status}`);
  }
});

test("monitorRun with MISSING credentials fails closed (UNCHANGED — never a manufactured upstream failure)", async () => {
  const args = {
    run_id: "apirun_1",
    attempt_id: ATTEMPT,
    target_sha: SHA,
    token: "",
    api_trigger_id: TRIGGER,
    fetchImpl: async () => {
      throw new Error("fetch must never be called without credentials");
    },
  };
  const noToken = await monitorRun({ ...args });
  assert.equal(noToken.stage, "UNCHANGED");
  assert.match(noToken.reason, /no WORKSPACE_AGENT_ACCESS_TOKEN/);
  const noTrigger = await monitorRun({ ...args, token: TOKEN, api_trigger_id: "" });
  assert.equal(noTrigger.stage, "UNCHANGED");
  assert.match(noTrigger.reason, /no WORKSPACE_AGENT_TRIGGER_ID/);
});
