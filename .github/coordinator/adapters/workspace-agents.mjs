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

// NOTE: no import from ../reconcile.mjs — reconcile's CLI runs a top-level
// await, so an adapter→reconcile import creates an ESM cycle that hangs the CLI
// (reconcile awaits this module while this module awaits reconcile's evaluation).
// The idempotency key is a pure string contract — inlined here to stay acyclic.
export function launchIdempotencyKey({ attempt_id, target_sha }) {
  return `${attempt_id}:LAUNCH_UNKNOWN:${target_sha}`;
}

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

// SUCCESS_CALLBACK_STAGES — the only worker callback stages that may authorize
// COMPLETED. The documented callback carries BUILD_READY | REVISION_READY |
// BLOCKED | FAILED; BLOCKED/FAILED describe work that did NOT succeed and must
// never become COMPLETED just because the upstream run status said "completed".
export const SUCCESS_CALLBACK_STAGES = Object.freeze(["BUILD_READY", "REVISION_READY"]);

// validateCallbackEvidence — a callback counts ONLY if it carries links, the
// SAME attempt_id and target_sha this run was launched under, and an explicitly
// SUCCESSFUL stage. current_head, when
// provided, must still equal target_sha: an old PASS against a moved head is
// stale and never satisfies the receipt (target_sha bound invariant).
export function validateCallbackEvidence({ evidence, attempt_id, target_sha, current_head }) {
  if (!evidence || typeof evidence !== "object") return false;
  if (!Array.isArray(evidence.links) || evidence.links.length === 0) return false;
  if (evidence.attempt_id !== attempt_id) return false;
  if (evidence.target_sha !== target_sha) return false;
  if (current_head && current_head !== target_sha) return false;
  if (!SUCCESS_CALLBACK_STAGES.includes(evidence.stage)) return false;
  return true;
}

// launchBuilder — fire the trigger per the OFFICIAL beta contract
// (https://learn.chatgpt.com/workspace-agents/trigger-runs):
//   POST /v1/workspace_agents/{api_trigger_id}/trigger
//   body: { conversation_key, input }            <-- input, NOT prompt
//   202  -> { conversation_url, agent_trigger_run_id }   <-- no id/status here
// The run's status/agent_id are obtained ONLY by polling the runs endpoint.
// Returns a normalized outcome object:
//   { stage: "RUNNING",        external_run_id, adapter_status:"queued", conversation_url, ok:true }
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
  // input (documented) carries the authorized work order. The adapter NEVER
  // accepts free-text work orders — authorization_ref is regex-bound upstream.
  // The attempt_id and callback contract are part of the order: a valid callback
  // must echo THIS attempt id and declare an explicit stage (GPT BLOCK #5).
  const body = {
    conversation_key: `studenthub:${issue_id}:builder`,
    input: [
      task_context,
      `Authorized contract ref: ${authorization_ref}`,
      `Bound head: ${target_sha}`,
      `Attempt: ${attempt_id}`,
      'On completion, post a "coordinator-callback v1" comment on this Linear issue with a JSON block: { attempt_id, target_sha, stage: BUILD_READY | REVISION_READY | BLOCKED | FAILED, links: [CI/PR evidence URLs] }. Echo the exact attempt_id and target_sha above.',
    ].join("\n"),
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

  // 401/403 = access wall, 429 = quota wall: retrying is doomed — FAILED and
  // pause this adapter so the next slot does not auto-launch another attempt.
  if (res.status === 429 || res.status === 401 || res.status === 403) {
    const kind = res.status === 429 ? "quota" : "access";
    return { stage: "FAILED", error_code: `HTTP_${res.status}`, error_kind: kind, pause_adapter: true, ok: false };
  }
  // 409 = channel/agent not in a runnable state; 404 = trigger unknown. Neither
  // is a quota wall — the slot stays held (LAUNCH_UNKNOWN) for reconciliation.
  if (res.status !== 202) {
    return { stage: "LAUNCH_UNKNOWN", reason: `unexpected HTTP ${res.status} from trigger`, ok: false };
  }
  let accepted;
  try {
    accepted = await res.json();
  } catch {
    return { stage: "LAUNCH_UNKNOWN", reason: "202 without parseable body — run id unknown", ok: false };
  }
  // Documented 202 shape: { conversation_url, agent_trigger_run_id }.
  if (typeof accepted?.agent_trigger_run_id !== "string" || accepted.agent_trigger_run_id.length === 0) {
    return { stage: "LAUNCH_UNKNOWN", reason: "202 without agent_trigger_run_id in body", ok: false };
  }
  return {
    stage: "RUNNING",
    external_run_id: accepted.agent_trigger_run_id, // apirun_... stored IMMEDIATELY
    adapter_status: "queued", // accepted and waiting to start; poll refines this
    conversation_url: typeof accepted.conversation_url === "string" ? accepted.conversation_url : null,
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
  api_trigger_id,
  base = API_BASE,
  runsBase,
}) {
  const runsEndpoint =
    api_trigger_id != null
      ? `${base}/v1/workspace_agents/${api_trigger_id}/runs` // official contract shape
      : runsBase ?? `${base}/v1/workspace_agents/runs`;
  // Fail closed on MISSING credentials: an empty bearer token or trigger id must
  // never manufacture an upstream 401/403 (which would map to FAILED + pause and
  // could be written during a nominal dry-run). No credentials => state unchanged.
  if (!token || token.length === 0) {
    return { stage: "UNCHANGED", reason: "no WORKSPACE_AGENT_ACCESS_TOKEN — poll skipped, state unchanged (fail closed)" };
  }
  if (!api_trigger_id || api_trigger_id.length === 0) {
    return { stage: "UNCHANGED", reason: "no WORKSPACE_AGENT_TRIGGER_ID — poll skipped, state unchanged (fail closed)" };
  }
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
      // Granular upstream status preserved verbatim. worker_identity is ONLY
      // set when the poll response actually carries the documented agent_id —
      // never fabricated from the run id.
      return {
        stage: "RUNNING",
        adapter_status: run.status,
        worker_identity: typeof run.agent_id === "string" && run.agent_id.length ? run.agent_id : null,
      };
    case "completed": {
      const outcome = {
        stage: "COMPLETED",
        adapter_status: "completed",
        evidence_links: evidence?.links ?? [],
        worker_identity: typeof run.agent_id === "string" && run.agent_id.length ? run.agent_id : null,
        conversation_url: typeof run.conversation_url === "string" ? run.conversation_url : null,
      };
      if (validateCallbackEvidence({ evidence, attempt_id, target_sha, current_head })) {
        return outcome;
      }
      // Completed without a validated callback can be a false positive (or stale
      // head) — HOLD for a human, never auto-COMPLETED.
      return { ...outcome, stage: "HOLD", reason: "completed without validated callback (attempt_id/target_sha must match)" };
    }
    case "failed": {
      const error_code = run.error?.code ?? run.last_error?.code ?? "RUN_FAILED";
      return {
        stage: "FAILED",
        error_code,
        adapter_status: "failed",
        worker_identity: typeof run.agent_id === "string" && run.agent_id.length ? run.agent_id : null,
      };
    }
    default:
      return { stage: "UNCHANGED", reason: `unknown upstream status "${run.status}" — preserving state` };
  }
}
