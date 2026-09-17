import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const source = fs.readFileSync(new URL('../host-suite-contract.mjs', import.meta.url), 'utf8');
const testSource = fs.readFileSync(new URL('../test/capability-requirements.test.mjs', import.meta.url), 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a12-inert-mutants-'));
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
try {
  fs.mkdirSync(path.join(root, 'test'));
  fs.writeFileSync(path.join(root, 'test/capability-requirements.test.mjs'), testSource);
  const run = text => {
    fs.writeFileSync(path.join(root, 'host-suite-contract.mjs'), text);
    const syntax = spawnSync(process.execPath, ['--check', path.join(root, 'host-suite-contract.mjs')], { encoding: 'utf8', env });
    assert.equal(syntax.status, 0, 'A12_INERT_MUTANT_SYNTAX');
    return spawnSync(process.execPath, ['--test', '--test-name-pattern=^A12 dependency shell_toolchain positive and named refusal$', path.join(root, 'test/capability-requirements.test.mjs')], { encoding: 'utf8', env, timeout: 30000 });
  };
  assert.equal(run(source).status, 0, 'A12_INERT_POSITIVE');
  console.log('A12_INERT_POSITIVE: pass');
  for (const [label, from, to] of [
    ['scratch directory restored', "invoke('/bin/sh',['-c','exit 0']);", "const fs=(await import('node:fs')).default;fs.mkdtempSync('/tmp/a12-forbidden-');invoke('/bin/sh',['-c','exit 0']);"],
    ['file write restored', "invoke('/bin/sh',['-c','exit 0']);", "const fs=(await import('node:fs')).default;fs.writeFileSync('/tmp/a12-forbidden','x');invoke('/bin/sh',['-c','exit 0']);"],
    ['file removal restored', "invoke('/bin/sh',['-c','exit 0']);", "const fs=(await import('node:fs')).default;fs.rmSync('/tmp/a12-forbidden',{force:true});invoke('/bin/sh',['-c','exit 0']);"],
    ['mutating child argv restored', "invoke('/usr/bin/mktemp',['--version']);", "invoke('/usr/bin/mktemp',['/tmp/a12-forbidden-XXXXXX']);"],
  ]) {
    assert.equal(source.split(from).length, 2, 'A12_INERT_UNIQUE_MUTATION');
    const r = run(source.replace(from, to));
    assert.equal(r.status, 1, 'A12_INERT_MUTATION_KILL');
    assert.match(r.stdout + r.stderr, /A12_DEPENDENCY_PROBE: shell_toolchain positive/, 'A12_INERT_NAMED_ASSERTION');
    assert.match(r.stdout + r.stderr, /ERR_ASSERTION/, 'A12_INERT_NAMED_ASSERTION');
    console.log(`${label}: killed by A12_DEPENDENCY_PROBE: shell_toolchain positive (ERR_ASSERTION)`);
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
