// Linux production effects. Tests replace only the syscall/command boundary.
import fs from 'node:fs';
import path from 'node:path';
import { verify as verifySignature } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical, hash, refuse, UNIT_NAMES, LIFECYCLE_ACTIONS } from './phase-a-driver.mjs';
import { FILES, TARGETS, DROP_IN_DIRECTORIES, approvedCheckout, expectedManifest } from './host-lifecycle.mjs';
import { hostProbe, preflight as capabilityPreflight } from './host-suite-contract.mjs';

export const productionBoundary = Object.freeze({ fs, uid: () => process.getuid(), now: () => Date.now(), apiEnv: () => ({ GH_TOKEN: process.env.GH_TOKEN }), wait: ms => new Promise(resolve => setTimeout(resolve, ms)),
  run: (file, args, options) => spawnSync(file, args, { encoding: 'utf8', timeout: 30000, ...options }) });
function guard(code, condition) { if (!condition) refuse(code); }
const equal = (a, b) => canonical(a) === canonical(b);
const identity = s => `${s.dev}:${s.ino}`;
const mode = s => s.mode & 0o777;
const sha = s => s === null || /^[a-f0-9]{40}$/.test(s);

export function createProductionLifecycle(spec, boundary = productionBoundary) {
  const { fs: f, run, uid } = boundary, c = spec.lifecycle, w = spec.window;
  guard('SHU251_PROVIDER_SCOPE', /^[a-z0-9][a-z0-9-]{7,63}$/.test(c.activation_id) &&
    path.isAbsolute(c.evidence_root) && path.normalize(c.evidence_root) === c.evidence_root &&
    c.evidence_dir === `${c.evidence_root}/${c.activation_id}` && w.unit_directory === '/etc/systemd/system');
  guard('SHU251_PREFLIGHT_PRIVILEGE', uid() === 0);
  const ref = `refs/shu251/activations/${c.activation_id}`, C = f.constants;
  let custody = null;
  const env = { PATH: '/usr/bin:/bin', LC_ALL: 'C', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'safe.directory', GIT_CONFIG_VALUE_0: w.repo_dir };
  function command(file, args, options = {}) {
    const result = run(file, args, { env, ...options });
    guard('SHU251_PROVIDER_COMMAND', !result.error && result.status === 0);
    return result.stdout.trim();
  }
  function stat(p) { try { return f.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } }
  // Every ancestor is inspected. Operations below pinned directory descriptors
  // cannot be redirected by swapping a pathname between check and syscall.
  function directory(p, fn) {
    guard('SHU251_PROVIDER_PATH', path.isAbsolute(p) && path.normalize(p) === p);
    let current = '/';
    for (const component of p.split('/').filter(Boolean)) {
      current = path.join(current, component);
      const s = stat(current);
      guard('SHU251_PROVIDER_PATH', s?.isDirectory() && !s.isSymbolicLink() && !(mode(s) & 0o022));
    }
    const before = f.lstatSync(p), fd = f.openSync(p, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW);
    const verify = () => guard('SHU251_PROVIDER_SUBSTITUTION', identity(f.fstatSync(fd)) === identity(before) &&
      identity(f.lstatSync(p)) === identity(before) && f.realpathSync(p) === p);
    try { verify(); const result = fn(`/proc/self/fd/${fd}`, fd, verify); verify(); return result; }
    finally { f.closeSync(fd); }
  }
  function item(p) {
    const s = stat(p);
    if (!s) return { kind: 'absent' };
    const meta = { uid: s.uid, gid: s.gid };
    if (s.isSymbolicLink()) {
      const target = f.readlinkSync(p);
      guard('SHU251_PROVIDER_SYMLINK', target === '/dev/null');
      return { kind: 'symlink', target, ...meta };
    }
    if (s.isDirectory()) return { kind: 'directory', ...meta, mode: mode(s) };
    guard('SHU251_PROVIDER_FILE', s.isFile() && s.nlink === 1);
    const fd = f.openSync(p, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    try {
      guard('SHU251_PROVIDER_SUBSTITUTION', identity(f.fstatSync(fd)) === identity(s));
      const data = f.readFileSync(fd).toString('base64');
      guard('SHU251_PROVIDER_SUBSTITUTION', identity(f.lstatSync(p)) === identity(s));
      return { kind: 'file', data, mode: mode(s), ...meta };
    } finally { f.closeSync(fd); }
  }
  const evidence = fn => directory(c.evidence_dir, fn);
  function json(name) {
    return evidence(root => {
      const v = item(`${root}/${name}`);
      if (v.kind === 'absent') return null;
      guard('SHU251_PROVIDER_STORAGE', v.kind === 'file' && v.uid === 0 && v.gid === 0 && v.mode === 0o600);
      return JSON.parse(Buffer.from(v.data, 'base64').toString());
    });
  }
  function atomic(root, fd, name, value, verify) {
    const temp = `${root}/.shu251-${name}-${process.pid}`;
    let handle;
    try {
      if (value.kind === 'symlink') f.symlinkSync(value.target, temp);
      else {
        handle = f.openSync(temp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, value.mode);
        f.writeFileSync(handle, Buffer.from(value.data, 'base64'));
        f.fchownSync(handle, value.uid, value.gid); f.fchmodSync(handle, value.mode);
        f.fsyncSync(handle); f.closeSync(handle); handle = undefined;
      }
      verify(); f.renameSync(temp, `${root}/${name}`); f.fsyncSync(fd);
    } finally {
      if (handle !== undefined) f.closeSync(handle);
      if (stat(temp)) f.unlinkSync(temp);
    }
  }
  function acquire(p) {
    return directory(path.dirname(p), (root, dirfd, verify) => {
      const file = `${root}/${path.basename(p)}`, s = stat(file);
      guard('SHU251_WRITER_LOCK', s?.isFile() && s.nlink === 1 && !(mode(s) & 0o022));
      const fd = f.openSync(file, C.O_RDWR | C.O_NOFOLLOW);
      try {
        guard('SHU251_PROVIDER_SUBSTITUTION', identity(f.fstatSync(fd)) === identity(s));
        // flock(2) locks the inherited open-file description. The parent's fd
        // retains custody after this child exits; close in finally releases it.
        const r = run('/usr/bin/flock', ['--exclusive', '--nonblock', '3'], { env, stdio: ['ignore', 'pipe', 'pipe', fd] });
        guard('SHU251_WRITER_LOCK', !r.error && r.status === 0);
        verify();
        return { fd, p, inode: identity(s) };
      } catch (e) { f.closeSync(fd); throw e; }
    });
  }
  function held() {
    guard('SHU251_PROVIDER_CUSTODY', custody !== null && custody.some(l => l.p === `${c.evidence_dir}/journal.lock`) && custody.every(l => identity(f.lstatSync(l.p)) === l.inode && identity(f.fstatSync(l.fd)) === l.inode));
  }
  function writerHeld() {
    held();
    guard('SHU251_PROVIDER_CUSTODY', custody.some(l => l.p === `${w.workspace_state_dir}/host-tick.lock`));
  }
  function git(args) { return command('/usr/bin/git', ['-C', w.repo_dir, ...args]); }
  function pinValue() {
    const out = run('/usr/bin/git', ['-C', w.repo_dir, 'rev-parse', '--verify', '--quiet', ref], { env });
    guard('SHU251_PROVIDER_PIN', !out.error && (out.status === 0 && /^[a-f0-9]{40}\s*$/.test(out.stdout) || out.status === 1 && !out.stdout));
    return out.status === 1 ? null : out.stdout.trim();
  }
  function remoteMain() {
    guard('SHU251_CHECKOUT_REMOTE', /^https:\/\/github\.com\/BAWES-Universe\/studenthub-platform(?:\.git)?$/.test(w.remote_url));
    const remote = git(['ls-remote', '--exit-code', w.remote_url, 'refs/heads/main']);
    const api = command('/usr/bin/gh', ['api', 'repos/BAWES-Universe/studenthub-platform/commits/main', '--jq', '[.sha,.commit.tree.sha]|@tsv'],
      { env: { ...env, ...(boundary.apiEnv?.() ?? {}) } });
    guard('SHU251_CHECKOUT_REMOTE', remote === `${w.approved_sha}\trefs/heads/main` && api === `${w.approved_sha}\t${c.approved_tree}`);
    return { remote_sha: remote.split('\t')[0], api_sha: api.split('\t')[0], tree: api.split('\t')[1] };
  }
  function checkoutTuple() {
    const head = run('/usr/bin/git', ['-C', w.repo_dir, 'symbolic-ref', '--quiet', 'HEAD'], { env });
    guard('SHU251_PROVIDER_CHECKOUT', !head.error && (head.status === 0 && head.stdout.trim() === 'refs/heads/main' || head.status === 1 && !head.stdout));
    return { sha: git(['rev-parse', 'HEAD']), head_ref: head.status === 0 ? head.stdout.trim() : null,
      main: git(['rev-parse', 'refs/heads/main']), origin_main: git(['rev-parse', 'refs/remotes/origin/main']),
      tree: git(['rev-parse', 'HEAD^{tree}']), clean: git(['status', '--porcelain', '--untracked-files=all']) === '' };
  }
  function account() {
    return { user: command('/usr/bin/id', ['-un', c.identity.user]), group: command('/usr/bin/id', ['-gn', c.identity.user]),
      uid: Number(command('/usr/bin/id', ['-u', c.identity.user])), gid: Number(command('/usr/bin/id', ['-g', c.identity.user])),
      groups: command('/usr/bin/id', ['-G', c.identity.user]).split(/\s+/).map(Number).sort((a,b) => a-b) };
  }
  function metadata(p) {
    return directory(path.dirname(p), root => {
      const s = f.lstatSync(`${root}/${path.basename(p)}`);
      return { path: p, kind: s.isFile() ? 'file' : s.isDirectory() ? 'directory' : 'other', uid: s.uid, gid: s.gid, mode: mode(s) };
    });
  }
  const show = (unit, property) => command('/usr/bin/systemctl', ['show', unit, `--property=${property}`, '--value']);
  function approval() {
    const artifact = directory('/etc/shu/approvals', root => item(`${root}/${c.activation_id}.json`));
    guard('SHU251_APPROVAL_CUSTODY', artifact.kind === 'file' && artifact.uid === 0 && artifact.gid === 0 && artifact.mode === 0o600);
    const bytes = Buffer.from(artifact.data, 'base64');
    guard('SHU251_APPROVAL_DIGEST', hash(bytes) === c.approval_sha256);
    const envelope = JSON.parse(bytes.toString('utf8'));
    const key = directory('/etc/shu/approvals', root => item(`${root}/owner.pub`));
    let authentic = false;
    try {
      authentic = key.kind === 'file' && key.uid === 0 && key.gid === 0 && key.mode === 0o644 &&
        equal(Object.keys(envelope).sort(), ['payload', 'signature']) &&
        verifySignature(null, Buffer.from(canonical(envelope.payload)), Buffer.from(key.data, 'base64'), Buffer.from(envelope.signature, 'base64'));
    } catch { /* Never expose key or artifact parser diagnostics. */ }
    guard('SHU251_APPROVAL_SIGNATURE', authentic);
    const a = envelope.payload;
    const bound = structuredClone(spec); delete bound.lifecycle.approval_sha256;
    guard('SHU251_APPROVAL_BINDING', equal(Object.keys(a).sort(), ['version', 'spec_sha256', 'not_before', 'expires_at', 'operations', 'teardown'].sort()) &&
      a.version === 'shu251-owner-approval-v1' && a.spec_sha256 === hash(canonical(bound)) &&
      Number.isSafeInteger(a.not_before) && Number.isSafeInteger(a.expires_at) && a.not_before < a.expires_at &&
      Array.isArray(a.operations) && a.operations.length > 0 && a.operations.every(s => Object.hasOwn(LIFECYCLE_ACTIONS, s) && s !== 'preflight') &&
      ['restore', 'retain'].includes(a.teardown));
    return a;
  }
  function storeJSON(name, value) {
    return evidence((root, fd, verify) => {
      atomic(root, fd, name, { kind: 'file', data: Buffer.from(JSON.stringify(value)).toString('base64'), uid: 0, gid: 0, mode: 0o600 }, verify);
      return true;
    });
  }
  function stateInventory() {
    const roots = [...new Set([w.workspace_state_dir, w.supervisor_state_dir])];
    const entries = {};
    const visit = p => {
      const s = f.lstatSync(p);
      guard('SHU251_PROVIDER_GATE_OFF', !s.isSymbolicLink());
      if (s.isDirectory()) {
        entries[p] = { directory: true, mtime: s.mtimeMs, ctime: s.ctimeMs };
        for (const child of f.readdirSync(p).sort()) visit(`${p}/${child}`);
      } else if (s.isFile()) entries[p] = { sha256: hash(f.readFileSync(p)), size: s.size, mtime: s.mtimeMs, ctime: s.ctimeMs };
      else guard('SHU251_PROVIDER_GATE_OFF', s.isSocket());
    };
    roots.forEach(visit);
    return entries;
  }
  let gateObservation = null;
  function observeState() {
    const roots = [...new Set([w.workspace_state_dir, w.supervisor_state_dir])];
    // One registration covers both roots, including baseline construction.
    // No command, await, or action runs between registrations of separate roots.
    let ancestor = roots[0];
    while (ancestor !== '/' && !roots.every(root => root === ancestor || root.startsWith(`${ancestor}/`))) ancestor = path.dirname(ancestor);
    let writes = 0, watchError = false;
    const watcher = f.watch(ancestor, { recursive: true }, (event, filename) => {
      if (filename == null) { watchError = true; return; }
      const changed = path.resolve(ancestor, String(filename));
      if (roots.some(root => changed === root || changed.startsWith(`${root}/`) || root.startsWith(`${changed}/`))) writes++;
    });
    watcher.on('error', () => { watchError = true; });
    const inventory = stateInventory;
    try {
      const before = inventory();
      return { before, inventory, get writes() { return writes; }, get watchError() { return watchError; },
        async check() {
          const after = inventory();
          await boundary.wait(0);
          guard('SHU251_PROVIDER_GATE_OFF', !watchError && writes === 0 && equal(before, after));
        },
        close() { watcher.close(); } };
    } catch (error) { watcher.close(); throw error; }
  }
  const provider = {
    // Start records this under writer custody. Gate-off compares it before
    // preflight, so even a write before watch registration cannot become a
    // fresh trusted baseline. Directory timestamps include create/delete pairs.
    gateOffBaseline(before) {
      if (before === undefined) { writerHeld(); return stateInventory(); }
      held();
      guard('SHU251_PROVIDER_GATE_OFF', gateObservation !== null && equal(before, gateObservation.before));
      return true;
    },
    async observeGateOff(fn) {
      guard('SHU251_PROVIDER_GATE_OFF', gateObservation === null);
      const observation = observeState();
      gateObservation = observation;
      try {
        const result = await fn();
        // Deliver queued watch events, including transient writes during the
        // final synchronous evidence commands, before acknowledging success.
        await observation.check();
        return result;
      } finally { gateObservation = null; observation.close(); }
    },
    initialize(step) {
      const a = approval();
      guard('SHU251_APPROVAL_TIME', ['host-rollback', 'pin-restore', 'pin-retain'].includes(step) || boundary.now() >= a.not_before && boundary.now() < a.expires_at);
      directory(c.evidence_root, (root, fd) => {
        guard('SHU251_APPROVAL_CUSTODY', f.fstatSync(fd).uid === 0);
        if (!stat(`${root}/${c.activation_id}`)) {
          f.mkdirSync(`${root}/${c.activation_id}`, { mode: 0o700 }); f.fsyncSync(fd);
        }
      });
      evidence((root, fd, verify) => {
        const s = f.fstatSync(fd);
        guard('SHU251_APPROVAL_CUSTODY', s.uid === 0 && s.gid === 0 && mode(s) === 0o700);
        if (!stat(`${root}/journal.lock`)) atomic(root, fd, 'journal.lock', { kind: 'file', data: '', uid: 0, gid: 0, mode: 0o600 }, verify);
      });
      const existing = json('manifest.json');
      guard('SHU251_APPROVAL_BINDING', existing === null || equal(existing, expectedManifest(spec)));
      if (existing === null) storeJSON('manifest.json', expectedManifest(spec));
      return true;
    },
    authorize(step, journal) {
      const a = approval();
      const cleanup = ['host-rollback', 'pin-restore', 'pin-retain'].includes(step);
      guard('SHU251_APPROVAL_TIME', cleanup || boundary.now() >= a.not_before && boundary.now() < a.expires_at);
      guard('SHU251_APPROVAL_ORDER', step === 'preflight' || cleanup || a.operations[(journal?.receipts ?? []).length] === step || journal?.receipts.at(-1)?.step === step && json('archive.json')?.journal_sha256 !== hash(canonical(journal)));
      guard('SHU251_APPROVAL_TEARDOWN', step !== 'pin-restore' && step !== 'pin-retain' || step === 'pin-retain' && !journal?.rolled_back || step === `pin-${a.teardown}`);
      return true;
    },
    recordPreflight(result) { return provider.withLock(() => storeJSON('preflight.json', result)); },
    resumeReceipt(step, journal) {
      held();
      if (step === 'restart' || journal?.receipts.at(-1)?.step !== step || json('archive.json')?.journal_sha256 === hash(canonical(journal))) return null;
      const prior = journal.receipts.at(-1);
      const expected = { ...(prior.evidence.after.state ?? prior.evidence.after.service?.state ?? prior.evidence.after) };
      delete expected.approved_main;
      guard('SHU251_PROVIDER_COMPARE', equal(provider.snapshot(), expected));
      return prior;
    },
    finalize(journal) {
      held();
      const receipts = journal.receipts.map(r => ({ step: r.step, sha256: hash(canonical(r)) }));
      return storeJSON('archive.json', { version: 'shu251-evidence-archive-v1', manifest: expectedManifest(spec),
        journal_sha256: hash(canonical(journal)), preflight_sha256: hash(canonical(json('preflight.json'))), receipts, rolled_back: journal.rolled_back });
    },
    remoteMain,
    async probe() {
      const approved_main = remoteMain();
      const probeSpec = { service_uid: c.identity.uid, service_gid: c.identity.gid, checkout: w.repo_dir, temp_dir: w.workspace_state_dir };
      const caps = await capabilityPreflight(probeSpec, hostProbe(probeSpec, boundary));
      // Prove file+directory fsync and rename on this actual evidence filesystem.
      evidence((root, fd, verify) => {
        atomic(root, fd, 'durability-probe', { kind: 'file', data: Buffer.from('proof').toString('base64'), uid: c.identity.uid, gid: c.identity.gid, mode: 0o600 }, verify);
        f.unlinkSync(`${root}/durability-probe`); f.fsyncSync(fd);
      });
      if (custody) held(); else { const l = acquire(`${w.workspace_state_dir}/host-tick.lock`); f.closeSync(l.fd); }
      const destination = directory(w.unit_directory, root => {
        const unreviewed = [];
        for (const n of DROP_IN_DIRECTORIES) if (stat(`${root}/${n}`)) directory(`${w.unit_directory}/${n}`, d => {
          for (const child of f.readdirSync(d)) if (child !== '10-shu251.conf') unreviewed.push(`${n}/${child}`);
        });
        const s = f.lstatSync(root);
        return { path: w.unit_directory, canonical: f.realpathSync(root), uid: s.uid, mode: mode(s), unreviewed_dropins: unreviewed };
      });
      const e = metadata(c.evidence_dir);
      return { approved_main, checkout_tuple: checkoutTuple(), checkout: { sha: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']), clean: git(['status', '--porcelain', '--untracked-files=all']) === '' },
        identity: account(), environment: Object.fromEntries(Object.entries(c.environment).map(([k,v]) => [k, metadata(v.path)])),
        directories: c.directories.map(d => metadata(d.path)), systemd_version: Number(command('/usr/bin/systemctl', ['show', '--property=Version', '--value']).match(/^\d+/)?.[0]),
        capabilities: [...Object.keys(caps.capabilities), 'atomic-rename', 'directory-fsync'],
        evidence: { path: e.path, canonical: f.realpathSync(e.path), uid: e.uid, mode: e.mode, manifest: json('manifest.json') },
        destination, writer_lock: custody ? (custody.some(l => l.p === `${w.workspace_state_dir}/host-tick.lock`) ? 'held-by-driver' : 'delegated-to-coordinator') : 'free' };
    },
    async withLock(fn, step) {
      guard('SHU251_WRITER_LOCK', custody === null);
      const locks = [];
      try {
        // Never contend with scheduled ticks during any complete observation
        // step, including network preflight and durable evidence finalization.
        if (!['readiness', 'restart', 'running-gate-off'].includes(step)) locks.push(acquire(`${w.workspace_state_dir}/host-tick.lock`));
        locks.push(acquire(`${c.evidence_dir}/journal.lock`)); custody = locks;
        return await fn();
      } finally { custody = null; for (const l of locks.reverse()) f.closeSync(l.fd); }
    },
    load() { held(); return json('journal.json'); },
    save(j) {
      held();
      guard('SHU251_PROVIDER_STORAGE', j.binding?.activation_id === c.activation_id);
      return evidence((root, fd, verify) => {
        const old = item(`${root}/journal.json`);
        guard('SHU251_PROVIDER_STORAGE', old.kind === 'absent' || old.kind === 'file' && old.mode === 0o600 && old.uid === 0 && old.gid === 0);
        atomic(root, fd, 'journal.json', { kind: 'file', data: Buffer.from(JSON.stringify(j)).toString('base64'), mode: 0o600, uid: 0, gid: 0 }, verify);
        return true;
      });
    },
    snapshot() {
      const files = {};
      directory(w.unit_directory, root => {
        for (const name of TARGETS) {
          const parent = path.dirname(name);
          files[name] = parent === '.' ? item(`${root}/${name}`) : files[parent]?.kind === 'absent' ? { kind: 'absent' }
            : directory(`${w.unit_directory}/${parent}`, d => item(`${d}/${path.basename(name)}`));
        }
      });
      return { files, enabled: Object.fromEntries(UNIT_NAMES.map(n => [n, show(n, 'UnitFileState') || 'not-found'])),
        active: Object.fromEntries(UNIT_NAMES.map(n => [n, show(n, 'ActiveState')])), checkout: checkoutTuple(), pin: { ref, sha: pinValue() } };
    },
    stage(units) {
      writerHeld(); guard('SHU251_PROVIDER_ALLOWLIST', equal(Object.keys(units).sort(), [...FILES].sort()));
      return evidence(root => {
        const dir = f.mkdtempSync(`${root}/stage-`); f.chmodSync(dir, 0o700);
        try {
          const observed = {};
          for (const [i,n] of FILES.entries()) {
            const p = `${dir}/${i}`; f.writeFileSync(p, units[n], { flag: 'wx', mode: 0o600 }); observed[n] = f.readFileSync(p, 'utf8');
          }
          const s = f.lstatSync(dir), real = f.realpathSync(dir);
          return { temporary: true, path: real, canonical: real, uid: s.uid, caller_uid: uid(), mode: mode(s), units: observed };
        } finally { f.rmSync(dir, { recursive: true }); }
      });
    },
    place(name, before, after) {
      writerHeld(); guard('SHU251_PROVIDER_ALLOWLIST', TARGETS.includes(name));
      const p = `${w.unit_directory}/${name}`;
      return directory(path.dirname(p), (root, fd, verify) => {
        const base = path.basename(p), dest = `${root}/${base}`, original = stat(dest);
        guard('SHU251_PROVIDER_COMPARE', equal(item(dest), before));
        const unchanged = () => {
          verify(); guard('SHU251_PROVIDER_SUBSTITUTION', identity(stat(dest) ?? {}) === identity(original ?? {}));
          guard('SHU251_PROVIDER_COMPARE', equal(item(dest), before));
        };
        guard('SHU251_PROVIDER_ALLOWLIST', after.kind === 'absent' || DROP_IN_DIRECTORIES.includes(name) && after.kind === 'directory' ||
          FILES.includes(name) && (after.kind === 'file' || after.kind === 'symlink' && after.target === '/dev/null'));
        if (after.kind === 'absent') {
          unchanged(); if (original?.isDirectory()) f.rmdirSync(dest); else if (original) f.unlinkSync(dest); f.fsyncSync(fd);
        } else if (after.kind === 'directory') {
          unchanged(); if (!original) f.mkdirSync(dest, { mode: after.mode });
          directory(p, (d, child) => { f.fchownSync(child, after.uid, after.gid); f.fchmodSync(child, after.mode); f.fsyncSync(child); }); f.fsyncSync(fd);
        } else atomic(root, fd, base, after, unchanged);
        verify(); guard('SHU251_PROVIDER_COMPARE', equal(item(dest), after)); return true;
      });
    },
    systemd(verb, unit) {
      held();
      if (verb !== 'restart' || unit !== 'shu-supervisor.service') writerHeld();
      const operations = { 'daemon-reload': [null], enable: ['shu-supervisor.service', 'shu-coordinator.timer'],
        start: UNIT_NAMES, restart: ['shu-supervisor.service'], stop: UNIT_NAMES, disable: UNIT_NAMES };
      guard('SHU251_PROVIDER_ARGV', Object.hasOwn(operations, verb) && operations[verb].includes(unit));
      if (verb === 'start' && unit === 'shu-coordinator.service') {
        // Keep journal custody while the coordinator acquires its own writer
        // lock. A successful systemctl call (including SuccessExitStatus=2)
        // does not prove the tick ran.
        const previous = Number(show(unit, 'ExecMainExitTimestampMonotonic'));
        const writer = custody.shift();
        f.closeSync(writer.fd);
        try {
          command('/usr/bin/systemctl', [verb, unit]);
          guard('SHU251_PROVIDER_TICK', show(unit, 'Result') === 'success' && show(unit, 'ExecMainStatus') === '0' &&
            Number(show(unit, 'ExecMainExitTimestampMonotonic')) > previous && show(unit, 'ActiveState') === 'inactive');
        } finally { custody.unshift(acquire(`${w.workspace_state_dir}/host-tick.lock`)); }
      } else command('/usr/bin/systemctl', unit === null ? ['daemon-reload'] : [verb, unit]);
      return true;
    },
    checkout(before, after) {
      writerHeld();
      guard('SHU251_PROVIDER_CHECKOUT', equal(after, approvedCheckout(spec)) || equal(after, c.checkout_before));
      const detached = { ...before, sha: after.sha, tree: after.tree, head_ref: null };
      const updated = { ...after, head_ref: null };
      let current = checkoutTuple();
      // All intermediate command-boundary states are derivable from the
      // durable intent. No reset --hard, force checkout or unconditional ref
      // overwrite is permitted, including recovery after a process exit.
      guard('SHU251_CHECKOUT_CAS', [before, detached, updated, after].some(v => equal(current, v)));
      if (equal(current, after)) return true;
      if (equal(current, before)) {
        if (equal(after, approvedCheckout(spec))) {
          remoteMain();
          git(['fetch', '--no-tags', '--no-write-fetch-head', w.remote_url, w.approved_sha]);
          remoteMain();
        }
        guard('SHU251_CHECKOUT_TREE', git(['rev-parse', `${after.sha}^{tree}`]) === after.tree);
        git(['checkout', '--detach', after.sha]);
        current = checkoutTuple();
        guard('SHU251_CHECKOUT_CAS', equal(current, detached));
      }
      if (equal(current, detached)) {
        command('/usr/bin/git', ['-C', w.repo_dir, 'update-ref', '--stdin'], { input:
          `start\noption no-deref\nverify HEAD ${after.sha}\nupdate refs/heads/main ${after.main} ${before.main}\nupdate refs/remotes/origin/main ${after.origin_main} ${before.origin_main}\nprepare\ncommit\n` });
        current = checkoutTuple();
        guard('SHU251_CHECKOUT_CAS', equal(current, updated));
      }
      if (after.head_ref !== null) git(['checkout', 'main']);
      guard('SHU251_CHECKOUT_CAS', equal(checkoutTuple(), after));
      return true;
    },
    pin(target, before, after) {
      writerHeld(); guard('SHU251_PROVIDER_PIN', target === ref && sha(before) && sha(after) && pinValue() === before);
      git(after === null ? ['update-ref', '-d', ref, before ?? '0'.repeat(40)] : ['update-ref', ref, after, before ?? '0'.repeat(40)]);
      guard('SHU251_PROVIDER_PIN', pinValue() === after); return true;
    },
    async runningGateOff() {
      held();
      const observation = gateObservation ?? observeState();
      const { before, inventory } = observation;
      let writer;
      try {
        let last = Number(show('shu-coordinator.service', 'ExecMainExitTimestampMonotonic')), ticks = 0;
        // Direct writer-custody callers still hand off for polling. The
        // complete running-gate-off action already has journal-only custody.
        if (custody[0].p === `${w.workspace_state_dir}/host-tick.lock`) {
          writer = custody.shift(); f.closeSync(writer.fd);
        }
        for (let polls = 0; polls < 240 && ticks < 3; polls++) {
          await boundary.wait(1000);
          guard('SHU251_PROVIDER_GATE_OFF', show('shu-supervisor.service', 'ActiveState') === 'active' &&
            show('shu-coordinator.timer', 'ActiveState') === 'active');
          const completed = Number(show('shu-coordinator.service', 'ExecMainExitTimestampMonotonic'));
          if (completed > last) {
            guard('SHU251_PROVIDER_GATE_OFF', show('shu-coordinator.service', 'Result') === 'success' &&
              show('shu-coordinator.service', 'ExecMainStatus') === '0');
            ticks++; last = completed;
          }
        }
        provider.serviceReadiness();
        const pid = Number(show('shu-supervisor.service', 'MainPID'));
        const children = f.readFileSync(`/proc/${pid}/task/${pid}/children`, 'utf8').trim();
        const after = inventory();
        const { writes, watchError } = observation;
        guard('SHU251_PROVIDER_GATE_OFF', ticks === 3 && !watchError && writes === 0 && children === '' && equal(before, after));
        return { before, after, ticks, writes, launches: 0 };
      } finally {
        if (observation !== gateObservation) observation.close();
        if (writer) custody.unshift(acquire(`${w.workspace_state_dir}/host-tick.lock`));
      }
    },
    serviceReadiness() {
      const pid = Number(show('shu-supervisor.service', 'MainPID'));
      guard('SHU251_PROVIDER_READINESS', Number.isSafeInteger(pid) && pid > 0);
      const status = f.readFileSync(`/proc/${pid}/status`, 'utf8');
      const ids = key => status.match(new RegExp(`^${key}:\\s+(.+)$`, 'm'))?.[1].trim().split(/\s+/).map(Number);
      const procEnv = f.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      const listeners = command('/usr/bin/ss', ['--unix', '--listening', '--no-header', '--processes']);
      const socketLines = listeners.split('\n').filter(line => line.split(/\s+/).includes(w.supervisor_socket));
      const config = JSON.parse(git(['show', `${w.approved_sha}:.github/coordinator/config.json`]));
      guard('SHU251_PROVIDER_READINESS', equal(ids('Uid'), Array(4).fill(c.identity.uid)) && equal(ids('Gid'), Array(4).fill(c.identity.gid)) &&
        equal([...new Set([c.identity.gid, ...(ids('Groups') ?? [])])].sort((a,b) => a-b), c.identity.groups) &&
        socketLines.length === 1 && socketLines[0].includes(`pid=${pid},`) &&
        show('shu-supervisor.service', 'ActiveState') === 'active' && show('shu-supervisor.service', 'SubState') === 'running' &&
        show('shu-coordinator.service', 'Result') === 'success' && show('shu-coordinator.service', 'ExecMainStatus') === '0' &&
        Number(show('shu-coordinator.service', 'ExecMainExitTimestampMonotonic')) > 0 &&
        procEnv.filter(v => v.startsWith('ENABLE_DISPATCH=')).join() === 'ENABLE_DISPATCH=false' && config.enable_dispatch === false);
      return { identity: account(), listeners: [w.supervisor_socket], supervisor: 'ready', coordinator: 'ready', committed_dispatch: config.enable_dispatch,
        runtime_dispatch: false, invocation_id: show('shu-supervisor.service', 'InvocationID') };
    },
    readiness() {
      const service = provider.serviceReadiness();
      const worker = JSON.parse(command('/usr/bin/node', [fileURLToPath(new URL('./host-window-bindings.mjs', import.meta.url)), 'worker', spec.window_spec_path])).evidence;
      const transport = JSON.parse(command('/usr/bin/node', [fileURLToPath(new URL('./host-window-bindings.mjs', import.meta.url)), 'transport', spec.window_spec_path])).evidence;
      guard('SHU251_PROVIDER_READINESS', transport?.ok === true && transport.stage === 'RUNNING' &&
        worker?.ok === true && worker.pid === w.fixture.pid && worker.start_token === w.fixture.start_token);
      return { ...service, worker: { pid: worker.pid, start_token: worker.start_token } };
    },
  };
  return provider;
}
