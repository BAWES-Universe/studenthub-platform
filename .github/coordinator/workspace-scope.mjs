import path from "node:path";

export const WORKSPACE_SCOPES = Object.freeze(["scoped", "full"]);
export const SCOPE_PHASES = Object.freeze(["initial", "revision", "review"]);
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
  const initial = validateAllowedPaths(fixture.initial_build_paths, { name: "fixture_lane.initial_build_paths" });
  if (!initial.ok) return initial;
  const revision = validateAllowedPaths(fixture.revision_paths, { name: "fixture_lane.revision_paths" });
  if (!revision.ok) return revision;
  if (fixture.seeded_defect_path !== SHU140_TRAP_PATH) {
    return { ok: false, reason: "fixture_lane.seeded_defect_path must pin the reviewed SHU-140 trap" };
  }
  if (initial.paths.includes(fixture.seeded_defect_path)) {
    return { ok: false, reason: "BLOCK is unreachable: seeded defect path is inside initial_build_paths" };
  }
  if (!revision.paths.includes(fixture.seeded_defect_path)) {
    return { ok: false, reason: "revision_paths must authorize the seeded defect path after BLOCK" };
  }
  if (JSON.stringify(initial.paths) !== JSON.stringify(SHU140_INITIAL_BUILD_PATHS) ||
      JSON.stringify(revision.paths) !== JSON.stringify(SHU140_REVISION_PATHS)) {
    return { ok: false, reason: "fixture scope paths differ from the reviewed exact SHU-140 contract" };
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

export function initialWorkspaceScope({ issueId, requestedWorker, fixtureLane } = {}) {
  if (requestedWorker === "claude-verifier") return { workspace_scope: "full", scope_phase: "review", allowed_paths: [], scoped_base_sha: null };
  if (fixtureLane?.id === issueId) {
    if (!fixtureScopeConfigured(fixtureLane)) {
      return { workspace_scope: "full", scope_phase: "initial", allowed_paths: [], scoped_base_sha: null };
    }
    const policy = validateFixtureScopePolicy(fixtureLane);
    if (!policy.ok) throw new Error(policy.reason);
    return { workspace_scope: "scoped", scope_phase: "initial", allowed_paths: policy.initial_build_paths, scoped_base_sha: null };
  }
  return { workspace_scope: "full", scope_phase: "initial", allowed_paths: [], scoped_base_sha: null };
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
