import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { createEpisodeHarness } from '../test/fixture/episode-harness.mjs';
import { createReceipt, nextReceiptState } from '../reconcile.mjs';
import { install, rollback, snapshot } from './install.mjs';

export function tree(root) {
  return fs.readdirSync(root).sort().flatMap(name => {
    const file = join(root, name), stat = fs.lstatSync(file);
    assert.ok(!stat.isSymbolicLink(), 'SHU251_STATE: fixture state must not contain symlinks');
    return [{ name, mode: stat.mode & 0o777, ...(stat.isDirectory() ? { entries: tree(file) } :
      { sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), mtime: stat.mtimeMs, ctime: stat.ctimeMs }) }];
  });
}
export function assertQuiet(before, after, launches, writes) {
  assert.equal(launches, 0, 'SHU251_ZERO_LAUNCH: disabled tick must make zero adapter calls');
  assert.equal(writes, 0, 'SHU251_ZERO_WRITE: disabled tick must make zero remote mutations');
  assert.deepEqual(after, before, 'SHU251_STATE_DIFF: disabled tick must preserve all fixture state');
}
export async function verifyKillSwitch() {
  const h = createEpisodeHarness();
  try {
    // Seed durable RUNNING state without ever enabling dispatch or spawning.
    const made = createReceipt({ issue_id: h.issueId, authorization_ref: 'FIXTURE-OPUS-CONTRACT-20260905',
      requested_worker: 'codex-builder', repo: h.config.pilot_repo, branch: 'fixture/test', target_sha: 'a'.repeat(40),
      reserved_at: '2026-09-10T11:00:00.000Z' });
    assert.equal(made.ok, true);
    const launched = nextReceiptState(made.receipt, { type: 'launch', at: '2026-09-10T11:01:00.000Z' });
    const running = nextReceiptState(launched.receipt, { type: 'worker_ack', external_run_id: 'fixture_run', worker_identity: 'fixture:worker', at: '2026-09-10T11:02:00.000Z' });
    assert.equal(running.accepted, true);
    h.comments.push({ body: `coordinator-receipt\n\`\`\`json\n${JSON.stringify(running.receipt)}\n\`\`\`` });
    assert.equal(h.receipts().length, 1, 'SHU251_FIXTURE: running receipt must be readable');
    let launches = 0, writes = 0;
    for (const adapter of Object.values(h.adapters)) {
      adapter.launchBuilder = async () => { launches++; return { stage: 'HOLD' }; };
      adapter.monitorRun = async () => { launches++; return { stage: 'RUNNING' }; };
    }
    const capture = () => structuredClone({ files: tree(h.dir), comments: h.comments, pauses: h.pauses, triggers: h.triggers, launched: h.launched });
    const before = capture();
    assert.equal(h.config.enable_dispatch, false, 'SHU251_GATE: fixture config gate must be off');
    for (let i = 0; i < 2; i++) {
      const result = await h.runTick({ env: { ENABLE_DISPATCH: 'false' }, io: {
        fetchImpl: async (url, options) => {
          const body = JSON.parse(options.body);
          if (/\bmutation\b/.test(body.query)) writes++;
          return h.fetchImpl(url, options);
        },
      } });
      assert.equal(result.code, 0, 'SHU251_TICK: reviewed disabled tick must finish successfully');
    }
    assertQuiet(before, capture(), launches, writes);
    return { ticks: 2, launches, writes, stateDiff: [] };
  } finally { h.cleanup(); }
}
export function fixtureParameters(root) {
  // Syntax-only executables. These are not supervisor interface implementations.
  return { workdir: root, supervisor: ['/usr/bin/true'], coordinator: ['/usr/bin/true'], writerLock: join(root, 'host-tick.lock') };
}
export async function verify() {
  const root = fs.mkdtempSync(join(tmpdir(), 'shu251-verify-'));
  try {
    fs.writeFileSync(join(root, 'shu-supervisor.service'), 'prior fixture bytes\n', { mode: 0o600 });
    const prior = snapshot(root);
    install(root, fixtureParameters(root));
    assert.equal(install(root, fixtureParameters(root)).changed, false, 'SHU251_IDEMPOTENT: repeated staging must be a no-op');
    const quiet = await verifyKillSwitch();
    rollback(root);
    assert.deepEqual(snapshot(root), prior, 'SHU251_ROLLBACK: prior bytes, modes and absence must be restored');
    assert.deepEqual(fs.readdirSync(root), ['shu-supervisor.service'], 'SHU251_CLEANUP: rollback must remove transaction artifacts');
    return { syntax: 'passed', rollback: 'exact bytes/modes/absence restored', ...quiet, scope: 'local fixtures only; no running-system proof' };
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(JSON.stringify(await verify(), null, 2));
