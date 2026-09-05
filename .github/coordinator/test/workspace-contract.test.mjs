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
    return { status: 202, ok: true, json: async () => ({ id: "apirun_wa_1", status: "queued" }) };
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
  assert.equal(out.external_run_id, "apirun_wa_1");
  assert.equal(out.adapter_status, "queued"); // granular upstream status retained

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
  assert.ok(body.prompt.includes("Authorized contract ref: SHU-77"));
  assert.ok(body.prompt.includes(SHA), "task context always carries the bound head");
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
