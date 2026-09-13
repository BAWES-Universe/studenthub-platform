import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export const names = ['shu-supervisor.service', 'shu-coordinator.service', 'shu-coordinator.timer'];
// Literal systemd argv, never a shell command. Escape expansion by systemd.
export function quote(value) {
  assert.ok(typeof value === 'string' && value.length > 0 && !/[\x00-\x1f\x7f]/.test(value), 'SHU251_PARAMETER: nonempty single-line parameter required');
  return '"' + value.replaceAll('\\', '\\\\').replaceAll('"', '\\"').replaceAll('%', '%%').replaceAll('$', () => '$$') + '"';
}
function command(argv) {
  assert.ok(Array.isArray(argv) && argv.length > 0 && argv[0].startsWith('/'), 'SHU251_COMMAND: absolute executable argv required');
  return argv.map(quote).join(' ');
}
export function render({ workdir, supervisor, coordinator, writerLock }) {
  assert.ok(workdir?.startsWith('/') && writerLock?.startsWith('/'), 'SHU251_PATH: absolute workdir and shared writer lock required');
  // Use the SAME lock as host-tick.sh. The supplied coordinator command must
  // invoke the reviewed tick directly, not recursively acquire this lock.
  assert.match(workdir, /^\/[a-zA-Z0-9_./-]+$/, 'SHU251_PATH: workdir must use plain absolute path characters');
  command(coordinator);
  const values = { WORKDIR: workdir, SUPERVISOR_EXEC: command(supervisor),
    COORDINATOR_EXEC: command(['/usr/bin/flock', '--nonblock', '--conflict-exit-code', '2', writerLock, ...coordinator]) };
  return Object.fromEntries(names.map(name => [name, fs.readFileSync(new URL(`${name}.in`, import.meta.url), 'utf8')
    .replace(/@([A-Z_]+)@/g, (_, key) => { assert.ok(key in values, 'SHU251_PARAMETER: unresolved template'); return values[key]; })]));
}
export function assertPolicy(units) {
  assert.match(units['shu-supervisor.service'], /^Restart=on-failure$/m, 'SHU251_RESTART: supervisor must restart on failure');
  assert.match(units['shu-coordinator.service'], /^Restart=on-failure$/m, 'SHU251_RESTART: writer must restart on failure');
  assert.match(units['shu-supervisor.service'], /^KillMode=process$/m, 'SHU251_CHILDREN: routine restart must preserve workers');
  assert.match(units['shu-coordinator.service'], /^ExecStart="\/usr\/bin\/flock" "--nonblock" "--conflict-exit-code" "2" /m, 'SHU251_WRITER: tick must hold the common flock');
  assert.match(units['shu-coordinator.timer'], /^Unit=shu-coordinator.service$/m, 'SHU251_WAKE: timer must target the single writer');
  for (const name of names.filter(n => n.endsWith('.service'))) {
    assert.match(units[name], /^Environment=ENABLE_DISPATCH=false$/m, 'SHU251_GATE: staged dispatch must be off');
    assert.doesNotMatch(units[name], /@[A-Z_]+@/, 'SHU251_PARAMETER: unresolved template');
  }
}
export function verifySyntax(directory) {
  const result = spawnSync('systemd-analyze', ['verify', ...names.map(n => join(directory, n))], { encoding: 'utf8', env: { PATH: process.env.PATH, LC_ALL: 'C', SYSTEMD_UNIT_PATH: `${directory}:/usr/lib/systemd/system:/lib/systemd/system` } });
  assert.equal(result.error, undefined, 'SHU251_SYNTAX: systemd-analyze must be available');
  assert.equal(result.status, 0, `SHU251_SYNTAX: unit validation failed\n${result.stderr}`);
  assert.equal(result.stderr.trim(), '', `SHU251_SYNTAX: unit validation emitted diagnostics\n${result.stderr}`);
}
