// P154D-07. The propagation that makes the invocation exclusion work, driven
// through the REAL production CLI entry point and the REAL `/usr/bin/env -i`.
//
// The fifth round's DISCLOSURE recorded this as the one load-bearing clause no
// control pinned: delete the invocation element from the re-exec and every
// in-process control still passes, while on the host the companion's identity
// is wiped, the exclusion never applies and the timer-triggered teardown
// refuses itself. The CONSTRUCTED command is pinned as a pure function by the
// controls in shu71-production.test.mjs; this file pins what actually CROSSES
// the lock, and the teardown that depends on it.
//
// How far the real path is driven, exactly, and where it stops:
//
//   * The real module's real top-level CLI branch runs, in its own process,
//     with a real `INVOCATION_ID` in its parent environment. Two doubles, both
//     applied from the preload and neither touching the module's source: the
//     identity guard is answered as root (productionFixture answers
//     `uid: () => 0` for every other control in this suite), and
//     `node:child_process` resolves to a recording module FOR THAT MODULE ONLY,
//     so the one spawnSync is captured rather than executed.
//   * The captured command is then EXECUTED, by this file, through the real
//     `/usr/bin/env` with the real `-i` and the real assignments the module
//     built. Two substitutions, both measured and both disclosed: the
//     `/usr/bin/flock --nonblock /run/lock/shu71-production.lock` prefix is
//     dropped, and asserted byte-exact on the constructed command instead; and
//     the WHOLE TAIL from `/usr/bin/node` on - that binary, <installedModule>
//     and the `expire <id>` argv behind them - is replaced by this harness's
//     inner driver and its own arguments, because `/usr/local/lib/shu71/...` is
//     a root-owned path absent on a suite host running as the service identity,
//     and the inner `SHU71_LOCKED=1` path needs real UID 0 and a /srv/shu tree.
//   * The inner process measures the environment it really inherited, reads the
//     module's own measurement port, and drives a timer-triggered teardown
//     whose ONLY source of self-identity is the value that crossed `env -i`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const service = fileURLToPath(new URL('../', import.meta.url));
const productionModule = path.join(service, 'shu71-production.mjs');
const preload = fileURLToPath(new URL('./fixture/shu71-reexec-cli-preload.mjs', import.meta.url));
const innerDriver = fileURLToPath(new URL('./fixture/shu71-reexec-locked-child.mjs', import.meta.url));
// The reviewed installation path, written out rather than imported, so a change
// to it is a change these controls see.
const INSTALLED = '/usr/local/lib/shu71/coordinator/service/shu71-production.mjs';
const LOCK_PREFIX = ['/usr/bin/flock', '--nonblock', '/run/lock/shu71-production.lock'];
const ENVIRONMENT = ['INVOCATION_ID', 'PATH', 'SHU71_LOCKED'];
const ID = 'shu71reexec00001';
const INVOCATION = 'deadbeefcafef00d0123456789abcdef';
// Planted in the environment of every process on the OUTER side of the lock.
// Neither may appear in the constructed command or in the inner process.
const POISON = { SHU71_REEXEC_POISON: 'operator-value-that-must-not-cross', SHU71_REEXEC_POISON_PARENT: 'carried' };
const source = fs.readFileSync(productionModule, 'utf8');

function scratch(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-reexec-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}
// Stage A. Run the REAL CLI entry with a real parent INVOCATION_ID and record
// the command it constructs for the far side of the kernel lock.
let records = 0;
function constructedCommand(root, file, invocation, name) {
  const record = path.join(root, `record-${++records}.json`);
  const env = { ...process.env, ...POISON, SHU71_REEXEC_RECORD: record, SHU71_REEXEC_TARGET: pathToFileURL(file).href };
  delete env.NODE_TEST_CONTEXT;
  delete env.SHU71_LOCKED;
  if (invocation === null) delete env.INVOCATION_ID; else env.INVOCATION_ID = invocation;
  const cli = spawnSync(process.execPath, ['--import', preload, file, 'expire', ID], { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(cli.error, undefined, `${name}_CLI_COMPLETED`);
  assert.equal(cli.status, 0, `${name}_CLI_EXIT: ${cli.stdout}${cli.stderr}`);
  assert.equal(cli.stdout, '', `${name}_CLI_NO_RECEIPT_FROM_THE_OUTER_PROCESS`);
  const recorded = JSON.parse(fs.readFileSync(record, 'utf8'));
  assert.equal(recorded.file, '/usr/bin/flock', `${name}_LOCKED_EXECUTABLE`);
  assert.deepEqual(recorded.options, { stdio: 'inherit' }, `${name}_SPAWN_OPTIONS_UNCHANGED`);
  return [recorded.file, ...recorded.args];
}
// Stage B. Execute the environment-carrying portion of that command for real.
let children = 0;
function lockedChild(root, command, planted, name) {
  const wipe = command.indexOf('/usr/bin/env'), node = command.indexOf('/usr/bin/node');
  assert.ok(wipe > 0 && node > wipe, `${name}_COMMAND_SHAPE`);
  const output = path.join(root, `inner-${++children}.json`);
  const argv = [...command.slice(wipe + 1, node), process.execPath, innerDriver, output, planted];
  // The parent hands over its whole environment; `-i` is what must discard it.
  const env = { ...process.env, ...POISON };
  delete env.NODE_TEST_CONTEXT;
  const child = spawnSync(command[wipe], argv, { env, encoding: 'utf8', timeout: 120000 });
  assert.equal(child.error, undefined, `${name}_INNER_COMPLETED`);
  assert.equal(child.status, 0, `${name}_INNER_EXIT: ${child.stdout}${child.stderr}`);
  const report = JSON.parse(fs.readFileSync(output, 'utf8'));
  assert.equal(report.threw, undefined, `${name}_INNER_DID_NOT_THROW: ${report.threw}`);
  return report;
}
// A mutant of the production module, written beside the real one exactly as the
// in-process mutation harness writes them, and spawned as its own CLI.
function mutantModule(root, before, after, name) {
  assert.equal(source.split(before).length, 2, `${name}_MUTATION_ANCHOR_UNIQUE`);
  const file = path.join(root, `production-${++records}.mjs`);
  fs.writeFileSync(file, source.replace(before, after).replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_, prefix, quote, relative) => `${prefix}${quote}${new URL(relative, pathToFileURL(productionModule)).href}${quote}`));
  assert.equal(spawnSync(process.execPath, ['--check', file]).status, 0, `${name}_MUTANT_SYNTAX_CLEAN`);
  return file;
}
// The environment the inner process really inherited: exactly three variables,
// the reviewed PATH, the lock flag, and the one propagated value - whole.
function innerEnvironment(report, invocation, name) {
  assert.deepEqual(report.environment_keys, ENVIRONMENT, `${name}_INNER_ENVIRONMENT_IS_EXACTLY_THREE`);
  assert.equal(report.path, '/usr/bin:/bin', `${name}_INNER_PATH`);
  assert.equal(report.locked, '1', `${name}_INNER_LOCKED`);
  assert.equal(report.carried, invocation, `${name}_INNER_OBSERVED_THE_PROPAGATED_ID`);
}

// CONTROL 7. One invocation value, exported to the real CLI, carried by the
// real command through the real `env -i`, measured by the module's own port in
// the inner process, and required to complete a timer-triggered teardown there.
export function reexecEndToEnd(t, file, name) {
  const root = scratch(t);
  const command = constructedCommand(root, file, INVOCATION, name);
  assert.equal(command.some(element => POISON.SHU71_REEXEC_POISON === element.split('=').slice(1).join('=')), false, `${name}_NO_OPERATOR_VALUE_IN_THE_COMMAND`);
  const report = lockedChild(root, command, INVOCATION, name);
  // (1) The boundary still takes no operator environment, measured on the
  // process that really inherited it.
  innerEnvironment(report, INVOCATION, name);
  // (2) The identity really crossed, and the module's own measurement port -
  // the one the exclusion reads - is what observed it.
  assert.equal(report.companion_invocation, INVOCATION, `${name}_COMPANION_IS_THAT_INVOCATION`);
  assert.equal(report.companion_state, 'activating', `${name}_COMPANION_MEASURABLY_ACTIVATING`);
  // (3) And with it, the timer-triggered teardown COMPLETES in the inner
  // process instead of refusing the very invocation performing it.
  assert.equal(report.armed, 'ARMED', `${name}_SETUP`);
  assert.equal(report.result.ok, true, `${name}_COMPLETED: ${JSON.stringify(report.result)}`);
  assert.equal(report.result.state, 'REVOKED', `${name}_RETIRED`);
  assert.equal(report.result.code, null, `${name}_NO_REFUSAL_CODE`);
  assert.deepEqual(report.result.failures, [], `${name}_NO_FAILURES`);
  assert.equal(report.teardown_complete, true, `${name}_RECEIPT_DURABLE`);
  assert.equal(report.retirement_receipt, true, `${name}_REMOVAL_RECEIPT`);
  assert.deepEqual(report.units_present, [false, false], `${name}_UNITS_REMOVED`);
  assert.equal(report.stop_issued, false, `${name}_NO_STOP_ISSUED`);
  assert.equal(report.kill_issued, false, `${name}_NO_KILL_ISSUED`);
  assert.equal(report.companion_still_live, 'activating', `${name}_STILL_THIS_INVOCATION_LIVE`);
  assert.equal(report.companion_still_this_invocation, INVOCATION, `${name}_STILL_THIS_INVOCATION_ID`);
  return command;
}
// CONTROL 5, at runtime rather than on the constructed command: a value
// carrying spaces and `=` crosses as ONE variable and cannot produce a second.
export function reexecOneVariable(t, file, name) {
  const root = scratch(t);
  const hostile = `${INVOCATION} PATH=/evil SHU71_LOCKED=0`;
  const command = constructedCommand(root, file, hostile, name);
  assert.deepEqual(command.slice(command.indexOf('-i') + 1, command.indexOf('/usr/bin/node')),
    ['PATH=/usr/bin:/bin', 'SHU71_LOCKED=1', `INVOCATION_ID=${hostile}`], `${name}_ONE_ARGV_ELEMENT`);
  const report = lockedChild(root, command, hostile, name);
  innerEnvironment(report, hostile, name);
  // It is still only an equality candidate: a value that really is the
  // companion's reported id excludes that start, and nothing else, so the
  // hostile prefix bought entry to no second variable and no second meaning.
  assert.equal(report.companion_invocation, hostile, `${name}_COMPANION_IS_THAT_INVOCATION`);
  assert.equal(report.result.ok, true, `${name}_EXCLUDES_ONLY_ON_EQUALITY: ${JSON.stringify(report.result)}`);
  return report;
}

test('B4 the locked re-exec carries this invocation across `env -i` and the inner teardown completes', t => {
  const command = reexecEndToEnd(t, productionModule, 'B4_REEXEC_END_TO_END');
  // The prefix this control does not execute is pinned here byte-exact instead.
  assert.deepEqual(command.slice(0, 3), LOCK_PREFIX, 'B4_REEXEC_END_TO_END_KERNEL_LOCK_PREFIX');
  assert.deepEqual(command.slice(3), ['/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'SHU71_LOCKED=1',
    `INVOCATION_ID=${INVOCATION}`, '/usr/bin/node', INSTALLED, 'expire', ID], 'B4_REEXEC_END_TO_END_CONSTRUCTED_COMMAND');
});

test('B4 a hostile invocation value crosses `env -i` as one variable and cannot inject a second', t => {
  reexecOneVariable(t, productionModule, 'B4_REEXEC_ONE_VARIABLE');
});

// The mutant the fifth round could not kill: the propagation deleted. Every
// in-process control still passes; this one dies, in the inner process, by the
// refusal the exclusion exists to prevent.
test('B4 mutation: the locked re-exec drops the invocation element', t => {
  const root = scratch(t);
  const name = 'B4_REEXEC_DROPPED';
  const file = mutantModule(root, '\n    ...(invocation ? [`INVOCATION_ID=${invocation}`] : []),', '', name);
  const command = constructedCommand(root, file, INVOCATION, name);
  assert.equal(command.some(element => element.startsWith('INVOCATION_ID=')), false, `${name}_MUTANT_CARRIES_NOTHING`);
  const report = lockedChild(root, command, INVOCATION, name);
  // The inner process is blind, and the teardown refuses the very invocation
  // performing it - the shipped regression, restored through the real CLI.
  assert.equal(report.carried, null, `${name}_INNER_IDENTITY_WIPED`);
  assert.equal(report.result.ok, false, `${name}_REFUSED`);
  assert.equal(report.result.code, 'ACT_CLEANUP_FAILED', `${name}_NAMED`);
  assert.ok(report.result.failures.includes('ACT_TEARDOWN_EXPIRY_SERVICE'), `${name}_COMPANION_REFUSAL_NAMED`);
  assert.deepEqual(report.units_present, [true, true], `${name}_UNITS_SURVIVE`);
  assert.equal(report.teardown_complete, false, `${name}_NO_COMPLETION`);
  assert.throws(() => reexecEndToEnd(t, file, 'B4_REEXEC_END_TO_END'),
    error => error.code === 'ERR_ASSERTION' && /B4_REEXEC_END_TO_END_/.test(error.message), `${name}_KILLS_THE_CONTROL`);
});

// The value's source: read it from anywhere but the single argument, and the
// function is no longer a function of the parent's invocation value.
test('B4 mutation: the invocation element is read from the environment, not the argument', t => {
  const root = scratch(t);
  const name = 'B4_REEXEC_FOREIGN_SOURCE';
  const file = mutantModule(root, '...(invocation ? [`INVOCATION_ID=${invocation}`] : []),',
    '...(invocation ? [`INVOCATION_ID=${process.env.SHU71_REEXEC_POISON_PARENT}`] : []),', name);
  const command = constructedCommand(root, file, INVOCATION, name);
  assert.ok(command.includes(`INVOCATION_ID=${POISON.SHU71_REEXEC_POISON_PARENT}`), `${name}_MUTANT_READS_ELSEWHERE`);
  assert.throws(() => reexecEndToEnd(t, file, 'B4_REEXEC_END_TO_END'),
    error => error.code === 'ERR_ASSERTION' && /B4_REEXEC_END_TO_END_/.test(error.message), `${name}_KILLS_THE_CONTROL`);
});

// Split the value into elements and `deadbeef…` alone would match a companion
// that reports the whole string, while `PATH=/evil` becomes a real variable.
test('B4 mutation: the invocation value is split across argv elements', t => {
  const root = scratch(t);
  const name = 'B4_REEXEC_SPLIT';
  const file = mutantModule(root, '...(invocation ? [`INVOCATION_ID=${invocation}`] : []),',
    "...(invocation ? `INVOCATION_ID=${invocation}`.split(' ') : []),", name);
  assert.throws(() => reexecOneVariable(t, file, 'B4_REEXEC_ONE_VARIABLE'),
    error => error.code === 'ERR_ASSERTION' && /B4_REEXEC_ONE_VARIABLE_/.test(error.message), `${name}_KILLS_THE_CONTROL`);
});

// The boundary itself: carry the parent environment through the lock.
test('B4 mutation: the parent environment is carried through the kernel lock', t => {
  const root = scratch(t);
  const name = 'B4_REEXEC_PARENT_ENVIRONMENT';
  const file = mutantModule(root, "'/usr/bin/env', '-i', 'PATH=/usr/bin:/bin', 'SHU71_LOCKED=1',",
    "'/usr/bin/env', '-i', ...Object.entries(process.env).map(([key, value]) => `${key}=${value}`), 'PATH=/usr/bin:/bin', 'SHU71_LOCKED=1',", name);
  const command = constructedCommand(root, file, INVOCATION, name);
  assert.ok(command.includes(`SHU71_REEXEC_POISON=${POISON.SHU71_REEXEC_POISON}`), `${name}_MUTANT_CARRIES_THE_PARENT_ENVIRONMENT`);
  assert.throws(() => reexecEndToEnd(t, file, 'B4_REEXEC_END_TO_END'),
    error => error.code === 'ERR_ASSERTION' && /B4_REEXEC_END_TO_END_/.test(error.message), `${name}_KILLS_THE_CONTROL`);
});

// `-i` itself: drop it and the inner process inherits the operator environment.
test('B4 mutation: the kernel lock no longer wipes the environment', t => {
  const root = scratch(t);
  const name = 'B4_REEXEC_NO_WIPE';
  const file = mutantModule(root, "'/usr/bin/env', '-i', 'PATH=/usr/bin:/bin'", "'/usr/bin/env', 'PATH=/usr/bin:/bin'", name);
  const command = constructedCommand(root, file, INVOCATION, name);
  assert.equal(command.includes('-i'), false, `${name}_MUTANT_DROPPED_THE_WIPE`);
  const report = lockedChild(root, command, INVOCATION, name);
  assert.ok(report.environment_keys.includes('SHU71_REEXEC_POISON'), `${name}_OPERATOR_ENVIRONMENT_INHERITED`);
  assert.throws(() => reexecEndToEnd(t, file, 'B4_REEXEC_END_TO_END'),
    error => error.code === 'ERR_ASSERTION' && /B4_REEXEC_END_TO_END_/.test(error.message), `${name}_KILLS_THE_CONTROL`);
});
