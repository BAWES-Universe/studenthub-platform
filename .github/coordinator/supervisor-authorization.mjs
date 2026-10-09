// Re-evaluate the existing dispatch authority in the child at launch and before
// publication. The signed work order carries data; it cannot turn a gate on.
import { resolveFixtureLane, resolveReviewOnlyLane, validateFixtureAttemptScope } from "./workspace-scope.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTwoFixtureEvidence } from "./two-fixture-evidence.mjs";
import { dispatchEnabledFor, resolveDispatchScope, parseReceiptsFromComments } from "./reconcile.mjs";
import { singleRunActivationStatus, activationAllowsTarget, activationRefusalCode } from "./single-run-activation.mjs";

// SHU-71 run 5: a correct revision was held because this check said no at
// publication, and nothing said which part said no. Every denial now names its
// clause (HOST_AUTH_*), and the name reaches the receipt through the push broker.
// An evidence read that failed is read again, a bounded number of times, before
// it denies: the same treatment the tick gives a failed or racing read.
export const AUTH_EVIDENCE_RETRIES = 2;
export const AUTH_EVIDENCE_WAIT_MS = 3000;

const denied = code => ({ ok: false, code: `HOST_AUTH_${code}` });

// The issues whose threads two-fixture-evidence.mjs reads.
const BROKER_FIXTURE_IDS = Object.freeze(["SHU-140", "SHU-254"]);

function evaluate(order, io) {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const env = io.env ?? process.env;
    const config = io.config ?? JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    const scope = resolveDispatchScope(config);
    if (!scope.valid || (scope.issueIds && !scope.issueIds.has(order.issue_id))) return denied("DISPATCH_SCOPE");
    if (config.adapter_pause_map?.[order.runtime]) return denied("ADAPTER_PAUSED");
    const filePath = env.SHU_SUPERVISOR_ACTIVATION_FILE;
    // The broker serves the SHU-71 fixtures' threads only. A scope that can admit
    // either fixture (the pair, one fixture alone, or no scope) still reads them,
    // because their receipts decide spent and retry; a scope without a fixture,
    // such as a single card, never needs them, so a failed read of threads it has
    // nothing to do with must not deny it (Hermes, PR #213 A1; GPT, PR #214 1).
    const fixtureScoped = !scope.issueIds || BROKER_FIXTURE_IDS.some(id => scope.issueIds.has(id));
    const evidence = env.SHU71_EVIDENCE_BROKER === "true" && fixtureScoped ? readTwoFixtureEvidence(config, env, io.evidenceRun) : null;
    // An unread thread is not an empty one: no receipts would read as an unspent
    // seed, and the pair would refuse as a rewind under the wrong name.
    if (evidence && (evidence.unavailable === true || !Array.isArray(evidence.comments))) return denied("EVIDENCE_UNAVAILABLE");
    const receipts = evidence ? parseReceiptsFromComments(evidence.comments, config.linear_receipt_actor_ids) : [];
    const activation = filePath ? singleRunActivationStatus({ filePath, config, receipts, dir, env,
      initialTargetSha: env.DISPATCH_TARGET_SHA, ...io.activation }) : null;
    if (activation?.code === "ACT_EVIDENCE_UNAVAILABLE") return denied("EVIDENCE_UNAVAILABLE");
    if (!dispatchEnabledFor(env, config, activation)) {
      return denied(activation && activation.state !== "armed" ? activationRefusalCode(activation) : "DISPATCH_DISABLED");
    }
    if (activation && !activationAllowsTarget(activation, order.issue_id)) return denied("TARGET_NOT_ALLOWED");
    const fixtureLane = resolveReviewOnlyLane(config, order.issue_id) ?? resolveFixtureLane(config, order.issue_id);
    if (fixtureLane && fixtureLane.authorization_ref !== order.authorization_ref) return denied("LANE_REF");
    // SHU-303: a review-only order is the one review its activation approved:
    // that head, that base, a reviewer. The signed order cannot pick another.
    if (activation?.review_only === true || Object.hasOwn(order, "review_base_sha")) {
      if (activation?.review_only !== true || order.role !== "review" || order.target_sha !== activation.initial_target_sha
          || order.review_base_sha !== activation.review_base_sha) return denied("REVIEW_BINDING");
    }
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
