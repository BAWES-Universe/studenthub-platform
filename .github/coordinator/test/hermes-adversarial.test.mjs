import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { execFileSync, spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { launchBuilder, monitorRun } from '../adapters/hermes-pool.mjs';

const base = { issue_id: 'SHU-FIXTURE-001', authorization_ref: 'FIXTURE-OPUS-CONTRACT-20260905', attempt_id: 'aaaaaaaa-1111-4222-8333-444444444444', target_sha: 'd'.repeat(40), task_context: 'fixture' };
const adapter = new URL('../adapters/hermes-pool.mjs', import.meta.url).href;
function fixture(t) {
  const poolDir = fs.mkdtempSync(join(tmpdir(), 'hermes-r3-'));
  t.after(() => fs.rmSync(poolDir, { recursive: true, force: true }));
  return { poolDir, lease: join(poolDir, 'leases', `${base.attempt_id}.json`), claim: join(poolDir, 'leases', `${base.attempt_id}.launch-claim`) };
}

test('R3: a stale queued reader cannot spawn after another process completes launch', async (t) => {
  const f = fixture(t);
  await launchBuilder({ ...base, io: { poolDir: f.poolDir } });
  const original = fs.writeFileSync;
  let interleaved = false;
  fs.writeFileSync = function (path, ...args) {
    // Claim creation writes a COMPLETE temp file and hard-links it into place,
    // so the claim path itself never reaches writeFileSync. Hooking the temp
    // write keeps the interleave where this test needs it: after A has read the
    // queued lease, before A owns the claim.
    if (typeof path === "string" && path.startsWith(f.claim) && path.endsWith(".tmp") && !interleaved) {
      interleaved = true;
      // A real second coordinator process runs to completion while A retains
      // its already-read queued snapshot. Only the Hermes spawn is mocked.
      execFileSync(process.execPath, ['--input-type=module', '-e', `
        import { launchBuilder } from ${JSON.stringify(adapter)};
        await launchBuilder({ ...${JSON.stringify(base)}, io: { poolDir: ${JSON.stringify(f.poolDir)}, spawn: () => ({pid: 7001}) } });
      `]);
    }
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  let extraSpawns = 0;
  try {
    await launchBuilder({ ...base, io: { poolDir: f.poolDir, spawn: () => { extraSpawns++; return {pid: 7002}; } } });
  } finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
  assert.equal(interleaved, true);
  assert.equal(extraSpawns, 0, 'the already-launched attempt must not launch again');
});

test('R3: worker completion between parent read and write is never lost', async (t) => {
  const f = fixture(t);
  const original = fs.writeFileSync;
  let spawned = false;
  let injected = false;
  fs.writeFileSync = function (path, data, ...args) {
    if (spawned && !injected) {
      injected = true;
      const lease = JSON.parse(fs.readFileSync(f.lease, 'utf8'));
      original(f.lease, JSON.stringify({ ...lease, status: 'done', granular: 'completed', heartbeat: 'worker-finished' }));
    }
    return original(path, data, ...args);
  };
  syncBuiltinESMExports();
  try {
    await launchBuilder({ ...base, io: { poolDir: f.poolDir, spawn: () => { spawned = true; return {pid: 7003}; } } });
  } finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
  assert.equal(injected, true);
  const out = await monitorRun({ ...base, io: { poolDir: f.poolDir }, evidence: { ...base, stage: 'BUILD_READY', links: ['https://example.test/evidence'] } });
  assert.equal(out.stage, 'COMPLETED');
  assert.equal(JSON.parse(fs.readFileSync(f.lease)).heartbeat, 'worker-finished');
});

test('R3: recovery cannot mint a local reservation from a forged receipt', async (t) => {
  const f = fixture(t);
  let spawns = 0;
  const out = await launchBuilder({ ...base, recovery: true, io: { poolDir: f.poolDir, spawn: () => { spawns++; return {pid: 7004}; } } });
  assert.equal(spawns, 0);
  assert.equal(out.stage, 'LAUNCH_UNKNOWN');
  assert.equal(fs.existsSync(f.lease), false);
});

test('R3: recovery refuses mismatched local reservation bindings', async (t) => {
  const f = fixture(t);
  await launchBuilder({ ...base, io: { poolDir: f.poolDir } });
  let spawns = 0;
  const out = await launchBuilder({ ...base, target_sha: 'e'.repeat(40), recovery: true, io: { poolDir: f.poolDir, spawn: () => { spawns++; return {pid: 7005}; } } });
  assert.equal(spawns, 0);
  assert.equal(out.stage, 'LAUNCH_UNKNOWN');
});

for (const when of ['before', 'after']) {
  test(`R3: real coordinator crash ${when} spawn holds ownership and pauses without relaunch`, async (t) => {
    const f = fixture(t);
    const counter = join(f.poolDir, 'spawns');
    const code = `
      import fs from 'node:fs';
      import { syncBuiltinESMExports } from 'node:module';
      import { launchBuilder } from ${JSON.stringify(adapter)};
      const write = fs.writeFileSync;
      fs.writeFileSync = function(path, data, ...args) {
        const result = write(path, data, ...args);
        if (${JSON.stringify(when)} === 'before' && path === ${JSON.stringify(f.lease)} && JSON.parse(data).status === 'claiming') process.exit(71);
        return result;
      };
      syncBuiltinESMExports();
      await launchBuilder({...${JSON.stringify(base)}, io: { poolDir: ${JSON.stringify(f.poolDir)}, spawn: () => {
        write(${JSON.stringify(counter)}, 'one worker exists'); process.exit(72);
      } }});
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8' });
    assert.equal(child.status, when === 'before' ? 71 : 72, child.stderr);
    assert.equal(fs.existsSync(counter), when === 'after');
    let spawns = 0;
    const out = await launchBuilder({
      ...base,
      recovery: true,
      io: { poolDir: f.poolDir, spawn: () => { spawns++; return { pid: 7100 }; } },
    });
    if (when === 'before') {
      // The claim is still at phase pre_spawn, which now PROVES io.spawn was
      // never called — the counter file above confirms it independently. This
      // attempt is recoverable, and pausing the whole adapter for it would be
      // a false positive that costs the lane its only dispatch slot.
      assert.equal(out.stage, 'RUNNING', 'a crash that never reached spawn must be recoverable');
      assert.equal(spawns, 1, 'exactly one worker, started by the recovery');
      assert.notEqual(out.pause_adapter, true);
    } else {
      // A worker exists. Retrying could double-launch it, so this stays a
      // visible fault and the claim is retained.
      assert.equal(out.stage, 'FAILED');
      assert.equal(out.pause_adapter, true);
      assert.equal(spawns, 0);
      assert.equal(fs.existsSync(f.claim), true);
    }
  });
}

for (const [name, owner] of [
  ['alive/reused PID', { owner_pid: process.pid, owner_host: 'local' }],
  ['foreign host', { owner_pid: 99999, owner_host: 'foreign' }],
  ['invalid PID', { owner_pid: -1, owner_host: 'local' }],
  ['wrong attempt', { owner_pid: 99999, owner_host: 'local', attempt_id: 'wrong' }],
  ['corrupt JSON', '{'],
  ['null JSON', 'null'],
]) {
  test(`R3: ${name} claim never permits another spawn`, async (t) => {
    const f = fixture(t);
    await launchBuilder({ ...base, io: { poolDir: f.poolDir } });
    fs.writeFileSync(f.claim, typeof owner === 'string' ? owner : JSON.stringify({ attempt_id: base.attempt_id, phase: 'pre_spawn', ...owner }));
    let spawns = 0;
    const out = await launchBuilder({ ...base, io: { poolDir: f.poolDir, hostname: () => 'local', spawn: () => { spawns++; } } });
    assert.equal(out.stage, 'LAUNCH_UNKNOWN');
    assert.equal(spawns, 0);
    assert.equal(fs.existsSync(f.claim), true);
  });
}

test('R3: post-spawn persistence error retains claim and prevents recovery spawn', async (t) => {
  const f = fixture(t);
  const original = fs.writeFileSync;
  let spawns = 0;
  fs.writeFileSync = function (path, ...args) {
    if (spawns) throw Object.assign(new Error('disk unavailable'), { code: 'EIO' });
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    const out = await launchBuilder({ ...base, io: { poolDir: f.poolDir, spawn: () => { spawns++; return {pid: 7010}; } } });
    assert.equal(out.stage, 'RUNNING');
  } finally { fs.writeFileSync = original; syncBuiltinESMExports(); }
  assert.equal(fs.existsSync(f.claim), true);
  await launchBuilder({ ...base, recovery: true, io: { poolDir: f.poolDir, spawn: () => { spawns++; return {pid: 7011}; } } });
  assert.equal(spawns, 1);
});

// Extract the policy step's script from the workflow by INDENTATION rather than
// by a fixed 10-space prefix: a reindent or a reordered step would otherwise
// silently change (or empty) what these tests execute, and a garbled script
// still "passes" a rejection test because bash exits non-zero either way.
function repositoryPolicyScript() {
  const workflow = fs.readFileSync(new URL('../../workflows/repository-policy.yml', import.meta.url), 'utf8').split('\n');
  const stepAt = workflow.findIndex((l) => l.includes('name: Reject tracked dependency trees and host-absolute symlinks'));
  assert.notEqual(stepAt, -1, 'the policy step must still exist under that name');
  const runAt = workflow.findIndex((l, i) => i > stepAt && /^\s*run: \|\s*$/.test(l));
  assert.notEqual(runAt, -1, 'the policy step must still use a run: | block');
  const runIndent = workflow[runAt].search(/\S/);
  const body = [];
  for (let i = runAt + 1; i < workflow.length; i += 1) {
    const line = workflow[i];
    if (line.trim() === '') { body.push(''); continue; }
    if (line.search(/\S/) <= runIndent) break; // dedented: the block ended
    body.push(line);
  }
  const indent = Math.min(...body.filter((l) => l.trim() !== '').map((l) => l.search(/\S/)));
  const script = body.map((l) => l.slice(indent)).join('\n');
  // Guard the extraction itself, so a bad parse fails loudly instead of
  // masquerading as a policy verdict.
  assert.ok(script.includes('git ls-files'), 'extracted script must actually be the policy check');
  assert.ok(script.includes('node_modules'), 'extracted script must retain the dependency-tree check');
  return script;
}

function runPolicyIn(cwd) {
  return spawnSync('bash', ['-e', '-o', 'pipefail', '-c', repositoryPolicyScript()], { cwd, encoding: 'utf8' });
}

function gitFixture(dir) {
  execFileSync('git', ['init', '-q', dir]);
  return () => execFileSync('git', ['-C', dir, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', 'commit', '-qm', 'fixture']);
}

// CLEAN-TREE CONTROL. Without it the rejection test below passes even when the
// extracted script is garbage, because any bash failure also exits non-zero.
test('R3: repository policy ACCEPTS a clean tree', (t) => {
  const f = fixture(t);
  const commit = gitFixture(f.poolDir);
  fs.writeFileSync(join(f.poolDir, 'ordinary.txt'), 'content');
  fs.symlinkSync('ordinary.txt', join(f.poolDir, 'relative-link'));
  execFileSync('git', ['-C', f.poolDir, 'add', '.']);
  commit();
  const result = runPolicyIn(f.poolDir);
  assert.equal(result.status, 0, `clean tree must pass: ${result.stdout}${result.stderr}`);
});

test('R3: repository policy rejects an absolute symlink with a newline name', (t) => {
  const f = fixture(t);
  const commit = gitFixture(f.poolDir);
  fs.symlinkSync('/host/private/dependencies', join(f.poolDir, 'bad\nlink'));
  execFileSync('git', ['-C', f.poolDir, 'add', '.']);
  commit();
  const result = runPolicyIn(f.poolDir);
  assert.notEqual(result.status, 0, 'policy must reject even quoted Git paths');
  assert.match(`${result.stdout}${result.stderr}`, /absolute host path/, 'and must reject it for the RIGHT reason');
});

test('R3: repository policy rejects a tracked node_modules path with a newline name', (t) => {
  const f = fixture(t);
  const commit = gitFixture(f.poolDir);
  fs.mkdirSync(join(f.poolDir, 'pkg\nprefix', 'node_modules'), { recursive: true });
  fs.writeFileSync(join(f.poolDir, 'pkg\nprefix', 'node_modules', 'dep'), 'x');
  execFileSync('git', ['-C', f.poolDir, 'add', '.']);
  commit();
  const result = runPolicyIn(f.poolDir);
  assert.notEqual(result.status, 0);
  assert.match(`${result.stdout}${result.stderr}`, /node_modules path is tracked/);
});

// CR-1: takeover of an abandoned pre_spawn claim overwrote the claim with a
// plain writeFileSync, so two coordinators reading the SAME abandoned claim both
// get ok and both proceed. PR #24's post-claim lease re-read masks that in the
// common case — but not when the winner spawns and then dies before persisting
// its running lease. The loser's takeover then CLOBBERS the winner's claim (so
// the record that a worker exists is destroyed), the lease still reads
// pre-spawn, and a second worker starts for one attempt.
test('CR-1: a takeover cannot double-launch when the previous owner died after spawning', async (t) => {
  const f = fixture(t);
  const counter = join(f.poolDir, 'spawns');
  await launchBuilder({ ...base, io: { poolDir: f.poolDir } }); // queued lease, no claim
  fs.writeFileSync(f.claim, JSON.stringify({
    attempt_id: base.attempt_id, owner_pid: 999999, owner_host: 'gone',
    phase: 'pre_spawn', claimed_at: '2026-09-05T00:00:00.000Z',
  }));

  const original = fs.writeFileSync;
  let interleaved = false;
  fs.writeFileSync = function (path, ...args) {
    // Claim creation goes via temp file + link, so a direct write to the claim
    // path is the takeover itself. Interleave a real coordinator there.
    if (path === f.claim && !interleaved) {
      interleaved = true;
      spawnSync(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs';
        import { launchBuilder } from ${JSON.stringify(adapter)};
        await launchBuilder({ ...${JSON.stringify(base)}, io: { poolDir: ${JSON.stringify(f.poolDir)}, spawn: () => {
          fs.appendFileSync(${JSON.stringify(counter)}, 'x');
          process.exit(72); // died after starting a worker, before persisting RUNNING
        } } });
      `], { encoding: 'utf8' });
    }
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    await launchBuilder({ ...base, io: { poolDir: f.poolDir, spawn: () => {
      fs.appendFileSync(counter, 'x'); return { pid: 8002 };
    } } });
  } finally { fs.writeFileSync = original; syncBuiltinESMExports(); }

  assert.equal(interleaved, true, 'the interleave must actually have happened');
  const spawns = fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').length : 0;
  assert.equal(spawns, 1, 'one attempt may never start two workers');
});

// CR-1b: winning the takeover marker is not enough. Another coordinator can
// complete its own takeover (and release the marker) between our read of the
// abandoned claim and our acquisition of the marker. Replacing the claim then
// would clobber a LIVE owner's claim and start a second worker, so the claim is
// re-verified against what we judged abandoned before it is replaced.
test('CR-1b: a takeover aborts if the claim was reclaimed while we waited', async (t) => {
  const f = fixture(t);
  const counter = join(f.poolDir, 'spawns');
  const takeover = join(f.poolDir, 'leases', `${base.attempt_id}.launch-takeover`);
  await launchBuilder({ ...base, io: { poolDir: f.poolDir } });
  fs.writeFileSync(f.claim, JSON.stringify({
    attempt_id: base.attempt_id, owner_pid: 999999, owner_host: 'gone',
    phase: 'pre_spawn', claimed_at: '2026-09-05T00:00:00.000Z',
  }));

  const original = fs.writeFileSync;
  let interleaved = false;
  fs.writeFileSync = function (path, ...args) {
    // The takeover marker is created as a complete temp file then linked, so a
    // write to <takeover>.<pid>.tmp is this process about to contend for it.
    if (typeof path === 'string' && path.startsWith(takeover) && path.endsWith('.tmp') && !interleaved) {
      interleaved = true;
      // A real coordinator takes the claim over, spawns, and releases the marker.
      spawnSync(process.execPath, ['--input-type=module', '-e', `
        import fs from 'node:fs';
        import { launchBuilder } from ${JSON.stringify(adapter)};
        await launchBuilder({ ...${JSON.stringify(base)}, io: { poolDir: ${JSON.stringify(f.poolDir)}, spawn: () => {
          fs.appendFileSync(${JSON.stringify(counter)}, 'x');
          process.exit(72); // spawned, then died before persisting RUNNING
        } } });
      `], { encoding: 'utf8' });
    }
    return original(path, ...args);
  };
  syncBuiltinESMExports();
  try {
    await launchBuilder({ ...base, io: { poolDir: f.poolDir, spawn: () => {
      fs.appendFileSync(counter, 'x'); return { pid: 8003 };
    } } });
  } finally { fs.writeFileSync = original; syncBuiltinESMExports(); }

  assert.equal(interleaved, true, 'the interleave must actually have happened');
  const spawns = fs.existsSync(counter) ? fs.readFileSync(counter, 'utf8').length : 0;
  assert.equal(spawns, 1, 'a reclaimed abandoned claim must not be taken over a second time');
});
