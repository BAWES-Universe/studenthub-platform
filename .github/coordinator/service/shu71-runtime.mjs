// Fixed host boundary; no operator-selected paths or executable.
export const RUNTIME_CODES = Object.freeze(['ACT_RUNTIME_DIRECTORY_MISSING', 'ACT_RUNTIME_SOCKET_MISSING',
  'ACT_RUNTIME_OWNER', 'ACT_RUNTIME_GROUP', 'ACT_RUNTIME_DIRECTORY_MODE', 'ACT_RUNTIME_SOCKET_MODE',
  'ACT_RUNTIME_COORDINATOR_ACCESS', 'ACT_RUNTIME_IDENTITY']);
const need = (ok, code) => { if (!ok) throw Object.assign(new Error(code), { code }); };
export function measureBrokerRuntime(b, env) {
  const run = (exe, args, code) => {
    const r = b.run(exe, args, { env });
    need(!r.error && r.status === 0, code); return String(r.stdout ?? '').trim();
  };
  const user = run('/usr/bin/getent', ['passwd', 'shu71-evidence'], 'ACT_RUNTIME_IDENTITY').split(':');
  const group = run('/usr/bin/getent', ['group', 'shu-workspace'], 'ACT_RUNTIME_IDENTITY').split(':');
  need(user.length === 7 && user[0] === 'shu71-evidence' && /^[1-9][0-9]*$/.test(user[2])
    && group.length === 4 && group[0] === 'shu-workspace' && /^[1-9][0-9]*$/.test(group[2]), 'ACT_RUNTIME_IDENTITY');
  const rows = ['/run/shu71-evidence', '/run/shu71-evidence/fixture.sock'].map((path, i) => {
    const missing = i ? 'ACT_RUNTIME_SOCKET_MISSING' : 'ACT_RUNTIME_DIRECTORY_MISSING';
    let s; try { s = b.fs.lstatSync(path); } catch { need(false, missing); }
    need(s && !s.isSymbolicLink() && (i ? s.isSocket() : s.isDirectory()), missing);
    need(s.uid === Number(user[2]), 'ACT_RUNTIME_OWNER');
    need(s.gid === Number(group[2]), 'ACT_RUNTIME_GROUP');
    need(i ? (s.mode & 0o7777) === 0o660 : (s.mode & 0o7777) === 0o750,
      i ? 'ACT_RUNTIME_SOCKET_MODE' : 'ACT_RUNTIME_DIRECTORY_MODE');
    return { path, ok: true, runtime: 'MEASURED', uid: s.uid, gid: s.gid, mode: s.mode & 0o7777 };
  });
  // Kernel permission probe under the coordinator's NSS primary/supplementary
  // groups, including traversal of every ancestor. This does not prove connect().
  const probe = "import fs from 'node:fs'; for(const p of ['/', '/run', '/run/shu71-evidence']) { if(fs.lstatSync(p).isSymbolicLink()) throw Error('symlink'); fs.accessSync(p,fs.constants.X_OK); } fs.accessSync('/run/shu71-evidence/fixture.sock',fs.constants.R_OK|fs.constants.W_OK);";
  run('/usr/bin/setpriv', ['--reuid=shu-coordinator', '--regid=shu-coordinator', '--init-groups',
    '/usr/bin/node', '--input-type=module', '-e', probe], 'ACT_RUNTIME_COORDINATOR_ACCESS');
  return { rows, coordinator_access: 'MEASURED_TRAVERSE_READ_WRITE', kernel_connect: 'HOST_ONLY_UNPROVEN' };
}
