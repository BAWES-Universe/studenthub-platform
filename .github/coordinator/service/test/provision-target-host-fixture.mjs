import { fixture } from './provision-prerequisites-fixture.mjs';
import { BROKER } from '../provision-shu71-prerequisites.mjs';
export const refusal = "configuration error - unknown item 'CREATE_MAIL_SPOOL' (notify administrator)\n";
export const procNoise = "/usr/bin/find: '/proc/<pid>/task/<pid>/fd/6': No such file or directory\n/usr/bin/find: '/proc/<pid>/task/<pid>/fdinfo/6': No such file or directory\n";
export function targetFixture(t) {
  const h = fixture(t), run = h.boundary.run;
  h.remove('/run/shu71-evidence');
  h.write('/etc/login.defs', '# SYS_UID_MIN 101\n# SYS_UID_MAX 999\n# SYS_GID_MIN 101\n# SYS_GID_MAX 999\nUID_MIN 1000\nGID_MIN 1000\nCREATE_MAIL_SPOOL no\nLOG_INIT yes\n');
  h.argv = [];
  h.boundary.run = (exe, args, opts) => {
    h.argv.push([exe, [...args]]);
    if (exe === '/usr/sbin/useradd') {
      if (args.includes('-K')) return { status: 3, stdout: '', stderr: refusal };
      if (args[0] === '-D') return { status: 0, stdout: `CREATE_MAIL_SPOOL=${h.faults.mailDefault ?? 'no'}\nLOG_INIT=yes\n` };
      if (h.faults.rejectConfiguration) return { status: 3, stdout: '', stderr: refusal };
    }
    if (exe === '/usr/bin/find') {
      if (h.faults.enumeration) return { status: 1, stdout: '', stderr: '/usr/bin/find: /srv/unreadable: Permission denied\n' };
      // Interpret the shipped find expression over actual fixture paths and the
      // same inode owner map used by all other filesystem operations.
      const pruned = args.includes('-prune') ? args.flatMap((a,i)=>a==='-path'?[args[i+1]]:[]) : [];
      if (!pruned.includes('/proc')) return { status: 1, stdout: '', stderr: procNoise };
      const matches=[];
      function visit(p) {
        if(pruned.includes(p)) return;
        const s=h.f.lstatSync(p);
        if ((args.includes('-uid') && s.uid===Number(args[args.indexOf('-uid')+1])) || (args.includes('-gid') && s.gid===Number(args[args.indexOf('-gid')+1]))) matches.push(p);
        if(s.isDirectory()) for(const n of h.f.readdirSync(p)) visit(p==='/'?'/'+n:p+'/'+n);
      }
      visit('/');
      return {status:0,stdout:h.faults.inUse?'/a/file\n':matches.map(p=>p+'\n').join('')};
    }
    return run(exe,args,opts);
  };
  h.broker = () => h.users().find(u=>u.name===BROKER);
  return h;
}
