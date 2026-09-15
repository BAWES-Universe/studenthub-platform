import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { generateKeyPairSync, sign } from 'node:crypto';
import { validateTwoFixtureActivation, reviewedActivationBytes } from '../two-fixture-activation.mjs';
import { readTwoFixtureEvidence } from '../two-fixture-evidence.mjs';
import { singleRunActivationStatus } from '../single-run-activation.mjs';
import { dispatchEnabledFor, main } from '../reconcile.mjs';
const committed = JSON.parse(fs.readFileSync(new URL('../config.json', import.meta.url), 'utf8'));
import { ephemeralPublicSource } from './fixture/ephemeral-public-source.mjs';
const { privateKey, publicKey } = ephemeralPublicSource();
const revision = 'a'.repeat(40);
function fixture() {
  const config = structuredClone(committed);
  config.two_fixture_activation_public_key = publicKey.export({ type: 'spki', format: 'pem' });
  const record = { kind: 'two-fixture-v1', activation_id: 'two-fixture-test', coordinator_revision: revision,
    slots: 2, expires_at: '2026-09-14T12:00:00.000Z', stop_before_merge: true,
    fixtures: [config.fixture_lane, ...config.fixture_lanes].map((lane, i) => ({ issue_id: lane.id,
      branch: `coordinator/${lane.id}`, seed_head: String(i + 1).repeat(40), lane: structuredClone(lane) })),
    gates: { reviewed: false, runtime: false }, signature: '' };
  return { record, config, revision, mainRevision: revision, now: new Date('2026-09-14T11:00:00Z'),
    heads: Object.fromEntries(record.fixtures.map(f => [f.branch, f.seed_head])),
    issues: record.fixtures.map(f => ({ id: f.issue_id, linearId: `uuid-${f.issue_id}`, title: f.issue_id, state: 'Todo', priority: 'High', labels: ['fixture-safe', 'coordinator:pilot', 'repo:platform'], repo: config.pilot_repo, assignee: null, delegate: null, linkedPRs: [], parent: null, blockers: [] })), env: {} };
}
function signed(input) {
  input.record.signature = sign(null, reviewedActivationBytes(input.record), privateKey).toString('base64');
  return input;
}
const cases = [
  ['ACT_MISSING_FIXTURE', x => x.record.fixtures.pop(), "record.fixtures.length < 2"],
  ['ACT_EXTRA_FIXTURE', x => x.record.fixtures.push({ ...structuredClone(x.record.fixtures[1]), issue_id: 'SHU-255' }), "record.fixtures.length > 2"],
  ['ACT_LANE_CROSS', x => { x.record.fixtures[1].lane = { ...structuredClone(x.record.fixtures[0].lane), id: 'SHU-254' }; }, "fixture.branch !== `coordinator/${fixture.issue_id}` || fixture.lane.id !== fixture.issue_id || !isDeepStrictEqual(fixture.lane, lane) || !validateFixtureScopePolicy(lane).ok"],
  ['ACT_DUPLICATE_LANE', x => { x.record.fixtures[1] = structuredClone(x.record.fixtures[0]); }, "new Set(record.fixtures.map(f => f.issue_id)).size !== record.fixtures.length || new Set(record.fixtures.map(f => f.lane.id)).size !== record.fixtures.length || new Set(configured.map(f => f.id)).size !== configured.length"],
  ['ACT_CAPACITY_DRIFT', x => { x.config.max_dispatch = 1; }, "record.slots !== 2 || config.max_dispatch !== record.slots"],
  ['ACT_STALE_SEED_HEAD', x => { x.heads['coordinator/SHU-254'] = 'f'.repeat(40); }, "heads[fixture.branch] !== fixture.seed_head"],
  ['ACT_MALFORMED', x => { delete x.record.stop_before_merge; }, "!exact(record, keys)"],
  ['ACT_PARTIAL_ARMING', x => { x.record.gates.reviewed = true; }, "record.gates.reviewed !== record.gates.runtime || record.fixtures.some(f => !issues.some(i => i.id === f.issue_id && i.linearId)) || configured.length !== 2"],
  ['ACT_MANUAL_GATE_BYPASS', x => { x.env.ENABLE_DISPATCH = 'true'; }, "!authenticated || config.enable_dispatch !== false || (env.ENABLE_DISPATCH === 'true') !== record.gates.runtime"],
];
for (const [code, change] of cases) test(`${code}: positive control and named refusal`, () => {
  const good = signed(fixture());
  assert.equal(validateTwoFixtureActivation(good).state, 'disabled', `${code}: positive control`);
  good.record.gates = { reviewed: true, runtime: true }; good.env.ENABLE_DISPATCH = 'true'; signed(good);
  assert.equal(validateTwoFixtureActivation(good).state, 'armed', `${code}: positive armed evaluation`);
  const bad = fixture(); change(bad); signed(bad);
  const result = validateTwoFixtureActivation(bad);
  assert.equal(result.code, code, `${code}: invalid binding must refuse`);
  assert.equal(result.state, 'refused', `${code}: nothing arms`);
});

test('ACT_BOUND_FIELDS: every required field, SHA, expiry, lane and capacity is enforced', () => {
  for (const key of Object.keys(fixture().record)) {
    const x = signed(fixture()); delete x.record[key];
    assert.equal(validateTwoFixtureActivation(x).code, 'ACT_MALFORMED', `missing ${key}`);
  }
  for (const change of [
    x => { x.record.coordinator_revision = 'bad'; }, x => { x.record.fixtures[0].seed_head = 'bad'; },
    x => { x.record.stop_before_merge = false; }, x => { x.record.expires_at = '2026-09-13T00:00:00Z'; },
    x => { x.record.expires_at = '2026-09-16T00:00:00Z'; }, x => { x.mainRevision = 'b'.repeat(40); },
    x => { x.revision = 'b'.repeat(40); }, x => { x.record.unknown = true; },
  ]) { const x = fixture(); change(x); signed(x); assert.equal(validateTwoFixtureActivation(x).code, 'ACT_MALFORMED'); }
  for (const slots of [0, 1, 3]) { const x = fixture(); x.record.slots = slots; signed(x); assert.equal(validateTwoFixtureActivation(x).code, 'ACT_CAPACITY_DRIFT'); }
  for (const change of [x => x.issues.pop(), x => { x.config.fixture_lanes = []; }, x => { x.record.gates.runtime = true; }]) {
    const x = fixture(); change(x); signed(x); assert.equal(validateTwoFixtureActivation(x).code, 'ACT_PARTIAL_ARMING');
  }
  for (const change of [x => { x.record.fixtures[1].lane.id = 'SHU-140'; }, x => x.config.fixture_lanes.push(x.config.fixture_lane)]) {
    const x = fixture(); change(x); signed(x); assert.equal(validateTwoFixtureActivation(x).code, 'ACT_DUPLICATE_LANE');
  }
});

test('ACT_REVIEW_SIGNATURE: unsigned, altered, wrong-key and manual committed gates refuse', () => {
  for (const pem of [null, '', generateKeyPairSync('ed25519').publicKey.export({ type: 'spki', format: 'pem' })]) {
    const x = signed(fixture()); x.config.two_fixture_activation_public_key = pem;
    assert.equal(validateTwoFixtureActivation(x).code, 'ACT_TRUST_ANCHOR_MISMATCH', 'ACT_SOURCE_DIVERGENCE: config cannot appoint a key');
  }
  const implicit = signed(fixture()); delete implicit.config.two_fixture_activation_public_key;
  assert.equal(validateTwoFixtureActivation(implicit).state, 'disabled', 'ACT_COMMITTED_DEFAULT: absent legacy config selects the committed source');
  for (const change of [x => { x.record.activation_id = 'altered-approval'; }, x => { x.record.signature = ''; },
    x => { x.config.enable_dispatch = true; }]) {
    const x = signed(fixture()); change(x);
    assert.equal(validateTwoFixtureActivation(x).code, 'ACT_MANUAL_GATE_BYPASS');
  }
});

function statusIO(x) {
  return { lstat: () => ({ isSymbolicLink: () => false, isFile: () => true, mode: 0o600 }),
    readFile: () => JSON.stringify(x.record), mainRevision: x.mainRevision,
    fixtureHeadResolver: branch => x.heads[branch] };
}
test('ACT_REVIEWED_PATH: in-memory record reaches existing status without creating a file or setting a gate', () => {
  const x = signed(fixture()); const before = structuredClone(x);
  const status = singleRunActivationStatus({ ...x, gitHead: revision, filePath: '/in-memory-only', io: statusIO(x) });
  assert.equal(status.state, 'disabled'); assert.deepEqual(x, before);
  x.record.gates = { reviewed: true, runtime: true }; x.env.ENABLE_DISPATCH = 'true'; signed(x);
  const armed = singleRunActivationStatus({ ...x, gitHead: revision, filePath: '/in-memory-only', io: statusIO(x) });
  assert.equal(armed.state, 'armed'); assert.equal(armed.target_issue_id, 'SHU-140');
  const second = singleRunActivationStatus({ ...x, gitHead: revision, filePath: '/in-memory-only', io: statusIO(x), receipts: [{ issue_id: 'SHU-140', stage: 'RUNNING' }] });
  assert.equal(second.target_issue_id, 'SHU-254');
});

test('ACT_GATES_OFF: actual tick has zero launches and writes; manual pair gates cannot bypass review', async () => {
  const x = signed(fixture()); let writes = 0, launches = 0;
  const snapshot = structuredClone(x);
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'act2-disabled-tick-'));
  let result;
  try {
    fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify(x.config));
    fs.writeFileSync(path.join(dir, 'snapshot.json'), JSON.stringify({ issues: x.issues, openPRs: [] }));
    result = await main(['--activation', '/in-memory-only'], {}, { ...statusIO(x),
      configPath: path.join(dir, 'config.json'), snapshotPath: path.join(dir, 'snapshot.json'), gitHead: revision, now: () => x.now,
      fetchImpl: async () => { writes++; throw new Error('unexpected network'); },
      adapterModules: { 'codex-cli': { launchBuilder: async () => { launches++; throw new Error('unexpected launch'); } } },
      prepareWorkspace: async () => { writes++; throw new Error('unexpected workspace write'); }, stdout: () => {} });
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  assert.equal(result, 0); assert.equal(writes, 0, 'ACT_GATES_OFF: zero writes'); assert.equal(launches, 0, 'ACT_GATES_OFF: zero launches');
  assert.deepEqual(x, snapshot, 'ACT_GATES_OFF: verifier cannot set a gate');
  assert.equal(committed.enable_dispatch, false);
  assert.equal(dispatchEnabledFor({ ENABLE_DISPATCH: 'true' }, { ...committed, enable_dispatch: true }), false);
});

for (const [code, , condition] of cases) test(`ACT_MUTATION ${code}: removed guard dies by named AssertionError`, () => {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'act2-review-mutant-'));
  try {
    fs.cpSync(new URL('../', import.meta.url), dir, { recursive: true });
    const file = path.join(dir, 'two-fixture-activation.mjs'); const original = fs.readFileSync(file, 'utf8');
    const from = code === 'ACT_MALFORMED' ? "!exact(record, keys) || record.kind" : `if (${condition})`;
    // Remove the complete shape check, so an independent later check must not masquerade as a kill.
    const mutated = code === 'ACT_MALFORMED'
      ? original.replace(/if \(!exact\(record, keys\)[\s\S]*?return refusal\('ACT_MALFORMED', 'invalid or missing bound field'\);/, "if (false) return refusal('ACT_MALFORMED', 'invalid or missing bound field');")
      : original.replace(from, 'if (false)');
    assert.notEqual(mutated, original, `${code}: mutation applied`); fs.writeFileSync(file, mutated);
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    const run = spawnSync(process.execPath, ['--test', `--test-name-pattern=^${code}:`, path.join(dir, 'test/two-fixture-activation.test.mjs')], { env, encoding: 'utf8', timeout: 30000 });
    const output = run.stdout + run.stderr;
    assert.equal(run.status, 1, output); assert.match(output, /AssertionError/, output);
    assert.ok(output.includes(`${code}: invalid binding must refuse`), output);
    assert.doesNotMatch(output, /SyntaxError|TypeError|ERR_MODULE_NOT_FOUND/, output);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('ACT_REMOTE_EVIDENCE: real helper resolves both heads and identities through read-only API doubles', () => {
  const x = fixture();
  const evidence = readTwoFixtureEvidence(x.config, { GITHUB_TOKEN: 'synthetic-github', LINEAR_API_TOKEN: 'synthetic-linear' }, (exe, args, options) => {
    assert.equal(args.join(' ').includes('synthetic-github'), false, 'credentials stay out of arguments');
    const prelude = `globalThis.fetch = async (url, options) => {
      if (url.startsWith('https://api.github.com/')) {
        if (options.method) throw new Error('GitHub must be read only');
        return { ok: true, json: async () => ({ object: { sha: url.includes('SHU-140') ? '${'1'.repeat(40)}' : '${'2'.repeat(40)}' } }) };
      }
      const body = JSON.parse(options.body);
      if (!body.query.startsWith('query ActivationFixture')) throw new Error('Linear must be a query');
      return { ok: true, json: async () => ({ data: { issue: { id: 'uuid-' + body.variables.id, identifier: body.variables.id } } }) };
    };`;
    const result = spawnSync(exe, [args[0], args[1], prelude + args[2]], options);
    assert.equal(result.status, 0); return result.stdout;
  });
  assert.deepEqual(evidence.heads, x.heads);
  assert.deepEqual(evidence.issues.map(i => i.id).sort(), ['SHU-140', 'SHU-254']);
});

test('ACT_REMOTE_FAILURE: absent credentials and failed API reads cannot supply evidence', () => {
  assert.deepEqual(readTwoFixtureEvidence(committed, {}, () => { throw new Error('must not execute'); }), { heads: {}, issues: [] });
  assert.deepEqual(readTwoFixtureEvidence(committed, { GITHUB_TOKEN: 'fake', LINEAR_API_TOKEN: 'fake' }, () => { throw new Error('API failure'); }), { heads: {}, issues: [] });
});
