import { supervisorTransportSecret } from "./service/credential-delivery.mjs";
import { hasLaunchReceipt, requireHoldCode } from './intended-work.mjs';
// Coordinator-side transport. Injected legacy adapters are reserved for existing
// unit fixtures; production always uses the durable supervisor socket.
import { signedSupervisorRequest, submitToSupervisor, SUPERVISOR_PROTOCOL_VERSION } from "./supervisor.mjs";
import { roleForReceipt, runtimeForLane, isWriterRole } from "./launch-vocabulary.mjs";
import { reviewFindingsContext } from "./review-findings.mjs";

export const SUPERVISOR_DISPATCH_NOTE = "launch transport: supervisor 2.0.0";

// SHU-303: a review-only run reviews someone else's pull request, so its branch
// name is the PR author's text. It travels as a checkout field only; the
// prompt names the run by trusted identifiers.
export function orderTaskContext(receipt) {
  const where = receipt.review_base_sha ? "the pull request under review" : receipt.branch;
  return `Authorized contract ref ${receipt.authorization_ref}; deterministic dispatch pilot; issue ${receipt.issue_id} on ${where} @ ${receipt.target_sha}`;
}

export function supervisorOrder(receipt, options = {}) {
  return {
    version: "1.0.0", role: roleForReceipt(receipt), runtime: receipt.runtime ?? runtimeForLane(receipt.requested_worker),
    ...Object.fromEntries(["issue_id", "authorization_ref", "attempt_id", "target_sha", "repo", "branch",
      "workspace_scope", "scope_phase", "allowed_paths", "scoped_base_sha", "review_base_sha"].filter(k => receipt[k] !== undefined).map(k => [k, receipt[k]])),
    // Findings are read from the durable receipt, so a resubmitted order is identical.
    task_context: orderTaskContext(receipt) + reviewFindingsContext(receipt),
    ...(options.cwd ? { cwd: options.cwd } : {}),
  };
}

// Reserved codes are the coordinator's own live-head findings; they set the stop
// reason, so a carried adapter result can never supply them.
function carriedReasonCode(result) {
  const code = result?.reason_code;
  return typeof code === "string" && /^[A-Z][A-Z0-9_]{2,63}$/.test(code) && !code.startsWith("LIVE_HEAD_") ? code : null;
}

// SHU-71 try 8: a Claude build ran for fifteen minutes and its receipt said only
// "run completed WITHOUT validated callback". The cause was on the host: the
// supervisor's own hold (output cap, deadline, a worker that exited without a
// result) or the adapter's failure code, and neither reached the receipt. Carry
// it as a code, never as free text, so a held run names its cause.
const CAUSE_CODE_RE = /^[A-Z][A-Z0-9_]{2,47}$/;
function causeCode(code, prefix = "") {
  return typeof code === "string" && CAUSE_CODE_RE.test(code) && !code.startsWith("LIVE_HEAD_") ? `${prefix}${code}` : null;
}
function unusableResultCode(response) {
  const result = response?.result;
  return causeCode(result?.error_code)
    ?? causeCode(response?.detail_code, "SUPERVISOR_")
    // A refusal code the adapter gave but that may not be carried stays withheld.
    ?? (result && result.stage !== "COMPLETED" && result.reason_code == null ? causeCode(result.stage, "ADAPTER_") : null);
}

export function carriedSupervisorOutcome(response, receipt, { current_head, headVerified = false } = {}) {
  if (response?.version !== SUPERVISOR_PROTOCOL_VERSION || !response.ok
      || response.attempt_id !== receipt.attempt_id || response.target_sha !== receipt.target_sha || response.durable !== true) {
    return { stage: "HOLD", reason: "supervisor contract or binding rejected" };
  }
  if (['ACCEPTED', 'RUNNING', 'UNLAUNCHED'].includes(response.stage) && !hasLaunchReceipt(response.launch_receipt, receipt)) {
    return { stage: 'LAUNCH_UNKNOWN', status: 'UNLAUNCHED', hold_code: requireHoldCode(response.hold_code ?? 'MISSING_LAUNCH_RECEIPT') };
  }
  const identity = { external_run_id: `supervisor_${receipt.attempt_id}` };
  if (["ACCEPTED", "RUNNING"].includes(response.stage)) {
    return { ...identity, stage: "RUNNING", adapter_status: response.stage === "ACCEPTED" ? "queued" : "in_progress", heartbeat: response.heartbeat };
  }
  if (!["COMPLETED", "FAILED"].includes(response.stage)) {
    const held = causeCode(response.detail_code, "SUPERVISOR_");
    return { ...identity, stage: "HOLD", ...(held ? { reason_code: held } : {}) };
  }
  const result = response.result;
  // An adapter that refused on its own carries why. Without its code every such
  // HOLD read as missing evidence in the receipt note.
  if (carriedReasonCode(result)) identity.reason_code = carriedReasonCode(result);
  const callback = result?.callback;
  const expectedHead = isWriterRole(roleForReceipt(receipt)) ? callback?.result_sha : receipt.target_sha;
  if (!callback || !Array.isArray(callback.links) || !callback.links.length
      || callback.attempt_id !== receipt.attempt_id || callback.target_sha !== receipt.target_sha) {
    if (!identity.reason_code && unusableResultCode(response)) identity.reason_code = unusableResultCode(response);
    return { ...identity, stage: "HOLD", reason: "completion has no bound callback evidence" };
  }
  if (!headVerified || !/^[0-9a-f]{40}$/.test(expectedHead ?? "") || expectedHead !== current_head
      || (callback.result_sha != null && callback.result_sha !== current_head)) {
    return { ...identity, stage: "HOLD", reason: "carried result_sha is unbound or stale" };
  }
  if (result.stage !== "COMPLETED" && !["BLOCKED", "FAILED"].includes(callback.stage)) {
    return { ...identity, stage: "HOLD", reason: "worker adapter refused completion" };
  }
  // Receipt folding retains role/verdict and author exclusion checks. Preserve
  // callback identifiers verbatim: a socket response cannot mint their binding.
  return { ...identity, stage: result.stage === "COMPLETED" ? "COMPLETED" : "HOLD",
    callback, worker_identity: result.worker_identity ?? null,
    reason_code: identity.reason_code, audit_evidence_links: result.audit_evidence_links,
    audit_notes: result.audit_notes };
}

export function supervisorAdapter(receipt, env, io = {}) {
  // The catch below never discards the cause. The reason string is the only place
  // a tick's transport fault becomes visible, and the bare label made a vanished
  // socket, a refused connection and a malformed frame read identically. Carrying
  // the cause changes no verdict: the outcome stays not-ok and stays HOLD.
  const contact = async (operation, options = {}) => {
    try {
      const request = signedSupervisorRequest(supervisorOrder(receipt, options), supervisorTransportSecret(env), operation);
      return await (io.supervisorTransport ?? submitToSupervisor)({ socketPath: env.SHU_SUPERVISOR_SOCKET, request });
    } catch (error) {
      // A non-Error throw, or one carrying an empty code AND message, used to
      // render an empty cause ("supervisor configuration unavailable: "), which
      // made the fault read the same as no fault at all. Fall back to the
      // stringified throw, and to a fixed label when even that is empty or the
      // literal "undefined", so the cause is always non-empty and meaningful.
      // Verdict unchanged: still not-ok, still HOLD.
      const described = error?.code || error?.message || String(error);
      const cause = typeof described === "string" && described.length > 0 && described !== "undefined"
        ? described : "unknown error";
      return { ok: false, stage: "HOLD", reason: `supervisor configuration unavailable: ${cause}` };
    }
  };
  return {
    supervised: true,
    async launchBuilder(options) {
      if (options.recovery && !receipt.notes?.includes(SUPERVISOR_DISPATCH_NOTE)) {
        return { stage: "LAUNCH_UNKNOWN", reason: "legacy launch is ambiguous; refusing possible duplicate" };
      }
      const response = await contact("submit", options);
      // A lost acknowledgement is ambiguous, so retry the identical durable
      // order next tick. No in-process launch or fresh attempt is permitted.
      if (!response.ok) return { stage: "LAUNCH_UNKNOWN", reason: response.reason };
      if (response.version !== SUPERVISOR_PROTOCOL_VERSION || response.attempt_id !== receipt.attempt_id
          || response.target_sha !== receipt.target_sha || response.durable !== true) return { stage: "LAUNCH_UNKNOWN" };
      if (response.stage === 'HOLD') return { stage: 'HOLD', external_run_id: `supervisor_${receipt.attempt_id}`, hold_code: requireHoldCode(response.hold_code ?? 'AMBIGUOUS_LAUNCH'),
        ...(causeCode(response.detail_code, "SUPERVISOR_") ? { reason_code: causeCode(response.detail_code, "SUPERVISOR_") } : {}) };
      if (!hasLaunchReceipt(response.launch_receipt, receipt)) return {
        stage: 'LAUNCH_UNKNOWN', status: 'UNLAUNCHED', hold_code: requireHoldCode(response.hold_code ?? 'MISSING_LAUNCH_RECEIPT'),
      };
      return { stage: "RUNNING", external_run_id: `supervisor_${receipt.attempt_id}`, adapter_status: "queued" };
    },
    async monitorRun(options) {
      return carriedSupervisorOutcome(await contact("status"), receipt, options);
    },
  };
}
