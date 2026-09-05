// workspace-agents adapter — OpenAI Workspace Agents API (builder adapter).
//
// Implements the official contract surface:
//   POST https://api.chatgpt.com/v1/workspace_agents/{api_trigger_id}/trigger
//     headers: Authorization: Bearer <token>
//              OpenAI-Beta: workspace_agent_runs=v1
//              Idempotency-Key: <attempt_id>:LAUNCH_UNKNOWN:<target_sha>
//              Content-Type: application/json
//     body:    { conversation_key: `studenthub:<issue_id>:builder`, ...task context }
//   GET  .../runs/{run_id} for status polling (monitorRun).
//
// Response mapping (MUST match — asserted in test/adapter.test.mjs):
//   HTTP 202 + run id      -> RUNNING   (external_run_id apirun_... stored IMMEDIATELY,
//                                        granular API status preserved in adapter_status)
//   transport/5xx/unknown  -> LAUNCH_UNKNOWN  (never fabricate a run, never release the slot)
//   run completed + VALIDATED callback       -> COMPLETED
//   run completed, no/mismatched callback    -> HOLD
//   run failed             -> FAILED (+ upstream error code)
//   quota/access error     -> FAILED + pause_adapter=true (adapter_pause_map)
//   transient poll failure -> UNCHANGED (state preserved — timeout alone never releases)
//
// The api_trigger_id and token come from the ENVIRONMENT (WORKSPACE_AGENT_ACCESS_TOKEN,
// WORKSPACE_AGENT_TRIGGER_ID) — never logged, never committed, never written to Linear.
// fetch is injectable so the whole module is testable with a mocked network.

import { launchIdempotencyKey } from "../reconcile.mjs";

export const API_BASE = "https://api.chatgpt.com";
export const BETA_HEADER = "workspace_agent_runs=v1";

export function buildTriggerHeaders({ token, attempt_id, target_sha }) {
  return {
    Authorization: `Bearer ${token}`,
    "OpenAI-Beta": BETA_HEADER,
    "Idempotency-Key": launchIdempotencyKey({ attempt_id, target_sha }),
    "Content-Type": "application/json",
  };
}

// validateCallbackEvidence — a callback counts ONLY if it carries links and the
// SAME attempt_id and target_sha this run was launched under. current_head, when
// provided, must still equal target_sha: an old PASS against a moved head is stale
// and never satisfies the receipt (target_sha bound invariant).
export function validateCallbackEvidence({ evidence, attempt_id, target_sha, current_head }) {
  if (!evidence || typeof evidence !== "object") return false;
  if (!Array.isArray(evidence.links) || evidence.links.length === 0) return false;
  if (evidence.attempt_id !== attempt_id) return false;
  if (evidence.target_sha !== target_sha) return false;
  if (current_head && current_head !== target_sha) return false;
  return true;
}

// launchBuilder — fire the trigger. Returns a normalized outcome object:
//   { stage: "RUNNING",        external_run_id, adapter_status, ok:true }
//   { stage: "LAUNCH_UNKNOWN", reason, ok:false }
//   { stage: "FAILED",         error_code, error_kind:"quota"|"access", pause_adapter:true, ok:false }
export async function launchBuilder({
  issue_id,
  authorization_ref,
  attempt_id,
  target_sha,
  task_context,
  api_trigger_id,
  token,
  fetchImpl = fetch,
  base = API_BASE,
}) {
  if (!token) {
    return { stage: "LAUNCH_UNKNOWN", reason: "no WORKSPACE_AGENT_ACCESS_TOKEN (env only — never committed)", ok: false };
  }
  if (!api_trigger_id) {
    return { stage: "LAUNCH_UNKNOWN", reason: "no WORKSPACE_AGENT_TRIGGER_ID", ok: false };
  }
  const headers = buildTriggerHeaders({ token, attempt_id, target_sha });
  const body = {
    conversation_key: `studenthub:${issue_id}:builder`,
    // Task context ALWAYS references the authorized contract — the adapter never
    // accepts free-text work orders (authorization_ref is regex-bound upstream).
    prompt: `${task_context}\nAuthorized contract ref: ${authorization_ref}\nBound head: ${target_sha}`,
  };
  let res;
  try {
    res = await fetchImpl(`${base}/v1/workspace_agents/${api_trigger_id}/trigger`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });
  } catch (err) {
    // Transport failure: we cannot know whether the run was accepted upstream —
    // LAUNCH_UNKNOWN holds the slot and a retry reuses the SAME Idempotency-Key.
    return { stage: "LAUNCH_UNKNOWN", reason: `transport failure: ${err.message}`, ok: false };
  }

  if (res.status === 429 || res.status === 401 || res.status === 403) {
    // Quota/access: retrying is doomed — FAILED and pause this adapter so the next
    // slot does not auto-launch another attempt against the same wall.
    const kind = res.status === 429 ? "quota" : "access";
    return { stage: "FAILED", error_code: `HTTP_${res.status}`, error_kind: kind, pause_adapter: true, ok: false };
  }
  if (res.status !== 202) {
    return { stage: "LAUNCH_UNKNOWN", reason: `unexpected HTTP ${res.status} from trigger`, ok: false };
  }
  let run;
  try {
    run = await res.json();
  } catch {
    return { stage: "LAUNCH_UNKNOWN", reason: "202 without parseable body — run id unknown", ok: false };
  }
  if (!run?.id) {
    return { stage: "LAUNCH_UNKNOWN", reason: "202 without run id in body", ok: false };
  }
  // 202 + run id: accepted. external_run_id (apirun_...) and the granular upstream
  // status are surfaced IMMEDIATELY — the orchestrator stores them on the receipt
  // without collapsing "queued"/"in_progress"/... into a generic RUNNING.
  return {
    stage: "RUNNING",
    external_run_id: run.id,
    adapter_status: typeof run.status === "string" && run.status.length ? run.status : "queued",
    ok: true,
  };
}

// monitorRun — poll one run and map the upstream status. Callback evidence is the
// orchestrator's already-validated evidence set (GitHub/Linear with matching
// attempt_id + target_sha); the completed mapping is decided HERE so the adapter
// contract is a single reviewable surface.
//   { stage:"RUNNING",   adapter_status }                 (queued|in_progress|suspended)
//   { stage:"COMPLETED", adapter_status:"completed" }      (completed + validated callback)
//   { stage:"HOLD",      adapter_status:"completed" }      (completed, no valid callback)
//   { stage:"FAILED",    error_code }                      (upstream failure)
//   { stage:"FAILED",    error_kind, pause_adapter:true }  (quota/access)
//   { stage:"UNCHANGED", reason }                          (transient poll failure)
export async function monitorRun({
  run_id,
  attempt_id,
  target_sha,
  evidence,
  current_head,
  token,
  fetchImpl = fetch,
  base = API_BASE,
  runsBase,
}) {
  const runsEndpoint = runsBase ?? `${base}/v1/workspace_agents/runs`;
  let res;
  try {
    res = await fetchImpl(`${runsEndpoint}/${run_id}`, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "OpenAI-Beta": BETA_HEADER,
      },
    });
  } catch (err) {
    // Transient poll failure: never change state, never release the slot.
    return { stage: "UNCHANGED", reason: `poll transport failure: ${err.message}` };
  }
  if (res.status === 429 || res.status === 401 || res.status === 403) {
    const kind = res.status === 429 ? "quota" : "access";
    return { stage: "FAILED", error_code: `HTTP_${res.status}`, error_kind: kind, pause_adapter: true };
  }
  if (res.status !== 200) {
    return { stage: "UNCHANGED", reason: `poll HTTP ${res.status} — transient` };
  }
  let run;
  try {
    run = await res.json();
  } catch {
    return { stage: "UNCHANGED", reason: "poll body unparseable — transient" };
  }
  switch (run.status) {
    case "queued":
    case "in_progress":
    case "suspended":
      // Granular upstream status preserved verbatim.
      return { stage: "RUNNING", adapter_status: run.status };
    case "completed": {
      if (validateCallbackEvidence({ evidence, attempt_id, target_sha, current_head })) {
        return { stage: "COMPLETED", adapter_status: "completed", evidence_links: evidence?.links ?? [] };
      }
      // Completed without a validated callback can be a false positive (or stale
      // head) — HOLD for a human, never auto-COMPLETED.
      return { stage: "HOLD", adapter_status: "completed", reason: "completed without validated callback (attempt_id/target_sha must match)" };
    }
    case "failed": {
      const error_code = run.last_error?.code ?? run.error?.code ?? "RUN_FAILED";
      return { stage: "FAILED", error_code, adapter_status: "failed" };
    }
    default:
      return { stage: "UNCHANGED", reason: `unknown upstream status "${run.status}" — preserving state` };
  }
}
