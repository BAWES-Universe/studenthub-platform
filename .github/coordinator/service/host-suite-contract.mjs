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
  'READER operator-owned checkout read by non-root account': 'Not exercisable: non-root account, no passwordless elevation to create root-owned checkout',
});
// A capability names a host precondition required by the suite, not merely a
// binary or a test label. Its probe executes fixed argv at absolute executable
// paths as the service identity (except the explicit privilege/worker identity
// probes). A successful probe establishes only its documented detection claim;
// it does not prove every operation, host deployment, or the suite verdict.
// Added dependency probes have zero filesystem side effects: no scratch, writes,
// or removals, under watched roots or elsewhere. Existing infrastructure probes
// (temp, parser, unit verification, flock, Unix socket) retain their explicit
// temporary-resource detection claims.
// shell_toolchain groups the actual wrapper/policy dependencies: /bin/sh,
// dirname, basename, env (including PATH resolution of node and basename), true, chmod, mktemp, rm,
// touch, cat and /usr/bin/node. Restored shell fixtures retain their real tool dependencies.
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
  ['shell_toolchain', 'SHU251_PREFLIGHT_SHELL_TOOLCHAIN', 'fixed argv as service identity: /bin/sh -c exit 0, /usr/bin/dirname /suite/wrapper, /usr/bin/env /usr/bin/true, /usr/bin/env node --version (child PATH resolution), /usr/bin/env basename --version (child PATH resolution), /usr/bin/node --version, and /usr/bin/{chmod,mktemp,rm,touch,cat,basename} --version; no filesystem mutation'],
  ['linux_proc', 'SHU251_PREFLIGHT_LINUX_PROC', 'service identity reads its proc stat, cmdline, environ and inherited file descriptor'],
  ['loopback_socket', 'SHU251_PREFLIGHT_LOOPBACK_SOCKET', 'service identity binds and closes an IPv4 loopback TCP socket'],
  ['unix_socket', 'SHU251_PREFLIGHT_UNIX_SOCKET', 'service identity binds and closes a temporary Unix socket'],
  ['node', 'SHU251_PREFLIGHT_NODE', 'Node major version at least 22'],
].map(([name, code, detection]) => Object.freeze({ name, code, detection })));
export function halt(code, detail = '') { throw Object.assign(new Error(`${code}: ${detail}`), { code }); }
const run = (file, args, options = {}) => spawnSync(file, args, { encoding: 'utf8', timeout: 30000, ...options });
const successful = out => !out.error && out.status === 0;
// Ordered, literal and deliberately independent of PATH, spec and environment.
export const CVTSUDOERS_CANDIDATES = Object.freeze(['/usr/bin/cvtsudoers', '/usr/bin/cvtsudoers.ws']);
export const CVTSUDOERS_REFUSALS = Object.freeze([
  'SHU251_PREFLIGHT_CVTSUDOERS', 'SHU251_PREFLIGHT_CVTSUDOERS_AMBIGUOUS',
  'SHU251_PREFLIGHT_CVTSUDOERS_SUBSTITUTION', 'SHU251_PREFLIGHT_CVTSUDOERS_OUTPUT',
]);
// Serialized into the service-identity Node probe; IO injection is test-only.
export function resolveCvtsudoers(tempDir, io = { fs, run }, policyFile = null) {
  const fail = code => halt(`SHU251_PREFLIGHT_CVTSUDOERS${code}`);
  const present = [];
  for (const candidate of CVTSUDOERS_CANDIDATES) {
    try { present.push({ candidate, stat: io.fs.lstatSync(candidate, { bigint: true }) }); }
    catch (error) { if (error.code !== 'ENOENT') fail('_SUBSTITUTION'); }
  }
  // Even agreeing dual providers are ambiguous: never select by ordering alone.
  if (present.length > 1) fail('_AMBIGUOUS');
  if (present.length === 0) fail('');
  const { candidate, stat } = present[0];
  const identity = s => ['dev', 'ino', 'mode', 'size', 'mtimeNs', 'ctimeNs'].map(k => String(s[k])).join(':');
  const verify = () => {
    for (const other of CVTSUDOERS_CANDIDATES.filter(p => p !== candidate)) {
      try { io.fs.lstatSync(other); fail('_AMBIGUOUS'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
    if (!stat.isFile() || !(Number(stat.mode) & 0o111) || io.fs.realpathSync(candidate) !== candidate) fail('_SUBSTITUTION');
    io.fs.accessSync(candidate, io.fs.constants.X_OK);
    if (identity(io.fs.lstatSync(candidate, { bigint: true })) !== identity(stat)) fail('_SUBSTITUTION');
  };
  let fd, dir;
  try {
    verify();
    fd = io.fs.openSync(candidate, io.fs.constants.O_RDONLY | io.fs.constants.O_NOFOLLOW | io.fs.constants.O_NONBLOCK);
    if (identity(io.fs.fstatSync(fd, { bigint: true })) !== identity(stat)) fail('_SUBSTITUTION');
    dir = io.fs.mkdtempSync(path.join(tempDir, 'shu251-cap-'));
    const fixture = path.join(dir, 'sudoers');
    io.fs.writeFileSync(fixture, 'root ALL=(ALL) ALL\n', { flag: 'wx' });
    verify();
    // Execute the pinned inode, not a second pathname lookup. Only this fixed
    // inherited descriptor is executable; candidate identity remains the path.
    const result = io.run('/proc/self/fd/3', ['-f', 'json', fixture], { stdio: ['ignore', 'pipe', 'pipe', fd], env: { LC_ALL: 'C' } });
    verify(); // Recheck the approved pathname and inode metadata after execution.
    if (!successful(result)) fail('');
    let output;
    try { output = JSON.parse(result.stdout); } catch { fail('_OUTPUT'); }
    const validShape = Array.isArray(output?.User_Specs) && output.User_Specs.length === 1 &&
      Array.isArray(output.User_Specs[0]?.User_List) && output.User_Specs[0].User_List.some(u => u?.username === 'root') &&
      Array.isArray(output.User_Specs[0]?.Cmnd_Specs) && output.User_Specs[0].Cmnd_Specs.length === 1 &&
      Array.isArray(output.User_Specs[0].Cmnd_Specs[0]?.Commands) &&
      output.User_Specs[0].Cmnd_Specs[0].Commands.some(c => c?.command === 'ALL');
    if (!validShape) fail('_OUTPUT');
    if (policyFile !== null) {
      verify();
      const policyEnvironment = { LC_ALL: 'C' };
      const policy = io.run("/proc/self/fd/3", ['-f', 'json', policyFile], { stdio: ['ignore', 'pipe', 'pipe', fd], env: policyEnvironment });
      verify();
      if (!successful(policy)) fail('');
      let parsed;
      try { parsed = JSON.parse(policy.stdout); } catch (error) { fail('_OUTPUT'); }
      return { available: true, identity: String(candidate), parsed };
    }
    return { available: true, identity: candidate };
  } catch (error) {
    if (CVTSUDOERS_REFUSALS.includes(error.code)) throw error;
    fail('_SUBSTITUTION');
  } finally {
    if (fd !== undefined) io.fs.closeSync(fd);
    if (dir !== undefined) io.fs.rmSync(dir, { recursive: true, force: true });
  }
}
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
      case 'cvtsudoers': {
        const source = `import fs from 'node:fs'; import path from 'node:path'; import {spawnSync} from 'node:child_process';
          const CVTSUDOERS_CANDIDATES=Object.freeze(${JSON.stringify(CVTSUDOERS_CANDIDATES)});
          const CVTSUDOERS_REFUSALS=${JSON.stringify(CVTSUDOERS_REFUSALS)};
          const run=${run.toString()}; const successful=${successful.toString()};
          ${halt.toString()} ${resolveCvtsudoers.toString()}
          try { console.log(JSON.stringify(resolveCvtsudoers(${JSON.stringify(spec.temp_dir)}))); }
          catch(e) { console.log(JSON.stringify({code:CVTSUDOERS_REFUSALS.includes(e.code)?e.code:'SHU251_PREFLIGHT_CVTSUDOERS'})); process.exitCode=2; }`;
        const result = asService(process.execPath, ['--input-type=module', '-e', source]);
        let value;
        try { value = JSON.parse(result.stdout); } catch { halt('SHU251_PREFLIGHT_CVTSUDOERS_OUTPUT'); }
        if (CVTSUDOERS_REFUSALS.includes(value?.code)) halt(value.code);
        if (!successful(result)) halt('SHU251_PREFLIGHT_CVTSUDOERS');
        if (value?.available !== true || !CVTSUDOERS_CANDIDATES.includes(value.identity)) halt('SHU251_PREFLIGHT_CVTSUDOERS_SUBSTITUTION');
        return value;
      }
      case 'user_namespaces': return successful(asService('/usr/bin/unshare', ['--user', '--map-root-user', '/bin/true']));
      case 'checkout': return io.fs.lstatSync(spec.checkout).uid === spec.service_uid && nodeProbe(`import fs from 'node:fs'; import path from 'node:path'; function visit(p){const s=fs.lstatSync(p); if(s.isSymbolicLink()) throw Error('symlink'); fs.accessSync(p,fs.constants.R_OK|(s.isDirectory()?fs.constants.X_OK:0)); if(s.isDirectory()) for(const n of fs.readdirSync(p)) { visit(path.join(p,n)); }} visit(${JSON.stringify(spec.checkout)});`);
      case 'temp': return temporary(`const f=path.join(dir,'probe'); fs.writeFileSync(f,'proof',{flag:'wx'}); if(fs.readFileSync(f,'utf8')!=='proof') throw Error('temp');`);
      case 'systemd': return successful(asService('/usr/bin/systemctl', ['--version'])) && successful(asService('/usr/bin/systemctl', ['show', '--property=Version', '--value']));
      case 'systemd_analyze': return temporary(`const f=path.join(dir,'shu251-cap.service'); fs.writeFileSync(f,'[Service]\\nType=oneshot\\nExecStart=/bin/true\\n'); if(spawnSync('/usr/bin/systemd-analyze',['verify',f]).status!==0) throw Error('systemd-analyze');`);
      case 'flock': return temporary(`if(spawnSync('/usr/bin/flock',['--nonblock',path.join(dir,'lock'),'/bin/true']).status!==0) throw Error('flock');`);
      case 'systemd_notify': return successful(asService('/usr/bin/systemd-notify', ['--version']));
      case 'git': return successful(asService('/usr/bin/git', ['--version']));
      case 'bash': return successful(asService('/bin/bash', ['--noprofile', '--norc', '-c', 'exit 0']));
      case 'shell_toolchain': return nodeProbe(`
        import {spawnSync} from 'node:child_process';
        const invoke=(file,args)=>{const r=spawnSync(file,args,{encoding:'utf8'});if(r.error||r.status!==0)throw Error('shell toolchain');return r.stdout;};
        invoke('/bin/sh',['-c','exit 0']);
        invoke('/usr/bin/dirname',['/suite/wrapper']);
        invoke('/usr/bin/env',['/usr/bin/true']);
        invoke('/usr/bin/chmod',['--version']);
        invoke('/usr/bin/mktemp',['--version']);
        invoke('/usr/bin/rm',['--version']);
        invoke('/usr/bin/touch',['--version']);
        invoke('/usr/bin/cat',['--version']);
        invoke('/usr/bin/env',['node','--version']);
        invoke('/usr/bin/basename',['--version']);
        invoke('/usr/bin/env',['basename','--version']);
        invoke('/usr/bin/node',['--version']);
      `);
      case 'linux_proc': return nodeProbe(`
        import fs from 'node:fs';
        for(const name of ['stat','cmdline','environ'])if(!fs.readFileSync('/proc/self/'+name).length)throw Error('proc');
        const fd=fs.openSync('/proc/version','r');const expected=fs.readFileSync('/proc/version','utf8');
        try{if(fs.readFileSync('/proc/self/fd/'+fd,'utf8')!==expected)throw Error('proc fd');}finally{fs.closeSync(fd);}
      `);
      case 'loopback_socket': return nodeProbe(`import net from 'node:net'; const s=net.createServer(); await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(0,'127.0.0.1',resolve)}); await new Promise((resolve,reject)=>s.close(e=>e?reject(e):resolve()));`);
      case 'unix_socket': return temporary(`const s=net.createServer(); await new Promise((resolve,reject)=>{s.once('error',reject);s.listen(path.join(dir,'socket'),resolve)}); await new Promise((resolve,reject)=>s.close(e=>e?reject(e):resolve()));`);
      case 'node': return Number(process.versions.node.split('.')[0]) >= 22;
      default: return false;
    }
  };
}
// Requirements are reviewed with the exact revision-pinned inventory, never
// supplied by the runner caller. Empty capability lists must be explicit.
export function deriveRequirements(names, requirements) {
  const fail = detail => halt('SHU251_PREFLIGHT_REQUIREMENTS', detail);
  if (!Array.isArray(names) || !names.length || !Array.isArray(requirements) ||
      requirements.length !== names.length) fail('exact required test set');
  const remaining = [...names];
  const derived = Object.fromEntries(CAPABILITIES.map(c => [c.name, []]));
  for (const row of requirements) {
    const index = remaining.indexOf(row?.name);
    if (index < 0 || !Array.isArray(row.capabilities)) fail(String(row?.name));
    remaining.splice(index, 1);
    const seen = new Set();
    for (const need of row.capabilities) {
      if (!need || !Object.hasOwn(derived, need.name) || seen.has(need.name)) fail(row.name);
      seen.add(need.name);
      if (Object.hasOwn(need, 'reason') &&
          (!Object.hasOwn(PERMITTED_SKIPS, row.name) || need.reason !== PERMITTED_SKIPS[row.name]))
        halt('SHU251_PREFLIGHT_SKIP_BINDING', row.name);
      derived[need.name].push({ ...need, test: row.name });
    }
  }
  return derived;
}
export async function preflight(spec, probe = hostProbe(spec), requiredSet) {
  if (!Number.isInteger(spec?.service_uid) || spec.service_uid <= 0 || !Number.isInteger(spec.service_gid) || spec.service_gid < 0 || !path.isAbsolute(spec.checkout ?? '') || !path.isAbsolute(spec.temp_dir ?? '')) halt('SHU251_PREFLIGHT_SPEC');
  if (requiredSet === null) halt('SHU251_PREFLIGHT_REQUIREMENTS', 'exact required test set');
  const derived = requiredSet === undefined ? null : deriveRequirements(requiredSet.names, requiredSet.requirements);
  const evidence = {};
  for (const capability of CAPABILITIES) {
    // Inventory-derived absence is not an authorized test skip. Do not execute
    // an unrelated probe (including one that throws) as a suite prerequisite.
    if (derived && derived[capability.name].length === 0) {
      evidence[capability.name] = { required: false };
      continue;
    }
    let available = false;
    let resolved;
    try {
      resolved = await probe(capability.name);
      available = capability.name === 'cvtsudoers'
        ? resolved?.available === true && CVTSUDOERS_CANDIDATES.includes(resolved.identity)
        : resolved === true;
    } catch (error) {
      if (capability.name === 'cvtsudoers' && CVTSUDOERS_REFUSALS.includes(error.code)) throw error;
      // An exception is a new failure, not evidence of an authorized absence.
      halt(capability.code, capability.name);
    }
    if (!available && resolved !== false) halt(capability.code, capability.name);
    if (!available && derived) {
      const needs = derived[capability.name];
      const uncovered = needs.filter(need => !Object.hasOwn(need, 'reason'));
      // Required capabilities other than the two identity proofs have no skip allowance.
      if (!['privilege', 'worker_uid'].includes(capability.name) || uncovered.length)
        halt(capability.code, uncovered.map(need => need.test).join(', ') || capability.name);
      evidence[capability.name] = { available: false, authorized_skips: needs.map(need => ({ name: need.test, reason: PERMITTED_SKIPS[need.test] })) };
      continue;
    }
    if (!available) halt(capability.code, capability.name);
    evidence[capability.name] = capability.name === 'cvtsudoers' ? resolved : 'available';
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
export function suiteNames(outcomes, names) {
  const sorted = values => JSON.stringify([...values].sort());
  if (!Array.isArray(names) || sorted(outcomes.map(o => o.name)) !== sorted(names)) halt('SHU251_SUITE_NAMES');
}
// Node's reporter protocol avoids interpreting human TAP, nested diagnostics or forged summary text.
export default async function* reporter(source) {
  for await (const event of source) {
    if (event.type === 'test:pass' || event.type === 'test:fail') {
      const d = event.data;
      if (d.details?.type === 'suite') continue;
      yield JSON.stringify({ type: 'outcome', name: d.name, status: event.type === 'test:fail' ? 'fail' : d.skip ? 'skip' : d.todo ? 'todo' : 'pass', reason: d.skip || undefined }) + '\n';
    }
    if (event.type === 'test:summary' && event.data.file === undefined) yield JSON.stringify({ type: 'complete' }) + '\n';
  }
}
export async function runSuite(spec, io = {}) {
  const contract = await (io.contract ?? (async () => {
    const { bindSuite, suiteQuiescence } = await import('./suite-runner-spec.mjs');
    const { verifyDisposableSuite, recordDisposableSuite } = await import('./disposable-suite.mjs');
    verifyDisposableSuite(spec);
    const bound = bindSuite(spec);
    return { ...bound, quiescence: suiteQuiescence(), record: recordDisposableSuite.bind(null, spec) };
  }))();
  const capabilities = await preflight(spec, io.probe ?? hostProbe(spec), contract.requirements === undefined ? undefined : contract);
  spec = { ...spec, files: contract.files, expected_tests: contract.expected_tests };
  if (!Array.isArray(spec.files) || !spec.files.length || spec.files.some(f => !path.isAbsolute(f) || !f.startsWith(`${spec.checkout}/`))) halt('SHU251_SUITE_FILES');
  const env = { ...process.env, TMPDIR: spec.temp_dir };
  delete env.NODE_TEST_CONTEXT;
  const result = (io.run ?? run)(process.execPath, ['--test', `--test-reporter=${import.meta.url}`, ...spec.files], { cwd: spec.checkout, timeout: 600000, maxBuffer: 32 * 1024 * 1024, env });
  let events;
  try { events = result.stdout.trim().split('\n').map(line => JSON.parse(line)); } catch { halt('SHU251_SUITE_MALFORMED'); }
  if (events.some(e => !['outcome', 'complete'].includes(e.type))) halt('SHU251_SUITE_MALFORMED');
  const outcomes = events.filter(e => e.type === 'outcome');
  const summary = evaluateSuite({ outcomes: events.filter(e => e.type === 'outcome'), complete: events.at(-1)?.type === 'complete' && events.filter(e => e.type === 'complete').length === 1, exit_code: result.status }, spec.expected_tests);
  suiteNames(outcomes, contract.names);
  const receipt = { ...summary, preflight: capabilities, identity: contract.identity, quiescence: contract.quiescence,
    ...(contract.binding ? { binding: contract.binding } : {}) };
  if (contract.record) await contract.record(receipt);
  return receipt;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  // Let this module finish evaluation before cyclic CLI imports settle.
  void (async () => {
    try {
      const [action, file] = process.argv.slice(2);
      if (!['preflight', 'run', 'measure', 'create', 'remove'].includes(action) || !path.isAbsolute(file ?? '')) halt('SHU251_SUITE_USAGE');
      const spec = JSON.parse(fs.readFileSync(file, 'utf8'));
      let result;
      if (action === 'preflight') result = await preflight(spec, hostProbe(spec), (await import('./suite-runner-spec.mjs')).bindSuite(spec));
      else if (action === 'run') result = await runSuite(spec);
      else if (action === 'measure') result = (await import('./suite-runner-spec.mjs')).measureSuite(spec);
      else {
        const lifecycle = await import('./disposable-suite.mjs');
        result = action === 'create' ? lifecycle.createDisposableSuite(spec) : lifecycle.removeDisposableSuite(spec);
      }
      console.log(JSON.stringify(result));
    } catch (error) { console.error(JSON.stringify({ ok: false, code: error.code?.startsWith('SHU251_') ? error.code : 'SHU251_SUITE_UNEXPECTED', reason: error.message })); process.exitCode = 2; }
  })();
}
