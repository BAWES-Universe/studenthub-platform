// Typed Phase-A executor. Effects use the production provider selected by the
// reviewed driver, or an explicit test capability boundary (HOST-LIFECYCLE.md).
import path from 'node:path';
import { CAPABILITIES } from './host-suite-contract.mjs';
export const REQUIRED_CAPABILITIES = Object.freeze([...CAPABILITIES.map(c => c.name), 'atomic-rename', 'directory-fsync']);
import { canonical, hash, refuse, approve, receipt, validateReceipt, createRestartCustody, validateRestartCustody, LIFECYCLE_ACTIONS, UNIT_NAMES } from './phase-a-driver.mjs';

export const FILES = Object.freeze([...UNIT_NAMES,
  'shu-supervisor.service.d/10-shu251.conf', 'shu-coordinator.service.d/10-shu251.conf']);
export const DROP_IN_DIRECTORIES = Object.freeze(['shu-supervisor.service.d', 'shu-coordinator.service.d']);
export const TARGETS = Object.freeze([...DROP_IN_DIRECTORIES, ...FILES]);
const copy = value => structuredClone(value);
const equal = (a, b) => canonical(a) === canonical(b);
const sha = v => typeof v === 'string' && /^[a-f0-9]{40}$/.test(v);
const digest = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const keys = (v, names) => v && typeof v === 'object' && !Array.isArray(v) && equal(Object.keys(v).sort(), [...names].sort());
// One independently removable named invariant per guard family. Tests disable
// each family individually, syntax-check the mutant and demand its named assertion.
export function check(code, condition) {
  if (!condition) refuse(code);
}
const absolute = p => typeof p === 'string' && /^\/[a-zA-Z0-9_.\/-]+$/.test(p) && path.normalize(p) === p && !p.endsWith('/');
const bytes = f => Buffer.from(f.data, 'base64');
const fileHash = f => hash(bytes(f));
const hashes = files => Object.fromEntries(FILES.map(n => [n, fileHash(files[n])]));
const binding = spec => ({ activation_id: spec.lifecycle.activation_id, approval_sha256: spec.lifecycle.approval_sha256,
  approved_sha: spec.window.approved_sha, spec_sha256: hash(canonical(spec)) });
const manifest = spec => ({ ...binding(spec), approved_tree: spec.lifecycle.approved_tree,
  rendered_sha256: spec.lifecycle.rendered_sha256 });
export const expectedManifest = manifest;

function configuration(spec) {
  const c = spec.lifecycle;
  check('SHU251_LIFECYCLE_SPEC', keys(c, ['activation_id', 'approval_sha256', 'approved_tree', 'identity', 'environment', 'directories',
    'systemd_version', 'capabilities', 'evidence_root', 'evidence_dir', 'rendered_sha256']) &&
    /^[a-z0-9][a-z0-9-]{7,63}$/.test(c.activation_id) && digest(c.approval_sha256) && sha(c.approved_tree) &&
    keys(c.identity, ['user', 'group', 'uid', 'gid', 'groups']) && /^[a-z_][a-z0-9_-]*$/.test(c.identity.user) && c.identity.user !== 'root' &&
    /^[a-z_][a-z0-9_-]*$/.test(c.identity.group) && Number.isSafeInteger(c.identity.uid) && c.identity.uid > 0 &&
    Number.isSafeInteger(c.identity.gid) && c.identity.gid > 0 && Array.isArray(c.identity.groups) &&
    c.identity.groups.every(g => Number.isSafeInteger(g) && g > 0) && new Set(c.identity.groups).size === c.identity.groups.length &&
    keys(c.rendered_sha256, FILES) && Object.values(c.rendered_sha256).every(digest) &&
    Number.isSafeInteger(c.systemd_version) && c.systemd_version >= 250 &&
    equal(c.capabilities, REQUIRED_CAPABILITIES) &&
    spec.window.unit_directory === '/etc/systemd/system');
  check('SHU251_LIFECYCLE_PATHS', absolute(c.evidence_root) && c.evidence_dir === `${c.evidence_root}/${c.activation_id}` &&
    keys(c.environment, ['supervisor', 'coordinator']) &&
    equal(c.environment.supervisor, { path: spec.render.supervisorEnvironmentFile, uid: c.identity.uid, gid: c.identity.gid, mode: 0o600, kind: 'file' }) &&
    equal(c.environment.coordinator, { path: spec.render.coordinatorEnvironmentFile, uid: c.identity.uid, gid: c.identity.gid, mode: 0o600, kind: 'file' }) &&
    absolute(spec.render.supervisorEnvironmentFile) && absolute(spec.render.coordinatorEnvironmentFile) &&
    spec.render.supervisorEnvironmentFile !== spec.render.coordinatorEnvironmentFile &&
    spec.render.supervisorEnvironmentFile !== '/srv/shu/service.env' && spec.render.coordinatorEnvironmentFile !== '/etc/shu/supervisor.env' &&
    spec.render.serviceUser === c.identity.user && spec.render.serviceGroup === c.identity.group &&
    spec.render.workspaceStateDir === spec.window.workspace_state_dir && spec.render.supervisorStateDir === spec.window.supervisor_state_dir &&
    spec.render.supervisorSocket === spec.window.supervisor_socket && absolute(spec.window.workspace_state_dir) && absolute(spec.window.supervisor_state_dir) &&
    equal(c.directories, [spec.window.workspace_state_dir, spec.window.supervisor_state_dir].map(p => ({ path: p, kind: 'directory', uid: c.identity.uid, gid: c.identity.gid, mode: 0o700 }))));
  return c;
}
async function preflight(spec, host, recovery = false) {
  const c = configuration(spec), p = await host.probe();
  check('SHU251_LIFECYCLE_CHECKOUT', equal(p.checkout, { sha: spec.window.approved_sha, tree: c.approved_tree, clean: true }));
  check('SHU251_LIFECYCLE_IDENTITY', equal(p.identity, c.identity));
  // Metadata only: probe must never read environment values. Exact keys prevent
  // accidental inclusion of values in a successful receipt.
  check('SHU251_LIFECYCLE_ENVIRONMENT', equal(p.environment, c.environment));
  check('SHU251_LIFECYCLE_DIRECTORIES', equal(p.directories, c.directories));
  check('SHU251_LIFECYCLE_CAPABILITIES', p.systemd_version === c.systemd_version && equal(p.capabilities, c.capabilities));
  check('SHU251_LIFECYCLE_EVIDENCE', equal(p.evidence, { path: c.evidence_dir, canonical: c.evidence_dir,
    uid: c.identity.uid, mode: 0o700, manifest: manifest(spec) }));
  check('SHU251_WRITER_LOCK', p.writer_lock === (recovery ? 'held-by-driver' : 'free'));
  check('SHU251_DESTINATION', equal(p.destination, { path: '/etc/systemd/system', canonical: '/etc/systemd/system', uid: 0, mode: 0o755, unreviewed_dropins: [] }));
  return { checkout: p.checkout, identity: p.identity, environment: p.environment, directories: p.directories,
    systemd_version: p.systemd_version, capabilities: p.capabilities, evidence: p.evidence };
}
function snapshotShape(s, spec) {
  const item = f => keys(f, ['kind']) && f.kind === 'absent' ||
    keys(f, ['kind', 'data', 'mode', 'uid', 'gid']) && f.kind === 'file' && typeof f.data === 'string' && bytes(f).toString('base64') === f.data &&
      Number.isSafeInteger(f.mode) && f.mode >= 0 && f.mode <= 0o777 && f.uid === 0 && f.gid === 0 ||
    keys(f, ['kind', 'target', 'uid', 'gid']) && f.kind === 'symlink' && f.target === '/dev/null' && f.uid === 0 && f.gid === 0;
  check('SHU251_LIFECYCLE_SNAPSHOT', keys(s, ['files', 'enabled', 'active', 'pin']) && keys(s.files, TARGETS) && Object.entries(s.files).every(([n, f]) => DROP_IN_DIRECTORIES.includes(n)
      ? equal(f, { kind: 'absent' }) || keys(f, ['kind', 'uid', 'gid', 'mode']) && f.kind === 'directory' && f.uid === 0 && f.gid === 0 &&
        Number.isSafeInteger(f.mode) && f.mode >= 0 && f.mode <= 0o777 && !(f.mode & 0o022) : item(f)) &&
    keys(s.enabled, UNIT_NAMES) && Object.values(s.enabled).every(v => ['enabled', 'disabled', 'masked', 'static', 'indirect', 'not-found'].includes(v)) &&
    keys(s.active, UNIT_NAMES) && Object.values(s.active).every(v => ['active', 'inactive'].includes(v)) &&
    keys(s.pin, ['ref', 'sha']) && s.pin.ref === `refs/shu251/activations/${spec.lifecycle.activation_id}` && (s.pin.sha === null || sha(s.pin.sha)));
  return s;
}
function priorSafe(s) {
  check('SHU251_LIFECYCLE_ROLLBACK_REENABLE', UNIT_NAMES.every(n => s.active[n] === 'inactive' && s.enabled[n] !== 'enabled') &&
    FILES.every(n => s.files[n].kind !== 'file' || n.endsWith('.timer') ||
      (/^Environment=ENABLE_DISPATCH=false$/m.test(bytes(s.files[n]).toString('utf8')) && !/ENABLE_DISPATCH=(?!false(?:\n|$))/.test(bytes(s.files[n]).toString('utf8')))));
}
function journalValid(j, spec) {
  check('SHU251_LIFECYCLE_JOURNAL', keys(j, ['version', 'binding', 'prior', 'entries', 'receipts', 'restart', 'rolled_back']) &&
    j.version === 1 && equal(j.binding, binding(spec)) && Array.isArray(j.entries) && Array.isArray(j.receipts) &&
    typeof j.rolled_back === 'boolean' && j.entries.every((e, i) => keys(e, ['id', 'verb', 'target', 'before', 'after', 'status']) &&
      e.id === i && ['pending', 'done', 'undone'].includes(e.status) &&
      (e.verb === 'place' && TARGETS.includes(e.target) || ['enable', 'start'].includes(e.verb) && UNIT_NAMES.includes(e.target) ||
       e.verb === 'daemon-reload' && e.target === null || e.verb === 'pin' && e.target === j.prior?.pin?.ref)) &&
    (j.restart === null || keys(j.restart, ['custody', 'record', 'consumed', 'after']) && j.restart.consumed === true));
  snapshotShape(j.prior, spec); priorSafe(j.prior);
  const replay = copy(j.prior);
  for (const e of j.entries) {
    const expected = value(replay, e.verb, e.target);
    check('SHU251_LIFECYCLE_INTENT', (e.verb === 'enable' ? ['disabled', 'masked', 'static', 'indirect', 'not-found'].includes(e.before) : equal(e.before, expected)) &&
      (e.verb === 'place' ? DROP_IN_DIRECTORIES.includes(e.target) ? equal(e.after, { kind: 'directory', uid: 0, gid: 0, mode: 0o755 }) : keys(e.after, ['kind', 'data', 'mode', 'uid', 'gid']) && e.after.kind === 'file' &&
        typeof e.after.data === 'string' && fileHash(e.after) === spec.lifecycle.rendered_sha256[e.target] &&
        e.after.mode === 0o644 && e.after.uid === 0 && e.after.gid === 0
        : e.verb === 'enable' ? ['shu-supervisor.service', 'shu-coordinator.timer'].includes(e.target) && e.after === 'enabled'
        : e.verb === 'start' ? e.after === (e.target === 'shu-coordinator.service' ? 'inactive' : 'active')
        : e.verb === 'pin' ? (e.after === spec.window.approved_sha || e.after === j.prior.pin.sha)
        : e.after === null));
    if (e.verb === 'place') replay.files[e.target] = copy(e.after);
    if (e.verb === 'enable') replay.enabled[e.target] = e.after;
    if (e.verb === 'start') replay.active[e.target] = e.after;
    if (e.verb === 'pin') replay.pin.sha = e.after;
  }
  for (const r of j.receipts) validateReceipt(r, r.step, spec);
  if (j.restart) validateRestartCustody(spec, j.restart.custody, j.restart.record);
}
function value(s, verb, target) {
  if (verb === 'place') return s.files[target];
  if (verb === 'enable') return s.enabled[target];
  if (verb === 'start') return s.active[target];
  if (verb === 'pin') return s.pin.sha;
  return null;
}
const errors = { place: 'SHU251_LIFECYCLE_PLACE', 'daemon-reload': 'SHU251_LIFECYCLE_RELOAD', enable: 'SHU251_LIFECYCLE_ENABLE',
  start: 'SHU251_LIFECYCLE_START', pin: 'SHU251_LIFECYCLE_PIN' };
async function boundary(host, code, fn) {
  let ok = false;
  try { ok = await fn() === true; } catch { /* A pending intent remains durable even for an ambiguous outcome. */ }
  check(code, ok);
}
async function stage(spec, io, host) {
  const base = await io.render(spec);
  const units = { ...base, 'shu-supervisor.service.d/10-shu251.conf': '[Service]\nEnvironment=ENABLE_DISPATCH=false\n',
    'shu-coordinator.service.d/10-shu251.conf': '[Service]\nEnvironment=ENABLE_DISPATCH=false\n' };
  check('SHU251_LIFECYCLE_RENDER', keys(units, FILES) && FILES.every(n => typeof units[n] === 'string' && hash(units[n]) === spec.lifecycle.rendered_sha256[n]) &&
    FILES.filter(n => !n.endsWith('.timer')).every(n => /^Environment=ENABLE_DISPATCH=false$/m.test(units[n]) && !/ENABLE_DISPATCH=(?!false(?:\n|$))/.test(units[n])));
  const staged = await host.stage(units);
  check('SHU251_LIFECYCLE_STAGE', staged?.temporary === true && staged.canonical === staged.path && absolute(staged.path) && equal(staged.units, units));
  check('SHU251_OWNER', staged.uid === staged.caller_uid);
  check('SHU251_PRIVATE', staged.mode === 0o700);
  return { ...Object.fromEntries(DROP_IN_DIRECTORIES.map(n => [n, { kind: 'directory', uid: 0, gid: 0, mode: 0o755 }])),
    ...Object.fromEntries(FILES.map(n => [n, { kind: 'file', data: Buffer.from(staged.units[n]).toString('base64'), uid: 0, gid: 0, mode: 0o644 }])) };
}
async function ready(spec, host) {
  const s = snapshotShape(await host.snapshot(), spec);
  check('SHU251_LIFECYCLE_INSTALLED', FILES.every(n => s.files[n].kind === 'file' && fileHash(s.files[n]) === spec.lifecycle.rendered_sha256[n] &&
    s.files[n].mode === 0o644 && s.files[n].uid === 0 && s.files[n].gid === 0));
  const r = await host.readiness();
  check('SHU251_LIFECYCLE_READINESS', keys(r, ['identity', 'listeners', 'supervisor', 'coordinator', 'committed_dispatch', 'runtime_dispatch', 'invocation_id', 'worker']) &&
    equal(r.identity, spec.lifecycle.identity) && equal(r.listeners, [spec.window.supervisor_socket]) && r.supervisor === 'ready' &&
    r.coordinator === 'ready' && r.committed_dispatch === false && r.runtime_dispatch === false && /^[a-f0-9]{32}$/.test(r.invocation_id) &&
    keys(r.worker, ['pid', 'start_token']) && Number.isSafeInteger(r.worker.pid) && r.worker.pid > 0 && typeof r.worker.start_token === 'string' &&
    r.worker.start_token.length > 0 && s.active['shu-supervisor.service'] === 'active' && s.active['shu-coordinator.timer'] === 'active' &&
    s.enabled['shu-supervisor.service'] === 'enabled' && s.enabled['shu-coordinator.timer'] === 'enabled');
  return { state: s, readiness: r };
}
export async function executeLifecycle(step, spec, options, io) {
  try {
    approve(step, spec, options);
    const result = await execute(step, spec, options, io);
    return validateReceipt(result, step, spec);
  } catch (error) {
    if (error.code?.startsWith('SHU251_')) throw error;
    // Never put probe output (possibly containing credentials) in driver errors.
    refuse('SHU251_LIFECYCLE_IO');
  }
}
async function execute(step, spec, options, io) {
  configuration(spec);
  check('SHU251_LIFECYCLE_INPUT', Object.hasOwn(LIFECYCLE_ACTIONS, step) && options.execute === true && Object.keys(options).every(k => ['execute', 'env', 'approvedHostMutation'].includes(k)));
  const host = io.lifecycle;
  check('SHU251_LIFECYCLE_IO', host && ['probe', 'snapshot', 'stage', 'readiness', 'withLock', 'load', 'save', 'place', 'systemd', 'pin'].every(k => typeof host[k] === 'function'));
  if (step === 'preflight') {
    const after = await preflight(spec, host);
    return receipt(step, spec, { binding: 'host_preflight', ok: true, ...pickBinding(spec), installed_sha256: {}, before: {}, after,
      journal_sha256: hash('null'), disposition: 'observed' });
  }
  // withLock must hold both activation journal custody and the existing writer
  // lock until the final durable receipt. There is no unlocked execution path.
  return host.withLock(async () => {
    await preflight(spec, host, true);
    let j = await host.load();
    const save = async () => { await boundary(host, 'SHU251_LIFECYCLE_DURABILITY', () => host.save(copy(j))); };
    if (j === null) {
      const prior = snapshotShape(await host.snapshot(), spec); priorSafe(prior);
      j = { version: 1, binding: binding(spec), prior, entries: [], receipts: [], restart: null, rolled_back: false };
      await save(); // Complete backup precedes the FIRST destination/ref mutation.
    } else journalValid(j, spec);
    const before = snapshotShape(await host.snapshot(), spec);
    async function perform(e) {
      const current = snapshotShape(await host.snapshot(), spec), v = value(current, e.verb, e.target);
      check('SHU251_LIFECYCLE_SUBSTITUTION', e.verb === 'daemon-reload' || equal(v, e.before) || equal(v, e.after));
      if (e.verb === 'daemon-reload' || e.verb === 'start' && e.target === 'shu-coordinator.service' || !equal(v, e.after)) {
        await boundary(host, errors[e.verb], () => e.verb === 'place' ? host.place(e.target, copy(e.before), copy(e.after))
          : e.verb === 'pin' ? host.pin(e.target, e.before, e.after)
          : host.systemd(e.verb, e.target));
      }
      const observed = await host.snapshot();
      check('SHU251_LIFECYCLE_EFFECT', e.verb === 'daemon-reload' || equal(value(observed, e.verb, e.target), e.after));
      e.status = 'done'; await save();
    }
    async function change(verb, target, after) {
      // Resume the same pending intent; never append a duplicate after a crash.
      const pending = j.entries.find(e => e.status === 'pending');
      if (pending) await perform(pending);
      const current = snapshotShape(await host.snapshot(), spec), prior = value(current, verb, target);
      const oneshot = verb === 'start' && target === 'shu-coordinator.service';
      if (oneshot && j.entries.some(e => e.verb === verb && e.target === target && e.status === 'done')) return;
      if (verb !== 'daemon-reload' && !oneshot && equal(prior, after)) return;
      const e = { id: j.entries.length, verb, target, before: copy(prior), after: copy(after), status: 'pending' };
      j.entries.push(e); await save(); await perform(e);
    }
    check('SHU251_LIFECYCLE_ORDER', (!j.rolled_back || ['host-rollback', 'pin-restore', 'pin-retain'].includes(step)) &&
      (step !== 'install' || !j.entries.some(e => ['enable', 'start'].includes(e.verb))) &&
      (!['readiness', 'restart'].includes(step) || j.receipts.some(r => r.step === 'start') && !j.entries.some(e => e.status === 'pending')));
    let after, disposition = 'executed';
    if (step === 'install') {
      const desired = await stage(spec, io, host);
      for (const n of TARGETS) await change('place', n, desired[n]);
      await change('daemon-reload', null, null);
      after = snapshotShape(await host.snapshot(), spec);
      check('SHU251_LIFECYCLE_INSTALLED', equal(after.files, desired));
    } else if (step === 'start') {
      const installed = snapshotShape(await host.snapshot(), spec);
      check('SHU251_LIFECYCLE_INSTALLED', FILES.every(n => installed.files[n].kind === 'file' && fileHash(installed.files[n]) === spec.lifecycle.rendered_sha256[n]));
      check('SHU251_LIFECYCLE_ORDER', j.receipts.some(r => r.step === 'install'));
      // The oneshot coordinator is static; only the supervisor and timer enable.
      for (const n of ['shu-supervisor.service', 'shu-coordinator.timer']) await change('enable', n, 'enabled');
      for (const n of UNIT_NAMES) await change('start', n, n === 'shu-coordinator.service' ? 'inactive' : 'active');
      after = await ready(spec, host);
    } else if (step === 'readiness') after = await ready(spec, host);
    else if (step === 'restart') {
      check('SHU251_RESTART_REPLAYED', j.restart === null);
      const observed = await ready(spec, host);
      const beforeReceipt = receipt('restart-before', spec, {
        invocation_id: observed.readiness.invocation_id,
        launch: { activation_id: spec.lifecycle.activation_id, ...observed.readiness.worker },
        worker: observed.readiness.worker, status: { stage: 'RUNNING', runtime_dispatch: false },
        identity: { rendered_sha256: spec.lifecycle.rendered_sha256, installed_sha256: hashes(observed.state.files) },
      });
      j.restart = { ...createRestartCustody(spec, beforeReceipt), consumed: true, after: null };
      await save(); // Single-use consumption precedes the restart process boundary.
      await boundary(host, 'SHU251_LIFECYCLE_RESTART', () => host.systemd('restart', 'shu-supervisor.service'));
      after = await ready(spec, host);
      check('SHU251_RESTART_ACCEPTANCE', after.readiness.invocation_id !== observed.readiness.invocation_id && equal(after.readiness.worker, observed.readiness.worker));
      j.restart.after = copy(after); await save();
    } else if (step === 'host-rollback') {
      // Pending operations may already have taken effect. Reconcile BOTH outcomes
      // from the durable intent, undo in reverse, then persist each completion.
      for (const e of [...j.entries].reverse()) {
        if (e.status === 'undone' || e.verb === 'pin') continue;
        const s = snapshotShape(await host.snapshot(), spec), v = value(s, e.verb, e.target);
        check('SHU251_LIFECYCLE_SUBSTITUTION', e.verb === 'daemon-reload' || equal(v, e.before) || equal(v, e.after) || e.verb === 'enable' && v === 'disabled');
        if (e.verb === 'daemon-reload' || !equal(v, e.before)) {
          await boundary(host, 'SHU251_LIFECYCLE_ROLLBACK', () => e.verb === 'place' ? host.place(e.target, copy(e.after), copy(e.before))
            : host.systemd(e.verb === 'enable' ? 'disable' : e.verb === 'start' ? 'stop' : 'daemon-reload', e.target));
        }
        check('SHU251_LIFECYCLE_ROLLBACK_EQUALITY', e.verb === 'daemon-reload' || e.verb === 'enable' || equal(value(await host.snapshot(), e.verb, e.target), e.before));
        e.status = 'undone'; await save();
      }
      await boundary(host, 'SHU251_LIFECYCLE_ROLLBACK', () => host.systemd('daemon-reload', null));
      after = snapshotShape(await host.snapshot(), spec);
      check('SHU251_LIFECYCLE_ROLLBACK_EQUALITY', equal({ ...after, pin: j.prior.pin }, j.prior));
      j.rolled_back = true; await save();
    } else if (step === 'pin') {
      await change('pin', j.prior.pin.ref, spec.window.approved_sha);
      after = snapshotShape(await host.snapshot(), spec);
    } else if (step === 'pin-restore') {
      check('SHU251_LIFECYCLE_PIN_RESTORE', j.rolled_back && equal({ ...before, pin: j.prior.pin }, j.prior) &&
        (before.pin.sha === spec.window.approved_sha || before.pin.sha === j.prior.pin.sha));
      await change('pin', j.prior.pin.ref, j.prior.pin.sha);
      after = snapshotShape(await host.snapshot(), spec); disposition = 'restored';
    } else if (step === 'pin-retain') {
      check('SHU251_LIFECYCLE_PIN_RETAIN', before.pin.sha === spec.window.approved_sha);
      after = before; disposition = 'retained';
    }
    const current = await host.snapshot();
    const result = receipt(step, spec, { binding: LIFECYCLE_ACTIONS[step], ok: true, ...pickBinding(spec),
      installed_sha256: Object.fromEntries(FILES.filter(n => current.files[n].kind === 'file').map(n => [n, fileHash(current.files[n])])),
      before, after, journal_sha256: hash(canonical(j)), disposition });
    j.receipts.push(result); await save();
    return result;
  });
}
function pickBinding(spec) {
  return { activation_id: spec.lifecycle.activation_id, approval_sha256: spec.lifecycle.approval_sha256 };
}
