// Re-evaluate the existing dispatch authority in the child at launch and before
// publication. The signed work order carries data; it cannot turn a gate on.
import { resolveFixtureLane, validateFixtureAttemptScope } from "./workspace-scope.mjs";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readTwoFixtureEvidence } from "./two-fixture-evidence.mjs";
import { dispatchEnabledFor, resolveDispatchScope, parseReceiptsFromComments } from "./reconcile.mjs";
import { singleRunActivationStatus, activationAllowsTarget } from "./single-run-activation.mjs";

export function authorizeWorkOrder(order) {
  try {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
    const scope = resolveDispatchScope(config);
    if (!scope.valid || (scope.issueIds && !scope.issueIds.has(order.issue_id)) || config.adapter_pause_map?.[order.runtime]) return false;
    const filePath = process.env.SHU_SUPERVISOR_ACTIVATION_FILE;
    const evidence = process.env.SHU71_EVIDENCE_BROKER === 'true' ? readTwoFixtureEvidence(config, process.env) : null;
    const receipts = evidence ? parseReceiptsFromComments(evidence.comments, config.linear_receipt_actor_ids) : [];
    const activation = filePath ? singleRunActivationStatus({ filePath, config, receipts, dir, env: process.env,
      initialTargetSha: process.env.DISPATCH_TARGET_SHA }) : null;
    if (!dispatchEnabledFor(process.env, config, activation)) return false;
    if (activation && !activationAllowsTarget(activation, order.issue_id)) return false;
    const fixtureLane = resolveFixtureLane(config, order.issue_id);
    if (fixtureLane && fixtureLane.authorization_ref !== order.authorization_ref) return false;
    if (!validateFixtureAttemptScope(order).ok) return false;
    return true;
  } catch { return false; }
}
