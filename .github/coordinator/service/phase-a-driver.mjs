#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const UNIT_NAMES = ['shu-supervisor.service', 'shu-coordinator.service', 'shu-coordinator.timer'];
export const LIFECYCLE_ACTIONS = Object.freeze({ preflight: 'host_preflight', install: 'host_install', start: 'host_start', readiness: 'host_readiness', restart: 'host_restart', 'host-rollback': 'host_rollback', pin: 'host_pin', 'pin-restore': 'host_pin_restore', 'pin-retain': 'host_pin_retain' });
export const ACTIONS = Object.freeze({ ...LIFECYCLE_ACTIONS, inventory: 'remote_inventory', quiescence: 'driver_quiescence', transport: 'transport_observation', launch: 'fixture_launch_observation', worker: 'worker_observation', 'replay-release': 'replay_release', cleanup: 'fixture_cleanup', 'capture-prior': 'prior_state_rollback', rollback: 'prior_state_rollback' });
const MUTATIONS = new Set(['replay-release', 'cleanup', 'capture-prior', 'rollback', ...Object.keys(LIFECYCLE_ACTIONS).filter(s => s !== 'preflight')]);
// Closed per-step evidence shapes. Binding objects retain the reviewed binding vocabulary.
export const EVIDENCE_FIELDS = Object.freeze({
  ...Object.fromEntries(Object.keys(LIFECYCLE_ACTIONS).map(step => [step, ['binding', 'ok', 'activation_id', 'approval_sha256', 'installed_sha256', 'before', 'after', 'journal_sha256', 'disposition']])),
  identity: ['rendered_sha256', 'installed_sha256'],
  'gate-off': ['identity', 'interval_ms', 'elapsed_ms', 'samples', 'launches', 'writes'],
  'restart-before': ['invocation_id', 'launch', 'worker', 'status', 'identity'],
  'restart-after': ['invocation_id', 'launch', 'worker', 'status', 'identity', 'before_receipt_sha256'],
  inventory: ['binding', 'ok', 'approved_sha', 'remote_ref', 'fixture_branch_head', 'comment_count', 'comments_digest'],
  quiescence: ['binding', 'ok', 'states', 'writer_lock'],
  transport: ['binding', 'ok', 'stage', 'attempt_id', 'credential'],
  launch: ['binding', 'ok', 'issue_id', 'attempt_id', 'target_sha', 'pid', 'start_token'],
  worker: ['binding', 'ok', 'pid', 'start_token'],
  'replay-release': ['binding', 'ok', 'replay', 'released', 'attempt_id'],
  cleanup: ['binding', 'ok', 'signaled_pid', 'removed'],
  'capture-prior': ['binding', 'ok', 'prior_state_file'],
  rollback: ['binding', 'ok', 'restored_revision', 'quiescence', 'dispatch_reenabled'],
});
const evidenceType = key => ['ok', 'released', 'dispatch_reenabled'].includes(key) ? 'boolean'
  : ['interval_ms', 'elapsed_ms', 'launches', 'writes', 'comment_count', 'pid', 'signaled_pid'].includes(key) ? 'number'
  : ['samples', 'removed'].includes(key) ? 'array'
  : ['before', 'after', 'rendered_sha256', 'installed_sha256', 'identity', 'launch', 'worker', 'status', 'states', 'credential', 'quiescence'].includes(key) ? 'object' : 'string';
export const RECEIPT_SCHEMA = Object.freeze({
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  type: 'object', additionalProperties: false,
  required: ['version', 'step', 'approved_sha', 'spec_sha256', 'evidence', 'evidence_sha256'],
  oneOf: Object.entries(EVIDENCE_FIELDS).map(([step, fields]) => ({ properties: {
    step: { const: step }, evidence: { type: 'object', additionalProperties: false, required: fields,
      properties: Object.fromEntries(fields.map(key => [key, { type: evidenceType(key) }])) },
  } })),
  properties: {
    version: { const: 'shu251-phase-a-receipt-v1' },
    step: { enum: ['identity', 'gate-off', 'restart-before', 'restart-after', ...Object.keys(ACTIONS)] },
    approved_sha: { type: 'string', pattern: '^[0-9a-f]{40}$' },
    spec_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
    evidence: { type: 'object', minProperties: 1 },
    evidence_sha256: { type: 'string', pattern: '^[0-9a-f]{64}$' },
  },
});
export function refuse(code, detail = '') { throw Object.assign(new Error(`${code}: ${detail}`), { code }); }
export const hash = bytes => createHash('sha256').update(bytes).digest('hex');
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${canonical(value[k])}`).join(',')}}`;
  const result = JSON.stringify(value);
  if (result === undefined) refuse('SHU251_RECEIPT_INVALID', 'non-JSON evidence');
  return result;
}
export function receipt(step, spec, evidence) {
  const result = { version: 'shu251-phase-a-receipt-v1', step, approved_sha: spec.window.approved_sha,
    spec_sha256: hash(canonical(spec)), evidence, evidence_sha256: hash(canonical(evidence)) };
  validateReceipt(result, step, spec);
  return result;
}
export function validateReceipt(value, step, spec) {
  if (!value || canonical(Object.keys(value).sort()) !== canonical([...RECEIPT_SCHEMA.required].sort()) ||
      value.version !== RECEIPT_SCHEMA.properties.version.const || !RECEIPT_SCHEMA.properties.step.enum.includes(step) ||
      value.step !== step || !/^[a-f0-9]{40}$/.test(value.approved_sha) || value.approved_sha !== spec.window.approved_sha ||
      value.spec_sha256 !== hash(canonical(spec)) || !value.evidence || Array.isArray(value.evidence) || typeof value.evidence !== 'object' || !Object.keys(value.evidence).length)
    refuse('SHU251_RECEIPT_INVALID', step);
  const fields = EVIDENCE_FIELDS[step];
  if (canonical(Object.keys(value.evidence).sort()) !== canonical([...fields].sort()) || fields.some(key => {
    const v = value.evidence[key], type = evidenceType(key);
    return type === 'array' ? !Array.isArray(v) : type === 'object' ? !v || typeof v !== 'object' || Array.isArray(v) : typeof v !== type;
  })) refuse('SHU251_RECEIPT_INVALID', 'evidence shape');
  if (value.evidence_sha256 !== hash(canonical(value.evidence))) refuse('SHU251_EVIDENCE_DIGEST', step);
  if (Object.hasOwn(LIFECYCLE_ACTIONS, step) && !(value.evidence.binding === LIFECYCLE_ACTIONS[step] &&
      value.evidence.ok === true && value.evidence.activation_id === spec.lifecycle?.activation_id &&
      value.evidence.approval_sha256 === spec.lifecycle?.approval_sha256 && /^[a-f0-9]{64}$/.test(value.evidence.journal_sha256) &&
      value.evidence.disposition === (step === 'preflight' ? 'observed' : step === 'pin-restore' ? 'restored' : step === 'pin-retain' ? 'retained' : 'executed')))
    refuse('SHU251_LIFECYCLE_RECEIPT', step);
  return value;
}
function read(file) {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink()) refuse('SHU251_INPUT_FILE', file);
  return fs.readFileSync(file);
}
// Custody is local durable state, not a signature or a boundary against its owner.
export function custodyPath(spec) {
  return path.join(spec.window.workspace_state_dir, '.shu251-phase-a', spec.window.approved_sha, hash(canonical(spec)));
}
function syncDirectory(dir) {
  const fd = fs.openSync(dir, 'r');
  try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function persist(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600);
  try { fs.writeFileSync(fd, canonical(value)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  syncDirectory(path.dirname(file));
}
function custodyRead(file) {
  try { return JSON.parse(read(file)); }
  catch { refuse('SHU251_RESTART_FORGED', 'missing, unreadable or malformed custody file'); }
}
function exactKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value) && canonical(Object.keys(value).sort()) === canonical(keys.sort());
}
function runIdentity(spec) {
  return { approved_sha: spec.window.approved_sha, spec_sha256: hash(canonical(spec)), window_sha256: hash(canonical(spec.window)) };
}
export function createRestartCustody(spec, before) {
  const run_id = randomUUID();
  const record = { version: 'shu251-restart-record-v1', run_id, identity: runIdentity(spec), position: 'restart-before', receipt: before };
  const custody = { version: 'shu251-restart-custody-v1', run_id, identity: runIdentity(spec), receipt_sha256: hash(canonical(before)) };
  return { custody, record };
}
function recordBefore(spec, before) {
  const dir = custodyPath(spec);
  // Create each directory durably; existing symlinks are never followed.
  const root = spec.window.workspace_state_dir;
  if (!fs.lstatSync(root).isDirectory() || fs.lstatSync(root).isSymbolicLink()) refuse('SHU251_RESTART_FORGED', 'state directory');
  let current = root;
  for (const part of path.relative(root, dir).split(path.sep)) {
    const parent = current; current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); syncDirectory(parent); }
    catch (error) { if (error.code !== 'EEXIST') throw error; }
    if (!fs.lstatSync(current).isDirectory() || fs.lstatSync(current).isSymbolicLink()) refuse('SHU251_RESTART_FORGED', 'custody directory');
  }
  const { custody, record } = createRestartCustody(spec, before);
  try {
    // An incomplete write fails closed; a run can never silently overwrite another.
    persist(path.join(dir, 'custody.json'), custody);
    persist(path.join(dir, 'record.json'), record);
  } catch (error) { if (error.code === 'EEXIST') refuse('SHU251_RESTART_REPLAYED', 'run already recorded'); throw error; }
}
function loadBefore(spec) {
  const dir = custodyPath(spec);
  // Validate every directory component on read as well as creation.
  let current = spec.window.workspace_state_dir;
  for (const part of ['', ...path.relative(current, dir).split(path.sep)]) {
    current = path.join(current, part);
    try { const stat = fs.lstatSync(current); if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(); }
    catch { refuse('SHU251_RESTART_FORGED', 'missing or invalid custody directory'); }
  }
  const custody = custodyRead(path.join(dir, 'custody.json'));
  const record = custodyRead(path.join(dir, 'record.json'));
  validateRestartCustody(spec, custody, record);
  return { before: record.receipt, dir, run_id: custody.run_id, receipt_sha256: custody.receipt_sha256 };
}
export function validateRestartCustody(spec, custody, record) {
  if (!exactKeys(custody, ['version', 'run_id', 'identity', 'receipt_sha256']) || custody.version !== 'shu251-restart-custody-v1' ||
      !/^[0-9a-f-]{36}$/.test(custody.run_id) || !/^[0-9a-f]{64}$/.test(custody.receipt_sha256) ||
      !exactKeys(record, ['version', 'run_id', 'identity', 'position', 'receipt']) || record.version !== 'shu251-restart-record-v1') refuse('SHU251_RESTART_FORGED', 'custody shape');
  if (canonical(custody.identity) !== canonical(runIdentity(spec)) || canonical(record.identity) !== canonical(runIdentity(spec)) || record.run_id !== custody.run_id) refuse('SHU251_RESTART_CROSS_RUN', 'run identity');
  if (record.position !== 'restart-before' || record.receipt?.step !== 'restart-before') refuse('SHU251_RESTART_SUBSTITUTED', 'record position');
  if (hash(canonical(record.receipt)) !== custody.receipt_sha256) refuse('SHU251_RESTART_FORGED', 'observed receipt differs from custody');
  try { validateReceipt(record.receipt, 'restart-before', spec); }
  catch { refuse('SHU251_RESTART_FORGED', 'receipt shape or digest'); }
  return record.receipt;
}
function consume({ dir, run_id, receipt_sha256 }) {
  try { persist(path.join(dir, 'consumed.json'), { version: 'shu251-restart-consumed-v1', run_id, receipt_sha256 }); }
  catch (error) {
    // Any existing marker, even damaged, is a refusal. Exclusive creation also
    // arbitrates concurrent consumers before either can emit an acceptance receipt.
    if (error.code === 'EEXIST') refuse('SHU251_RESTART_REPLAYED', 'record already consumed');
    throw error;
  }
}
function command(file, args, options = {}) {
  const out = spawnSync(file, args, { encoding: 'utf8', timeout: 30000, ...options });
  if (out.error || out.status !== 0) refuse('SHU251_COMMAND_FAILED', `${file}: ${out.status}`);
  return out.stdout;
}
export function assertRollbackSafe(prior, sha) {
  if (prior?.version !== 'shu251-prior-state-v1' || prior.approved_sha !== sha) refuse('SHU251_ROLLBACK_STATE');
  for (const unit of UNIT_NAMES) {
    if (prior.active?.[unit] !== 'inactive' || !['disabled', 'masked', 'static', 'indirect', 'not-found'].includes(prior.enabled?.[unit])) refuse('SHU251_ROLLBACK_REENABLE', unit);
    const item = prior.units?.[unit];
    if (item !== null) {
      if (typeof item?.data !== 'string') refuse('SHU251_ROLLBACK_STATE', unit);
      const bytes = Buffer.from(item.data, 'base64').toString('utf8');
      // Only absent units or the freshly rendered dispatch-off bytes can be restored.
      if (unit.endsWith('.service') && (!/^Environment=ENABLE_DISPATCH=false$/m.test(bytes) || /ENABLE_DISPATCH=(?!false(?:\n|$))/.test(bytes))) refuse('SHU251_ROLLBACK_REENABLE', unit);
    }
  }
}
export const defaultIO = {
  read,
  async render(spec) {
    const { render, serviceParameters, assertPolicy } = await import('./units.mjs');
    const parameters = serviceParameters(spec.render);
    const environment = read(parameters.coordinatorEnvironmentFile).toString('utf8');
    if (/^ENABLE_DISPATCH=/m.test(environment)) refuse('SHU251_ENV_GATE_OVERRIDE');
    const units = render(parameters); assertPolicy(units, parameters); return units;
  },
  async pin(spec) {
    if (path.resolve(HERE, '../../..') !== spec.window.repo_dir) refuse('SHU251_CHECKOUT_PATH');
    const { validateWindowSpec } = await import('./host-window-bindings.mjs');
    validateWindowSpec(spec.window);
    for (const [renderKey, windowKey] of [['workspaceStateDir', 'workspace_state_dir'], ['supervisorStateDir', 'supervisor_state_dir'], ['supervisorSocket', 'supervisor_socket']])
      if (spec.render[renderKey] !== spec.window[windowKey]) refuse('SHU251_RENDER_BINDING', renderKey);
  },
  lockExisting(spec) {
    let stat;
    try { stat = fs.lstatSync(path.join(spec.window.workspace_state_dir, 'host-tick.lock')); }
    catch { refuse('SHU251_LOCK_MISSING'); }
    if (!stat.isFile() || stat.isSymbolicLink()) refuse('SHU251_LOCK_MISSING');
  },
  run(action, specPath, spec) {
    // Git trust is scoped to this process and the single approved checkout only.
    return command('/bin/sh', [path.join(HERE, 'shu251-operational-bindings.sh'), action, specPath], {
      env: { ...process.env, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: spec.window.repo_dir },
    });
  },
  async wait(ms) { await new Promise(resolve => setTimeout(resolve, ms)); },
  now() { return performance.now(); },
  snapshot(spec) {
    const result = {};
    function visit(file) {
      const stat = fs.lstatSync(file, { bigint: true });
      if (stat.isSymbolicLink()) refuse('SHU251_INVENTORY_SYMLINK', file);
      if (stat.isDirectory()) for (const child of fs.readdirSync(file).sort()) visit(path.join(file, child));
      else if (stat.isFile()) result[file] = { sha256: hash(read(file)), size: String(stat.size), mtime_ns: String(stat.mtimeNs), ctime_ns: String(stat.ctimeNs) };
      else if (!stat.isSocket()) refuse('SHU251_INVENTORY_TYPE', file);
    }
    visit(spec.window.workspace_state_dir);
    if (!spec.window.supervisor_state_dir.startsWith(`${spec.window.workspace_state_dir}/`)) visit(spec.window.supervisor_state_dir);
    return result;
  },
  watch(spec) {
    let writes = 0, error;
    const watchers = [...new Set([spec.window.workspace_state_dir, spec.window.supervisor_state_dir])].map(root => {
      const watcher = fs.watch(root, { recursive: true }, () => writes++);
      watcher.on('error', cause => { error = cause; }); return watcher;
    });
    return { count() { if (error) refuse('SHU251_WATCH_FAILED'); return writes; }, close() { watchers.forEach(w => w.close()); } };
  },
  invocation() {
    const value = command('/usr/bin/systemctl', ['show', 'shu-supervisor.service', '--property=InvocationID', '--value']).trim();
    if (!/^[a-f0-9]{32}$/.test(value)) refuse('SHU251_RESTART_ID');
    return value;
  },
};
export function approve(action, spec, options) {
  if (MUTATIONS.has(action) && !(options.env?.SHU251_HOST_MUTATION_APPROVED === 'true' && options.approvedHostMutation === spec.window.approved_sha)) refuse('SHU251_HOST_MUTATION_APPROVAL', action);
}
export async function binding(action, spec, options, io) {
  if (!Object.hasOwn(ACTIONS, action)) refuse('SHU251_ACTION', action);
  approve(action, spec, options);
  if (action === 'quiescence') io.lockExisting(spec);
  let result;
  try { result = JSON.parse(await io.run(action, spec.window_spec_path, spec)); }
  catch (error) { if (error.code?.startsWith('SHU251_')) throw error; refuse('SHU251_BINDING_RECEIPT', action); }
  const e = result?.evidence;
  if (result?.ok !== true || e?.ok !== true || e.binding !== ACTIONS[action]) refuse('SHU251_BINDING_RECEIPT', action);
  const w = spec.window;
  if (action === 'inventory' && (e.approved_sha !== w.approved_sha || e.remote_ref !== w.remote_ref || e.fixture_branch_head !== w.fixture.target_sha || !Number.isInteger(e.comment_count) || e.comment_count < 0 || !/^[a-f0-9]{64}$/.test(e.comments_digest))) refuse('SHU251_BINDING_RECEIPT', action);
  if (action === 'quiescence' && (canonical(e.states) !== canonical(Object.fromEntries(UNIT_NAMES.map(n => [n, 'inactive']))) || e.writer_lock !== 'free')) refuse('SHU251_BINDING_RECEIPT', action);
  if (['worker', 'launch'].includes(action) && (e.pid !== w.fixture.pid || e.start_token !== w.fixture.start_token)) refuse('SHU251_BINDING_RECEIPT', action);
  if (action === 'launch' && (e.attempt_id !== w.fixture.attempt_id || e.target_sha !== w.fixture.target_sha || e.issue_id !== w.fixture.issue_id)) refuse('SHU251_BINDING_RECEIPT', action);
  if (action === 'transport' && (e.attempt_id !== w.fixture.attempt_id || !['RUNNING', 'COMPLETED', 'FAILED', 'ACCEPTED', 'HOLD'].includes(e.stage) || e.credential?.ok !== true || e.credential.binding !== 'status_credential_delivery')) refuse('SHU251_BINDING_RECEIPT', action);
  if (action === 'rollback' && e.restored_revision !== w.approved_sha) refuse('SHU251_BINDING_RECEIPT', action);
  if (action === 'capture-prior' && e.prior_state_file !== w.prior_state_file) refuse('SHU251_BINDING_RECEIPT', action);
  if (action === 'replay-release' && (e.replay !== 'accepted' || e.released !== true || e.attempt_id !== w.fixture.attempt_id)) refuse('SHU251_BINDING_RECEIPT', action);
  if (action === 'cleanup' && (e.signaled_pid !== w.fixture.pid || canonical(e.removed) !== canonical([w.fixture.release_file, w.fixture.journal_file]))) refuse('SHU251_BINDING_RECEIPT', action);
  return e;
}
export async function identity(spec, io) {
  const units = await io.render(spec), rendered = {}, installed = {};
  for (const name of UNIT_NAMES) {
    const expected = Buffer.from(units[name]), actual = io.read(path.join(spec.window.unit_directory, name));
    rendered[name] = hash(expected); installed[name] = hash(actual);
    if (!expected.equals(actual)) refuse('SHU251_UNIT_IDENTITY', name);
  }
  return { rendered_sha256: rendered, installed_sha256: installed };
}
export async function drive(step, spec, options = {}, io = defaultIO) {
  try {
    if (!RECEIPT_SCHEMA.properties.step.enum.includes(step) || !/^[a-f0-9]{40}$/.test(spec?.window?.approved_sha) || !path.isAbsolute(spec.window_spec_path ?? '') || spec.render?.workdir !== spec.window.repo_dir) refuse('SHU251_DRIVER_SPEC');
    if (canonical(JSON.parse(io.read(spec.window_spec_path))) !== canonical(spec.window)) refuse('SHU251_SPEC_CHANGED');
    if (Object.hasOwn(options, 'before')) refuse('SHU251_RESTART_CALLER_BEFORE', 'caller receipt is not custody');
    approve(step, spec, options);
    // A dry run is a plan, never an acceptance receipt and never invokes a binding.
    if (options.execute !== true) return { version: 'shu251-phase-a-plan-v1', step, approved_sha: spec.window.approved_sha, dry_run: true };
    if (Object.hasOwn(LIFECYCLE_ACTIONS, step)) {
      const { executeLifecycle } = await import('./host-lifecycle.mjs');
      return await executeLifecycle(step, spec, options, io);
    }
    await io.pin(spec);
    await binding('inventory', spec, options, io);
    let evidence, custody;
    if (step === 'identity') evidence = await identity(spec, io);
    else if (step === 'gate-off') {
      const units = await io.render(spec);
      const timer = units['shu-coordinator.timer'];
      const match = /^OnUnitInactiveSec=(\d+)s$/m.exec(timer);
      if (!match || Number(match[1]) < 1) refuse('SHU251_WAKE_INTERVAL');
      const interval_ms = (Number(match[1]) + 1) * 1000;
      const unitIdentity = await identity(spec, io);
      await binding('quiescence', spec, options, io); // The lock must already exist; observing it must not create state.
      const watcher = io.watch(spec);
      try {
        const samples = [];
        const start = io.now();
        for (let i = 0; i < 3; i++) {
          if (i) await io.wait(interval_ms);
          const quiescence = await binding('quiescence', spec, options, io);
          const inventory = await binding('inventory', spec, options, io);
          samples.push({ quiescence, inventory, authoritative: io.snapshot(spec) });
          if (canonical(samples[i]) !== canonical(samples[0])) refuse('SHU251_GATE_OFF_DIFF');
        }
        const elapsed_ms = io.now() - start;
        if (elapsed_ms < interval_ms * 2) refuse('SHU251_WAKE_INTERVAL');
        if (watcher.count() !== 0) refuse('SHU251_GATE_OFF_WRITES');
        evidence = { identity: unitIdentity, interval_ms, elapsed_ms, samples, launches: 0, writes: 0 };
      } finally { watcher.close(); }
    } else if (step.startsWith('restart-')) {
      const invocation_id = io.invocation();
      const launch = await binding('launch', spec, options, io);
      const worker = await binding('worker', spec, options, io);
      // transport invokes the reviewed check-status.mjs client and its exact schema validator.
      const status = await binding('transport', spec, options, io);
      if (status.stage !== 'RUNNING') refuse('SHU251_RESTART_STATUS');
      evidence = { invocation_id, launch, worker, status, identity: await identity(spec, io) };
      if (step === 'restart-after') {
        custody = loadBefore(spec);
        const { before } = custody;
        if (!/^[a-f0-9]{32}$/.test(before.evidence.invocation_id ?? '') || before.evidence.invocation_id === invocation_id || canonical(before.evidence.launch) !== canonical(launch) || canonical(before.evidence.worker) !== canonical(worker)) refuse('SHU251_RESTART_ACCEPTANCE');
        evidence.before_receipt_sha256 = hash(canonical(before));
      }
    } else {
      if (step === 'rollback') {
        const prior = JSON.parse(io.read(spec.window.prior_state_file));
        assertRollbackSafe(prior, spec.window.approved_sha);
        const units = await io.render(spec);
        for (const unit of UNIT_NAMES) if (prior.units[unit] !== null && !Buffer.from(prior.units[unit].data, 'base64').equals(Buffer.from(units[unit]))) refuse('SHU251_ROLLBACK_BYTES', unit);
      }
      evidence = await binding(step, spec, options, io);
      if (step === 'rollback') evidence = { ...evidence, quiescence: await binding('quiescence', spec, options, io), dispatch_reenabled: false };
    }
    const result = receipt(step, spec, evidence);
    if (step === 'restart-before') recordBefore(spec, result);
    if (custody) consume(custody);
    return result;
  } catch (error) { if (error.code?.startsWith('SHU251_')) throw error; refuse('SHU251_DRIVER_UNEXPECTED', error.message); }
}
export async function main(argv = process.argv.slice(2)) {
  const [step, file, ...flags] = argv;
  if (!path.isAbsolute(file ?? '')) refuse('SHU251_DRIVER_USAGE');
  const options = { env: process.env };
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--execute') options.execute = true;
    else if (flags[i] === '--approved-host-mutation') options.approvedHostMutation = flags[++i];
    else if (flags[i] === '--before') refuse('SHU251_RESTART_CALLER_BEFORE', '--before is no longer supported');
    else refuse('SHU251_DRIVER_USAGE', flags[i]);
  }
  return drive(step, JSON.parse(read(file)), options);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await main())); }
  catch (error) { console.error(JSON.stringify({ ok: false, code: error.code?.startsWith('SHU251_') ? error.code : 'SHU251_DRIVER_UNEXPECTED', reason: error.message })); process.exitCode = 2; }
}
