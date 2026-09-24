import { supervisorTransportSecret } from "./service/credential-delivery.mjs";
import { hasLaunchReceipt, requireHoldCode } from './intended-work.mjs';
// Coordinator-side transport. Injected legacy adapters are reserved for existing
// unit fixtures; production always uses the durable supervisor socket.
import { signedSupervisorRequest, submitToSupervisor, SUPERVISOR_PROTOCOL_VERSION } from "./supervisor.mjs";
import { roleForReceipt, runtimeForLane, isWriterRole } from "./launch-vocabulary.mjs";

export const SUPERVISOR_DISPATCH_NOTE = "launch transport: supervisor 2.0.0";

export function supervisorOrder(receipt, options = {}) {
  return {
    version: "1.0.0", role: roleForReceipt(receipt), runtime: receipt.runtime ?? runtimeForLane(receipt.requested_worker),
    ...Object.fromEntries(["issue_id", "authorization_ref", "attempt_id", "target_sha", "repo", "branch",
      "workspace_scope", "scope_phase", "allowed_paths", "scoped_base_sha"].filter(k => receipt[k] !== undefined).map(k => [k, receipt[k]])),
    task_context: `Authorized contract ref ${receipt.authorization_ref}; deterministic dispatch pilot; issue ${receipt.issue_id} on ${receipt.branch} @ ${receipt.target_sha}`,
    ...(options.cwd ? { cwd: options.cwd } : {}),
  };
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
  if (!["COMPLETED", "FAILED"].includes(response.stage)) return { ...identity, stage: "HOLD" };
  const result = response.result;
  const callback = result?.callback;
  const expectedHead = isWriterRole(roleForReceipt(receipt)) ? callback?.result_sha : receipt.target_sha;
  if (!callback || !Array.isArray(callback.links) || !callback.links.length
      || callback.attempt_id !== receipt.attempt_id || callback.target_sha !== receipt.target_sha) {
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
    reason_code: result.reason_code, audit_evidence_links: result.audit_evidence_links,
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
    } catch (error) { return { ok: false, stage: "HOLD", reason: `supervisor configuration unavailable: ${error?.code || error?.message}` }; }
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
      if (response.stage === 'HOLD') return { stage: 'HOLD', external_run_id: `supervisor_${receipt.attempt_id}`, hold_code: requireHoldCode(response.hold_code ?? 'AMBIGUOUS_LAUNCH') };
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
