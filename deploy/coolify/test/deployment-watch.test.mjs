import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { pollGatewayRun } from '../deployment-watch.mjs';

function fixture(t, events) {
  const root = mkdtempSync(join(tmpdir(), 'shu256-watch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'events.json');
  const signal = join(root, 'signals');
  writeFileSync(file, JSON.stringify(events));
  return { root, file, signal, run: () => spawnSync(process.execPath,
    ['deploy/coolify/deployment-watch.mjs', '--events', file, '--signal-dir', signal], { encoding: 'utf8' }) };
}

test('FAILED event CLI creates and updates incident plus orchestration wake', (t) => {
  const f = fixture(t, [{ source: 'coolify', id: 'gateway-deploy-1', status: 'FAILED' }]);
  for (let i = 0; i < 2; i++) {
    const result = f.run();
    assert.equal(result.status, 0, result.stderr);
    const incident = JSON.parse(result.stdout);
    assert.equal(incident.status, 'FAILED');
    const wake = JSON.parse(readFileSync(join(f.signal, 'wake.json'), 'utf8'));
    assert.equal(wake.route, 'orchestration');
    assert.deepEqual(JSON.parse(readFileSync(join(f.signal, wake.incident), 'utf8')), incident);
  }
  assert.equal(readdirSync(f.signal).length, 2);
});

test('empty and successful events CLI stay silent and create no signal', (t) => {
  for (const events of [[], [{ source: 'github', id: 'run-1', status: 'success' }], [{ source: 'coolify', id: 'deploy-1', status: 'in_progress' }]]) {
    const f = fixture(t, events);
    const result = f.run();
    assert.equal(result.status, 0);
    assert.equal(result.stdout, '', 'QUIET_STDOUT: non-failures must emit no incident');
    assert.equal(result.stderr, '', 'QUIET_STDERR: non-failures must emit no diagnostic');
    assert.equal(existsSync(f.signal), false, 'NO_WAKE: non-failures must create no signal directory');
  }
});

test('gateway polling normalizes a failed GitHub run', () => {
  assert.deepEqual(pollGatewayRun('owner/repo', '123', (command, args) => {
    assert.equal(command, 'gh');
    assert.deepEqual(args, ['api', 'repos/owner/repo/actions/runs/123']);
    return JSON.stringify({ id: 123, path: '.github/workflows/build.yml', conclusion: 'failure' });
  }), [{ source: 'github', id: 'owner/repo/123', status: 'failure' }]);
});

test('watcher rejects unrelated workflow and malformed failure without wake', (t) => {
  assert.throws(() => pollGatewayRun('owner/repo', '123', () => JSON.stringify({ id: 123, path: 'other.yml' })),
    /gateway build workflow/, 'WRONG_WORKFLOW: unrelated run must be refused');
  const f = fixture(t, [{ source: 'coolify', id: '../bad\nline', status: 'FAILED' }]);
  assert.equal(f.run().status, 1, 'INVALID_EVENT: malformed failure must exit nonzero');
  assert.equal(existsSync(f.signal), false, 'INVALID_EVENT_NO_WAKE: malformed failure must not create a wake');
});
