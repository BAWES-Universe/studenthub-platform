import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
const base = new URL('../', import.meta.url);
const source = fs.readFileSync(new URL('host-suite-contract.mjs', base), 'utf8');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'a12-current-probes-'));
const env = { ...process.env }; delete env.NODE_TEST_CONTEXT;
try {
  fs.mkdirSync(path.join(root, 'test'));
  fs.copyFileSync(new URL('test/capability-requirements.test.mjs', base), path.join(root, 'test/capability-requirements.test.mjs'));
  const run = text => {
    fs.writeFileSync(path.join(root, 'host-suite-contract.mjs'), text);
    return spawnSync(process.execPath, ['--test', '--test-name-pattern=^A12 dependency shell_toolchain positive and named refusal$', path.join(root, 'test/capability-requirements.test.mjs')], { env, encoding: 'utf8' });
  };
  assert.equal(run(source).status, 0, 'A12_CURRENT_PROBE_POSITIVE');
  console.log('A12_CURRENT_PROBE_POSITIVE: pass');
  for (const [label, from, to, name] of [
    ['F1 absolute basename invocation removed', "invoke('/usr/bin/basename',['--version']);", '', 'A12_DEPENDENCY_PROBE: shell_toolchain /usr/bin/basename'],
    ['F1 PATH basename invocation removed', "invoke('/usr/bin/env',['basename','--version']);", '', 'A12_DEPENDENCY_PROBE: shell_toolchain env basename'],
    ['F1 PATH basename replaced by absolute form', "invoke('/usr/bin/env',['basename','--version']);", "invoke('/usr/bin/basename',['--version']);", 'A12_DEPENDENCY_PROBE: shell_toolchain env basename'],
    ['F1 PATH detection removed', '/usr/bin/env basename --version (child PATH resolution)', '/usr/bin/env basename --version', 'A12_SHELL_DETECTION: /usr/bin/env basename --version (child PATH resolution)'],
    ['F5 absolute node invocation removed', "invoke('/usr/bin/node',['--version']);", '', 'A12_DEPENDENCY_PROBE: shell_toolchain /usr/bin/node'],
    ['F5 absolute node detection removed', '/usr/bin/node --version, and', 'and', 'A12_SHELL_DETECTION: /usr/bin/node --version'],
    ['M16 no filesystem mutation detection removed', '; no filesystem mutation', '', 'A12_SHELL_DETECTION: ; no filesystem mutation'],
  ]) {
    assert.equal(source.split(from).length, 2, 'A12_CURRENT_MUTATION_ANCHOR');
    const r = run(source.replace(from, to));
    assert.equal(r.status, 1, `A12_CURRENT_MUTATION_KILL: ${label}`);
    assert.ok(r.stdout.includes('ERR_ASSERTION') && r.stdout.includes(name), `A12_CURRENT_NAMED_KILL: ${label}\n${r.stdout}`);
    console.log(`${label}: killed by ${name}`);
  }
} finally { fs.rmSync(root, { recursive: true, force: true }); }
