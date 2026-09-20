#!/usr/bin/env node
// SHU-251 reviewed host-window operations. This file is inert until an operator
// invokes one of its typed actions. It accepts data, never shell command text.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { checkStatus } from './check-status.mjs';
import { signedSupervisorRequest, submitToSupervisor } from '../supervisor.mjs';
import { measureBranchHead, fetchIssueComments } from '../reconcile.mjs';

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ISSUE = /^SHU-[0-9]+$/;
const UNIT_NAMES = ['shu-supervisor.service', 'shu-coordinator.service', 'shu-coordinator.timer'];
export const BINDING_CODES = Object.freeze({
  remote_inventory: 'SHU251_REMOTE_INVENTORY',
  transport_observation: 'SHU251_TRANSPORT_OBSERVATION',
  driver_quiescence: 'SHU251_DRIVER_QUIESCENCE',
  fixture_launch_observation: 'SHU251_FIXTURE_LAUNCH',
  replay_release: 'SHU251_REPLAY_RELEASE',
  worker_observation: 'SHU251_WORKER_OBSERVATION',
  status_credential_delivery: 'SHU251_STATUS_CREDENTIAL',
  fixture_cleanup: 'SHU251_FIXTURE_CLEANUP',
  prior_state_rollback: 'SHU251_PRIOR_STATE_ROLLBACK',
});

export class HostBindingHalt extends Error {
  constructor(binding, reason, details = {}) {
    const code = BINDING_CODES[binding] ?? 'SHU251_OPERATIONAL_BINDING';
    super(`${code}: ${reason}`);
    this.name = 'HostBindingHalt';
    this.binding = binding;
    this.code = code;
    this.details = details;
  }
  toJSON() { return { ok: false, binding: this.binding, code: this.code, reason: this.message, details: this.details }; }
}
const halt = (binding, reason, details) => { throw new HostBindingHalt(binding, reason, details); };
const object = (value, binding, name) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) halt(binding, `${name} must be an object`);
  return value;
};
const exactKeys = (value, keys, binding, name) => {
  object(value, binding, name);
  const actual = Object.keys(value).sort(), expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) halt(binding, `${name} fields are not the closed contract`, { actual, expected });
};
const absolute = (value, binding, name) => {
  if (typeof value !== 'string' || !path.isAbsolute(value) || path.normalize(value) !== value) halt(binding, `${name} must be a normalized absolute path`);
  return value;
};
function readJson(file, binding) {
  absolute(file, binding, 'JSON path');
  let stat;
  try { stat = fs.lstatSync(file); } catch { return halt(binding, 'JSON input is absent'); }
  if (!stat.isFile() || stat.isSymbolicLink()) halt(binding, 'JSON input must be a regular non-symlink file');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return halt(binding, 'JSON input must parse'); }
}
function run(file, args, binding, options = {}) {
  const result = spawnSync(file, args, { encoding: 'utf8', ...options });
  if (result.error || result.status !== 0) halt(binding, 'fixed command failed', { file, args, status: result.status, stderr: String(result.stderr ?? '').trim().slice(0, 500) });
  return String(result.stdout ?? '').trim();
}
function serviceState(kind, unit, binding) {
  const result = spawnSync('/usr/bin/systemctl', [kind, unit], { encoding: 'utf8' });
  if (result.error || ![0, 1, 3, 4].includes(result.status)) halt(binding, 'service state observation failed', { kind, unit, status: result.status });
  return String(result.stdout ?? '').trim();
}
function processStartToken(pid, binding = 'worker_observation') {
  if (!Number.isInteger(pid) || pid <= 1) halt(binding, 'worker PID must be a positive non-init integer');
  let stat;
  try { stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); }
  catch (error) { return halt(binding, 'worker process is not observable', { pid, cause_code: error.code ?? 'UNKNOWN' }); }
  const token = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
  if (!/^\d+$/.test(token ?? '')) halt(binding, 'worker process start token is unavailable', { pid });
  return token;
}
function waitForProcessExit(pid, startToken, timeoutMs = 5000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try { if (processStartToken(pid) !== startToken) return true; }
    catch (error) { if (error instanceof HostBindingHalt && error.details.cause_code === 'ENOENT') return true; throw error; }
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
  }
  return false;
}
const digest = data => createHash('sha256').update(data).digest('hex');

export function validateWindowSpec(spec) {
  exactKeys(spec, ['version', 'approved_sha', 'repo_dir', 'remote_url', 'remote_ref', 'workspace_state_dir',
    'supervisor_state_dir', 'supervisor_socket', 'status_environment_file', 'service_uid', 'fixture',
    'unit_directory', 'staged_unit_directory', 'prior_state_file'], 'remote_inventory', 'window spec');
  if (spec.version !== 'shu251-host-window-v2') halt('remote_inventory', 'unsupported window spec version');
  if (!SHA.test(spec.approved_sha ?? '')) halt('remote_inventory', 'approved SHA must be exact');
  for (const key of ['repo_dir', 'workspace_state_dir', 'supervisor_state_dir', 'supervisor_socket',
    'status_environment_file', 'unit_directory', 'staged_unit_directory', 'prior_state_file']) absolute(spec[key], 'remote_inventory', key);
  if (typeof spec.remote_url !== 'string' || !/^https:\/\/github\.com\/BAWES-Universe\/studenthub-platform(?:\.git)?$/.test(spec.remote_url)) halt('remote_inventory', 'remote URL is not the approved repository');
  if (spec.remote_ref !== 'refs/heads/main') halt('remote_inventory', 'remote ref must be refs/heads/main');
  if (!Number.isInteger(spec.service_uid) || spec.service_uid <= 0) halt('remote_inventory', 'service UID must be non-root');
  exactKeys(spec.fixture, ['issue_id', 'attempt_id', 'target_sha', 'order_json', 'release_file', 'journal_file', 'pid', 'start_token'], 'fixture_launch_observation', 'fixture');
  if (!ISSUE.test(spec.fixture.issue_id ?? '') || !UUID.test(spec.fixture.attempt_id ?? '') || !SHA.test(spec.fixture.target_sha ?? '')) halt('fixture_launch_observation', 'fixture identity is invalid');
  for (const key of ['order_json', 'release_file', 'journal_file']) absolute(spec.fixture[key], 'fixture_launch_observation', `fixture.${key}`);
  const noProcessYet = spec.fixture.pid === null && spec.fixture.start_token === null;
  const boundProcess = Number.isInteger(spec.fixture.pid) && spec.fixture.pid > 1 && /^\d+$/.test(spec.fixture.start_token ?? '');
  if (!noProcessYet && !boundProcess) halt('worker_observation', 'fixture process identity must be entirely absent or exactly bound');
  return spec;
}

// A TRANSIENT ANSWER IS NOT A MOVED INVENTORY. `fetchBranchHead` answers null
// for a 429, a 5xx, a body that would not parse and a branch that genuinely
// does not exist alike, and the caller below reported every one of them as
// "remote fixture inventory is incomplete or moved" - a claim about the remote
// that a read which never answered cannot support. The read is MEASURED here
// and a transient answer is retried under a small fixed bound. 404 is NOT in
// that set: a branch the remote says is absent is an answer, not a race, and
// still refuses on the first answer exactly as today. The VALUE is never
// retried - the comparison against target_sha is made once, on whatever the
// read finally answered.
export const INVENTORY_READ = Object.freeze({ attempts: 3, delaysMs: Object.freeze([200, 400]),
  statuses: Object.freeze([408, 425, 429, 500, 502, 503, 504]) });
export async function measureBranchHeadBounded(request, io = {}) {
  const measure = io.measure ?? measureBranchHead;
  const wait = io.wait ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  let measured = { ok: false, status: null, sha: null };
  for (let attempt = 1; attempt <= INVENTORY_READ.attempts; attempt++) {
    measured = await measure(request);
    if (measured.ok || !INVENTORY_READ.statuses.includes(measured.status) || attempt === INVENTORY_READ.attempts) break;
    await wait(INVENTORY_READ.delaysMs[attempt - 1]);
  }
  return measured;
}
export async function readRemoteWork(spec, env = process.env, io = {}) {
  const binding = 'remote_inventory', order = boundOrder(spec, binding);
  if (!env.LINEAR_API_TOKEN || !env.GITHUB_TOKEN) halt(binding, 'read-only Linear and GitHub credentials are required');
  const comments = await (io.comments ?? fetchIssueComments)({ issueId: spec.fixture.issue_id, token: env.LINEAR_API_TOKEN });
  const branchHead = await measureBranchHeadBounded({ repo: order.repo, branch: order.branch, token: env.GITHUB_TOKEN }, io);
  return { branch_head: branchHead.sha, branch_head_read: branchHead, comment_count: comments.length,
    comments_digest: digest(Buffer.from(JSON.stringify(comments.map(comment => ({ body: comment.body, createdAt: comment.createdAt, user: comment.user?.id }))))) };
}

export async function observeRemoteInventory(spec, io = { run, readRemote: readRemoteWork }) {
  validateWindowSpec(spec);
  const binding = 'remote_inventory';
  const head = io.run('/usr/bin/git', ['rev-parse', 'HEAD'], binding, { cwd: spec.repo_dir });
  const status = io.run('/usr/bin/git', ['status', '--porcelain'], binding, { cwd: spec.repo_dir });
  const remote = io.run('/usr/bin/git', ['ls-remote', '--exit-code', spec.remote_url, spec.remote_ref], binding, { cwd: spec.repo_dir });
  const remoteSha = remote.split(/\s+/)[0];
  if (status !== '' || head !== spec.approved_sha || remoteSha !== spec.approved_sha) halt(binding, 'clean local and remote heads must equal the approved SHA', { head, remote_sha: remoteSha, dirty: status !== '' });
  let work;
  try { work = await io.readRemote(spec); } catch (error) {
    if (error instanceof HostBindingHalt) throw error;
    return halt(binding, 'remote fixture inventory failed', { error: error.message });
  }
  // A read that never answered halts under its own reason, BEFORE the line
  // that would otherwise report it as a moved inventory. The measurement is
  // only present when this module performed the read itself; an injected
  // readRemote that supplies none is compared exactly as it is today.
  if (work?.branch_head_read && work.branch_head_read.ok !== true)
    halt(binding, 'remote fixture inventory could not be read', { status: work.branch_head_read.status });
  if (work?.branch_head !== spec.fixture.target_sha || !Number.isInteger(work.comment_count) || work.comment_count < 0 || !/^[0-9a-f]{64}$/.test(work.comments_digest ?? '')) halt(binding, 'remote fixture inventory is incomplete or moved');
  return { binding, ok: true, approved_sha: spec.approved_sha, remote_ref: spec.remote_ref,
    fixture_branch_head: work.branch_head, comment_count: work.comment_count, comments_digest: work.comments_digest };
}

export function deliverStatusCredential(spec, io = fs) {
  validateWindowSpec(spec);
  const binding = 'status_credential_delivery';
  let stat, parent;
  try { stat = io.lstatSync(spec.status_environment_file); parent = io.lstatSync(path.dirname(spec.status_environment_file)); }
  catch { return halt(binding, 'status environment file or its parent is absent'); }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0 || ![0, spec.service_uid].includes(stat.uid)) halt(binding, 'status environment file must be a private regular file owned by root or the service identity');
  if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) !== 0 || ![0, spec.service_uid].includes(parent.uid)) halt(binding, 'status environment parent must be a private real directory owned by root or the service identity');
  const lines = io.readFileSync(spec.status_environment_file, 'utf8').split(/\r?\n/).filter(Boolean);
  if (lines.length !== 1 || !lines[0].startsWith('SHU_SUPERVISOR_SECRET=')) halt(binding, 'status environment file must contain only the supervisor credential');
  const secret = lines[0].slice('SHU_SUPERVISOR_SECRET='.length);
  if (Buffer.byteLength(secret) < 32) halt(binding, 'supervisor credential is too short');
  return { secret, evidence: { binding, ok: true, path: spec.status_environment_file, uid: stat.uid, mode: stat.mode & 0o777, key_names: ['SHU_SUPERVISOR_SECRET'] } };
}

export async function observeTransport(spec, { credential = deliverStatusCredential, status = checkStatus,
  socketStat = file => fs.lstatSync(file) } = {}) {
  validateWindowSpec(spec);
  const binding = 'transport_observation';
  let socket;
  try { socket = socketStat(spec.supervisor_socket); } catch { return halt(binding, 'supervisor socket is absent'); }
  if (!socket.isSocket() || socket.isSymbolicLink()) halt(binding, 'supervisor endpoint must be a Unix socket');
  const order = readJson(spec.fixture.order_json, binding);
  const delivered = credential(spec);
  let response;
  try { response = await status({ stateDir: spec.supervisor_state_dir, socketPath: spec.supervisor_socket, secret: delivered.secret, order }); }
  catch (error) { return halt(binding, 'authenticated status failed', { error: error.message }); }
  if (response.attempt_id !== spec.fixture.attempt_id || response.target_sha !== spec.fixture.target_sha) halt(binding, 'authenticated status does not match the approved fixture');
  return { binding, ok: true, stage: response.stage, attempt_id: response.attempt_id, credential: delivered.evidence };
}

export function observeDriverQuiescence(spec, io = { run, serviceState }) {
  validateWindowSpec(spec);
  const binding = 'driver_quiescence';
  const states = Object.fromEntries(UNIT_NAMES.map(unit => [unit, io.serviceState('is-active', unit, binding)]));
  if (Object.values(states).some(state => state !== 'inactive')) halt(binding, 'all driver units must be inactive', { states });
  io.run('/usr/bin/flock', ['--nonblock', `${spec.workspace_state_dir}/host-tick.lock`, '/usr/bin/true'], binding);
  return { binding, ok: true, states, writer_lock: 'free' };
}

function boundOrder(spec, binding) {
  const order = readJson(spec.fixture.order_json, binding);
  if (order.issue_id !== spec.fixture.issue_id || order.attempt_id !== spec.fixture.attempt_id || order.target_sha !== spec.fixture.target_sha) halt(binding, 'work order does not match the approved fixture identity');
  return order;
}
export function observeFixtureLaunch(spec, { readStartToken = processStartToken } = {}) {
  validateWindowSpec(spec);
  const binding = 'fixture_launch_observation', order = boundOrder(spec, binding);
  const launch = readJson(path.join(spec.supervisor_state_dir, 'launches', `${spec.fixture.attempt_id}.json`), binding);
  if (launch.issue_id !== order.issue_id || launch.attempt_id !== order.attempt_id || launch.target_sha !== order.target_sha || launch.phase !== 'launched' || launch.pid !== spec.fixture.pid || !/^[0-9a-f]{64}$/.test(launch.completion_token_hash ?? '')) halt(binding, 'durable launch receipt is not exactly fixture-bound');
  if (readStartToken(launch.pid, binding) !== spec.fixture.start_token) halt(binding, 'live worker identity differs from the approved fixture');
  return { binding, ok: true, issue_id: order.issue_id, attempt_id: order.attempt_id, target_sha: order.target_sha, pid: launch.pid, start_token: spec.fixture.start_token };
}

export function observeWorker(spec, { readStartToken = processStartToken } = {}) {
  validateWindowSpec(spec);
  const binding = 'worker_observation', observed = readStartToken(spec.fixture.pid, binding);
  if (observed !== spec.fixture.start_token) halt(binding, 'PID reuse or worker replacement detected', { pid: spec.fixture.pid });
  return { binding, ok: true, pid: spec.fixture.pid, start_token: observed };
}

function atomicExclusive(file, data) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, data); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
export async function replayAndRelease(spec, { credential = deliverStatusCredential, submit = submitToSupervisor,
  observeLaunch = observeFixtureLaunch, observeLiveWorker = observeWorker } = {}) {
  validateWindowSpec(spec);
  const binding = 'replay_release', order = boundOrder(spec, binding);
  observeLaunch(spec); observeLiveWorker(spec);
  if (fs.existsSync(spec.fixture.release_file)) halt(binding, 'release marker already exists');
  const delivered = credential(spec);
  const replay = await submit({ socketPath: spec.supervisor_socket, request: signedSupervisorRequest(order, delivered.secret) });
  if (replay?.ok !== true || replay.duplicate !== true || replay.status !== 'RUNNING') halt(binding, 'supervisor replay was not accepted as the existing running attempt', { status: replay?.status, duplicate: replay?.duplicate });
  observeLiveWorker(spec);
  atomicExclusive(spec.fixture.release_file, `${spec.fixture.issue_id} ${spec.fixture.attempt_id} ${spec.fixture.target_sha}\n`);
  return { binding, ok: true, replay: 'accepted', released: true, attempt_id: spec.fixture.attempt_id };
}
export function cleanupFixture(spec, { signal = process.kill, observeLaunch = observeFixtureLaunch,
  waitForExit = waitForProcessExit } = {}) {
  validateWindowSpec(spec);
  const binding = 'fixture_cleanup';
  const launch = observeLaunch(spec);
  if (launch.pid !== spec.fixture.pid || launch.start_token !== spec.fixture.start_token) halt(binding, 'cleanup identity binding failed');
  for (const file of [spec.fixture.release_file, spec.fixture.journal_file]) {
    const parent = path.dirname(file);
    if (parent !== path.dirname(spec.fixture.order_json)) halt(binding, 'cleanup paths must share the fixture evidence directory');
    if (fs.lstatSync(file, { throwIfNoEntry: false })?.isSymbolicLink()) halt(binding, 'cleanup refuses symlinks');
  }
  signal(spec.fixture.pid, 'SIGTERM');
  if (!waitForExit(spec.fixture.pid, spec.fixture.start_token)) halt(binding, 'identity-bound fixture process did not exit after SIGTERM', { pid: spec.fixture.pid });
  for (const file of [spec.fixture.release_file, spec.fixture.journal_file]) fs.rmSync(file, { force: true });
  return { binding, ok: true, signaled_pid: spec.fixture.pid, removed: [spec.fixture.release_file, spec.fixture.journal_file] };
}

export function capturePriorState(spec, io = { run, serviceState }) {
  validateWindowSpec(spec);
  const binding = 'prior_state_rollback';
  const staged = {}, units = Object.fromEntries(UNIT_NAMES.map(name => {
    const file = path.join(spec.unit_directory, name), stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (stat && !stat.isFile())) halt(binding, 'prior unit target must be absent or a regular file', { name });
    const stagedFile = path.join(spec.staged_unit_directory, name), stagedStat = fs.lstatSync(stagedFile, { throwIfNoEntry: false });
    if (!stagedStat?.isFile() || stagedStat.isSymbolicLink()) halt(binding, 'approved staged unit must be a regular file', { name });
    staged[name] = digest(fs.readFileSync(stagedFile));
    return [name, stat ? { data: fs.readFileSync(file).toString('base64'), mode: stat.mode & 0o777 } : null];
  }));
  const active = Object.fromEntries(UNIT_NAMES.map(name => [name, io.serviceState('is-active', name, binding)]));
  const enabled = Object.fromEntries(UNIT_NAMES.map(name => [name, io.serviceState('is-enabled', name, binding)]));
  atomicExclusive(spec.prior_state_file, JSON.stringify({ version: 'shu251-prior-state-v1', approved_sha: spec.approved_sha, units, staged, active, enabled }) + '\n');
  return { binding, ok: true, prior_state_file: spec.prior_state_file };
}

export function rollbackPriorState(spec, io = { run }) {
  validateWindowSpec(spec);
  const binding = 'prior_state_rollback', prior = readJson(spec.prior_state_file, binding);
  exactKeys(prior, ['version', 'approved_sha', 'units', 'staged', 'active', 'enabled'], binding, 'prior state');
  if (prior.version !== 'shu251-prior-state-v1' || prior.approved_sha !== spec.approved_sha) halt(binding, 'prior state is not bound to the approved revision');
  for (const key of ['units', 'staged', 'active', 'enabled']) exactKeys(prior[key], UNIT_NAMES, binding, `prior state ${key}`);
  for (const name of UNIT_NAMES) {
    if (!['active', 'inactive', 'failed', 'unknown', 'not-found'].includes(prior.active[name]) ||
        !['enabled', 'disabled', 'static', 'indirect', 'masked', 'not-found'].includes(prior.enabled[name])) halt(binding, 'prior service state is not recognized', { name });
    if ((prior.active[name] === 'active' || prior.enabled[name] === 'enabled') &&
        (!prior.units[name] || !Buffer.from(prior.units[name].data, 'base64').toString('utf8').includes('Environment=ENABLE_DISPATCH=false'))) halt(binding, 'active or enabled prior service must retain dispatch-off in captured bytes', { name });
  }
  for (const name of UNIT_NAMES) {
    const file = path.join(spec.unit_directory, name), stat = fs.lstatSync(file, { throwIfNoEntry: false });
    if (stat?.isSymbolicLink() || (stat && !stat.isFile())) halt(binding, 'rollback refuses non-regular unit targets', { name });
    const current = stat ? fs.readFileSync(file) : null, original = prior.units[name] ? Buffer.from(prior.units[name].data, 'base64') : null;
    const owned = current === null ? original === null : digest(current) === prior.staged[name] || Boolean(original?.equals(current));
    if (!owned) halt(binding, 'unit changed after staging; refusing to clobber it', { name });
  }
  for (const name of UNIT_NAMES) io.run('/usr/bin/systemctl', ['stop', name], binding);
  for (const name of UNIT_NAMES) {
    const file = path.join(spec.unit_directory, name), item = prior.units[name];
    if (item === null) fs.rmSync(file, { force: true });
    else { fs.writeFileSync(file, Buffer.from(item.data, 'base64'), { mode: item.mode }); fs.chmodSync(file, item.mode); }
  }
  io.run('/usr/bin/systemctl', ['daemon-reload'], binding);
  for (const name of UNIT_NAMES) {
    if (prior.enabled[name] === 'enabled') io.run('/usr/bin/systemctl', ['enable', name], binding);
    else io.run('/usr/bin/systemctl', ['disable', name], binding);
  }
  for (const name of UNIT_NAMES.filter(name => prior.active[name] === 'active')) io.run('/usr/bin/systemctl', ['start', name], binding);
  return { binding, ok: true, restored_revision: prior.approved_sha };
}

export async function main(argv = process.argv.slice(2)) {
  const [action, specPath] = argv;
  const allowed = ['inventory', 'quiescence', 'transport', 'launch', 'worker', 'replay-release', 'cleanup', 'capture-prior', 'rollback'];
  if (!allowed.includes(action) || !path.isAbsolute(specPath ?? '')) halt('remote_inventory', `usage: host-window-bindings.mjs ${allowed.join('|')} /absolute/window-spec.json`);
  const spec = validateWindowSpec(readJson(specPath, 'remote_inventory'));
  return action === 'inventory' ? observeRemoteInventory(spec)
    : action === 'quiescence' ? observeDriverQuiescence(spec)
    : action === 'transport' ? observeTransport(spec)
    : action === 'launch' ? observeFixtureLaunch(spec)
    : action === 'worker' ? observeWorker(spec)
    : action === 'replay-release' ? replayAndRelease(spec)
    : action === 'cleanup' ? cleanupFixture(spec)
    : action === 'capture-prior' ? capturePriorState(spec)
    : rollbackPriorState(spec);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify({ ok: true, evidence: await main() }, null, 2)); }
  catch (error) {
    console.error(JSON.stringify(error instanceof HostBindingHalt ? error : { ok: false, code: 'SHU251_UNEXPECTED', reason: error.message }, null, 2));
    process.exitCode = 2;
  }
}
