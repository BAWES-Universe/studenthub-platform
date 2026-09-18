#!/usr/bin/env node
// Closed, repository-reviewed host boundary. Importing this module performs no IO.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { resolveCvtsudoers } from './host-suite-contract.mjs';
import { renderEvidenceBroker } from './shu71-production.mjs';

export const PATHS = Object.freeze({
  checkout: '/srv/shu/studenthub-platform', tree: '/usr/local/lib/shu71/coordinator',
  sudoers: '/etc/sudoers.d/shu-reviewer', wrapper: '/usr/local/libexec/shu-reviewer-sandbox',
  unit: '/etc/systemd/system/shu71-evidence.service', receipt: '/etc/shu/shu71-prerequisites.json',
});
export const BROKER = 'shu71-evidence';
const ACCOUNT_FILES = [...['/etc/passwd', '/etc/shadow', '/etc/group', '/etc/gshadow', '/etc/subuid', '/etc/subgid'].flatMap(p => [p, p + '-']), '/etc/.pwd.lock'];
const PREFIX = '.github/coordinator/';
const need = (v, code) => { if (!v) throw Object.assign(new Error(code), { code }); };
const ENV = Object.freeze({ PATH: '/usr/sbin:/usr/bin:/sbin:/bin', LC_ALL: 'C', HOME: '/nonexistent',
  GIT_OPTIONAL_LOCKS: '0', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_NO_REPLACE_OBJECTS: '1', GIT_TERMINAL_PROMPT: '0' });
export const boundary = Object.freeze({ fs, uid: () => process.getuid(),
  run: (exe, args, opts) => spawnSync(exe, args, { encoding: 'utf8', timeout: 30000, maxBuffer: 64 * 1024 * 1024, ...opts }) });

export function provisioner(revision, b = boundary) {
  need(/^[a-f0-9]{40}$/.test(revision), 'ACT_PREREQUISITE_REVISION');
  need(b.uid() === 0, 'ACT_PROCESS_IDENTITY');
  const f = b.fs, C = f.constants;
  const command = (exe, args, options = {}) => {
    const r = b.run(exe, args, { env: ENV, ...options });
    need(!r.error && r.status === 0, 'ACT_PREREQUISITE_COMMAND');
    return Buffer.isBuffer(r.stdout) ? r.stdout : Buffer.from(r.stdout ?? '');
  };
  const git = (args, input) => { const { uid, gid } = serviceIdentity(); return command('/usr/bin/setpriv', [`--reuid=${uid}`, `--regid=${gid}`, '--clear-groups', '/usr/bin/git',
    '-c', 'core.hooksPath=/dev/null', '-c', 'credential.helper=', '-C', PATHS.checkout, ...args], { input, encoding: null }); };
  const hash = bytes => git(['hash-object', '--stdin'], bytes).toString().trim();
  const stat = p => { try { return f.lstatSync(p); } catch (e) { if (e.code === 'ENOENT') return null; throw e; } };
  function custody(p) {
    for (let current = p;; current = path.dirname(current)) {
      const s = stat(current);
      need(s?.isDirectory() && !s.isSymbolicLink() && s.uid === 0 && !(s.mode & 0o022), 'ACT_PREREQUISITE_CUSTODY');
      if (current === '/') break;
    }
  }
  function read(p) {
    custody(path.dirname(p));
    const fd = f.openSync(p, C.O_RDONLY | C.O_NOFOLLOW | C.O_NONBLOCK);
    try {
      const s = f.fstatSync(fd);
      need(s.isFile() && s.nlink === 1, 'ACT_PREREQUISITE_CUSTODY');
      return { bytes: f.readFileSync(fd).toString('base64'), mode: s.mode & 0o7777, uid: s.uid, gid: s.gid };
    } finally { f.closeSync(fd); }
  }
  function expected() {
    need(git(['rev-parse', 'HEAD']).toString().trim() === revision && git(['status', '--porcelain=v1', '--untracked-files=all']).length === 0,
      'ACT_PREREQUISITE_CHECKOUT');
    const rows = git(['ls-tree', '-r', '-z', '--full-tree', revision, '--', '.github/coordinator']).toString().split('\0').filter(Boolean);
    const entries = rows.map(row => {
      const m = /^(100644|100755) blob ([a-f0-9]{40})\t(\.github\/coordinator\/[A-Za-z0-9_./-]+)$/.exec(row);
      need(m && !m[3].split('/').some(s => s === '..' || s === '.' || !s), 'ACT_CODE_BINDING');
      if (m[3].slice(PREFIX.length).split('/').includes('test')) return null;
      const bytes = git(['cat-file', 'blob', m[2]]);
      need(hash(bytes) === m[2], 'ACT_CODE_BINDING');
      return { path: `${PATHS.tree}/${m[3].slice(PREFIX.length)}`, bytes: bytes.toString('base64'),
        mode: m[1] === '100755' ? 0o755 : 0o644, uid: 0, gid: 0, blob: m[2], kind: 'tree' };
    }).filter(Boolean);
    const source = rel => {
      const entry = entries.find(e => e.path === `${PATHS.tree}/${rel}`);
      need(entry, 'ACT_CODE_BINDING'); return entry.bytes;
    };
    need(entries.some(e => e.path === `${PATHS.tree}/service/provision-shu71-prerequisites.mjs`), 'ACT_CODE_BINDING');
    entries.push({ path: PATHS.sudoers, bytes: source('service/shu-reviewer.sudoers'), mode: 0o440, uid: 0, gid: 0, kind: 'sudoers' },
      { path: PATHS.wrapper, bytes: source('reviewer-sandbox.sh'), mode: 0o755, uid: 0, gid: 0, kind: 'wrapper' },
      { path: PATHS.unit, bytes: Buffer.from(renderEvidenceBroker()).toString('base64'), mode: 0o644, uid: 0, gid: 0, kind: 'unit' });
    return entries;
  }
  function verifyFile(e) {
    const code = suffix => e.kind === 'sudoers' ? `SHU251_SUDOERS_${suffix}` : e.kind === 'wrapper' ? 'ACT_WRAPPER_DRIFT' : `ACT_TREE_${suffix}`;
    need(e.kind !== 'sudoers' || e.path === PATHS.sudoers, 'SHU251_SUDOERS_PATH');
    need(!stat(e.path + '.shu71-pending'), 'ACT_PREREQUISITE_RESIDUE');
    need(stat(e.path), code('PATH'));
    const actual = read(e.path);
    need(actual.uid === e.uid && actual.gid === e.gid, code('OWNER'));
    need(actual.mode === e.mode, code('MODE'));
    need(actual.bytes === e.bytes && hash(Buffer.from(actual.bytes, 'base64')) === (e.blob ?? hash(Buffer.from(e.bytes, 'base64'))), code('CONTENT'));
    return { path: e.path, uid: actual.uid, gid: actual.gid, mode: actual.mode, blob: hash(Buffer.from(actual.bytes, 'base64')) };
  }
  function inventory(entries) {
    const allowed = new Set(entries.filter(e => e.kind === 'tree').map(e => e.path));
    const dirs = new Set();
    for (const p of allowed) for (let d = path.dirname(p); d.startsWith(PATHS.tree); d = path.dirname(d)) dirs.add(d);
    function visit(p) {
      const s = stat(p); need(s, 'ACT_TREE_PATH');
      if (s.isDirectory()) {
        need(dirs.has(p), 'ACT_TREE_EXTRA'); custody(p);
        for (const n of f.readdirSync(p)) visit(path.join(p, n));
      } else need(allowed.has(p), 'ACT_TREE_EXTRA');
    }
    visit(PATHS.tree);
  }
  function databases() {
    const parse = db => command('/usr/bin/getent', [db]).toString().trim().split('\n').map(row => row.split(':'));
    const users = parse('passwd').map(p => ({ name: p[0], uid: Number(p[2]), gid: Number(p[3]), home: p[5], shell: p[6] }));
    const groups = parse('group').map(p => ({ name: p[0], gid: Number(p[2]), members: p[3] }));
    need(users.every(p => p.name && Number.isInteger(p.uid) && Number.isInteger(p.gid)) && groups.every(p => p.name && Number.isInteger(p.gid)), 'ACT_IDENTITY_DATABASE');
    return { users, groups };
  }
  function serviceIdentity() {
    const { users, groups } = databases();
    const us = users.filter(u => u.name === 'shu-coordinator'), gs = groups.filter(g => g.name === 'shu-coordinator');
    need(us.length === 1 && gs.length === 1, 'ACT_SERVICE_IDENTITY_MISSING');
    need(us[0].uid > 0 && gs[0].gid > 0 && us[0].gid === gs[0].gid, 'ACT_SERVICE_IDENTITY');
    return { uid: us[0].uid, gid: gs[0].gid };
  }
  function checkout() {
    const { uid, gid } = serviceIdentity(), s = stat(PATHS.checkout);
    need(s?.isDirectory() && !s.isSymbolicLink() && s.uid === uid, 'ACT_PREREQUISITE_CHECKOUT');
    // Same read/traverse/no-symlink capability as host-suite-contract.mjs:152.
    const probe = `import fs from 'node:fs'; import path from 'node:path'; function visit(p){const s=fs.lstatSync(p); if(s.isSymbolicLink()) throw Error('symlink'); fs.accessSync(p,fs.constants.R_OK|(s.isDirectory()?fs.constants.X_OK:0)); if(s.isDirectory()) for(const n of fs.readdirSync(p)) { visit(path.join(p,n)); }} visit(${JSON.stringify(PATHS.checkout)});`;
    const r = b.run('/usr/bin/setpriv', [`--reuid=${uid}`, `--regid=${gid}`, '--clear-groups', '/usr/bin/node', '--input-type=module', '-e', probe], { env: ENV });
    need(!r.error && r.status === 0, 'ACT_PREREQUISITE_CHECKOUT_ACCESS');
    return { uid: s.uid, gid: s.gid, revision };
  }
  function identity(allowAbsent = false) {
    const { users, groups } = databases(), us = users.filter(p => p.name === BROKER), gs = groups.filter(p => p.name === BROKER);
    need(us.length <= 1 && gs.length <= 1, 'ACT_IDENTITY_COLLISION');
    const u = us[0], g = gs[0];
    need(!u || u.uid !== 996 && u.name !== 'messagebus', 'ACT_BROKER_MESSAGEBUS');
    need(!u || !users.some(p => p.name !== BROKER && p.uid === u.uid), 'ACT_BROKER_UID_COLLISION');
    need(!g || !groups.some(p => p.name !== BROKER && p.gid === g.gid), 'ACT_BROKER_GID_COLLISION');
    need(!g || !users.some(p => p.name !== BROKER && p.gid === g.gid), 'ACT_BROKER_GID_COLLISION');
    if (!u || !g) { need(allowAbsent && !u && !g, 'ACT_BROKER_IDENTITY_MISSING'); return null; }
    need(u.uid > 0 && g.gid > 0 && u.gid === g.gid && u.home === '/nonexistent' && u.shell === '/usr/sbin/nologin' && g.members === '', 'ACT_BROKER_IDENTITY');
    need(renderEvidenceBroker().includes(`\nUser=${BROKER}\nGroup=${BROKER}\n`) && !/\n(?:User|Group)=\d+\n/.test(renderEvidenceBroker()), 'ACT_BROKER_UNIT_BINDING');
    return { name: BROKER, uid: u.uid, gid: g.gid };
  }
  function allocate() {
    const db = databases(), defs = f.readFileSync('/etc/login.defs', 'utf8');
    const range = kind => {
      const val = edge => { const matches = [...defs.matchAll(new RegExp(`^\\s*SYS_${kind}_${edge}\\s+(\\d+)\\s*(?:#.*)?$`, 'gm'))];
        need(matches.length === 1, 'ACT_IDENTITY_SYSTEM_RANGE'); return Number(matches[0][1]); };
      const lo = val('MIN'), hi = val('MAX'); need(lo > 0 && hi >= lo && hi < 65534, 'ACT_IDENTITY_SYSTEM_RANGE'); return [lo, hi];
    };
    const choose = (kind, used) => { const [lo, hi] = range(kind); for (let n = lo; n <= hi; n++) if (n !== 996 && !used.has(n)) return n;
      need(false, 'ACT_IDENTITY_SYSTEM_RANGE'); };
    return { name: BROKER, uid: choose('UID', new Set(db.users.map(u => u.uid))),
      gid: choose('GID', new Set([...db.groups.map(g => g.gid), ...db.users.map(u => u.gid)])) };
  }
  function parser() {
    try { return resolveCvtsudoers(null, { fs: f, run: b.run }, PATHS.sudoers); }
    catch { need(false, 'SHU251_SUDOERS_PARSER'); }
  }
  function verify(entries) {
    inventory(entries);
    const paths = entries.map(verifyFile);
    const broker = identity(); const parsed = parser();
    return { paths, broker, parser: parsed.identity };
  }
  function syncDir(p) { const fd = f.openSync(p, C.O_RDONLY | C.O_DIRECTORY | C.O_NOFOLLOW); try { f.fsyncSync(fd); } finally { f.closeSync(fd); } }
  function write(p, value) {
    custody(path.dirname(p));
    const tmp = p + '.shu71-pending';
    need(!stat(tmp), 'ACT_PREREQUISITE_RESIDUE');
    const fd = f.openSync(tmp, C.O_WRONLY | C.O_CREAT | C.O_EXCL | C.O_NOFOLLOW, 0o600);
    try { f.writeFileSync(fd, Buffer.from(value.bytes, 'base64')); f.fchownSync(fd, value.uid, value.gid); f.fchmodSync(fd, value.mode); f.fsyncSync(fd); }
    finally { f.closeSync(fd); }
    f.renameSync(tmp, p); syncDir(path.dirname(p));
  }
  function remove(p) { if (stat(p)) { f.unlinkSync(p); syncDir(path.dirname(p)); } }
  const save = j => write(PATHS.receipt, { bytes: Buffer.from(JSON.stringify(j)).toString('base64'), uid: 0, gid: 0, mode: 0o600 });
  function load() {
    custody(path.dirname(PATHS.receipt));
    // An interrupted receipt replacement leaves the old complete write-ahead
    // record authoritative. The first record has no preceding effects.
    if (stat(PATHS.receipt + '.shu71-pending')) remove(PATHS.receipt + '.shu71-pending');
    if (!stat(PATHS.receipt)) return null;
    const r = read(PATHS.receipt);
    need(r.uid === 0 && r.gid === 0 && r.mode === 0o600, 'ACT_PREREQUISITE_RECEIPT');
    const j = JSON.parse(Buffer.from(r.bytes, 'base64').toString());
    need(j.version === 1 && j.revision === revision && Array.isArray(j.effects), 'ACT_PREREQUISITE_RECEIPT');
    const treePath = p => typeof p === 'string' && p.startsWith(PATHS.tree + '/') && /^[A-Za-z0-9_./-]+$/.test(p) && !p.split('/').some(n => n === '..' || n === '.');
    for (const e of j.effects) {
      if (e.kind === 'file') need(treePath(e.path) || [PATHS.sudoers, PATHS.wrapper, PATHS.unit].includes(e.path), 'ACT_PREREQUISITE_RECEIPT');
      else if (e.kind === 'directory') need(treePath(e.path) || [PATHS.tree, '/usr/local/lib/shu71', '/usr/local/lib', '/usr/local/libexec', '/etc/sudoers.d', '/etc/systemd', '/etc/systemd/system'].includes(e.path), 'ACT_PREREQUISITE_RECEIPT');
      else if (e.kind === 'identity') need(e.name === BROKER && Number.isInteger(e.uid) && e.uid > 0 && e.uid !== 996 && Number.isInteger(e.gid) && e.gid > 0 && JSON.stringify(e.accounts?.map(a => a.path)) === JSON.stringify(ACCOUNT_FILES), 'ACT_PREREQUISITE_RECEIPT');
      else need(false, 'ACT_PREREQUISITE_RECEIPT');
    }
    return j;
  }
  function rollback(j) {
    remove(PATHS.receipt + '.shu71-pending');
    for (const e of [...j.effects].reverse()) {
      if (e.kind === 'file') {
        remove(e.path + '.shu71-pending');
        const current = stat(e.path) ? read(e.path) : null;
        need(current === null || JSON.stringify(current) === JSON.stringify(e.before) || JSON.stringify(current) === JSON.stringify(e.after), 'ACT_ROLLBACK_FILE_DRIFT');
        if (e.before === null) remove(e.path);
        else if (!stat(e.path) || JSON.stringify(read(e.path)) !== JSON.stringify(e.before)) write(e.path, e.before);
      } else if (e.kind === 'directory') {
        if (stat(e.path)) { f.rmdirSync(e.path); syncDir(path.dirname(e.path)); }
      } else if (e.kind === 'identity') {
        const { users, groups } = databases(), u = users.find(u => u.name === BROKER), g = groups.find(g => g.name === BROKER);
        need(!u || u.uid === e.uid && u.gid === e.gid && u.home === '/nonexistent' && u.shell === '/usr/sbin/nologin', 'ACT_ROLLBACK_IDENTITY_DRIFT');
        need(!g || g.gid === e.gid && g.members === '', 'ACT_ROLLBACK_IDENTITY_DRIFT');
        // All mounted filesystems must be searchable; errors refuse deletion.
        // This also observes proc owners. No account is removed if any use is found.
        if (u || g) {
          for (const pid of f.readdirSync('/proc').filter(n => /^[0-9]+$/.test(n))) {
            let status;
            try { status = f.readFileSync(`/proc/${pid}/status`, 'utf8'); } catch (e) { if (e.code === 'ENOENT') continue; throw e; }
            const ids = status.split('\n').filter(line => /^(Uid|Gid|Groups):/.test(line)).flatMap(line => line.split(/\s+/).slice(1).filter(Boolean).map(Number));
            need(!ids.includes(e.uid) && !ids.includes(e.gid), 'ACT_ROLLBACK_IDENTITY_IN_USE');
          }
        }
        if (u || g) need(command('/usr/bin/find', ['/', '-uid', String(e.uid), '-o', '-gid', String(e.gid)]).length === 0, 'ACT_ROLLBACK_IDENTITY_IN_USE');
        if (u) command('/usr/sbin/userdel', [BROKER]);
        if (g && databases().groups.some(g => g.name === BROKER)) command('/usr/sbin/groupdel', [BROKER]);
        // Account utilities rewrite their backup files as well as the databases.
        // Restore only our insertion/deletion, refusing unrelated database edits.
        for (const account of e.accounts) {
          const current = stat(account.path) ? read(account.path) : null;
          const base = e.accounts.find(a => a.path === account.path.replace(/-$/, '')).before;
          const withoutBroker = value => Buffer.from(value?.bytes ?? '', 'base64').toString().split('\n').filter(line => !line.startsWith(BROKER + ':')).join('\n');
          need(current === null || current.bytes === account.before?.bytes || withoutBroker(current) === withoutBroker(base), 'ACT_ROLLBACK_ACCOUNT_DRIFT');
          remove(account.path + '.shu71-pending');
          if (account.before === null) remove(account.path);
          else if (JSON.stringify(current) !== JSON.stringify(account.before)) write(account.path, account.before);
        }
      }
    }
    for (const e of j.effects) {
      if (e.kind === 'file') need(!stat(e.path + '.shu71-pending') && (e.before === null ? !stat(e.path) : JSON.stringify(read(e.path)) === JSON.stringify(e.before)), 'ACT_ROLLBACK_RESIDUE');
      if (e.kind === 'directory') need(!stat(e.path), 'ACT_ROLLBACK_RESIDUE');
      if (e.kind === 'identity') {
        need(!databases().users.some(u => u.name === BROKER) && !databases().groups.some(g => g.name === BROKER), 'ACT_ROLLBACK_RESIDUE');
        for (const a of e.accounts) need(!stat(a.path + '.shu71-pending') && (a.before === null ? !stat(a.path) : JSON.stringify(read(a.path)) === JSON.stringify(a.before)), 'ACT_ROLLBACK_RESIDUE');
      }
    }
    remove(PATHS.receipt); need(!stat(PATHS.receipt), 'ACT_ROLLBACK_RESIDUE');
    return { ok: true, state: 'ROLLED_BACK', revision };
  }
  function install() {
    const old = load();
    if (old && old.state !== 'VERIFIED') return { ...rollback(old), ok: false, code: 'ACT_PREREQUISITE_INSTALL_RECOVERED' };
    const entries = expected();
    if (old) return { ok: true, state: 'ADOPTED', revision, ...verify(entries) };
    // An existing coordinator tree is adopted only as an exact complete tree.
    // It is never patched over a partial/stale installation.
    if (stat(PATHS.tree)) { inventory(entries); entries.filter(e => e.kind === 'tree').forEach(verifyFile); }
    const existing = identity(true), allocated = existing ?? allocate();
    const j = { version: 1, revision, state: 'INSTALLING', broker: allocated, effects: [] };
    save(j);
    const effect = (record, perform) => { j.effects.push(record); save(j); perform(); };
    function directory(p) {
      if (stat(p)) { custody(p); return; }
      directory(path.dirname(p));
      effect({ kind: 'directory', path: p }, () => { f.mkdirSync(p, { mode: 0o755 }); syncDir(path.dirname(p)); });
    }
    try {
      if (!existing) effect({ kind: 'identity', ...allocated, accounts: ACCOUNT_FILES.map(p => ({ path: p, before: stat(p) ? read(p) : null })) }, () => {
        const { users, groups } = databases();
        need(!users.some(u => u.uid === allocated.uid || u.name === BROKER), 'ACT_BROKER_UID_COLLISION');
        need(!groups.some(g => g.gid === allocated.gid || g.name === BROKER) && !users.some(u => u.gid === allocated.gid), 'ACT_BROKER_GID_COLLISION');
        command('/usr/sbin/groupadd', ['--system', '--gid', String(allocated.gid), BROKER]);
        command('/usr/sbin/useradd', ['--system', '--no-create-home', '--no-log-init', '-K', 'CREATE_MAIL_SPOOL=no', '--uid', String(allocated.uid), '--gid', String(allocated.gid), '--home-dir', '/nonexistent', '--shell', '/usr/sbin/nologin', BROKER]);
        const measured = identity(); need(measured.uid === allocated.uid && measured.gid === allocated.gid, 'ACT_BROKER_IDENTITY');
      });
      for (const e of entries) {
        directory(path.dirname(e.path));
        need(!stat(e.path + '.shu71-pending'), 'ACT_PREREQUISITE_RESIDUE');
        const before = stat(e.path) ? read(e.path) : null;
        if (before && before.bytes === e.bytes && before.uid === e.uid && before.gid === e.gid && before.mode === e.mode) continue;
        effect({ kind: 'file', path: e.path, before, after: { bytes: e.bytes, mode: e.mode, uid: e.uid, gid: e.gid } }, () => write(e.path, e));
      }
      const result = verify(entries); j.state = 'VERIFIED'; save(j);
      return { ok: true, state: 'VERIFIED', revision, ...result };
    } catch (error) {
      try { rollback(j); } catch { need(false, 'ACT_PREREQUISITE_ROLLBACK_REQUIRED'); }
      throw error;
    }
  }
  function precondition() {
    const report = { ok: true, revision, paths: [] };
    const check = (p, fn) => { try { report.paths.push({ path: p, ok: true, ...fn() }); }
      catch (e) { report.ok = false; report.paths.push({ path: p, ok: false, code: !e.code ? 'ACT_PREREQUISITE_MISSING' : /^(ACT_|SHU251_)[A-Z0-9_]+$/.test(e.code) ? e.code : e.code === 'ENOENT' ? 'ACT_PREREQUISITE_PATH_MISSING' : 'ACT_PREREQUISITE_MEASUREMENT' }); } };
    let entries;
    check(PATHS.checkout, () => {
      const measured = checkout(); entries = expected(); return measured;
    });
    if (entries) {
      for (const e of entries) check(e.path, () => verifyFile(e));
      check(PATHS.tree, () => { inventory(entries); return {}; });
    }
    check(PATHS.sudoers + '#parser', () => ({ parser: parser().identity }));
    check('identity:' + BROKER, () => identity());
    check(PATHS.receipt, () => {
      need(!stat(PATHS.receipt + '.shu71-pending'), 'ACT_PREREQUISITE_RESIDUE');
      const r = read(PATHS.receipt), j = JSON.parse(Buffer.from(r.bytes, 'base64'));
      need(r.uid === 0 && r.gid === 0 && r.mode === 0o600 && j.state === 'VERIFIED' && j.revision === revision, 'ACT_PREREQUISITE_RECEIPT');
      need(JSON.stringify(j.broker) === JSON.stringify(identity()), 'ACT_BROKER_IDENTITY'); return { state: j.state };
    });
    const files = [['/etc/shu/approvals/owner.pub', 0o644, 0, 0], ['/etc/shu/approvals/shu71-owner.pub', 0o600, 0, 0],
      ['/etc/shu/keys/shu71-signing.pem', 0o600, 0, 0], ['/etc/shu/supervisor.env', 0o600, 0, 0], ['/srv/shu/coordinator.env', 0o600, 'shu-coordinator', 'shu-coordinator']];
    for (const [p, mode, owner, group] of files) check(p, () => {
      const { uid, gid } = owner === 'shu-coordinator' ? serviceIdentity() : { uid: owner, gid: group };
      const r = read(p); need(r.mode === mode && r.uid === uid && r.gid === gid && r.bytes.length > 0, 'ACT_PREREQUISITE_CUSTODY'); return { uid, gid, mode };
    });
    for (const p of ['/etc/shu/approvals', '/etc/shu/keys', '/srv/shu/state/shu71-evidence']) check(p, () => { custody(p); const s = stat(p); need(s.gid === 0, 'ACT_PREREQUISITE_CUSTODY'); return { uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 }; });
    for (const p of ['/srv/shu/state/workspaces', '/srv/shu/state/workspaces/supervisor', '/srv/shu/worktrees']) check(p, () => {
      const s = stat(p);
      if (p === '/srv/shu/worktrees') {
        need(s?.isDirectory() && !s.isSymbolicLink() && (s.mode & 0o7777) === 0o3770, 'ACT_PREREQUISITE_CUSTODY');
        return { uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 };
      }
      const { uid, gid } = serviceIdentity();
      custody(p.endsWith('/supervisor') ? '/srv/shu/state' : path.dirname(p));
      if (p.endsWith('/supervisor')) { const parent = stat(path.dirname(p)); need(parent?.isDirectory() && !parent.isSymbolicLink() && parent.uid === uid && parent.gid === gid && (parent.mode & 0o7777) === 0o700, 'ACT_PREREQUISITE_CUSTODY'); }
      need(s?.isDirectory() && !s.isSymbolicLink() && s.uid === uid && s.gid === gid && (s.mode & 0o7777) === 0o700, 'ACT_PREREQUISITE_CUSTODY');
      return { uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 };
    });
    for (const ref of ['refs/heads/coordinator/SHU-140', 'refs/heads/coordinator/SHU-254']) check(ref, () => {
      const head = git(['rev-parse', '--verify', `${ref}^{commit}`]).toString().trim(); need(/^[a-f0-9]{40}$/.test(head), 'ACT_REF_BINDING'); return { head };
    });
    return report;
  }
  return { install, precondition, verify: () => verify(expected()), rollback: () => { const j = load(); return j ? rollback(j) : { ok: true, state: 'ABSENT' }; },
    // Exported closure methods are test seams only, never CLI input.
    verifyFile, identity };
}
export function parseCli(argv) {
  need(argv.length === 2 && ['install', 'verify', 'rollback', 'precondition'].includes(argv[0]) && /^[a-f0-9]{40}$/.test(argv[1]), 'ACT_COMMAND_INVALID');
  return { action: argv[0], revision: argv[1] };
}
export function runCli(argv, b = boundary, emit = value => console.log(JSON.stringify(value))) {
  try {
    const { action, revision } = parseCli(argv);
    if (['install', 'rollback'].includes(action)) {
      need(b.uid() === 0, 'ACT_PROCESS_IDENTITY');
      const script = `import { provisioner } from 'file://${PATHS.checkout}/.github/coordinator/service/provision-shu71-prerequisites.mjs'; const r = provisioner('${revision}').${action}(); console.log(JSON.stringify(r)); if(r.ok === false) process.exitCode = 2;`;
      const result = b.run('/usr/bin/flock', ['--exclusive', '--nonblock', '--no-fork', '/etc/shu', '/usr/bin/node', '--input-type=module', '-e', script], { env: ENV, timeout: 0, stdio: 'inherit' });
      need(!result.error && [0, 2].includes(result.status), 'ACT_PREREQUISITE_LOCK_OR_EXECUTION');
      return result.status;
    } else {
      const result = provisioner(revision, b)[action]();
      emit(result); return result.ok === false ? 2 : 0;
    }
  } catch (e) { emit({ ok: false, code: e.code ?? 'ACT_PREREQUISITE_FAILED' }); return 2; }
}

if (import.meta.url.startsWith('file:') && process.argv[1] === fileURLToPath(import.meta.url)) process.exitCode = runCli(process.argv.slice(2));
