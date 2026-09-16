// Linux production effects. Tests replace only the syscall/command boundary.
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { canonical, refuse, UNIT_NAMES } from './phase-a-driver.mjs';
import { FILES, TARGETS, DROP_IN_DIRECTORIES } from './host-lifecycle.mjs';
import { hostProbe, preflight as capabilityPreflight } from './host-suite-contract.mjs';

export const productionBoundary = Object.freeze({ fs, uid: () => process.getuid(),
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
      guard('SHU251_PROVIDER_STORAGE', v.kind === 'file' && v.uid === c.identity.uid && v.mode === 0o600);
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
    guard('SHU251_PROVIDER_CUSTODY', custody !== null && custody.every(l => identity(f.lstatSync(l.p)) === l.inode && identity(f.fstatSync(l.fd)) === l.inode));
  }
  function git(args) { return command('/usr/bin/git', ['-C', w.repo_dir, ...args]); }
  function pinValue() {
    const out = run('/usr/bin/git', ['-C', w.repo_dir, 'rev-parse', '--verify', '--quiet', ref], { env });
    guard('SHU251_PROVIDER_PIN', !out.error && (out.status === 0 && /^[a-f0-9]{40}\s*$/.test(out.stdout) || out.status === 1 && !out.stdout));
    return out.status === 1 ? null : out.stdout.trim();
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
  const provider = {
    async probe() {
      const probeSpec = { service_uid: c.identity.uid, service_gid: c.identity.gid, checkout: w.repo_dir, temp_dir: c.evidence_dir };
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
      return { checkout: { sha: git(['rev-parse', 'HEAD']), tree: git(['rev-parse', 'HEAD^{tree}']), clean: git(['status', '--porcelain', '--untracked-files=all']) === '' },
        identity: account(), environment: Object.fromEntries(Object.entries(c.environment).map(([k,v]) => [k, metadata(v.path)])),
        directories: c.directories.map(d => metadata(d.path)), systemd_version: Number(command('/usr/bin/systemctl', ['show', '--property=Version', '--value']).match(/^\d+/)?.[0]),
        capabilities: [...Object.keys(caps.capabilities), 'atomic-rename', 'directory-fsync'],
        evidence: { path: e.path, canonical: f.realpathSync(e.path), uid: e.uid, mode: e.mode, manifest: json('manifest.json') },
        destination, writer_lock: custody ? 'held-by-driver' : 'free' };
    },
    async withLock(fn) {
      guard('SHU251_WRITER_LOCK', custody === null);
      const locks = [];
      try {
        locks.push(acquire(`${w.workspace_state_dir}/host-tick.lock`));
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
        guard('SHU251_PROVIDER_STORAGE', old.kind === 'absent' || old.kind === 'file' && old.mode === 0o600 && old.uid === c.identity.uid);
        atomic(root, fd, 'journal.json', { kind: 'file', data: Buffer.from(JSON.stringify(j)).toString('base64'), mode: 0o600, uid: c.identity.uid, gid: c.identity.gid }, verify);
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
        active: Object.fromEntries(UNIT_NAMES.map(n => [n, show(n, 'ActiveState')])), pin: { ref, sha: pinValue() } };
    },
    stage(units) {
      held(); guard('SHU251_PROVIDER_ALLOWLIST', equal(Object.keys(units).sort(), [...FILES].sort()));
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
      held(); guard('SHU251_PROVIDER_ALLOWLIST', TARGETS.includes(name));
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
      const operations = { 'daemon-reload': [null], enable: ['shu-supervisor.service', 'shu-coordinator.timer'],
        start: UNIT_NAMES, restart: ['shu-supervisor.service'], stop: UNIT_NAMES, disable: UNIT_NAMES };
      guard('SHU251_PROVIDER_ARGV', Object.hasOwn(operations, verb) && operations[verb].includes(unit));
      command('/usr/bin/systemctl', unit === null ? ['daemon-reload'] : [verb, unit]); return true;
    },
    pin(target, before, after) {
      held(); guard('SHU251_PROVIDER_PIN', target === ref && sha(before) && sha(after) && pinValue() === before);
      git(after === null ? ['update-ref', '-d', ref, before ?? '0'.repeat(40)] : ['update-ref', ref, after, before ?? '0'.repeat(40)]);
      guard('SHU251_PROVIDER_PIN', pinValue() === after); return true;
    },
    readiness() {
      const pid = Number(show('shu-supervisor.service', 'MainPID'));
      guard('SHU251_PROVIDER_READINESS', Number.isSafeInteger(pid) && pid > 0);
      const status = f.readFileSync(`/proc/${pid}/status`, 'utf8');
      const ids = key => status.match(new RegExp(`^${key}:\\s+(.+)$`, 'm'))?.[1].trim().split(/\s+/).map(Number);
      const procEnv = f.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0');
      const worker = JSON.parse(command('/usr/bin/node', [fileURLToPath(new URL('./host-window-bindings.mjs', import.meta.url)), 'worker', spec.window_spec_path])).evidence;
      const transport = JSON.parse(command('/usr/bin/node', [fileURLToPath(new URL('./host-window-bindings.mjs', import.meta.url)), 'transport', spec.window_spec_path])).evidence;
      const listeners = command('/usr/bin/ss', ['--unix', '--listening', '--no-header', '--processes']);
      const socketLines = listeners.split('\n').filter(line => line.split(/\s+/).includes(w.supervisor_socket));
      const config = JSON.parse(git(['show', `${w.approved_sha}:.github/coordinator/config.json`]));
      guard('SHU251_PROVIDER_READINESS', equal(ids('Uid'), Array(4).fill(c.identity.uid)) && equal(ids('Gid'), Array(4).fill(c.identity.gid)) &&
        equal([...new Set([c.identity.gid, ...(ids('Groups') ?? [])])].sort((a,b) => a-b), c.identity.groups) &&
        socketLines.length === 1 && socketLines[0].includes(`pid=${pid},`) && transport?.ok === true && transport.stage === 'RUNNING' &&
        worker?.ok === true && worker.pid === w.fixture.pid && worker.start_token === w.fixture.start_token &&
        show('shu-supervisor.service', 'ActiveState') === 'active' && show('shu-supervisor.service', 'SubState') === 'running' &&
        show('shu-coordinator.service', 'Result') === 'success' && ['0', '2'].includes(show('shu-coordinator.service', 'ExecMainStatus')) &&
        Number(show('shu-coordinator.service', 'ExecMainExitTimestampMonotonic')) > 0 &&
        procEnv.filter(v => v.startsWith('ENABLE_DISPATCH=')).join() === 'ENABLE_DISPATCH=false' && config.enable_dispatch === false);
      return { identity: account(), listeners: [w.supervisor_socket], supervisor: 'ready', coordinator: 'ready', committed_dispatch: config.enable_dispatch,
        runtime_dispatch: false, invocation_id: show('shu-supervisor.service', 'InvocationID'), worker: { pid: worker.pid, start_token: worker.start_token } };
    },
  };
  return provider;
}
