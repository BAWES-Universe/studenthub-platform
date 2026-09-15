// SHU-261 deployed reviewer-isolation contract. This module is read-only: it
// validates the reviewed wrapper and sanitized host evidence, but never creates
// users, changes ownership/ACLs, installs files, or starts services.
import assert from "node:assert/strict";
import fs from "node:fs";

export const REVIEWER_IDENTITIES = Object.freeze({
  coordinator: "shu-coordinator",
  reviewer: "shu-reviewer",
  writer: "shu-worker",
  workspace_group: "shu-workspace",
});

export const REVIEWER_LAYOUT = Object.freeze({
  checkout: "/srv/shu/studenthub-platform",
  worktree_root: "/srv/shu/worktrees",
  activation_records: "/srv/shu/state",
  workspace_authority: "/srv/shu/state/workspaces",
  supervisor_secrets: "/etc/shu",
  deployed_supervisor_environment: "/srv/shu/service.env",
  coordinator_environment: "/srv/shu/coordinator.env",
  ssh_credentials: "/srv/shu/.gitkeys",
  codex_session_sidecars: "/srv/codex",
  service_home_claude_sidecars: "/srv/shu/.claude",
  claude_session_sidecars: "/home/shu-coordinator",
  coordinator_logs: "/srv/shu/logs",
});

export const PROTECTED_CLASSES = Object.freeze([
  "activation_records",
  "workspace_authority",
  "supervisor_secrets",
  "coordinator_environment",
  "ssh_credentials",
  "codex_session_sidecars",
  "service_home_claude_sidecars",
  "claude_session_sidecars",
  "coordinator_logs",
  "sibling_attempts",
]);

function required(source, pattern, message) {
  assert.match(source, pattern, message);
}

export function assertReviewerSandboxContract(source) {
  required(source, /--profile\" \|\| \( \"\$2\" != \"test\" && \"\$2\" != \"model\" \)/,
    "SHU261_PROFILE: test and model phases must use explicit shared isolation profiles");
  required(source, /--uid=\"\$reviewer_uid\"/, "SHU261_IDENTITY: sandbox must use deployed shu-reviewer uid");
  required(source, /--gid=\"\$reviewer_gid\"/, "SHU261_IDENTITY: sandbox must use deployed shu-reviewer gid");
  required(source, /reviewer_uid\" == \"\$\{SUDO_UID:-\}\"/, "SHU261_IDENTITY: reviewer must differ from coordinator caller");
  for (const path of [
    "/srv/shu/state", "/etc/shu", "/srv/shu/service.env", "/srv/shu/coordinator.env", "/srv/shu/.gitkeys",
    "/srv/codex", "/srv/shu/.claude", "/home/shu-coordinator", "/srv/shu/logs", "/var/log", "/run/log",
  ]) {
    assert.ok(source.includes(path), `SHU261_PROTECTED_PATH: sandbox must mask ${path}`);
  }
  required(source, /InaccessiblePaths=\$sibling/, "SHU261_SIBLING: every sibling attempt must be masked");
  required(source, /-type f -links \+1/, "SHU261_HARDLINK: assigned checkout hardlinks must fail closed");
  required(source, /flock -n 9/, "SHU261_PROCESS: same-uid reviewer processes must be serialized");
  required(source, /refuses concurrent same-identity execution/,
    "SHU261_PROCESS: concurrent reviewer refusal must be explicit");
  required(source, /ProtectProc=invisible/, "SHU261_PROCESS: host processes must be invisible");
  required(source, /InaccessiblePaths=\/run/, "SHU261_PROCESS: runtime authority and journal sockets must be hidden");
  required(source, /ProtectSystem=strict/, "SHU261_WRITE: host filesystem must be read-only");
  required(source, /NoNewPrivileges=yes/, "SHU261_PRIVILEGE: reviewer must not gain privileges");
  required(source, /CapabilityBoundingSet=/, "SHU261_PRIVILEGE: reviewer capability set must be empty");
  required(source, /PrivateNetwork=yes/, "SHU261_TEST_NETWORK: assigned tests must have no network");
  required(source, /RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6/,
    "SHU261_MODEL_NETWORK: model profile permits AF_UNIX, AF_INET, AF_INET6; no destination allowlist");
  assert.deepEqual([...source.matchAll(/network_args=\(([\s\S]*?)\)/g)].map((match) => match[1].trim()), [
    '"--property=PrivateNetwork=yes"\n    "--property=RestrictAddressFamilies=AF_UNIX"',
    '"--property=RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6"',
  ], "SHU261_NETWORK_ENFORCEMENT: exact test isolation and model address families must stay pinned");
  assert.doesNotMatch(source, /provider[- ]network[- ]only|ordinary[ ]provider[ ]network/i,
    "SHU261_NETWORK_CLAIM: address families do not confine destinations");
  required(source, /no destination allowlist/,
    "SHU261_NETWORK_CLAIM: disclose the absence of destination confinement");
  assert.doesNotMatch(source.replace(/^\s*#.*$/gm, ""),
    /IPAddressAllow|IPAddressDeny|RestrictNetworkInterfaces|NFTSet|SocketBindAllow|SocketBindDeny|\b(?:nft|iptables|ip6tables|firewall-cmd)\b|(?:HTTP|HTTPS|ALL)_PROXY/i,
    "SHU261_NETWORK_NO_ALLOWLIST: wrapper has no destination filtering or proxy mechanism");
  required(source, /HOME=\/tmp\/shu-reviewer-home/, "SHU261_SIDECAR: reviewer home must be transient and private");
  required(source, /accepts only the reviewed exact-head evidence child/,
    "SHU261_COMMAND: test profile must bind the reviewed child");
  required(source, /accepts only subscription-authenticated Claude/,
    "SHU261_COMMAND: model profile must bind Claude");
  required(source, /--setenv=CLAUDE_CODE_OAUTH_TOKEN"\)/,
    "SHU261_ENVIRONMENT: reviewer OAuth may be copied only without an argv value");
  assert.equal(source.includes("--setenv=CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN"), false,
    "SHU261_ENVIRONMENT: reviewer OAuth must never appear in systemd-run argv");
  return true;
}

export function assertIsolationEvidence(report, { expectedUid, expectedClasses = PROTECTED_CLASSES } = {}) {
  assert.equal(report?.actual_uid, expectedUid, "SHU261_POSITIVE_UID: reviewer process must run under the deployed reviewer uid");
  assert.notEqual(report?.actual_uid, report?.workspace_uid,
    "SHU261_POSITIVE_UID: reviewer uid must differ from checkout owner");
  for (const name of expectedClasses) {
    assert.equal(report?.protected_class_probes?.[name], "DENIED", `SHU261_CLASS_${name.toUpperCase()}: protected sentinel must be denied`);
  }
  assert.equal(report?.sibling_workspace_probe, "DENIED",
    "SHU261_SIBLING: the wrapper's dynamic sibling mask must deny the sibling worktree");
  assert.equal(report?.symlink_probe, "DENIED", "SHU261_SYMLINK: protected sentinel through checkout symlink must be denied");
  assert.equal(report?.traversal_probe, "DENIED", "SHU261_TRAVERSAL: protected sentinel through path traversal must be denied");
  assert.equal(report?.inherited_descriptor_probe, "DENIED", "SHU261_FD: inherited descriptor must not expose protected bytes");
  assert.equal(report?.environment_value_probe, "DENIED", "SHU261_ENVIRONMENT: inherited environment must not expose protected bytes");
  assert.equal(report?.process_inspection_probe, "DENIED", "SHU261_PROCESS: reviewer must not inspect coordinator processes");
  assert.deepEqual(report?.forbidden_env_keys, [],
    "SHU261_ENVIRONMENT: the confined test environment must contain no credential-bearing keys");
  assert.equal(report?.workspace_write_probe, "DENIED", "SHU261_WRITE: assigned checkout must remain read-only");
  assert.equal(report?.tests?.executed, true, "SHU261_POSITIVE_TEST: assigned exact-head tests must execute");
  assert.equal(report?.tests?.exit_code, 0, "SHU261_POSITIVE_TEST: assigned exact-head tests must pass");
  return true;
}

function inspectPath(path, { fsImpl = fs } = {}) {
  const stat = fsImpl.lstatSync(path);
  assert.equal(stat.isSymbolicLink(), false, `SHU261_HOST_PATH: ${path} must not be a symlink`);
  assert.equal(fsImpl.realpathSync(path), path, `SHU261_HOST_PATH: ${path} must be canonical`);
  return { path, uid: stat.uid, gid: stat.gid, mode: stat.mode & 0o7777, kind: stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other" };
}

export function readOnlyHostPreflight({ lookupIdentity, lookupGroup, fsImpl = fs } = {}) {
  assert.equal(typeof lookupIdentity, "function", "SHU261_HOST_IDENTITY: identity lookup is required");
  assert.equal(typeof lookupGroup, "function", "SHU261_HOST_IDENTITY: group lookup is required");
  const identities = Object.fromEntries(["coordinator", "reviewer", "writer"].map((role) => [role, lookupIdentity(REVIEWER_IDENTITIES[role])]));
  identities.workspace_group = lookupGroup(REVIEWER_IDENTITIES.workspace_group);
  for (const [role, identity] of Object.entries(identities).filter(([role]) => role !== "workspace_group")) {
    assert.ok(Number.isInteger(identity?.uid) && Number.isInteger(identity?.gid), `SHU261_HOST_IDENTITY: ${role} identity must exist`);
  }
  assert.ok(Number.isInteger(identities.workspace_group?.gid), "SHU261_HOST_IDENTITY: workspace group must exist");
  assert.notEqual(identities.reviewer.uid, 0, "SHU261_HOST_IDENTITY: reviewer must be non-root");
  assert.notEqual(identities.reviewer.uid, identities.coordinator.uid, "SHU261_HOST_IDENTITY: reviewer and coordinator must be distinct");
  assert.notEqual(identities.reviewer.uid, identities.writer.uid, "SHU261_HOST_IDENTITY: reviewer and writer must be distinct");
  const paths = [REVIEWER_LAYOUT.checkout, REVIEWER_LAYOUT.worktree_root, REVIEWER_LAYOUT.activation_records,
    REVIEWER_LAYOUT.workspace_authority, REVIEWER_LAYOUT.supervisor_secrets, REVIEWER_LAYOUT.coordinator_environment,
    REVIEWER_LAYOUT.deployed_supervisor_environment, REVIEWER_LAYOUT.ssh_credentials, REVIEWER_LAYOUT.codex_session_sidecars,
    REVIEWER_LAYOUT.service_home_claude_sidecars, REVIEWER_LAYOUT.claude_session_sidecars];
  const metadata = paths.map((path) => inspectPath(path, { fsImpl }));
  return { version: "shu261-host-preflight-v1", identities, paths: metadata };
}
