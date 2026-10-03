// Re-evaluate the existing dispatch authority in the child at launch and before
// publication. The signed work order carries data; it cannot turn a gate on.
import { resolveFixtureLane, validateFixtureAttemptScope } from "./workspace-scope.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTwoFixtureEvidence } from "./two-fixture-evidence.mjs";
import { dispatchEnabledFor, resolveDispatchScope, parseReceiptsFromComments } from "./reconcile.mjs";
import { singleRunActivationStatus, activationAllowsTarget } from "./single-run-activation.mjs";

// SHU-71 run 5: a correct revision was held because this check said no at
// publication, and nothing said which part said no. Every denial now names its
// clause (HOST_AUTH_*), and the name reaches the receipt through the push broker.
// An evidence read that failed is read again, a bounded number of times, before
// it denies: the same treatment the tick gives a failed or racing read.
export const AUTH_EVIDENCE_RETRIES = 2;
export const AUTH_EVIDENCE_WAIT_MS = 3000;

const denied = code => ({ ok: false, code: `HOST_AUTH_${code}` });

function activationCode(activation) {
  if (/^ACT_[A-Z0-9_]{2,32}$/.test(activation?.code ?? "")) return activation.code;
  if (["expired", "spent"].includes(activation?.reporting_exception)) return `ACTIVATION_${activation.reporting_exception.toUpperCase()}`;
  if (/^activation is spent/.test(activation?.reason ?? "")) return "ACTIVATION_SPENT";
  return "ACTIVATION_REFUSED";
}

function evaluate(order, io) {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const env = io.env ?? process.env;
    const config = io.config ?? JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    const scope = resolveDispatchScope(config);
    if (!scope.valid || (scope.issueIds && !scope.issueIds.has(order.issue_id))) return denied("DISPATCH_SCOPE");
    if (config.adapter_pause_map?.[order.runtime]) return denied("ADAPTER_PAUSED");
    const filePath = env.SHU_SUPERVISOR_ACTIVATION_FILE;
    const evidence = env.SHU71_EVIDENCE_BROKER === "true" ? readTwoFixtureEvidence(config, env, io.evidenceRun) : null;
    // An unread thread is not an empty one: no receipts would read as an unspent
    // seed, and the pair would refuse as a rewind under the wrong name.
    if (evidence && (evidence.unavailable === true || !Array.isArray(evidence.comments))) return denied("EVIDENCE_UNAVAILABLE");
    const receipts = evidence ? parseReceiptsFromComments(evidence.comments, config.linear_receipt_actor_ids) : [];
    const activation = filePath ? singleRunActivationStatus({ filePath, config, receipts, dir, env,
      initialTargetSha: env.DISPATCH_TARGET_SHA, ...io.activation }) : null;
    if (activation?.code === "ACT_EVIDENCE_UNAVAILABLE") return denied("EVIDENCE_UNAVAILABLE");
    if (!dispatchEnabledFor(env, config, activation)) {
      return denied(activation && activation.state !== "armed" ? activationCode(activation) : "DISPATCH_DISABLED");
    }
    if (activation && !activationAllowsTarget(activation, order.issue_id)) return denied("TARGET_NOT_ALLOWED");
    const fixtureLane = resolveFixtureLane(config, order.issue_id);
    if (fixtureLane && fixtureLane.authorization_ref !== order.authorization_ref) return denied("LANE_REF");
    if (!validateFixtureAttemptScope(order).ok) return denied("ATTEMPT_SCOPE");
    return { ok: true, code: null };
  } catch { return denied("CHECK_FAILED"); }
}

// { ok: true } or { ok: false, code }. Never throws.
export function workOrderAuthorization(order, io = {}) {
  for (let retry = 0; ; retry++) {
    const verdict = evaluate(order, io);
    if (verdict.code !== "HOST_AUTH_EVIDENCE_UNAVAILABLE" || retry >= AUTH_EVIDENCE_RETRIES) return verdict;
    (io.wait ?? (delay => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay); }))(AUTH_EVIDENCE_WAIT_MS);
  }
}

export function authorizeWorkOrder(order, io = {}) {
  return workOrderAuthorization(order, io).ok === true;
}
