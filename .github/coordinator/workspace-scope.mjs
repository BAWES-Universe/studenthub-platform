import { resolveReceiptRoleAuthority, roleForLane } from "./launch-vocabulary.mjs";
import path from "node:path";

export const WORKSPACE_SCOPES = Object.freeze(["scoped", "full"]);
export const SCOPE_PHASES = Object.freeze(["initial", "revision", "review"]);
export const WORKSPACE_SCOPE_FIELDS = Object.freeze(["workspace_scope", "scope_phase", "allowed_paths", "scoped_base_sha"]);
const SHA = /^[0-9a-f]{40}$/;

export const SHU140_INITIAL_BUILD_PATHS = Object.freeze([
  "tools/fixture/scan-vacuous.mjs",
  "tools/fixture/test/scan-vacuous.test.mjs",
]);
export const SHU140_REVISION_PATHS = Object.freeze([
  ...SHU140_INITIAL_BUILD_PATHS,
  "tools/fixture-conformance/scan-vacuous.expectations.mjs",
]);
export const SHU140_TRAP_PATH = "tools/fixture-conformance/scan-vacuous.expectations.mjs";

export const SHU254_INITIAL_BUILD_PATHS = Object.freeze([
  "tools/fixture-2/scan-unawaited.mjs",
  "tools/fixture-2/test/scan-unawaited.test.mjs",
]);
export const SHU254_TRAP_PATH = "tools/fixture-2-conformance/scan-unawaited.expectations.mjs";
export const SHU254_REVISION_PATHS = Object.freeze([...SHU254_INITIAL_BUILD_PATHS, SHU254_TRAP_PATH]);

const FIXTURE_CONTRACTS = Object.freeze({
  "SHU-140": { initial_build_paths: SHU140_INITIAL_BUILD_PATHS, revision_paths: SHU140_REVISION_PATHS, seeded_defect_path: SHU140_TRAP_PATH },
  "SHU-254": { initial_build_paths: SHU254_INITIAL_BUILD_PATHS, revision_paths: SHU254_REVISION_PATHS, seeded_defect_path: SHU254_TRAP_PATH },
});

// The legacy object remains supported; additional lanes must have unique IDs.
export function resolveFixtureLane(config = {}, issueId) {
  const extra = config.fixture_lanes ?? [];
  if (!Array.isArray(extra)) throw new Error("fixture_lanes must be an array");
  const lanes = [...(config.fixture_lane ? [config.fixture_lane] : []), ...extra];
  const ids = new Set();
  for (const lane of lanes) {
    if (!lane || typeof lane.id !== "string" || !lane.id || ids.has(lane.id)) {
      throw new Error("fixture lanes require unique issue ids");
    }
    ids.add(lane.id);
  }
  return lanes.find((lane) => lane.id === issueId) ?? null;
}

// Check issue binding again on durable receipts, including recovery, before I/O.
export function validateFixtureAttemptScope(receipt = {}) {
  const contract = FIXTURE_CONTRACTS[receipt.issue_id];
  if (!contract || receipt.workspace_scope !== "scoped") return { ok: true };
  const expected = receipt.scope_phase === "revision" ? contract.revision_paths : contract.initial_build_paths;
  if (JSON.stringify(receipt.allowed_paths) !== JSON.stringify(expected)) {
    return { ok: false, reason: `LANE_MISMATCH: ${receipt.issue_id} ${receipt.scope_phase} paths differ from its fixture contract` };
  }
  return { ok: true };
}

export function fixtureScopeConfigured(fixture = {}) {
  return ["initial_build_paths", "revision_paths", "seeded_defect_path"].some((key) => Object.hasOwn(fixture, key));
}

export function validateAllowedPaths(value, { name = "allowed_paths", allowEmpty = false } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    return { ok: false, reason: `${name} must be a non-empty array of exact paths` };
  }
  const seen = new Set();
  for (const entry of value) {
    if (typeof entry !== "string" || entry.length === 0 || entry.includes("\0") || entry.includes("\\") ||
        path.posix.isAbsolute(entry) || entry === "." || entry.startsWith("./") || entry.endsWith("/") ||
        entry.split("/").some((part) => !part || part === "." || part === ".." || part.toLowerCase() === ".git") ||
        path.posix.normalize(entry) !== entry || /[*?[\]{}!]/.test(entry)) {
      return { ok: false, reason: `${name} contains an unsafe, non-literal, or non-normalized path` };
    }
    if (seen.has(entry)) return { ok: false, reason: `${name} contains a duplicate path` };
    seen.add(entry);
  }
  return { ok: true, paths: [...value] };
}

export function validateFixtureScopePolicy(fixture = {}) {
  const contract = FIXTURE_CONTRACTS[fixture.id];
  if (!contract) return { ok: false, reason: "unknown fixture scope issue id" };
  const initial = validateAllowedPaths(fixture.initial_build_paths, { name: "fixture_lane.initial_build_paths" });
  if (!initial.ok) return initial;
  const revision = validateAllowedPaths(fixture.revision_paths, { name: "fixture_lane.revision_paths" });
  if (!revision.ok) return revision;
  if (fixture.seeded_defect_path !== contract.seeded_defect_path) {
    return { ok: false, reason: `fixture_lane.seeded_defect_path must pin the reviewed ${fixture.id} trap` };
  }
  if (initial.paths.includes(fixture.seeded_defect_path)) {
    return { ok: false, reason: "BLOCK is unreachable: seeded defect path is inside initial_build_paths" };
  }
  if (!revision.paths.includes(fixture.seeded_defect_path)) {
    return { ok: false, reason: "revision_paths must authorize the seeded defect path after BLOCK" };
  }
  if (JSON.stringify(initial.paths) !== JSON.stringify(contract.initial_build_paths) ||
      JSON.stringify(revision.paths) !== JSON.stringify(contract.revision_paths)) {
    return { ok: false, reason: `fixture scope paths differ from the reviewed exact ${fixture.id} contract` };
  }
  return { ok: true, initial_build_paths: initial.paths, revision_paths: revision.paths, seeded_defect_path: fixture.seeded_defect_path };
}

export function validateWorkspaceScope({ workspace_scope, scope_phase, allowed_paths, scoped_base_sha = null } = {}, { requireScopedBase = false } = {}) {
  if (!WORKSPACE_SCOPES.includes(workspace_scope)) return { ok: false, reason: "unknown workspace_scope" };
  if (!SCOPE_PHASES.includes(scope_phase)) return { ok: false, reason: "unknown scope_phase" };
  if (workspace_scope === "scoped" && scoped_base_sha !== null && !SHA.test(scoped_base_sha)) {
    return { ok: false, reason: "scoped workspace has an invalid scoped_base_sha" };
  }
  if (workspace_scope === "scoped" && requireScopedBase && !SHA.test(scoped_base_sha ?? "")) {
    return { ok: false, reason: "scoped workspace requires its deterministic scoped_base_sha" };
  }
  if (workspace_scope === "full" && scoped_base_sha !== null) return { ok: false, reason: "full workspace must not carry a scoped_base_sha" };
  if (scope_phase === "review") {
    if (workspace_scope !== "full" || !Array.isArray(allowed_paths) || allowed_paths.length !== 0) {
      return { ok: false, reason: "review workspace must be full with no allowed-path subset" };
    }
    return { ok: true, paths: [] };
  }
  if (workspace_scope === "full") {
    if (!Array.isArray(allowed_paths) || allowed_paths.length !== 0) return { ok: false, reason: "full workspace must not carry allowed paths" };
    return { ok: true, paths: [] };
  }
  return validateAllowedPaths(allowed_paths);
}

export function normalizeReceiptWorkspaceScope(receipt = {}) {
  const authority = resolveReceiptRoleAuthority(receipt);
  if (!authority.ok) return authority;
  const present = WORKSPACE_SCOPE_FIELDS.filter((field) => Object.hasOwn(receipt, field));
  if (present.length === 0) {
    return { ok: true, scope: {
      workspace_scope: "full",
      scope_phase: authority.role === "review" ? "review" : "initial",
      allowed_paths: [],
      scoped_base_sha: null,
    } };
  }
  if (present.length !== WORKSPACE_SCOPE_FIELDS.length) {
    return { ok: false, reason: "workspace scope metadata is partially present" };
  }
  const candidate = Object.fromEntries(WORKSPACE_SCOPE_FIELDS.map((field) => [field, receipt[field]]));
  const checked = validateWorkspaceScope(candidate, { requireScopedBase: true });
  if (checked.ok) {
    const laneCheck = validateFixtureAttemptScope(receipt);
    if (!laneCheck.ok) return laneCheck;
  }
  return checked.ok ? { ok: true, scope: { ...candidate, allowed_paths: [...candidate.allowed_paths] } } : checked;
}

export function initialWorkspaceScope({ issueId, requestedWorker, role = roleForLane(requestedWorker), fixtureLane, allowedPaths = [], legacy = false } = {}) {
  if (!role || role !== roleForLane(requestedWorker) && role !== "revise") throw new Error("invalid initial workspace role");
  if (role === "review") return { workspace_scope: "full", scope_phase: "review", allowed_paths: [], scoped_base_sha: null };
  if (fixtureLane && fixtureLane.id !== issueId) throw new Error(`LANE_MISMATCH: fixture lane does not match ${issueId}`);
  if (fixtureLane && fixtureLane.id === issueId) {
    if (!fixtureScopeConfigured(fixtureLane) && legacy) {
      return { workspace_scope: "full", scope_phase: "initial", allowed_paths: [], scoped_base_sha: null };
    }
    const policy = validateFixtureScopePolicy(fixtureLane);
    if (!policy.ok) throw new Error(policy.reason);
    return { workspace_scope: "scoped", scope_phase: "initial", allowed_paths: policy.initial_build_paths, scoped_base_sha: null };
  }
  if (legacy) return { workspace_scope: "full", scope_phase: "initial", allowed_paths: [], scoped_base_sha: null };
  const paths = validateAllowedPaths(allowedPaths);
  if (!paths.ok) throw new Error(`initial writer scope requires approved literal paths: ${paths.reason}`);
  return { workspace_scope: "scoped", scope_phase: "initial", allowed_paths: paths.paths, scoped_base_sha: null };
}

export function successorWorkspaceScope(role, fixtureLane) {
  if (role === "review") return { workspace_scope: "full", scope_phase: "review", allowed_paths: [], scoped_base_sha: null };
  if (role !== "revise") throw new Error(`unsupported successor scope role ${String(role)}`);
  if (!fixtureScopeConfigured(fixtureLane ?? {})) {
    return { workspace_scope: "full", scope_phase: "revision", allowed_paths: [], scoped_base_sha: null };
  }
  const policy = validateFixtureScopePolicy(fixtureLane);
  if (!policy.ok) throw new Error(policy.reason);
  return { workspace_scope: "scoped", scope_phase: "revision", allowed_paths: policy.revision_paths, scoped_base_sha: null };
}
