import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import * as api from '../units.mjs';
import { secretText, coordinatorText, environmentText, supervisorEnvironment } from './shu71-supervisor-environment-fixture.mjs';
function controls(module = api) {
  assert.deepEqual(module.assertSupervisorLaunchEnvironment(secretText(), coordinatorText()), supervisorEnvironment, 'CLOSURE_SPLIT_PASSES');
  assert.throws(() => module.assertSupervisorLaunchEnvironment(environmentText(), coordinatorText()), /SHU251_ENV_CROSSED/, 'CLOSURE_COMBINED_REFUSED');
  assert.throws(() => module.assertSupervisorLaunchEnvironment(secretText(), coordinatorText() + secretText()), /SHU251_ENV_CROSSED/, 'CLOSURE_CROSSED_REFUSED');
  const child = module.adapterLaunchEnvironment(coordinatorText());
  for (const key of module.supervisorAdapterKeys) assert.equal(child[key], supervisorEnvironment[key], 'CLOSURE_CHILD_BINDINGS');
  for (const key of ['SHU_SUPERVISOR_SECRET', 'GITHUB_TOKEN', 'LINEAR_API_TOKEN']) assert.equal(child[key], undefined, 'CLOSURE_CHILD_NO_AUTHORITY');
}
test('CLOSURE_ENV split passes combined and crossed refuse', () => controls());
test('CLOSURE_ENV child reads fixed coordinator source with custody', () => {
  const calls = [];
  const io = { constants: fs.constants,
    openSync(p, flags) { calls.push(p); assert.ok(flags & fs.constants.O_NOFOLLOW); return 9; },
    fstatSync: () => ({ isFile: () => true, nlink: 1, uid: 999, gid: 999, mode: 0o100600, size: 100 }),
    readFileSync: () => coordinatorText(), closeSync: fd => calls.push(fd) };
  assert.deepEqual(api.readAdapterLaunchEnvironment(io, 999), api.adapterLaunchEnvironment(coordinatorText()), 'CLOSURE_CHILD_SOURCE');
  assert.deepEqual(calls, ['/srv/shu/coordinator.env', 9]);
  assert.throws(() => api.readAdapterLaunchEnvironment(io, 998), /SHU251_ENV_CUSTODY/);
});
for (const [label, from, to, assertion] of [
  ['combined accepted', "supervisor.size === 1 && supervisor.has('SHU_SUPERVISOR_SECRET')", 'true', 'CLOSURE_COMBINED_REFUSED'],
  ['crossed accepted', "!coordinator.has('SHU_SUPERVISOR_SECRET')", 'true', 'CLOSURE_CROSSED_REFUSED'],
  ['child adapter delivery omitted', 'supervisorAdapterKeys.includes(key)\n    ||', 'false\n    ||', 'CLOSURE_CHILD_BINDINGS'],
]) test(`CLOSURE_ENV mutation ${label}`, async t => {
  controls();
  const sourceURL = new URL('../units.mjs', import.meta.url);
  const source = fs.readFileSync(sourceURL, 'utf8').replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, q, p) => `from '${new URL(p, sourceURL).href}'`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'closure-env-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'mutant.mjs');
  // The first matching coordinator guard is the arming guard; staging retains its own.
  assert.ok(source.includes(from)); fs.writeFileSync(file, source.replace(from, to));
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0);
  const mutant = await import(pathToFileURL(file));
  assert.throws(() => controls(mutant), e => e.code === 'ERR_ASSERTION' && e.message.includes(assertion), assertion);
});
