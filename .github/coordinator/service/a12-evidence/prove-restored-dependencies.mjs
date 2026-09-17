// Repository-only controls; local current uid is the fixture service identity.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { hostProbe } from '../host-suite-contract.mjs';
const base = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('host-suite-contract.mjs', base), 'utf8');
const testSource = fs.readFileSync(new URL('test/capability-requirements.test.mjs', base), 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a12-restored-'));
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
try {
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test/capability-requirements.test.mjs'), testSource);
  const run = text => {
    fs.writeFileSync(path.join(root, 'host-suite-contract.mjs'), text);
    assert.equal(spawnSync(process.execPath, ['--check', path.join(root, 'host-suite-contract.mjs')], { env }).status, 0, 'A12_MUTANT_SYNTAX');
    return spawnSync(process.execPath, ['--test', '--test-name-pattern=^A12 dependency shell_toolchain positive and named refusal$', path.join(root, 'test/capability-requirements.test.mjs')], { env, encoding: 'utf8' });
  };
  assert.equal(run(source).status, 0, 'A12_RESTORED_POSITIVE');
  console.log('A12_RESTORED_POSITIVE: pass');
  for (const [label, from, to, assertion] of [
    ['capability entry omitted', source.split('\n').find(line => line.startsWith("  ['shell_toolchain',")), '', 'A12_DEPENDENCY_ENTRY'],
    ['service detection omitted', 'fixed argv as service identity:', 'fixed argv:', 'A12_SHELL_DETECTION'],
    ['touch omitted', "invoke('/usr/bin/touch',['--version']);", '', 'A12_DEPENDENCY_PROBE: shell_toolchain /usr/bin/touch'],
    ['cat omitted', "invoke('/usr/bin/cat',['--version']);", '', 'A12_DEPENDENCY_PROBE: shell_toolchain /usr/bin/cat'],
    ['env node omitted', "invoke('/usr/bin/env',['node','--version']);", '', 'A12_DEPENDENCY_PROBE: shell_toolchain env node'],
    ['env node replaced by absolute node', "invoke('/usr/bin/env',['node','--version']);", "invoke('/usr/bin/env',['/usr/bin/node','--version']);", 'A12_DEPENDENCY_PROBE: shell_toolchain positive'],
    ['touch writes a file', "invoke('/usr/bin/touch',['--version']);", "invoke('/usr/bin/touch',['/tmp/a12-forbidden']);", 'A12_DEPENDENCY_PROBE: shell_toolchain positive'],
    ['cat reads a file', "invoke('/usr/bin/cat',['--version']);", "invoke('/usr/bin/cat',['/etc/passwd']);", 'A12_DEPENDENCY_PROBE: shell_toolchain positive'],
    ['detection omits tools', 'chmod,mktemp,rm,touch,cat', 'chmod,mktemp,rm', 'A12_SHELL_DETECTION'],
    ['detection omits PATH claim', '/usr/bin/env node --version (child PATH resolution)', '/usr/bin/env /usr/bin/node --version', 'A12_SHELL_DETECTION'],
  ]) {
    assert.equal(source.split(from).length, 2, 'A12_MUTANT_ANCHOR');
    const r = run(source.replace(from, to));
    assert.equal(r.status, 1, `A12_MUTATION_KILL: ${label}`);
    assert.ok(r.stdout.includes(assertion) && r.stdout.includes('ERR_ASSERTION'), `A12_NAMED_KILL: ${label}`);
    console.log(`${label}: killed by ${assertion} (ERR_ASSERTION)`);
  }
  // Mutate the actual derivation input in an isolated evidence copy.
  const evidence = path.join(root, 'a12-evidence'); fs.mkdirSync(evidence);
  fs.cpSync(new URL('a12-evidence/', base), evidence, { recursive: true });
  for (const file of ['host-suite-contract.mjs','suite-runner-spec.mjs'])
    fs.copyFileSync(new URL(file, base), path.join(root, file));
  const runDerive = () => spawnSync(process.execPath, [path.join(evidence, 'derive-inventory.mjs'), ...process.argv.slice(2)], { cwd: process.cwd(), env, encoding: 'utf8' });
  assert.equal(runDerive().status, 0, 'A12_MAPPING_POSITIVE');
  const mappingFile = path.join(evidence, 'file-requirements.json');
  const original = fs.readFileSync(mappingFile, 'utf8');
  for (const file of ['push-broker-gitconfig','workspace-result','codex-contract','workspace-result-mutations','episode-successor-dispatch']) {
    const rows = JSON.parse(original);
    rows.find(r => r.file.endsWith(`/${file}.test.mjs`)).capabilities = rows.find(r => r.file.endsWith(`/${file}.test.mjs`)).capabilities.filter(c => c !== 'shell_toolchain');
    fs.writeFileSync(mappingFile, JSON.stringify(rows));
    const r = runDerive();
    assert.equal(r.status, 1, 'A12_MAPPING_MUTATION_KILL');
    assert.ok(r.stderr.includes(`A12_RESTORED_SHELL_REQUIREMENT: ${file}`) && r.stderr.includes('ERR_ASSERTION'), 'A12_MAPPING_NAMED_KILL');
    console.log(`remove shell_toolchain from ${file}: killed by A12_RESTORED_SHELL_REQUIREMENT: ${file} (ERR_ASSERTION)`);
  }
  // Execute the unmodified probe as the current service uid, recording the
  // actual fixed child argv/results without changing their options or PATH.
  const spec = { service_uid: process.getuid(), service_gid: process.getgid() };
  const probe = hostProbe(spec, { uid: () => process.getuid(), run(file, args) {
    assert.equal(file, process.execPath, 'A12_SERVICE_IDENTITY');
    const recording = args.at(-1).replace("import {spawnSync} from 'node:child_process';", `import {spawnSync as realSpawn} from 'node:child_process';
      const spawnSync=(file,args,options)=>{const r=realSpawn(file,args,options); console.log(JSON.stringify({uid:process.getuid(),file,args,status:r.status,stdout:r.stdout.trim()}));return r;};`);
    const r = spawnSync(file, [...args.slice(0, -1), recording], { env, encoding: 'utf8' });
    for (const line of r.stdout.trim().split('\n')) {
      const call = JSON.parse(line);
      assert.equal(call.uid, spec.service_uid, 'A12_SERVICE_IDENTITY');
      assert.equal(call.status, 0, 'A12_REAL_TOOL_EXIT');
      console.log(`A12_REAL_TOOL: ${line}`);
    }
    return r;
  } });
  assert.equal(await probe('shell_toolchain'), true, 'A12_REAL_SHELL_TOOLCHAIN');
  console.log('A12_REAL_SHELL_TOOLCHAIN: pass');
} finally { fs.rmSync(root, { recursive: true, force: true }); }
