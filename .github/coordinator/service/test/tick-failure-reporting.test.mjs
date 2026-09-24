import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

// The tick's failure path must name its cause. A bare token — all this printed
// before — leaves a stalled run unexplainable from its own journal: in the v1
// demonstration, attempt 1 died at worker start and the cause was discarded.
const TICK = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'coordinator-tick.mjs');
const TOKEN = 'ACT_COORDINATOR_TICK_FAILED';

test('TICK_FAILURE: a thrown error names its cause on stderr', () => {
  // The activation path is pinned to ACTIVATION_FILE, so any other value throws
  // inside the tick's try block — a real throw from the reviewed entry point.
  const run = spawnSync(process.execPath, [TICK, '--activation', '/dev/null/not-the-activation.json'], { encoding: 'utf8' });
  assert.equal(run.status, 1, `the tick must fail closed (status ${run.status})`);
  const at = run.stderr.indexOf(TOKEN);
  assert.notEqual(at, -1, 'the token must still be printed');
  assert.match(run.stderr.slice(at + TOKEN.length), /ACT_ACTIVATION_PATH/, 'the cause must follow the token');
});
