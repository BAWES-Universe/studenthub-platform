import fs from 'node:fs';
import os from 'node:os';
import vm from 'node:vm';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { PATHS, BROKER } from '../provision-shu71-prerequisites.mjs';
export const revision = 'a'.repeat(40);
export const blob = bytes => createHash('sha1').update(`blob ${Buffer.byteLength(bytes)}\0`).update(bytes).digest('hex');
export function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-provision-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const owners = new Map(), handles = new Map(), events = [], faults = {};
  const local = p => typeof p === 'number' ? p : root + p;
  const logical = p => typeof p === 'number' ? handles.get(p) : p;
  const effect = (name, fn) => { events.push(name); if (faults.before?.(name)) throw Error('INJECTED'); const r = fn(); if (faults.after?.(name)) throw Error('INJECTED'); return r; };
  const s = (p, st) => new Proxy(st, { get(target, key) {
    if (logical(p) === '/run/shu71-evidence' || logical(p) === '/run/shu71-evidence/fixture.sock') {
      if (key === 'uid') return users.find(u => u.name === BROKER)?.uid ?? 0;
      if (key === 'gid') return groups.find(g => g.name === 'shu-workspace')?.gid ?? 0;
      if (key === 'isSocket') return () => logical(p).endsWith('/fixture.sock');
    }
    if (key === 'uid' || key === 'gid') return (owners.get(logical(p)) ?? [0, 0])[key === 'uid' ? 0 : 1];
    const v = target[key]; return typeof v === 'function' ? v.bind(target) : v;
  } });
  const f = { constants: fs.constants,
    lstatSync: (p, opts) => s(p, fs.lstatSync(local(p), opts)), fstatSync: (fd, opts) => s(fd, fs.fstatSync(fd, opts)),
    readFileSync: (p, encoding) => fs.readFileSync(local(p), encoding), readdirSync: p => fs.readdirSync(local(p)),
    realpathSync: p => fs.realpathSync(local(p)).slice(root.length), accessSync: (p, mode) => fs.accessSync(local(p), mode),
    openSync(p, flags, mode) { const fd = fs.openSync(local(p), flags, mode); handles.set(fd, p); return fd; },
    closeSync(fd) { handles.delete(fd); fs.closeSync(fd); },
    writeFileSync: (p, data) => effect(`write:${logical(p)}`, () => fs.writeFileSync(local(p), data)),
    fchownSync: (fd, uid, gid) => effect(`chown:${logical(fd)}`, () => owners.set(logical(fd), [uid, gid])),
    fchmodSync: (fd, mode) => effect(`chmod:${logical(fd)}`, () => fs.fchmodSync(fd, mode)),
    fsyncSync: fd => effect(`fsync:${logical(fd)}`, () => {}),
    mkdirSync: (p, opts) => effect(`mkdir:${p}`, () => fs.mkdirSync(local(p), opts)),
    rmdirSync: p => effect(`rmdir:${p}`, () => fs.rmdirSync(local(p))),
    unlinkSync: p => effect(`unlink:${p}`, () => { fs.unlinkSync(local(p)); owners.delete(p); }),
    renameSync: (a, b) => effect(`rename:${b}`, () => { fs.renameSync(local(a), local(b)); owners.set(b, owners.get(a) ?? [0, 0]); owners.delete(a); }),
  };
  function directory(p, mode = 0o755, uid = 0, gid = 0) { fs.mkdirSync(local(p), { recursive: true, mode }); fs.chmodSync(local(p), mode); owners.set(p, [uid, gid]); }
  function write(p, bytes, mode = 0o644, uid = 0, gid = 0) { fs.mkdirSync(path.dirname(local(p)), { recursive: true, mode: 0o755 }); if (fs.existsSync(local(p))) fs.chmodSync(local(p), 0o600); fs.writeFileSync(local(p), bytes); fs.chmodSync(local(p), mode); owners.set(p, [uid, gid]); }
  const sources = new Map([
    ['service/provision-shu71-prerequisites.mjs', Buffer.from('reviewed entrypoint')],
    ['service/shu71-production.mjs', Buffer.from('reviewed production')],
    ['service/shu-reviewer.sudoers', fs.readFileSync(new URL('../shu-reviewer.sudoers', import.meta.url))],
    ['reviewer-sandbox.sh', fs.readFileSync(new URL('../../reviewer-sandbox.sh', import.meta.url))],
    ['test/excluded.test.mjs', Buffer.from('not production')],
  ]);
  let users = [{ name: 'messagebus', uid: 996, gid: 998, home: '/nonexistent', shell: '/usr/sbin/nologin' }];
  let groups = [{ name: 'messagebus', gid: 998, members: '' }, { name: 'shu-coordinator', gid: 982, members: '' }, { name: 'shu-workspace', gid: 980, members: 'shu-coordinator' }];
  users.push({ name: 'shu-coordinator', uid: 999, gid: 982, home: '/nonexistent', shell: '/usr/sbin/nologin' });
  function accountBytes() { return {
    '/etc/passwd': users.map(u => `${u.name}:x:${u.uid}:${u.gid}::${u.home}:${u.shell}`).join('\n') + '\n',
    '/etc/group': groups.map(g => `${g.name}:x:${g.gid}:${g.members}`).join('\n') + '\n',
    '/etc/shadow': users.map(u => `${u.name}:!:20000:0:99999:7:::`).join('\n') + '\n',
    '/etc/gshadow': groups.map(g => `${g.name}:!::`).join('\n') + '\n',
  }; }
  const run = (exe, args, opts = {}) => {
    let stdout = ''; let status = 0;
    if (exe === '/usr/bin/setpriv' && args.includes('/usr/bin/node')) {
      const uid = Number(args[0].split('=')[1]), gid = Number(args[1].split('=')[1]);
      const probeFS = { ...f, accessSync(p, requested) {
        const st = f.lstatSync(p), shift = st.uid === uid ? 6 : st.gid === gid ? 3 : 0;
        if (((st.mode >> shift) & requested) !== requested) throw Error('EACCES');
      } };
      try { vm.runInNewContext(args.at(-1).replace(/import .*?; /g, ''), {fs: probeFS, path}); }
      catch { status = 1; }
    } else if (exe === '/usr/bin/setpriv') {
      const a = args.slice(args.indexOf('-C') + 2), verb = a[0];
      if (verb === 'rev-parse') stdout = revision;
      else if (verb === 'status') stdout = '';
      else if (verb === 'ls-tree') stdout = [...sources].map(([p, bytes]) => `${p.endsWith('.sh') ? '100755' : '100644'} blob ${blob(bytes)}\t.github/coordinator/${p}\0`).join('');
      else if (verb === 'cat-file') stdout = [...sources.values()].find(bytes => blob(bytes) === a[2]);
      else if (verb === 'hash-object') stdout = blob(opts.input);
      else throw Error('unexpected git ' + args);
    } else if (exe === '/usr/bin/id') stdout = groups.filter(g => g.members.split(',').includes(args[1]) || g.gid === users.find(u => u.name === args[1])?.gid).map(g => g.name).join(' ');
    else if (exe === '/usr/bin/getent') stdout = args[0] === 'passwd'
      ? users.map(u => `${u.name}:x:${u.uid}:${u.gid}::${u.home}:${u.shell}`).join('\n')
      : groups.map(g => `${g.name}:x:${g.gid}:${g.members}`).join('\n');
    else if (exe === '/proc/self/fd/3') {
      events.push('parser:' + args.at(-1));
      if (faults.parser) status = 1;
      stdout = JSON.stringify({ User_Specs: [{ User_List: [{ username: 'root' }], Cmnd_Specs: [{ Commands: [{ command: 'ALL' }] }] }] });
    } else if (exe === '/usr/bin/find') stdout = faults.inUse ? '/a/file\n' : '';
    else effect('command:' + exe, () => {
      const prior = accountBytes(); write('/etc/.pwd.lock', '', 0o600);
      if (exe === '/usr/sbin/groupadd') groups.push({ name: BROKER, gid: Number(args[2]), members: '' });
      else if (exe === '/usr/sbin/useradd') users.push({ name: BROKER, uid: Number(args[args.indexOf('--uid') + 1]), gid: Number(args[args.indexOf('--gid') + 1]), home: '/nonexistent', shell: '/usr/sbin/nologin' });
      else if (exe === '/usr/sbin/userdel') users = users.filter(u => u.name !== BROKER);
      else if (exe === '/usr/sbin/groupdel') groups = groups.filter(g => g.name !== BROKER);
      else throw Error('unexpected command ' + exe);
      for (const [p, bytes] of Object.entries(accountBytes())) if (prior[p] !== bytes) { write(p + '-', prior[p], p.includes('shadow') ? 0o600 : 0o644); write(p, bytes, p.includes('shadow') ? 0o600 : 0o644); }
    });
    return { status, stdout };
  };
  directory('/run/shu71-evidence', 0o750); write('/run/shu71-evidence/fixture.sock', '', 0o660);
  directory('/proc'); directory('/etc/shu'); directory('/etc/sudoers.d'); directory('/etc/systemd/system'); directory('/usr/local/libexec');
  directory(PATHS.checkout, 0o755, 999, 982);
  for (const [p, bytes] of Object.entries(accountBytes())) write(p, bytes, p.includes('shadow') ? 0o600 : 0o644);
  write('/etc/passwd-', 'old exact backup\n', 0o600);
  write('/etc/login.defs', 'SYS_UID_MIN 100\nSYS_UID_MAX 999\nSYS_GID_MIN 100\nSYS_GID_MAX 999\n');
  write('/usr/bin/cvtsudoers.ws', 'parser double', 0o755);
  write('/etc/sudoers.d/shu-reviewer-sandbox', 'unrelated', 0o440);
  write(PATHS.wrapper, 'old wrapper', 0o750, 12, 13);
  for (const p of ['/etc/shu/approvals/owner.pub', '/etc/shu/approvals/shu71-owner.pub', '/etc/shu/keys/shu71-activation-ed25519.pem', '/etc/shu/supervisor.env']) write(p, 'private fixture', p.endsWith('/owner.pub') ? 0o644 : 0o600);
  write('/srv/shu/coordinator.env', 'private fixture', 0o600, 999, 982);
  directory('/srv/shu/state/shu71-evidence'); directory('/srv/shu/state/workspaces', 0o700, 999, 982);
  directory('/srv/shu/state/workspaces/supervisor', 0o700, 999, 982); directory('/srv/shu/worktrees', 0o3770, 999, 980);
  function snapshot() {
    const result = {};
    function visit(p) { const st = f.lstatSync(p); result[p] = { mode: st.mode & 0o7777, uid: st.uid, gid: st.gid, ...(st.isFile() ? { bytes: f.readFileSync(p).toString('base64') } : {}) };
      if (st.isDirectory()) for (const n of f.readdirSync(p)) visit(path.posix.join(p, n)); }
    visit('/'); return { files: result, users: structuredClone(users), groups: structuredClone(groups) };
  }
  return { boundary: { fs: f, run, uid: () => 0 }, root, f, write, directory, owners, events, faults, sources, snapshot,
    users: () => users, groups: () => groups, remove: p => fs.rmSync(local(p), { recursive: true, force: true }) };
}
