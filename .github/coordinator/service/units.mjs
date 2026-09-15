import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

// Deployed SHU_WORKSPACE_STATE_DIR (docs/SHU-63-activation-contract.md).
// Single source of truth for service defaults and writer-lock policy.
export const WORKSPACE_STATE_DIR = '/srv/shu/state/workspaces';
const overrideWarning = '# SHU251_WRITER_LOCK: workspace state directory override; two-writer hazard';
function workspaceDirectory({ workspaceStateDir = WORKSPACE_STATE_DIR, allowWorkspaceStateDirOverride } = {}) {
  assert.ok(typeof workspaceStateDir === 'string' && /^\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(workspaceStateDir) && !workspaceStateDir.split('/').some(p => p === '.' || p === '..'), 'SHU251_WRITER_LOCK: canonical workspace state directory required');
  assert.ok(workspaceStateDir === WORKSPACE_STATE_DIR || allowWorkspaceStateDirOverride === true, 'SHU251_WRITER_LOCK: foreign workspace state directory requires allowWorkspaceStateDirOverride=true');
  return workspaceStateDir;
}

// System services share the identity owning the private workspace/socket directory.
function serviceConfiguration({ serviceUser = 'shu-coordinator', serviceGroup = serviceUser,
  supervisorEnvironmentFile = '/etc/shu/supervisor.env', coordinatorEnvironmentFile = '/srv/shu/service.env' } = {}) {
  for (const value of [serviceUser, serviceGroup]) {
    assert.ok(typeof value === 'string' && /^[a-z_][a-z0-9_-]*$/.test(value) && value !== 'root',
      'SHU251_IDENTITY: non-root service user and group names required');
  }
  for (const environmentFile of [supervisorEnvironmentFile, coordinatorEnvironmentFile]) {
    assert.ok(typeof environmentFile === 'string' && /^\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(environmentFile)
      && !environmentFile.split('/').some(p => p === '.' || p === '..'),
      'SHU251_SECRET_FILE: plain absolute environment file path required');
  }
  assert.notEqual(supervisorEnvironmentFile, coordinatorEnvironmentFile, 'SHU251_ENV_IDENTICAL: environment files must be distinct');
  assert.ok(supervisorEnvironmentFile !== '/srv/shu/service.env' && coordinatorEnvironmentFile !== '/etc/shu/supervisor.env',
    'SHU251_ENV_CROSSED: environment file paths belong to the other unit');
  return { serviceUser, serviceGroup, supervisorEnvironmentFile, coordinatorEnvironmentFile };
}

// Inspect key names and nonempty values only; never include contents in errors.
// Restrict the accepted format to unambiguous single-line systemd assignments.
function environmentBindings(identity) {
  const files = [identity.supervisorEnvironmentFile, identity.coordinatorEnvironmentFile];
  const stats = files.map(file => {
    const stat = fs.lstatSync(file, { throwIfNoEntry: false });
    assert.ok(stat, 'SHU251_ENV_MISSING: required environment file is absent');
    assert.ok(stat.isFile(), 'SHU251_ENV_FILE: environment binding must be a regular non-symlink file');
    return stat;
  });
  assert.ok(stats[0].dev !== stats[1].dev || stats[0].ino !== stats[1].ino,
    'SHU251_ENV_IDENTICAL: environment files must not share an inode');
  const entries = files.map(file => {
    let source;
    try { source = fs.readFileSync(file, 'utf8'); }
    catch { assert.fail('SHU251_ENV_UNREADABLE: required environment file cannot be read'); }
    const result = new Map();
    for (const line of source.split(/\r?\n/)) {
      if (/^\s*(?:[#;].*)?$/.test(line)) continue;
      const match = /^([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
      assert.ok(match && !result.has(match[1]), 'SHU251_ENV_CONTENT: unique single-line assignments required');
      const raw = match[2];
      const value = /^(?:"[^"\\]*"|'[^'\\]*')$/.test(raw) ? raw.slice(1, -1) : raw;
      assert.ok(value.trim().length > 0 && !/["'\\]/.test(value), 'SHU251_ENV_CONTENT: nonempty unambiguous values required');
      result.set(match[1], value);
    }
    return result;
  });
  const [supervisor, coordinator] = entries;
  assert.ok(!supervisor.has('GITHUB_TOKEN') && !supervisor.has('LINEAR_API_TOKEN') && !coordinator.has('SHU_SUPERVISOR_SECRET'),
    'SHU251_ENV_CROSSED: environment contents belong to the other unit');
  assert.ok(supervisor.size === 1 && Buffer.byteLength(supervisor.get('SHU_SUPERVISOR_SECRET') ?? '') >= 32,
    'SHU251_ENV_SUPERVISOR: only SHU_SUPERVISOR_SECRET of at least 32 bytes is required');
  assert.ok(coordinator.has('GITHUB_TOKEN') && coordinator.has('LINEAR_API_TOKEN'),
    'SHU251_ENV_COORDINATOR: GITHUB_TOKEN and LINEAR_API_TOKEN are required');
}

export const names = ['shu-supervisor.service', 'shu-coordinator.service', 'shu-coordinator.timer'];
// Literal systemd argv, never a shell command. Escape expansion by systemd.
export function quote(value) {
  assert.ok(typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value), 'SHU251_PARAMETER: nonempty single-line parameter required');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"';
}
function command(argv) {
  assert.ok(Array.isArray(argv) && argv.length > 0 && argv[0].startsWith('/'), 'SHU251_COMMAND: absolute executable argv required');
  return argv.map(quote).join(' ');
}
export function render({ workdir, supervisor, coordinator, writerLock, workspaceStateDir = WORKSPACE_STATE_DIR, allowWorkspaceStateDirOverride, supervisorStateDir, supervisorSocket, serviceUser, serviceGroup, supervisorEnvironmentFile, coordinatorEnvironmentFile }) {
  assert.ok(workdir?.startsWith('/') && writerLock?.startsWith('/'), 'SHU251_PATH: absolute workdir and shared writer lock required');
  // Use the SAME lock as host-tick.sh. The supplied coordinator command must
  // invoke the reviewed tick directly, not recursively acquire this lock.
  assert.match(workdir, /^\/[a-zA-Z0-9_./-]+$/, 'SHU251_PATH: workdir must use plain absolute path characters');
  workspaceDirectory({ workspaceStateDir, allowWorkspaceStateDirOverride });
  if (supervisorStateDir === undefined) supervisorStateDir = join(workspaceStateDir, 'supervisor');
  if (supervisorSocket === undefined) supervisorSocket = join(workspaceStateDir, 'supervisor.sock');
  assert.equal(writerLock, `${workspaceStateDir}/host-tick.lock`, 'SHU251_WRITER_LOCK: writer lock must equal SHU_WORKSPACE_STATE_DIR/host-tick.lock');
  for (const path of [supervisorStateDir, supervisorSocket]) assert.match(path, /^\/[a-zA-Z0-9_./-]+$/, 'SHU251_PATH: plain absolute supervisor paths required');
  command(coordinator);
  const identity = serviceConfiguration({ serviceUser, serviceGroup, supervisorEnvironmentFile, coordinatorEnvironmentFile });
  environmentBindings(identity);
  const values = { SERVICE_USER: identity.serviceUser, SERVICE_GROUP: identity.serviceGroup, SUPERVISOR_ENVIRONMENT_FILE: identity.supervisorEnvironmentFile, COORDINATOR_ENVIRONMENT_FILE: identity.coordinatorEnvironmentFile, WORKDIR: workdir, WORKSPACE_STATE_DIR: workspaceStateDir, SUPERVISOR_STATE_DIR: supervisorStateDir, SUPERVISOR_SOCKET: supervisorSocket, SUPERVISOR_EXEC: command(supervisor),
    COORDINATOR_EXEC: command(['/usr/bin/flock', '--nonblock', '--conflict-exit-code', '2', writerLock, ...coordinator]) };
  const units = Object.fromEntries(names.map(name => [name, fs.readFileSync(new URL(`${name}.in`, import.meta.url), 'utf8')
    .replace(/@([A-Z_]+)@/g, (_, key) => { assert.ok(key in values, 'SHU251_PARAMETER: unresolved template'); return values[key]; })]));
  if (allowWorkspaceStateDirOverride === true) units['shu-coordinator.service'] = `${overrideWarning}\n${units['shu-coordinator.service']}`;
  return units;
}
export function assertPolicy(units, options = {}) {
  const expectedState = workspaceDirectory(options);
  const identity = serviceConfiguration(options);
  environmentBindings(identity);
  assert.match(units['shu-supervisor.service'], /^Type=notify$/m, 'SHU251_READINESS: supervisor must notify after recovery and listen');
  assert.match(units['shu-supervisor.service'], /^Restart=on-failure$/m, 'SHU251_RESTART: supervisor must restart on failure');
  assert.match(units['shu-coordinator.service'], /^Restart=on-failure$/m, 'SHU251_RESTART: writer must restart on failure');
  assert.match(units['shu-supervisor.service'], /^KillMode=process$/m, 'SHU251_CHILDREN: routine restart must preserve workers');
  assert.match(units['shu-coordinator.service'], /^ExecStart="\/usr\/bin\/flock" "--nonblock" "--conflict-exit-code" "2" /m, 'SHU251_WRITER: tick must hold the common flock');
  assert.match(units['shu-coordinator.timer'], /^Unit=shu-coordinator.service$/m, 'SHU251_WAKE: timer must target the single writer');
  const writer = units['shu-coordinator.service'];
  const states = [...writer.matchAll(/^Environment=SHU_WORKSPACE_STATE_DIR=(\/[a-zA-Z0-9_./-]+)$/gm)];
  assert.ok(states.length === 1 && states[0][1] === expectedState, 'SHU251_WRITER_LOCK: rendered SHU_WORKSPACE_STATE_DIR must equal the deployed workspace state directory or explicit override');
  if (options.allowWorkspaceStateDirOverride === true) assert.ok(writer.startsWith(`${overrideWarning}\n`), 'SHU251_WRITER_LOCK: explicit override must carry the two-writer hazard warning');
  const starts = writer.split('\n').filter(line => line.startsWith('ExecStart='));
  assert.ok(states.length === 1 && starts.length === 1 && starts[0].startsWith(`ExecStart="/usr/bin/flock" "--nonblock" "--conflict-exit-code" "2" ${quote(`${expectedState}/host-tick.lock`)} `), 'SHU251_WRITER_LOCK: writer lock must equal SHU_WORKSPACE_STATE_DIR/host-tick.lock');
  assert.match(writer, /^Requires=shu-supervisor.service$/m, 'SHU251_DEPENDENCY: coordinator must require supervisor');
  for (const name of names) {
    assert.doesNotMatch(units[name], /@[A-Z_]+@/, 'SHU251_PARAMETER: unresolved template');
    assert.doesNotMatch(units[name], /SHU_SUPERVISOR_SECRET\s*=/i, 'SHU251_SECRET_LITERAL: units must not embed supervisor secrets');
  }
  for (const name of names.filter(n => n.endsWith('.service'))) {
    for (const [directive, expected] of [['User', identity.serviceUser], ['Group', identity.serviceGroup]]) {
      assert.deepEqual(units[name].split('\n').filter(line => line.startsWith(`${directive}=`)), [`${directive}=${expected}`],
        `SHU251_IDENTITY: ${name} must run with configured ${directive}`);
    }
    assert.deepEqual(units[name].split('\n').filter(line => line.startsWith('EnvironmentFile=')), [`EnvironmentFile=${identity[name === 'shu-supervisor.service' ? 'supervisorEnvironmentFile' : 'coordinatorEnvironmentFile']}`],
      'SHU251_SECRET_FILE: each service must require its own environment file');
    assert.match(units[name], /^Environment=ENABLE_DISPATCH=false$/m, 'SHU251_GATE: staged dispatch must be off');
  }
}
export function verifySyntax(directory) {
  const result = spawnSync('systemd-analyze', ['verify', ...names.map(n => join(directory, n))], { encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C', SYSTEMD_UNIT_PATH: `${directory}:/usr/lib/systemd/system:/lib/systemd/system` } });
  assert.equal(result.error, undefined, 'SHU251_SYNTAX: systemd-analyze must be available');
  assert.equal(result.status, 0, `SHU251_SYNTAX: unit validation failed\n${result.stderr}`);
  assert.equal(result.stderr.trim(), '', `SHU251_SYNTAX: unit validation emitted diagnostics\n${result.stderr}`);
}

// Concrete merged interface; secrets and activation are supplied separately at deployment.
export function serviceParameters({ workdir, workspaceStateDir = WORKSPACE_STATE_DIR, allowWorkspaceStateDirOverride, supervisorStateDir, supervisorSocket, serviceUser, serviceGroup, supervisorEnvironmentFile, coordinatorEnvironmentFile, node = process.execPath }) {
  workspaceDirectory({ workspaceStateDir, allowWorkspaceStateDirOverride });
  return { ...serviceConfiguration({ serviceUser, serviceGroup, supervisorEnvironmentFile, coordinatorEnvironmentFile }), workdir, workspaceStateDir, allowWorkspaceStateDirOverride, supervisorStateDir, supervisorSocket,
    writerLock: join(workspaceStateDir, 'host-tick.lock'),
    supervisor: [node, join(workdir, '.github/coordinator/service/supervisor-service.mjs')],
    coordinator: [node, join(workdir, '.github/coordinator/reconcile.mjs')] };
}
