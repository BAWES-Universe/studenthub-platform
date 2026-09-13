import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EventEmitter } from 'node:events';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { runInNewContext } from 'node:vm';
import { once } from 'node:events';
import { RUNTIMES, ROLES, RUNTIME_ROLE_SUPPORT, laneForRuntimeRole, resolveReceiptRoleAuthority } from '../launch-vocabulary.mjs';
import { createReceipt, validateReceipt, foldLaunchOutcome, receiptCommentBody, parseReceiptCommentBody, parseReceiptsFromComments, main } from '../reconcile.mjs';
import { validWorkOrder, routeSuccessorFromReceipts } from '../review-routing.mjs';
import { CapacityScheduler } from '../capacity-scheduler.mjs';
import { DurableSupervisor, signedSupervisorRequest } from '../supervisor.mjs';
import { supervisorOrder } from '../supervisor-dispatch.mjs';
import { createEpisodeHarness, SHA_INPUT, SHA_WRITE } from './fixture/episode-harness.mjs';

// No live adapters, network, or host state. Mutations modify disposable copies only.
const SECRET = 'shu71-deterministic-supervisor-secret-32-bytes';
const ID = 'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee';
const named = {
  matrix: 'SHU71_MATRIX: every declared runtime/role must reserve a valid work order',
  role: 'SHU71_ROLE: receipt replay must preserve trusted role instead of lane default',
  conflict: 'SHU71_CONFLICT: lane disagreement must HOLD routing',
  unsupported: 'SHU71_UNSUPPORTED: undeclared runtime capability must refuse the work order',
  build: 'SHU71_BUILD: Claude build must complete BUILD_READY with its trusted role',
  block: 'SHU71_BLOCK: independent Codex BLOCK must route revision to the Claude writer',
  pass: 'SHU71_PASS: independent Codex PASS must complete and close the loop',
  author: 'SHU71_AUTHOR: fresh Claude review session must not clear its own author family',
  responsive: 'SHU71_RESPONSIVE: reconcile must return within 1000ms while the child is still executing',
  duplicate: 'SHU71_DUPLICATE: duplicate wakeups must launch exactly one child',
  crash: 'SHU71_CRASH: accepted submission must recover exactly once',
  restart: 'SHU71_RESTART: proven live restart must retain one running worker',
  ambiguous: 'SHU71_AMBIGUOUS: unknown restart must HOLD without another launch regardless of elapsed time',
  window: 'SHU71_WINDOW: pre-spawn crash marker must HOLD without launching',
  death: 'SHU71_DEATH: dead child must yield terminal HOLD and a responsive later tick',
  isolation: 'SHU71_ISOLATION: held or hanging first unit must allow selection and launch of a later eligible unit',
};
function temp(t) {
  const dir = fs.mkdtempSync(join(tmpdir(), 'shu71-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir;
}
function receipt(role, runtime, extra = {}) {
  const made = createReceipt({ receipt_version: '1.1.0', role, runtime,
    requested_worker: laneForRuntimeRole(runtime, role), issue_id: 'SHU-71', authorization_ref: 'SHU-71',
    repo: 'BAWES-Universe/studenthub-platform', branch: 'test/shu71', target_sha: SHA_INPUT,
    attempt_id: ID, reserved_at: '2026-09-10T12:00:00.000Z', ...extra });
  assert.equal(made.ok, true, named.matrix); return made.receipt;
}
function finish(r, stage, lineage = [], links = ['https://example.invalid/deterministic-defect-check']) {
  return foldLaunchOutcome(r, { stage: 'COMPLETED', external_run_id: `fixture_${r.attempt_id}`,
    worker_identity: r.runtime === 'claude-code' ? 'claude:fresh-session' : 'codex:independent',
    callback: { attempt_id: r.attempt_id, target_sha: r.target_sha, result_sha: SHA_WRITE, stage,
      links } },
  { current_head: SHA_WRITE, expected_head: SHA_WRITE, lineage, now: () => new Date('2026-09-10T12:01:00.000Z') }).receipt;
}
for (const runtime of RUNTIMES) for (const role of ROLES) {
  test(`SHU-71 matrix: ${runtime}/${role}`, t => {
    const r = receipt(role, runtime), dir = temp(t);
    assert.equal(RUNTIME_ROLE_SUPPORT[runtime].includes(role), true, named.matrix);
    const scheduler = new CapacityScheduler({ stateDir: dir, policy: { global_limit: 2, review_reserve: 1,
      hosts: { local: 2 }, accounts: { fixture: 2 }, runtimes: { [runtime]: 2 }, budget_micros: 100,
      max_deadline_ms: 10000, max_retries: 1, max_revisions: 3, reservation_ttl_ms: 1000 } });
    const reservation = scheduler.reserve({ task_id: role, role, runtime, host: 'local', account: 'fixture',
      repo: r.repo, branch: r.branch, worktree: join(dir, 'work'), overlap_keys: [], blocked_by: [],
      estimated_cost_micros: 1, deadline_ms: 1000, retry: 0, revision: 0, priority: 1 });
    assert.equal(reservation.ok && validateReceipt(r).valid && validWorkOrder(supervisorOrder(r)).ok, true, named.matrix);
    const replay = parseReceiptCommentBody(receiptCommentBody(r));
    assert.deepEqual([replay.role, resolveReceiptRoleAuthority(replay).role, supervisorOrder(replay).role], [role, role, role], named.role);
    assert.equal(validWorkOrder({ ...supervisorOrder(r), role: 'publish' }).ok, false, named.unsupported);
  });
}
test('SHU-71 authority: conflicting lane HOLDs', () => {
  const r = { ...receipt('build', 'claude-code'), role: 'review' };
  assert.equal(routeSuccessorFromReceipts({ terminal: r }).hold, 'role_authority_invalid', named.conflict);
  assert.equal(validateReceipt(r).valid, false, named.conflict);
});
// Undeclared-capability refusal cannot occur in the production vocabulary:
// all three runtimes declare all three roles. This restricted-copy test is
// hypothetical validator coverage, not evidence of production refusal.
test('SHU-71 restricted capability refusal', {
  skip: process.env.SHU71_RESTRICTED !== '1' && 'production vocabulary has no undeclared runtime/role pair',
}, () => {
  assert.equal(validWorkOrder({ version: '1.0.0', role: 'review', runtime: 'codex-cli', issue_id: 'SHU-71',
    attempt_id: ID, target_sha: SHA_INPUT, authorization_ref: 'SHU-71' }).ok, false, named.unsupported);
});
// These are routing tests with a deterministic fixture reviewer, not a live
// Codex/model review. The reviewer reads the artifact linked by the build receipt
// and executes its exported predicate against an independently specified contract.
function reviewBuild(writer) {
  const artifact = fs.readFileSync(new URL(writer.evidence_links[0]), 'utf8');
  const predicate = runInNewContext(artifact, Object.create(null), { timeout: 100 });
  return [[-1, false], [0, false], [1, true]].every(([input, expected]) =>
    predicate(input) === expected) ? 'PASS' : 'BLOCKED';
}
const buildSources = {
  BLOCKED: '(n) => n >= 0',
  PASS: '(n) => n > 0',
};
for (const verdict of ['BLOCKED', 'PASS']) {
  test(`SHU-71 reversal: Claude BUILD_READY then Codex ${verdict}`, t => {
    const artifact = join(temp(t), 'build-result.js');
    fs.writeFileSync(artifact, buildSources[verdict]);
    const writer = finish(receipt('build', 'claude-code'), 'BUILD_READY', [], [pathToFileURL(artifact).href]);
    assert.deepEqual([writer.stage, writer.verdict_stage, writer.role], ['COMPLETED', 'BUILD_READY', 'build'], named.build);
    const actualVerdict = reviewBuild(writer);
    const review = finish(receipt('review', 'codex-cli', { target_sha: SHA_WRITE,
      attempt_id: 'bbbbbbbb-bbbb-4ccc-8ddd-eeeeeeeeeeee' }), actualVerdict, [writer]);
    const routed = routeSuccessorFromReceipts({ terminal: review, issueReceipts: [writer, review],
      evidenceStage: review.verdict_stage, authoritativeHead: SHA_WRITE, evidenceResultSha: SHA_WRITE });
    if (verdict === 'BLOCKED') {
      assert.deepEqual([review.stage, review.role, routed.ok, routed.order?.role, routed.order?.runtime,
        routed.order?.requested_worker, routed.order?.actor, routed.order?.target_sha],
      ['HOLD', 'review', true, 'revise', 'claude-code', 'claude-builder', writer.worker_identity, SHA_WRITE], named.block);
      assert.equal(validWorkOrder(routed.order).ok, true, named.block);
    } else assert.deepEqual([review.stage, review.verdict_stage, review.role, routed.terminal], ['COMPLETED', 'PASS', 'review', true], named.pass);
  });
}
test('SHU-71 reversal: author family cannot clear its revision', () => {
  const writer = finish(receipt('build', 'claude-code'), 'BUILD_READY');
  const revision = finish(receipt('revise', 'claude-code', { target_sha: SHA_WRITE,
    attempt_id: 'cccccccc-bbbb-4ccc-8ddd-eeeeeeeeeeee' }), 'REVISION_READY');
  writer.worker_identity = 'claude:original-author'; revision.worker_identity = 'claude:revision-author';
  const review = finish(receipt('review', 'claude-code', { target_sha: SHA_WRITE }), 'PASS', [writer, revision]);
  assert.equal(review.stage, 'HOLD', named.author);
  assert.equal(routeSuccessorFromReceipts({ terminal: review, issueReceipts: [writer, revision, review], evidenceStage: 'PASS' }).hold, 'author_exclusion', named.author);
});
function setup(t, multiple = false, working = false) {
  const h = createEpisodeHarness({ issueId: 'SHU-71', githubToken: 'fake-token' });
  t.after(async () => {
    for (const child of children) if (working && child.exitCode === null) {
      const exited = once(child, 'exit'); child.kill(); await exited;
    }
    supervisor.shutdown(); h.cleanup();
  });
  const children = [], scheduled = [];
  let probe = true;
  const make = () => new DurableSupervisor({ stateDir: join(h.dir, 'supervisor'), secret: SECRET,
    probeProcess: () => probe, schedule: fn => scheduled.push(fn), spawnWorker: order => {
      const child = working ? spawn(process.execPath, ['-e', `
        let value = 1;
        setInterval(() => {
          for (let i = 0; i < 10000; i++) value = (value * 1664525 + 1013904223) >>> 0;
          process.stdout.write(String(value) + '\\n');
        }, 5);
      `], { stdio: ['ignore', 'pipe', 'pipe'] }) : new EventEmitter();
      if (working) {
        child.work = 0;
        child.stdout.on('data', () => child.work++);
      } else child.pid = 10000 + children.length;
      child.processStartToken = `fixture-${child.pid}`; if (!working) { child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); }
      if (!working) child.kill = () => {}; child.executing = true; child.order = order;
      child.on('exit', () => { child.executing = false; }); children.push(child); return child;
    } });
  let supervisor = make();
  // Bounded alternative path gives the await-child mutation a named assertion instead of a timeout.
  h.adapters['codex-cli'].launchBuilder = () => new Promise(resolve => setTimeout(() => resolve({ stage: 'HOLD' }), 1200));
  let tick = extra => h.runTick({ env: { SHU_SUPERVISOR_SECRET: SECRET },
    io: { supervisorTransport: ({ request }) => supervisor.submit(request), ...extra } });
  if (multiple) {
    const second = { ...structuredClone(h.nodes[0]), id: '22222222-aaaa-4bbb-8ccc-000000000777', identifier: 'SHU-72' };
    h.nodes.push(second);
    const secondComments = [];
    // Entirely private fixture policy; repository config.json is never written.
    const policy = { ...h.config, enable_dispatch: true, max_dispatch: 2 }; delete policy.dispatch_scope;
    const policyPath = join(h.dir, 'multi-issue-test-policy.json'); fs.writeFileSync(policyPath, JSON.stringify(policy));
    const fetchImpl = async (url, options) => {
      if (!String(url).includes('api.github.com')) {
        const { query, variables } = JSON.parse(options.body);
        const respond = data => ({ status: 200, ok: true, json: async () => ({ data }) });
        if (variables?.issueId === second.id || variables?.issueId === second.identifier) {
          if (query.includes('CoordinatorIssueComments')) return respond({ issue: { comments: { nodes: secondComments } } });
          if (query.includes('commentCreate')) {
            secondComments.push({ body: variables.body, createdAt: '2026-09-10T12:00:00.000Z' });
            return respond({ commentCreate: { success: true, comment: { id: `second-${secondComments.length}` } } });
          }
        }
      }
      return h.fetchImpl(url, options);
    };
    tick = extra => main([], { ENABLE_DISPATCH: 'true', LINEAR_API_TOKEN: 'fake', GITHUB_TOKEN: 'fake',
      DISPATCH_TARGET_SHA: SHA_INPUT, SHU_SUPERVISOR_SECRET: SECRET }, {
      configPath: policyPath, skipActivationPreflight: true, now: () => new Date('2026-09-10T12:00:00.000Z'),
      stdout: () => {}, fetchDurable: true, pollRuns: true, fetchImpl, adapterModules: h.adapters,
      supervisorTransport: ({ request }) => supervisor.submit(request), ...extra,
    });
    h.allReceipts = () => [...h.receipts(), ...parseReceiptsFromComments(secondComments)];
  }
  const drain = async () => { while (scheduled.length) await scheduled.shift()(); };
  return { h, tick, drain, children, get supervisor() { return supervisor; },
    restart(value) { probe = value; scheduled.length = 0; supervisor.shutdown(); supervisor = make(); return supervisor.recover(); } };
}
test('SHU-71 responsiveness: reconcile returns during executing child', async t => {
  // Allow an order of magnitude more headroom for CI runner load (100ms -> 1000ms).
  // A genuinely blocking tick awaits the child's whole run, so this still catches it.
  const f = setup(t, false, true); const start = performance.now(); await f.tick();
  assert.ok(performance.now() - start < 1000, named.responsive);
  await f.drain(); assert.equal(f.children[0]?.executing, true, named.responsive);
  await once(f.children[0].stdout, 'data');
  const workBefore = f.children[0].work;
  const later = performance.now(); await f.tick(); const elapsed = performance.now() - later;
  assert.ok(elapsed < 1000 && f.children[0].executing, named.responsive);
  assert.equal(f.supervisor.store.readRun(f.children[0].order.attempt_id).status, 'running', named.responsive);
  await once(f.children[0].stdout, 'data');
  assert.ok(f.children[0].work > workBefore, named.responsive);
  t.diagnostic(`Measured reconcile return: ${elapsed.toFixed(2)}ms; real child produced computed output before and after tick`);
});
// Separate OS processes rendezvous inside accept and after reading the accepted
// run in launch. The latter forces every contender past the in-memory status
// check: only the real atomic durable claim can elect the one spawn winner.
test('SHU-71 recovery: duplicate wakeups launch once', { timeout: 45000 }, async t => {
  const dir = temp(t), order = supervisorOrder(receipt('build', 'claude-code'));
  const worker = join(dir, 'racer.mjs');
  fs.writeFileSync(worker, `
    import fs from 'node:fs';
    import { join } from 'node:path';
    import { EventEmitter } from 'node:events';
    import { DurableSupervisor, signedSupervisorRequest } from ${JSON.stringify(new URL('../supervisor.mjs', import.meta.url).href)};
    const dir = process.argv[2], order = JSON.parse(process.argv[3]);
    const pause = new Int32Array(new SharedArrayBuffer(4));
    function barrier(phase) {
      process.send(phase);
      const until = Date.now() + 30000;
      while (!fs.existsSync(join(dir, phase))) {
        if (Date.now() > until) throw new Error('race barrier timeout: ' + phase);
        Atomics.wait(pause, 0, 0, 5);
      }
    }
    const supervisor = new DurableSupervisor({ stateDir: join(dir, 'state'),
      secret: ${JSON.stringify(SECRET)}, schedule: () => {}, spawnWorker: () => {
        fs.writeFileSync(join(dir, 'spawn-' + process.pid), 'spawn');
        const child = new EventEmitter(); child.pid = process.pid;
        child.processStartToken = 'fixture-' + process.pid; return child;
      } });
    const accept = supervisor.store.accept.bind(supervisor.store);
    supervisor.store.accept = (...args) => { barrier('submit'); return accept(...args); };
    const result = await supervisor.submit(signedSupervisorRequest(order, ${JSON.stringify(SECRET)}));
    if (!result.ok) throw new Error(JSON.stringify(result));
    const readRun = supervisor.store.readRun.bind(supervisor.store);
    let first = true;
    supervisor.store.readRun = (...args) => {
      const run = readRun(...args);
      if (first) { first = false; barrier('launch'); }
      return run;
    };
    await supervisor.launch(order.attempt_id);
    process.disconnect();
  `);
  const counts = { submit: 0, launch: 0 }, racers = [];
  t.after(() => racers.forEach(child => child.kill()));
  const results = await Promise.all(Array.from({ length: 80 }, () => new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [worker, dir, JSON.stringify(order)],
      { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
    racers.push(child);
    let errors = '';
    child.stderr.on('data', chunk => { errors += chunk; });
    child.on('error', reject);
    child.on('message', phase => {
      if (++counts[phase] === 80) fs.writeFileSync(join(dir, phase), 'release');
    });
    child.on('exit', code => resolve({ code, errors }));
  })));
  assert.ok(results.every(r => r.code === 0), JSON.stringify(results.filter(r => r.code !== 0)));
  assert.deepEqual(counts, { submit: 80, launch: 80 }, named.duplicate);
  assert.equal(fs.readdirSync(dir).filter(name => name.startsWith('spawn-')).length, 1, named.duplicate);
});
test('SHU-71 recovery: crash after submission recovers once', async t => {
  const f = setup(t);
  await f.tick({ supervisorTransport: async ({ request }) => { await f.supervisor.submit(request); throw new Error('lost acknowledgement'); } });
  assert.equal(f.h.receipts()[0].stage, 'LAUNCH_UNKNOWN', named.crash);
  f.restart(true); await f.tick(); await f.drain(); await f.tick();
  assert.deepEqual([f.children.length, f.supervisor.store.attempts().length, f.h.receipts()[0].stage], [1, 1, 'RUNNING'], named.crash);
});
test('SHU-71 recovery: live restart and ambiguous elapsed restart', async t => {
  const f = setup(t); await f.tick(); await f.drain();
  const live = f.restart(true); await f.drain(); await f.tick();
  assert.deepEqual([live[0].status, f.children.length], ['running', 1], named.restart);
  const id = f.children[0].order.attempt_id, run = f.supervisor.store.readRun(id);
  f.supervisor.store.writeRun(id, { ...run, heartbeat: '2000-01-01T00:00:00.000Z', started_at: '2000-01-01T00:00:00.000Z' });
  const held = f.restart(null); await f.drain(); await f.tick(); await f.tick();
  assert.deepEqual([held[0].status, f.children.length, f.h.receipts()[0].stage], ['hold', 1, 'HOLD'], named.ambiguous);
});
test('SHU-71 recovery: crash at durable pre-spawn marker', async t => {
  const f = setup(t); await f.tick();
  const id = f.supervisor.store.attempts()[0];
  // Crash after the durable spawn-intent write but before recording any process identity.
  f.supervisor.store.markLaunch(id, { attempt_id: id, phase: 'spawn_attempted',
    spawn_attempted_at: '2000-01-01T00:00:00.000Z' });
  const recovered = f.restart(null); await f.drain(); await f.tick();
  assert.deepEqual([recovered[0].status, recovered[0].error_code, f.children.length, f.h.receipts()[0].stage],
    ['hold', 'AMBIGUOUS_LAUNCH', 0, 'HOLD'], named.window);
});
test('SHU-71 recovery: child death yields terminal receipt', async t => {
  const f = setup(t); await f.tick(); await f.drain(); f.children[0].emit('exit', 1, 'SIGKILL');
  const start = performance.now(); await f.tick();
  assert.ok(performance.now() - start < 1000 && f.h.receipts()[0].stage === 'HOLD', named.death);
  await f.tick(); assert.equal(f.children.length, 1, named.death);
});
for (const failing of [false, true]) test(`SHU-71 isolation: ${failing ? 'dead' : 'hanging'} worker permits later unit`, async t => {
  const f = setup(t, true); await f.tick(); await f.drain();
  assert.equal(f.children[0]?.order.issue_id, 'SHU-71', named.isolation);
  if (failing) f.children[0].emit('exit', 1, 'SIGKILL');
  const started = performance.now(); await f.tick();
  // A terminal transition consumes this tick; dispatch resumes on the next tick.
  if (failing) await f.tick();
  await f.drain();
  assert.ok(performance.now() - started < 1000, named.isolation);
  assert.deepEqual(f.children.map(c => c.order.issue_id), ['SHU-71', 'SHU-72'], named.isolation);
  assert.equal(f.children[1].executing, true, named.isolation);
  assert.deepEqual(f.h.allReceipts().map(r => [r.issue_id, r.stage]),
    [['SHU-71', failing ? 'HOLD' : 'RUNNING'], ['SHU-72', 'RUNNING']], named.isolation);
});

function isolated(t, changes, pattern, envExtra = {}) {
  const dir = temp(t);
  fs.cpSync(new URL('../', import.meta.url), dir, { recursive: true });
  for (const [file, before, after] of changes) {
    const target = join(dir, file), full = fs.readFileSync(target, 'utf8');
    const boundary = file === 'test/shu71-battery.test.mjs' ? full.indexOf('\nconst mutations = [') : full.length;
    const source = full.slice(0, boundary);
    assert.equal(source.split(before).length, 2, `SHU71_ANCHOR: unique ${file} mutation anchor`);
    fs.writeFileSync(target, source.replace(before, after) + full.slice(boundary));
  }
  const env = { ...process.env, ...envExtra }; delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--test', `--test-name-pattern=${pattern}`, join(dir, 'test/shu71-battery.test.mjs')],
    { env, encoding: 'utf8', timeout: 60000 });
  assert.equal(result.error, undefined, 'SHU71_MUTATION: subprocess must finish, not time out');
  return { status: result.status, output: result.stdout + result.stderr };
}
const restriction = ['launch-vocabulary.mjs',
  '"codex-cli": Object.freeze([ROLE_BUILD, ROLE_REVISE, ROLE_REVIEW]),',
  '"codex-cli": Object.freeze([ROLE_BUILD, ROLE_REVISE]),'];
test('SHU-71 capability: restricted declaration refuses review', t => {
  const result = isolated(t, [restriction], '^SHU-71 restricted capability refusal$', { SHU71_RESTRICTED: '1' });
  assert.equal(result.status, 0, result.output);
  assert.match(result.output, /# pass 1\b/);
});
const mutations = [
  ['artifact repairs BLOCK to PASS', 'test/shu71-battery.test.mjs',
    "BLOCKED: '(n) => n >= 0',", "BLOCKED: '(n) => n > 0',",
    '^SHU-71 reversal: Claude BUILD_READY then Codex BLOCKED$', 'block'],
  ['artifact breaks PASS to BLOCK', 'test/shu71-battery.test.mjs',
    "PASS: '(n) => n > 0',", "PASS: '(n) => n >= 0',",
    '^SHU-71 reversal: Claude BUILD_READY then Codex PASS$', 'pass'],
  ['delete durable claimLaunch guard alone', 'supervisor.mjs',
    'if (!claimed) return this.store.readRun(attemptId);', '',
    '^SHU-71 recovery: duplicate', 'duplicate'],
  ['realistically slow tick', 'test/shu71-battery.test.mjs',
    'const later = performance.now(); await f.tick();',
    'const later = performance.now(); await new Promise(resolve => setTimeout(resolve, 2500)); await f.tick();',
    '^SHU-71 responsiveness:', 'responsive'],

  ['role re-keyed to lane', 'launch-vocabulary.mjs',
    'return { ok: true, role: receipt.role, runtime: receipt.runtime, source: "authority" };',
    'return { ok: true, role: definition.role, runtime: receipt.runtime, source: "authority" };',
    '^SHU-71 matrix: .*revise$', 'role'],
  ['reject declared combinations', 'review-routing.mjs',
    'if (!RUNTIME_ROLE_SUPPORT[order.runtime].includes(order.role)) {', 'if (true) {', '^SHU-71 matrix:', 'matrix'],
  ['ignore lane disagreement', 'launch-vocabulary.mjs',
    'if (!definition.roles.includes(receipt.role)) {', 'if (false) {', '^SHU-71 authority:', 'conflict'],
  ['accept undeclared capability', 'review-routing.mjs',
    'if (!RUNTIME_ROLE_SUPPORT[order.runtime].includes(order.role)) {', 'if (false) {',
    '^SHU-71 restricted capability refusal$', 'unsupported', [restriction], { SHU71_RESTRICTED: '1' }],
  ['discard Claude build completion', 'reconcile.mjs',
    'next.stage = "COMPLETED";', 'next.stage = receipt.role === "build" ? "HOLD" : "COMPLETED";',
    '^SHU-71 reversal: Claude BUILD_READY then Codex PASS$', 'build'],
  ['route BLOCK to reviewer', 'review-routing.mjs',
    'const writer = activeWriter(entries);', 'const writer = { runtime: requested.runtime, actor: "codex:independent" };',
    '^SHU-71 reversal: Claude BUILD_READY then Codex BLOCKED$', 'block'],
  ['discard Codex PASS completion', 'reconcile.mjs',
    'next.stage = "COMPLETED";', 'next.stage = receipt.role === "review" ? "HOLD" : "COMPLETED";',
    '^SHU-71 reversal: Claude BUILD_READY then Codex PASS$', 'pass'],
  ['allow reversed same-family self-review', 'review-routing.mjs',
    'authors.has(entry.actor) && entry.runtime === authority.runtime', 'false',
    '^SHU-71 reversal: author family', 'author'],
  ['tick awaits child', 'reconcile.mjs',
    'launch = await dispatchAdapterModule.launchBuilder({', 'launch = await (await loadAdapterModule(adapter, io)).launchBuilder({',
    '^SHU-71 responsiveness:', 'responsive'],
  ['duplicate wakeup launches', 'supervisor.mjs',
    'const run = accepted.run;', 'if (accepted.duplicate) this.spawnWorker(request.order, {});\n    const run = accepted.run;',
    '^SHU-71 recovery: duplicate', 'duplicate'],
  ['lose accepted submission recovery', 'supervisor.mjs',
    'this.schedule(() => void this.launch(attemptId));\n          results.push(run);',
    'this.store.writeRun(attemptId, { ...run, status: "hold" });\n          results.push(run);',
    '^SHU-71 recovery: crash after submission', 'crash'],
  ['treat proven live restart as dead', 'supervisor.mjs',
    'if (alive === true) {', 'if (false) {', '^SHU-71 recovery: live restart', 'restart'],
  ['ambiguous restart launches', 'supervisor.mjs',
    'const alive = this.probeProcess(run);',
    'const alive = this.probeProcess(run); if (alive === null) this.spawnWorker(this.store.readOrder(attemptId), {});',
    '^SHU-71 recovery: live restart', 'ambiguous'],
  ['ignore pre-spawn crash marker', 'supervisor.mjs',
    'if (this.store.hasLaunch(attemptId)) {', 'if (false) {',
    '^SHU-71 recovery: crash at durable', 'window'],
  ['dead worker remains running', 'supervisor-dispatch.mjs',
    'return { ...identity, stage: "HOLD", reason: "completion has no bound callback evidence" };',
    'return { ...identity, stage: "RUNNING", adapter_status: "in_progress" };',
    '^SHU-71 recovery: child death', 'death'],
  ['hanging unit blocks selection', 'reconcile.mjs',
    'skipped.push({ id: issue.id, reason: "already has an active receipt" });\n      continue;',
    'return { candidate: null, adapter: null, skipped };', '^SHU-71 isolation: hanging', 'isolation'],
  ['held unit blocks selection', 'reconcile.mjs',
    'skipped.push({ id: issue.id, reason: "issue has a terminal COMPLETED/HOLD receipt — parked for human/next-step, not auto-redispatched" });\n      continue;',
    'return { candidate: null, adapter: null, skipped };', '^SHU-71 isolation: dead', 'isolation'],
];
for (const [name, file, before, after, pattern, key, prelude = [], env = {}] of mutations) {
  test(`SHU-71 mutation: ${name}`, t => {
    const result = isolated(t, [...prelude, [file, before, after]], pattern, env);
    assert.equal(result.status, 1, result.output);
    assert.match(result.output, /name: 'AssertionError'/, result.output);
    assert.match(result.output, /code: 'ERR_ASSERTION'/, result.output);
    assert.ok(result.output.includes(named[key]), result.output);
    t.diagnostic(`Killed ${name}: AssertionError: ${named[key]}`);
  });
}
