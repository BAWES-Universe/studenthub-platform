#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PERMITTED_SKIPS = Object.freeze({
  'SHU-227: worker owns its checkout and recovery preserves descendant commits': 'requires root or passwordless sudo for distinct-uid proof',
  'SHU-227: non-owner service account resolves revision with no global Git trust': 'requires distinct-uid execution',
  'SHU-227: empty-root main drives real Git, both real adapters and real broker through four launches': 'requires distinct-uid execution',
  'SHU-228: empty-root main drives real Git, both real adapters and real broker through four launches': 'requires distinct-uid execution',
  'SHU-241 A2 host: R1 uses the existing bundle transport through the distinct worker identity': 'host cannot switch to the fixture worker uid',
  'SHU-244 A10: distinct-root scoped handoff production workspace': 'host cannot switch worker uid',
  'SHU-71 restricted capability refusal': 'production vocabulary has no undeclared runtime/role pair',
});
export const CAPABILITIES = Object.freeze([
  ['privilege', 'SHU251_PREFLIGHT_PRIVILEGE', 'effective UID 0 or sudo -n id -u returns 0'],
  ['worker_uid', 'SHU251_PREFLIGHT_WORKER_UID', 'setpriv to fixture UID/GID 65534; id -u returns 65534; distinct from service UID'],
  ['temp', 'SHU251_PREFLIGHT_TEMP', 'service identity creates, writes, reads and removes a private temporary directory'],
  ['cvtsudoers', 'SHU251_PREFLIGHT_CVTSUDOERS', 'cvtsudoers -f json parses a temporary sudoers fixture'],
  ['user_namespaces', 'SHU251_PREFLIGHT_USER_NAMESPACES', 'service identity executes unshare --user --map-root-user /bin/true'],
  ['checkout', 'SHU251_PREFLIGHT_CHECKOUT', 'checkout owned by service UID; service identity traverses and reads every regular checkout file; no symlinks'],
  ['systemd', 'SHU251_PREFLIGHT_SYSTEMD', 'systemctl --version and systemctl show --property=Version --value succeed'],
  ['systemd_analyze', 'SHU251_PREFLIGHT_SYSTEMD_ANALYZE', 'systemd-analyze verify accepts a temporary oneshot unit'],
  ['flock', 'SHU251_PREFLIGHT_FLOCK', 'flock --nonblock on a temporary lock succeeds'],
  ['systemd_notify', 'SHU251_PREFLIGHT_SYSTEMD_NOTIFY', 'systemd-notify --version succeeds'],
  ['git', 'SHU251_PREFLIGHT_GIT', 'git --version succeeds'],
  ['bash', 'SHU251_PREFLIGHT_BASH', 'bash --noprofile --norc -c exit succeeds'],
  ['unix_socket', 'SHU251_PREFLIGHT_UNIX_SOCKET', 'service identity binds and closes a temporary Unix socket'],
  ['node', 'SHU251_PREFLIGHT_NODE', 'Node major version at least 22'],
].map(([name, code, detection]) => Object.freeze({ name, code, detection })));
export function halt(code, detail = '') { throw Object.assign(new Error(`${code}: ${detail}`), { code }); }
const run = (file, args, options = {}) => spawnSync(file, args, { encoding: 'utf8', timeout: 30000, ...options });
const successful = out => !out.error && out.status === 0;
export function hostProbe(spec, io = { run, fs, uid: () => process.getuid() }) {
  const asService = (file, args) => io.uid() === spec.service_uid ? io.run(file, args)
    : io.uid() === 0 ? io.run('/usr/bin/setpriv', [`--reuid=${spec.service_uid}`, `--regid=${spec.service_gid}`, '--clear-groups', file, ...args])
      : io.run('/usr/bin/sudo', ['-n', '-u', `#${spec.service_uid}`, '-g', `#${spec.service_gid}`, file, ...args]);
  const nodeProbe = source => successful(asService(process.execPath, ['--input-type=module', '-e', source]));
  const temporary = body => nodeProbe(`import fs from 'node:fs'; import path from 'node:path'; import net from 'node:net'; import {spawnSync} from 'node:child_process'; const dir=fs.mkdtempSync(path.join(${JSON.stringify(spec.temp_dir)},'shu251-cap-')); try { ${body} } finally { fs.rmSync(dir,{recursive:true,force:true}); }`);
  return async name => {
    switch (name) {
      case 'privilege': return io.uid() === 0 || (successful(io.run('/usr/bin/sudo', ['-n', '/usr/bin/id', '-u'])) && io.run('/usr/bin/sudo', ['-n', '/usr/bin/id', '-u']).stdout.trim() === '0');
      case 'worker_uid': {
        if (spec.service_uid === 65534) return false;
        const args = ['--reuid=65534', '--regid=65534', '--clear-groups', '/usr/bin/id', '-u'];
        const out = io.uid() === 0 ? io.run('/usr/bin/setpriv', args) : io.run('/usr/bin/sudo', ['-n', '/usr/bin/setpriv', ...args]);
        return successful(out) && out.stdout.trim() === '65534';
      }
      case 'cvtsudoers': return temporary(`const f=path.join(dir,'sudoers'); fs.writeFileSync(f,'root ALL=(ALL) ALL\\n'); const r=spawnSync('/usr/bin/cvtsudoers',['-f','json',f]); if(r.status!==0) throw Error('cvtsudoers'); JSON.parse(r.stdout);`);
      case 'user_namespaces': return successful(asService('/usr/bin/unshare', ['--user', '--map-root-user', '/bin/true']));
      case 'checkout': return io.fs.lstatSync(spec.checkout).uid === spec.service_uid && nodeProbe(`import fs from 'node:fs'; import path from 'node:path'; function visit(p){const s=fs.lstatSync(p); if(s.isSymbolicLink()) throw Error('symlink'); fs.accessSync(p,fs.constants.R_OK|(s.isDirectory()?fs.constants.X_OK:0)); if(s.isDirectory()) for(const n of fs.readdirSync(p)) { visit(path.join(p,n)); }} visit(${JSON.stringify(spec.checkout)});`);
      case 'temp': return temporary(`const f=path.join(dir,'probe'); fs.writeFileSync(f,'proof',{flag:'wx'}); if(fs.readFileSync(f,'utf8')!=='proof') throw Error('temp');`);
      case 'systemd': return successful(asService('/usr/bin/systemctl', ['--version'])) && successful(asService('/usr/bin/systemctl', ['show', '--property=Version', '--value']));
      case 'systemd_analyze': return temporary(`const f=path.join(dir,'shu251-cap.service'); fs.writeFileSync(f,'[Service]\\nType=oneshot\\nExecStart=/bin/true\\n'); if(spawnSync('/usr/bin/systemd-analyze',['verify',f]).status!==0) throw Error('systemd-analyze');`);
      case 'flock': return temporary(`if(spawnSync('/usr/bin/flock',['--nonblock',path.join(dir,'lock'),'/bin/true']).status!==0) throw Error('flock');`);
      case 'systemd_notify': return successful(asService('/usr/bin/systemd-notify', ['--version']));
      case 'git': return successful(asService('/usr/bin/git', ['--version']));
      case 'bash': return successful(asService('/bin/bash', ['--noprofile', '--norc', '-c', 'exit 0']));
      case 'unix_socket': return temporary(`const s=net.createServer(); await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(path.join(dir,'socket'),resolve)}); await new Promise((resolve,reject)=>s.close(e=>e?reject(e):resolve()));`);
      case 'node': return Number(process.versions.node.split('.')[0]) >= 22;
      default: return false;
    }
  };
}
export async function preflight(spec, probe = hostProbe(spec)) {
  if (!Number.isInteger(spec?.service_uid) || spec.service_uid <= 0 || !Number.isInteger(spec.service_gid) || spec.service_gid < 0 || !path.isAbsolute(spec.checkout ?? '') || !path.isAbsolute(spec.temp_dir ?? '')) halt('SHU251_PREFLIGHT_SPEC');
  const evidence = {};
  for (const capability of CAPABILITIES) {
    let available = false;
    try { available = await probe(capability.name) === true; } catch { /* Named refusal below includes probe exceptions. */ }
    if (!available) halt(capability.code, capability.name);
    evidence[capability.name] = 'available';
  }
  return { version: 'shu251-host-preflight-v1', capabilities: evidence };
}
export function evaluateSuite(report, expectedTests) {
  if (!Number.isInteger(expectedTests) || expectedTests < 1 || !report || !Array.isArray(report.outcomes) || report.outcomes.length !== expectedTests || report.complete !== true) halt('SHU251_SUITE_INCOMPLETE');
  const counts = { tests: 0, pass: 0, fail: 0, skipped: 0 };
  for (const outcome of report.outcomes) {
    const { name, status, reason } = outcome;
    if (typeof name !== 'string' || !name) halt('SHU251_SUITE_MALFORMED');
    if (status === 'fail') halt('SHU251_SUITE_FAILURE', name);
    if (status === 'skip' && (!Object.hasOwn(PERMITTED_SKIPS, name) || reason !== PERMITTED_SKIPS[name])) halt('SHU251_SUITE_UNPERMITTED_SKIP', `${name}: ${reason}`);
    if (!['pass', 'skip'].includes(status)) halt('SHU251_SUITE_OUTCOME', name);
    counts.tests++; counts[status === 'skip' ? 'skipped' : 'pass']++;
  }
  if (report.exit_code !== 0) halt('SHU251_SUITE_EXIT', String(report.exit_code));
  return { version: 'shu251-host-suite-v1', counts };
}
// Node's reporter protocol avoids interpreting human TAP, nested diagnostics or forged summary text.
export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const d = event.data;
      if (d.details?.type === 'suite') continue;
      yield JSON.stringify({ type: 'outcome', name: d.name, status: d.skip ? 'skip' : d.todo ? 'todo' : event.type === 'test:pass' ? 'pass' : 'fail', reason: d.skip || undefined }) + '\n';
    }
    if (event.type === 'test:summary' && event.data.file === undefined) yield JSON.stringify({ type: 'complete' }) + '\n';
  }
}
export async function runSuite(spec, io = {}) {
  const capabilities = await preflight(spec, io.probe ?? hostProbe(spec));
  if (!Array.isArray(spec.files) || !spec.files.length || spec.files.some(f => !path.isAbsolute(f) || !f.startsWith(`${spec.checkout}/`))) halt('SHU251_SUITE_FILES');
  const env = { ...process.env, TMPDIR: spec.temp_dir };
  delete env.NODE_TEST_CONTEXT;
  const result = (io.run ?? run)(process.execPath, ['--test', `--test-reporter=${import.meta.url}`, ...spec.files], { cwd: spec.checkout, timeout: 600000, maxBuffer: 32 * 1024 * 1024, env });
  let events;
  try { events = result.stdout.trim().split('\n').map(line => JSON.parse(line)); } catch { halt('SHU251_SUITE_MALFORMED'); }
  if (events.some(e => !['outcome', 'complete'].includes(e.type))) halt('SHU251_SUITE_MALFORMED');
  const summary = evaluateSuite({ outcomes: events.filter(e => e.type === 'outcome'), complete: events.at(-1)?.type === 'complete' && events.filter(e => e.type === 'complete').length === 1, exit_code: result.status }, spec.expected_tests);
  return { ...summary, preflight: capabilities };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const [action, file] = process.argv.slice(2);
    if (!['preflight', 'run'].includes(action) || !path.isAbsolute(file ?? '')) halt('SHU251_SUITE_USAGE');
    const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
    console.log(JSON.stringify(action === 'preflight' ? await preflight(spec) : await runSuite(spec)));
  } catch (error) { console.error(JSON.stringify({ ok: false, code: error.code?.startsWith('SHU251_') ? error.code : 'SHU251_SUITE_UNEXPECTED', reason: error.message })); process.exitCode = 2; }
}
