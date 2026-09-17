import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as contract from '../host-suite-contract.mjs';
const spec = { service_uid: 999, service_gid: 982, service_groups: [980, 982], checkout: '/fixture', temp_dir: '/fixture/tmp' };
const name = 'SHU-227: worker owns its checkout and recovery preserves descendant commits';
const reason = 'requires root or passwordless sudo for distinct-uid proof';
const covered = { names: [name], requirements: [{ name, capabilities: [{ name: 'privilege', reason }, { name: 'worker_uid', reason }] }] };
const probe = key => key === 'cvtsudoers' ? { available: true, identity: '/usr/bin/cvtsudoers.ws' } : !['privilege', 'worker_uid'].includes(key);
async function controls(api = contract) {
  let accepted;
  await assert.doesNotReject(async () => { accepted = await api.preflight(spec, probe, covered); }, 'COVERED_ABSENCE');
  assert.deepEqual(accepted.capabilities.privilege, { available: false, authorized_skips: [{ name, reason }] }, 'COVERED_ABSENCE');
  assert.deepEqual(accepted.capabilities.worker_uid, accepted.capabilities.privilege, 'WORKER_COVERED_ABSENCE');
  const result = await api.runSuite(spec, { probe, contract: async () => ({ ...covered, files: ['/fixture/test.mjs'], expected_tests: 1 }),
    run: () => ({ status: 0, stdout: JSON.stringify({ type: 'outcome', name, status: 'skip', reason }) + '\n{"type":"complete"}' }) });
  assert.deepEqual(result.counts, { tests: 1, pass: 0, fail: 0, skipped: 1 }, 'COVERED_SUITE');
  for (const capability of ['privilege', 'worker_uid']) {
    const required = { names: [name, 'uncovered proof'], requirements: [...covered.requirements, { name: 'uncovered proof', capabilities: [{ name: capability }] }] };
    await assert.rejects(() => api.preflight(spec, probe, required), error => error.code === (capability === 'privilege' ? 'SHU251_PREFLIGHT_PRIVILEGE' : 'SHU251_PREFLIGHT_WORKER_UID') && error.message.includes('uncovered proof'), 'UNCOVERED_BY_NAME');
  }
  await assert.rejects(() => api.preflight(spec, probe, { ...covered, requirements: [] }), { code: 'SHU251_PREFLIGHT_REQUIREMENTS' }, 'SHU251_PREFLIGHT_REQUIREMENTS');
  for (const change of [ { name: 'new test' }, { capabilities: [{ name: 'privilege', reason: reason + ' ' }] } ]) {
    const row = { ...covered.requirements[0], ...change };
    await assert.rejects(() => api.preflight(spec, probe, { names: [row.name], requirements: [row] }), { code: 'SHU251_PREFLIGHT_SKIP_BINDING' }, 'SHU251_PREFLIGHT_SKIP_BINDING');
  }
  await assert.rejects(() => api.preflight(spec, () => { throw Error('new failure'); }, covered), { code: 'SHU251_PREFLIGHT_PRIVILEGE' }, 'PROBE_FAILURE_NOT_SKIP');
  for (const value of [undefined, null, {}, 'missing'])
    await assert.rejects(() => api.preflight(spec, () => value, covered), { code: 'SHU251_PREFLIGHT_PRIVILEGE' }, 'MALFORMED_PROBE_NOT_SKIP');
  const ns = { names: ['M3 namespace capability control'], requirements: [{ name: 'M3 namespace capability control', capabilities: [{ name: 'user_namespaces' }] }] };
  await assert.rejects(() => api.preflight(spec, key => key === 'user_namespaces' ? false : probe(key), ns), error => error.code === 'SHU251_PREFLIGHT_USER_NAMESPACES' && error.message.includes(ns.names[0]), 'NAMESPACE_REQUIRED');
  for (const [status, why, code] of [['fail', reason, 'SHU251_SUITE_FAILURE'], ['skip', reason + ' ', 'SHU251_SUITE_UNPERMITTED_SKIP']])
    assert.throws(() => api.evaluateSuite({ complete: true, exit_code: 0, outcomes: [{ name, status, reason: why }] }, 1), { code }, 'OUTCOME_NOT_RECLASSIFIED');
}
// Reviewed requirement mapping only, not an authoritative suite inventory.
// The removed namespace startup row required user_namespaces. Its replacement
// proofs require the parser or Bash; no namespace requirement transfers to them.
test('SHU251 C2 Option A wrapper proofs have no namespace requirement', () => {
  const requirements = [
    { name: 'SHU261_NO_SETENV_POLICY', capabilities: [{ name: 'cvtsudoers' }] },
    { name: 'SHU261 wrapper contract isolates both reviewer phases and every protected class', capabilities: [] },
    { name: 'SHU261 root wrapper startup ignores PATH and BASH_ENV before parsing', capabilities: [{ name: 'bash' }] },
  ];
  const derived = contract.deriveRequirements(requirements.map(row => row.name), requirements);
  assert.deepEqual(derived.user_namespaces, []);
  assert.equal(derived.cvtsudoers[0].test, requirements[0].name);
  assert.equal(derived.bash[0].test, requirements[2].name);
});
test('SHU251 C2 derived capability positive and refusal controls', () => controls());
test('SHU251 C2 supplied identities do not imply sudo authority', async () => {
  for (const [uid, gid] of [[999, 982], [994, 979]]) {
    const calls = [];
    const p = contract.hostProbe({ ...spec, service_uid: uid, service_gid: gid }, { uid: () => uid, run: (file, args) => { calls.push([file, args]); return { status: 1, stdout: '' }; } });
    assert.equal(await p('privilege'), false); assert.equal(await p('worker_uid'), false);
    assert.ok(calls.every(([file]) => file === '/usr/bin/sudo'));
    assert.equal(await p('user_namespaces'), false);
    assert.deepEqual(calls.at(-1), ['/usr/bin/unshare', ['--user', '--map-root-user', '/bin/true']]);
  }
});
const mutations = [
  ['covered absence rejected', "if (!available && derived)", 'if (false)', 'COVERED_ABSENCE'],
  ['uncovered requirement ignored', '|| uncovered.length)', '|| false)', 'UNCOVERED_BY_NAME'],
  ['required set omitted', 'requirements.length !== names.length', 'false', 'SHU251_PREFLIGHT_REQUIREMENTS'],
  ['skip binding bypassed', "(!Object.hasOwn(PERMITTED_SKIPS, row.name) || need.reason !== PERMITTED_SKIPS[row.name])", 'false', 'SHU251_PREFLIGHT_SKIP_BINDING'],
  ['malformed probe reclassified', 'if (!available && resolved !== false)', 'if (false)', 'MALFORMED_PROBE_NOT_SKIP'],
  ['probe failure reclassified', '      halt(capability.code, capability.name);', '      available = false; resolved = false;', 'PROBE_FAILURE_NOT_SKIP'],
  ['namespace absence waived', "!['privilege', 'worker_uid'].includes(capability.name) || uncovered.length", "capability.name !== 'user_namespaces' && (!['privilege', 'worker_uid'].includes(capability.name) || uncovered.length)", 'NAMESPACE_REQUIRED'],
  ['new outcome failure accepted', "if (status === 'fail')", 'if (false)', 'OUTCOME_NOT_RECLASSIFIED'],
  ['different outcome reason accepted', 'reason !== PERMITTED_SKIPS[name]', 'false', 'OUTCOME_NOT_RECLASSIFIED'],
];
for (const [label, from, to, assertion] of mutations) test(`SHU251 C2 mutation ${label}`, async t => {
  await controls();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'c2-mutation-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mutant.mjs');
  const source = fs.readFileSync(new URL('../host-suite-contract.mjs', import.meta.url), 'utf8');
  assert.equal(source.split(from).length, 2, 'unique mutation');
  fs.writeFileSync(file, source.replace(from, to));
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0, 'syntax clean');
  const mutant = await import(pathToFileURL(file));
  await assert.rejects(() => controls(mutant), error => error.code === 'ERR_ASSERTION' && error.message.includes(assertion), assertion);
});

// Exercise the probe bodies, including their negative paths, without changing
// host configuration. Probe resources are read-only proc descriptors and ephemeral TCP sockets.
const dependencySpec = { ...spec, service_uid: process.getuid(), service_gid: process.getgid(), temp_dir: os.tmpdir() };
async function dependencyControl(api, capability, fault = '') {
  const p = api.hostProbe(dependencySpec, { uid: () => process.getuid(), run(file, args) {
    assert.equal(file, process.execPath, 'A12_DEPENDENCY_SERVICE: probe uses the service Node identity');
    assert.deepEqual(args.slice(0, -1), ['--input-type=module', '-e'], 'A12_INERT_ARGV');
    const denyWrites = `import fsGuard from 'node:fs';
      for(const key of ['mkdtempSync','mkdirSync','writeFileSync','appendFileSync','rmSync','unlinkSync','renameSync','chmodSync','utimesSync'])
        fsGuard[key]=()=>{throw Error('A12_INERT_FILESYSTEM');};
      const open=fsGuard.openSync;
      fsGuard.openSync=(file,flags,...rest)=>{if(flags!=='r')throw Error('A12_INERT_FILESYSTEM');return open(file,flags,...rest);};`;
    const source = denyWrites + args.at(-1).replace("import {spawnSync} from 'node:child_process';",
      `import {spawnSync as realSpawn} from 'node:child_process';
       const spawnSync=(file,args,options)=>{
         const permitted={'/bin/sh':['-c','exit 0'],'/usr/bin/dirname':['/suite/wrapper'],
           '/usr/bin/env':['/usr/bin/true'],'/usr/bin/chmod':['--version'],
           '/usr/bin/mktemp':['--version'],'/usr/bin/rm':['--version']};
         if(JSON.stringify(args)!==JSON.stringify(permitted[file]))throw Error('A12_INERT_ARGV');
         if(file===${JSON.stringify(fault)})return {status:1,stdout:''};
         return realSpawn(file,args,options);
       };`);
    return spawnSync(file, [...args.slice(0, -1), source], { encoding: 'utf8' });
  } });
  assert.equal(await p(capability), !fault, `A12_DEPENDENCY_PROBE: ${capability} ${fault || 'positive'}`);
}
for (const capability of ['shell_toolchain', 'linux_proc', 'loopback_socket']) {
  test(`A12 dependency ${capability} positive and named refusal`, async () => {
    await dependencyControl(contract, capability);
    const entry = contract.CAPABILITIES.find(c => c.name === capability);
    await assert.rejects(() => contract.preflight(spec, key => key === capability ? false : key === 'cvtsudoers'
      ? { available: true, identity: '/usr/bin/cvtsudoers' } : true), { code: entry.code }, 'A12_DEPENDENCY_REFUSAL');
    const p = contract.hostProbe(dependencySpec, { uid: () => process.getuid(), run: () => ({ status: 1 }) });
    assert.equal(await p(capability), false, `A12_DEPENDENCY_FAILURE: ${capability}`);
  });
  test(`A12 dependency mutation bypass ${capability}`, async t => {
    await dependencyControl(contract, capability);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a12-dependency-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    const file = path.join(dir, 'mutant.mjs');
    const source = fs.readFileSync(new URL('../host-suite-contract.mjs', import.meta.url), 'utf8');
    const anchor = `case '${capability}': return nodeProbe(`;
    assert.equal(source.split(anchor).length, 2, 'A12_DEPENDENCY_MUTATION_ANCHOR');
    fs.writeFileSync(file, source.replace(anchor, `case '${capability}': return true; return nodeProbe(`));
    const mutant = await import(pathToFileURL(file));
    const control = async api => {
      const p = api.hostProbe(dependencySpec, { uid: () => process.getuid(), run: () => ({ status: 1 }) });
      assert.equal(await p(capability), false, `A12_DEPENDENCY_FAILURE: ${capability}`);
    };
    await control(contract);
    await assert.rejects(() => control(mutant), e => e.code === 'ERR_ASSERTION' && e.message.includes('A12_DEPENDENCY_FAILURE'), 'A12_DEPENDENCY_MUTATION_KILL');
  });
}
for (const tool of ['/bin/sh', '/usr/bin/dirname', '/usr/bin/env', '/usr/bin/chmod', '/usr/bin/mktemp', '/usr/bin/rm']) {
  test(`A12 shell toolchain requires ${tool}`, () => dependencyControl(contract, 'shell_toolchain', tool));
}
for (const [label, capability, anchor, replacement, injection] of [
  ['tool exit', 'shell_toolchain', "if(r.error||r.status!==0)throw Error('shell toolchain');", '',
    "import {spawnSync} from 'node:child_process';|const spawnSync=()=>({status:1,stdout:''});"],
  ['tool spawn error', 'shell_toolchain', "if(r.error||r.status!==0)throw Error('shell toolchain');", '',
    "import {spawnSync} from 'node:child_process';|const spawnSync=()=>({status:0,error:Error('fixture'),stdout:''});"],
  ['proc content', 'linux_proc', "if(!fs.readFileSync('/proc/self/'+name).length)throw Error('proc');", "fs.readFileSync('/proc/self/'+name);",
    "import fs from 'node:fs';|import fs from 'node:fs';const read=fs.readFileSync;fs.readFileSync=(p,...a)=>['/proc/self/stat','/proc/self/cmdline','/proc/self/environ'].includes(p)?Buffer.alloc(0):read(p,...a);"],
  ['proc descriptor', 'linux_proc', "if(fs.readFileSync('/proc/self/fd/'+fd,'utf8')!==expected)throw Error('proc fd');", "fs.readFileSync('/proc/self/fd/'+fd,'utf8');",
    "import fs from 'node:fs';|import fs from 'node:fs';const read=fs.readFileSync;fs.readFileSync=(p,...a)=>String(p).startsWith('/proc/self/fd/')?'wrong':read(p,...a);"],
]) test(`A12 dependency mutation ${label} dies by named assertion`, async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a12-probe-guard-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mutant.mjs');
  const source = fs.readFileSync(new URL('../host-suite-contract.mjs', import.meta.url), 'utf8');
  assert.equal(source.split(anchor).length, 2, 'A12_DEPENDENCY_MUTATION_ANCHOR');
  fs.writeFileSync(file, source.replace(anchor, replacement));
  const mutant = await import(pathToFileURL(file));
  const control = async api => {
    const p = api.hostProbe(dependencySpec, { uid: () => process.getuid(), run(file, args) {
      const [from, to] = injection.split('|');
      return spawnSync(file, [...args.slice(0, -1), args.at(-1).replace(from, to)], { encoding: 'utf8' });
    } });
    assert.equal(await p(capability), false, `A12_DEPENDENCY_GUARD: ${label}`);
  };
  await dependencyControl(contract, capability);
  await control(contract);
  await assert.rejects(() => control(mutant), e => e.code === 'ERR_ASSERTION' && e.message.includes('A12_DEPENDENCY_GUARD'), 'A12_DEPENDENCY_MUTATION_KILL');
});
