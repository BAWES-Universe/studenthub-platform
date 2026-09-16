import assert from 'node:assert/strict';
import { drive, hash, canonical, UNIT_NAMES } from '../phase-a-driver.mjs';
import { FILES, TARGETS, DROP_IN_DIRECTORIES, expectedManifest, REQUIRED_CAPABILITIES } from '../host-lifecycle.mjs';
const SHA = 'a'.repeat(40), OLD = 'b'.repeat(40);
const approved = { execute: true, approvedHostMutation: SHA, env: { SHU251_HOST_MUTATION_APPROVED: 'true' } };
const clone = v => structuredClone(v);
export function fixture() {
  const window = { remote_url: 'https://github.com/BAWES-Universe/studenthub-platform.git', approved_sha: SHA, repo_dir: '/reviewed/repo', unit_directory: '/etc/systemd/system',
    workspace_state_dir: '/srv/shu/state/workspaces', supervisor_state_dir: '/srv/shu/state/workspaces/supervisor',
    supervisor_socket: '/srv/shu/state/workspaces/supervisor.sock' };
  const render = { workdir: window.repo_dir, serviceUser: 'shu-coordinator', serviceGroup: 'shu-coordinator',
    supervisorEnvironmentFile: '/etc/shu/supervisor.env', coordinatorEnvironmentFile: '/srv/shu/coordinator.env',
    workspaceStateDir: window.workspace_state_dir, supervisorStateDir: window.supervisor_state_dir, supervisorSocket: window.supervisor_socket };
  const units = Object.fromEntries(UNIT_NAMES.map(n => [n, n.endsWith('.timer') ? '[Timer]\nUnit=shu-coordinator.service\n' :
    `[Service]\nUser=shu-coordinator\nGroup=shu-coordinator\nEnvironment=ENABLE_DISPATCH=false\n# approved ${n}\n`]));
  const rendered = { ...units, ...Object.fromEntries(FILES.filter(n => !UNIT_NAMES.includes(n)).map(n => [n, '[Service]\nEnvironment=ENABLE_DISPATCH=false\n'])) };
  const identity = { user: 'shu-coordinator', group: 'shu-coordinator', uid: 1001, gid: 1001, groups: [1001, 1002] };
  const spec = { window, render, window_spec_path: '/reviewed/window.json', lifecycle: {
    checkout_before: { sha: SHA, head_ref: 'refs/heads/main', main: SHA, origin_main: SHA, tree: 'c'.repeat(40), clean: true },
    activation_id: 'shu251-window-001', approval_sha256: hash('review approval'), approved_tree: 'c'.repeat(40), identity,
    environment: Object.fromEntries(['supervisor', 'coordinator'].map(n => [n, { path: render[`${n}EnvironmentFile`], uid: n === 'supervisor' ? 0 : 1001, gid: n === 'supervisor' ? 0 : 1001, mode: 0o600, kind: 'file' }])),
    directories: [window.workspace_state_dir, window.supervisor_state_dir].map(p => ({ path: p, kind: 'directory', uid: 1001, gid: 1001, mode: 0o700 })),
    systemd_version: 255, capabilities: [...REQUIRED_CAPABILITIES],
    evidence_root: '/srv/shu/evidence', evidence_dir: '/srv/shu/evidence/shu251-window-001',
    rendered_sha256: Object.fromEntries(FILES.map(n => [n, hash(rendered[n])])),
  } };
  let state = { checkout: clone(spec.lifecycle.checkout_before), files: Object.fromEntries(TARGETS.map(n => [n, { kind: 'absent' }])),
    enabled: Object.fromEntries(UNIT_NAMES.map(n => [n, 'disabled'])), active: Object.fromEntries(UNIT_NAMES.map(n => [n, 'inactive'])),
    pin: { ref: 'refs/shu251/activations/shu251-window-001', sha: OLD } };
  let journal = null, locked = false, observing = false, invocation = 'd'.repeat(32), saves = 0;
  const calls = [], faults = { before: null, after: null, save: null, saveAfter: null }, overrides = {};
  const remoteMain = () => ({ remote_sha: SHA, api_sha: SHA, tree: spec.lifecycle.approved_tree });
  const probe = () => ({ checkout_tuple: clone(state.checkout), approved_main: remoteMain(), checkout: { sha: SHA, tree: spec.lifecycle.approved_tree, clean: true }, identity: clone(identity),
    environment: clone(spec.lifecycle.environment), directories: clone(spec.lifecycle.directories), systemd_version: 255,
    capabilities: clone(spec.lifecycle.capabilities), writer_lock: locked ? (observing ? 'delegated-to-coordinator' : 'held-by-driver') : 'free',
    destination: { path: '/etc/systemd/system', canonical: '/etc/systemd/system', uid: 0, mode: 0o755, unreviewed_dropins: [] },
    evidence: { path: spec.lifecycle.evidence_dir, canonical: spec.lifecycle.evidence_dir, uid: 0, mode: 0o700, manifest: expectedManifest(spec) } });
  function effect(verb, target, perform) {
    assert.ok(locked, 'all mutations hold custody');
    assert.ok(!observing || verb === 'restart', 'non-restart mutations hold the writer lock');
    assert.ok(journal, 'backup must be durable before any mutation');
    if (verb === 'restart') assert.equal(journal.restart?.consumed, true, 'restart consumption precedes process boundary');
    else if (!['stop', 'disable', 'mask'].includes(verb) && !(verb === 'daemon-reload' && journal.entries.every(e => e.status === 'undone' || e.verb === 'pin')))
      assert.ok(journal.entries.some(e => e.target === target && (e.verb === verb || verb === 'place')), 'durable intent precedes mutation');
    calls.push({ verb, target });
    if (faults.before?.(verb, target, calls.length)) throw new Error('injected before effect');
    perform();
    if (faults.after?.(verb, target, calls.length)) throw new Error('injected after effect');
    return true;
  }
  const host = {
    remoteMain,
    recordPreflight: async () => true, resumeReceipt: async () => null, initialize: async () => true, authorize: async () => true, finalize: async () => true,
    probe: async () => overrides.probe ? overrides.probe(probe()) : probe(),
    snapshot: async () => overrides.snapshot ? overrides.snapshot(clone(state)) : clone(state),
    stage: async u => {
      const s = { path: '/private/tmp/stage', canonical: '/private/tmp/stage', temporary: true, mode: 0o700, uid: 1001, caller_uid: 1001, units: clone(u) };
      return overrides.stage ? overrides.stage(s) : s;
    },
    readiness: async () => {
      const r = { identity: clone(identity), listeners: [window.supervisor_socket], supervisor: 'ready', coordinator: 'ready',
        committed_dispatch: false, runtime_dispatch: false, invocation_id: invocation, worker: { pid: 4321, start_token: '12345' } };
      return overrides.readiness ? overrides.readiness(r) : r;
    },
    runningGateOff: async () => ({ before: {}, after: {}, ticks: 3, writes: 0, launches: 0 }),
    serviceReadiness: async () => {
      const r = await host.readiness();
      delete r.worker;
      return r;
    },
    withLock: async (fn, step) => {
      if (locked) throw Object.assign(new Error('busy'), { code: 'SHU251_WRITER_LOCK' });
      locked = true; observing = ['readiness', 'restart', 'running-gate-off'].includes(step);
      try { return await fn(); } finally { locked = false; observing = false; }
    },
    load: async () => overrides.load ? overrides.load(clone(journal)) : clone(journal),
    save: async j => {
      saves++;
      if (faults.save?.(saves, j)) throw new Error('injected journal fsync failure');
      journal = clone(j);
      if (faults.saveAfter?.(saves, j)) throw new Error('injected failure after durable save');
      return true;
    },
    place: async (target, before, after) => effect('place', target, () => {
      assert.ok(TARGETS.includes(target), 'only reviewed destinations');
      assert.deepEqual(state.files[target], before, 'atomic no-follow compare and replace');
      state.files[target] = clone(after);
    }),
    systemd: async (verb, target) => effect(verb, target, () => {
      assert.ok(['daemon-reload', 'enable', 'start', 'stop', 'disable', 'mask', 'restart'].includes(verb), 'only reviewed verbs');
      assert.ok(verb === 'daemon-reload' ? target === null : UNIT_NAMES.includes(target), 'only reviewed units');
      if (verb === 'enable') state.enabled[target] = 'enabled';
      if (verb === 'disable') state.enabled[target] = 'disabled';
      if (verb === 'mask') state.enabled[target] = 'masked';
      if (verb === 'start') state.active[target] = target === 'shu-coordinator.service' ? 'inactive' : 'active';
      if (verb === 'stop') state.active[target] = 'inactive';
      if (verb === 'daemon-reload' && canonical(state.files) === canonical(journal.prior.files)) {
        for (const n of UNIT_NAMES) if (state.enabled[n] !== 'enabled') state.enabled[n] = journal.prior.enabled[n];
      }
      if (verb === 'restart') invocation = 'e'.repeat(32);
    }),
    checkout: async (before, after) => effect('checkout', window.repo_dir, () => { assert.deepEqual(state.checkout, before); state.checkout = clone(after); }),
    pin: async (ref, before, after) => effect('pin', ref, () => {
      assert.equal(ref, state.pin.ref); assert.equal(before, state.pin.sha); state.pin.sha = after;
    }),
  };
  const io = { lifecycle: host, render: async () => clone(units), read: file => {
    assert.equal(file, spec.window_spec_path, 'preflight never reads environment values'); return Buffer.from(JSON.stringify(window));
  }, pin() { assert.fail('no legacy implicit pin'); }, run() { assert.fail('no shell binding'); } };
  return { spec, io, host, calls, faults, overrides, units, rendered, get state() { return state; }, get journal() { return journal; },
    run: (step, options = approved) => drive(step, spec, options, io), setJournal: j => { journal = clone(j); } };
}
