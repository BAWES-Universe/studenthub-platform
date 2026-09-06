// SHU-63 activation contract — explicit, checkable, and fail closed.
//
// The pivot was described as "only two login steps" (`codex login` on the box,
// and a Claude subscription token). That is the AUTH surface, not the ACTIVATION
// surface. A Codex builder that logs in successfully still cannot do the job
// unless five further things are true, and every one of them fails at a
// different, later, and more expensive moment if it is discovered at runtime:
//
//   1. the Codex sandbox may reach the network         -> otherwise it cannot push
//   2. GitHub head-verification credentials exist      -> otherwise COMPLETED can
//                                                         never be head-checked
//   3. git push authentication is wired                -> otherwise finished work
//                                                         never leaves the box
//   4. durable state survives a reboot                 -> otherwise thread ids are
//                                                         lost and sessions are
//                                                         unresumable
//   5. the coordinator runs ON the brick box           -> otherwise the host-local
//                                                         sidecars it writes are
//                                                         on a machine that is
//                                                         thrown away
//
// Requirements 2-5 are checked against the environment. Requirement 1 cannot be
// probed from inside this process, so it must be DECLARED by the operator; the
// declaration is recorded so the assumption is visible rather than implied.
//
// Nothing here enables dispatch. It only refuses to start a builder when the
// wiring that makes a builder useful is absent.

import { accessSync, constants as fsConstants, mkdirSync, realpathSync, statSync } from "node:fs";
import { hostname as nodeHostname } from "node:os";
import path from "node:path";

// Paths that do not survive a reboot on a normal Linux box. A durable Codex
// session id written here is lost exactly when it is most needed.
const EPHEMERAL_PREFIXES = Object.freeze(["/tmp", "/var/tmp", "/dev/shm", "/run"]);

export const ACTIVATION_REQUIREMENTS = Object.freeze([
  "codex_sandbox_network",
  "github_head_credentials",
  "git_push_authentication",
  "durable_state_persistence",
  "coordinator_on_brick_box",
]);

function unmet(requirement, detail, remedy) {
  return { requirement, detail, remedy };
}

// Is `dir` a usable, writable directory that is not on ephemeral storage?
function durableStateProblem(dir, { statImpl, accessImpl, mkdirImpl, realpathImpl }) {
  if (typeof dir !== "string" || dir.length === 0) return "no durable state directory is configured";
  if (!path.isAbsolute(dir)) return `state directory ${dir} is not an absolute host path`;
  const configured = path.resolve(dir);
  if (EPHEMERAL_PREFIXES.some((p) => configured === p || configured.startsWith(`${p}/`))) {
    return `state directory ${configured} is on ephemeral storage and will not survive a reboot`;
  }
  try {
    statImpl(configured);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      return `state directory ${configured} is unusable: ${error?.code ?? error?.message ?? "unknown"}`;
    }
    try {
      // The adapter creates this directory on first use. The preflight runs first,
      // so it must perform the same safe setup instead of requiring an undocumented
      // manual mkdir on a clean host.
      mkdirImpl(configured, { recursive: true, mode: 0o700 });
    } catch (mkdirError) {
      return `state directory ${configured} could not be created: ${mkdirError?.code ?? mkdirError?.message ?? "unknown"}`;
    }
  }
  let resolved;
  try {
    resolved = realpathImpl(configured);
  } catch (error) {
    return `state directory ${configured} could not be resolved: ${error?.code ?? error?.message ?? "unknown"}`;
  }
  if (typeof resolved !== "string" || !path.isAbsolute(resolved)) {
    return `state directory ${configured} resolved to an invalid host path`;
  }
  if (EPHEMERAL_PREFIXES.some((p) => resolved === p || resolved.startsWith(`${p}/`))) {
    return `state directory ${configured} resolves to ephemeral storage at ${resolved} and will not survive a reboot`;
  }
  try {
    const stat = statImpl(resolved);
    if (!stat.isDirectory()) return `state path ${resolved} is not a directory`;
    // Session and ownership sidecars authorize exact-id recovery. A
    // group/world-writable directory lets another local account forge or
    // replace that authority even though each individual file is mode 0600.
    if (typeof stat.mode === "number" && (stat.mode & 0o077) !== 0) {
      return `state directory ${resolved} permissions are too broad; expected no group/world access`;
    }
  } catch (error) {
    return `state directory ${resolved} is unusable: ${error?.code ?? error?.message ?? "unknown"}`;
  }
  try {
    accessImpl(resolved, fsConstants.W_OK);
  } catch {
    return `state directory ${resolved} is not writable by the coordinator`;
  }
  return null;
}

// preflightActivation — returns { ok, unmet: [...] }. Every entry names the
// requirement, what was actually observed, and the operator action that fixes
// it, so a refusal is actionable rather than just a refusal.
export function preflightActivation({ env = {}, stateDir = null, cwd = null, io = {} } = {}) {
  const statImpl = io.statImpl ?? statSync;
  const accessImpl = io.accessImpl ?? accessSync;
  const mkdirImpl = io.mkdirImpl ?? mkdirSync;
  const realpathImpl = io.realpathImpl ?? realpathSync;
  const hostnameImpl = io.hostname ?? nodeHostname;
  const gitRemoteImpl = io.gitPushRemote ?? null;
  const problems = [];

  // 1. Codex sandbox network access — DECLARED, not probed. `codex exec` runs
  //    under --sandbox workspace-write, whose network posture is a property of
  //    the CLI's sandbox configuration on the box. This process cannot inspect
  //    that, so the operator declares it and the declaration is auditable.
  if (env.CODEX_SANDBOX_NETWORK !== "enabled") {
    problems.push(unmet(
      "codex_sandbox_network",
      `CODEX_SANDBOX_NETWORK is ${env.CODEX_SANDBOX_NETWORK ? `"${env.CODEX_SANDBOX_NETWORK}"` : "unset"}`,
      "confirm the Codex sandbox may reach the network (it must fetch and push), then set CODEX_SANDBOX_NETWORK=enabled on the coordinator",
    ));
  }

  // 2. GitHub head-verification credentials. Without a token the live head can
  //    never be resolved, so the stale-head guard degrades to "the bound head is
  //    the reference" and a superseded tree can satisfy a receipt.
  if (typeof env.GITHUB_TOKEN !== "string" || env.GITHUB_TOKEN.trim().length === 0) {
    problems.push(unmet(
      "github_head_credentials",
      "GITHUB_TOKEN is empty",
      "provide a repo-scoped GITHUB_TOKEN so COMPLETED can be checked against the live branch head",
    ));
  }

  // 3. git push authentication. The builder's whole output is a pushed branch;
  //    without a push remote the work is finished and stranded on the box.
  if (env.CODEX_GIT_PUSH_READY !== "true") {
    problems.push(unmet(
      "git_push_authentication",
      `CODEX_GIT_PUSH_READY is ${env.CODEX_GIT_PUSH_READY ? `"${env.CODEX_GIT_PUSH_READY}"` : "unset"}`,
      "wire and verify push credentials for the builder worktree (deploy key or gh auth), then set CODEX_GIT_PUSH_READY=true",
    ));
  } else if (gitRemoteImpl) {
    let pushRemote = null;
    try {
      pushRemote = gitRemoteImpl(cwd);
    } catch (error) {
      pushRemote = null;
      problems.push(unmet("git_push_authentication", `push remote lookup failed: ${error?.message ?? "unknown"}`,
        "configure an authenticated push remote for the worktree the builder runs in"));
    }
    if (pushRemote !== null && (typeof pushRemote !== "string" || pushRemote.length === 0)) {
      problems.push(unmet("git_push_authentication", "the builder worktree has no push remote",
        "configure an authenticated push remote for the worktree the builder runs in"));
    }
  }

  // 4. Durable state persistence.
  const stateProblem = durableStateProblem(stateDir, { statImpl, accessImpl, mkdirImpl, realpathImpl });
  if (stateProblem) {
    problems.push(unmet("durable_state_persistence", stateProblem,
      "point CODEX_HOME (or io.codexStateDir) at persistent storage on the brick box"));
  }

  // 5. Coordinator runs on the brick box. The sidecars are HOST-LOCAL: written
  //    on an ephemeral CI runner they describe a machine that no longer exists,
  //    and every ownership check silently degrades to "unknown".
  const expectedHost = env.COORDINATOR_HOST;
  if (typeof expectedHost !== "string" || expectedHost.length === 0) {
    problems.push(unmet("coordinator_on_brick_box", "COORDINATOR_HOST is unset",
      "set COORDINATOR_HOST to the brick box hostname so a coordinator running anywhere else refuses to dispatch"));
  } else {
    let actual = null;
    try {
      actual = hostnameImpl();
    } catch (error) {
      problems.push(unmet("coordinator_on_brick_box", `hostname unavailable: ${error?.message ?? "unknown"}`,
        "run the coordinator on the brick box"));
    }
    if (actual !== null && actual !== expectedHost) {
      problems.push(unmet("coordinator_on_brick_box", `running on "${actual}", expected "${expectedHost}"`,
        "run the coordinator on the brick box, or correct COORDINATOR_HOST"));
    }
  }

  return { ok: problems.length === 0, unmet: problems };
}

// A single-line, operator-readable summary of what is missing.
export function describeUnmetActivation(unmetList) {
  return unmetList.map((u) => `${u.requirement}: ${u.detail} — ${u.remedy}`).join("; ");
}
