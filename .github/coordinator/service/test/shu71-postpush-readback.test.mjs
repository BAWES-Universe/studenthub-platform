// SHU-71 post-push read-back robustness. An approved window armed through the
// documented entrypoint pushed the reseed commit successfully and then HALTED on
// ACT_API_FAILED. Measured read-only afterwards, the remote ref carried the
// reseed commit, `compare/<old>...<next>` answered `ahead` with the required
// merge base, and the coordinator's own token answered 200 on every one of those
// routes with thousands of requests of headroom - so the failing call was a
// transient answer to a READ that the code had already satisfied. The halt record
// carried neither the route nor the status, so the failing read could not be
// identified from the evidence at all.
//
// Two defects, two groups of controls. F1: the post-push read-only GETs retry
// under a bounded policy, and NOTHING else does - not the push, not the Linear
// mutation, and never a COMPARISON, so a genuine state mismatch still refuses on
// the first answer and the budget cannot convert it into a pass. F2: a failed API
// call names itself - route, status, GraphQL codes - in the halt record, carrying
// no token, header or body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createShu71Production, READ_RETRY, RETRYABLE_READ_STATUS, apiFailureDetail, retryableApiFailure } from '../shu71-production.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
const keys = ephemeralPublicSource();
const moduleUrl = new URL('../shu71-production.mjs', import.meta.url);
const source = fs.readFileSync(moduleUrl, 'utf8');
const ACTIVATION = '/srv/shu/state/shu71-activation.json';
const PREFIX = 'https://api.github.com/repos/BAWES-Universe/studenthub-platform/';
const REF140 = 'git/ref/heads/coordinator%2FSHU-140';
const REF254 = 'git/ref/heads/coordinator%2FSHU-254';
const MAIN = 'git/ref/heads/main';
const compareRoute = h => `compare/${h.spec.pkg.reseed.expected_parent}...${h.spec.pkg.reseed.expected_seed_head}`;
// Secrets the disposable fixture plants behind every call this module makes.
const POISON = ['GITHUB_POISON', 'LINEAR_POISON', 's'.repeat(40), 'Authorization', 'Bearer', 'x-access-token'];

const fixture = t => productionFixture(t, keys);
const failure = status => ({ ok: false, status, text: async () => '{}' });
const replied = value => ({ ok: true, status: 200, text: async () => JSON.stringify(value) });
const cardWrites = h => h.events.filter(e => e.startsWith('card:'));

// A programmable layer over the fixture's interpreted GitHub API. `answer` is
// called with the route, that route's attempt number and the number of
// CONSECUTIVE calls to the same route (one logical read's attempts are always
// consecutive). Returning undefined lets the fixture answer for real; returning
// { rewrite } lets a control corrupt a real 200 answer - which is a genuine state
// mismatch, not a failed call.
function interceptReads(h, answer) {
  const inner = h.boundary.fetch;
  const calls = [], delays = [];
  let previous = null, within = 0;
  h.boundary.readWait = async ms => { delays.push(ms); };
  h.boundary.fetch = async (url, options) => {
    if (!url.startsWith(PREFIX)) return inner(url, options);
    const route = url.slice(PREFIX.length);
    calls.push(route);
    within = route === previous ? within + 1 : 1;
    previous = route;
    const planned = answer(route, calls.filter(r => r === route).length, within);
    if (planned === undefined) return inner(url, options);
    if (planned.rewrite) return replied(planned.rewrite(JSON.parse(await (await inner(url, options)).text())));
    return planned;
  };
  return { calls, delays, count: route => calls.filter(r => r === route).length };
}

// ---------------------------------------------------------------- F1 controls

// A transient answer to the ref read-back is retried and the window ARMS. The
// retry is not silent: the record names the read that raced and how many
// attempts it took.
async function refRaceCheck(create, h) {
  const reads = interceptReads(h, (route, attempt) => route === REF140 && attempt === 1 ? failure(503) : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.state, 'ARMED', 'B5_REF_READ_RACE_RETRIED');
  assert.equal(result.code ?? null, null, 'B5_REF_READ_RACE_RETRIED');
  assert.deepEqual(result.api_read_retries, [{ operation: `github:${REF140}`, attempts: 2 }], 'B5_REF_READ_RACE_RETRIED');
  assert.deepEqual(reads.delays, [1000], 'B5_REF_READ_RACE_RETRIED');
  assert.ok(h.exists(ACTIVATION), 'B5_REF_READ_RACE_RETRIED');
}

// The exact shape the target host produced: the push LANDS, and the comparison
// that reads it back is not answerable yet. Two transient 404s and the window
// still arms.
async function compareRaceCheck(create, h) {
  const route = compareRoute(h);
  const reads = interceptReads(h, (r, attempt) => r === route && attempt <= 2 ? failure(404) : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.state, 'ARMED', 'B5_COMPARE_RACE_RETRIED');
  assert.deepEqual(result.api_read_retries, [{ operation: `github:${route}`, attempts: 3 }], 'B5_COMPARE_RACE_RETRIED');
  assert.deepEqual(reads.delays, [1000, 2000], 'B5_COMPARE_RACE_RETRIED');
  assert.equal(reads.count(route), 3, 'B5_COMPARE_RACE_RETRIED');
}

// Retry is not tolerance. When EVERY attempt fails the window still refuses
// under the same name it refuses under today, the budget is spent exactly once,
// and nothing is armed: no activation file, no fixture card written.
async function persistentFailureCheck(create, h) {
  const route = compareRoute(h);
  const reads = interceptReads(h, r => r === route ? failure(503) : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_API_FAILED', 'B5_PERSISTENT_FAILURE_REFUSED');
  assert.equal(result.state, 'HALT', 'B5_PERSISTENT_FAILURE_REFUSED');
  assert.equal(reads.count(route), READ_RETRY.attempts, 'B5_PERSISTENT_FAILURE_REFUSED');
  assert.deepEqual(reads.delays, [...READ_RETRY.delaysMs], 'B5_PERSISTENT_FAILURE_REFUSED');
  assert.equal(result.api_failure?.attempts, READ_RETRY.attempts, 'B5_PERSISTENT_FAILURE_REFUSED');
  assert.equal(h.exists(ACTIVATION), false, 'B5_PERSISTENT_FAILURE_REFUSED');
  assert.deepEqual(cardWrites(h), [], 'B5_PERSISTENT_FAILURE_REFUSED');
}

// A WRONG SHA IS NOT A RACE. The ref read-back answers 200 carrying a sha that is
// not the approved one on its first answer and the approved one on every answer
// afterwards. A correct retry never sees the difference: the read succeeded, so
// the comparison refuses ACT_REF_BINDING on that first answer and the route is
// never read again.
async function refMismatchCheck(create, h) {
  const reads = interceptReads(h, (route, attempt) =>
    route === REF140 && attempt === 1 ? { rewrite: () => ({ object: { sha: 'f'.repeat(40) } }) } : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_REF_BINDING', 'B5_REF_MISMATCH_NOT_RETRIED');
  assert.equal(result.state, 'HALT', 'B5_REF_MISMATCH_NOT_RETRIED');
  assert.equal(reads.count(REF140), 1, 'B5_REF_MISMATCH_NOT_RETRIED');
  assert.deepEqual(reads.delays, [], 'B5_REF_MISMATCH_NOT_RETRIED');
  assert.equal(result.api_read_retries, undefined, 'B5_REF_MISMATCH_NOT_RETRIED');
  assert.equal(h.exists(ACTIVATION), false, 'B5_REF_MISMATCH_NOT_RETRIED');
}

// The same claim at the comparison the post-push step makes: a real ancestry
// answer that is not `ahead` refuses ACT_REMOTE_ANCESTRY on the first answer and
// is never retried into acceptance, however correct a later answer would be.
async function ancestryMismatchCheck(create, h) {
  const route = compareRoute(h);
  const reads = interceptReads(h, (r, attempt) =>
    r === route && attempt === 1 ? { rewrite: body => ({ ...body, status: 'behind' }) } : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_REMOTE_ANCESTRY', 'B5_ANCESTRY_MISMATCH_NOT_RETRIED');
  assert.equal(reads.count(route), 1, 'B5_ANCESTRY_MISMATCH_NOT_RETRIED');
  assert.deepEqual(reads.delays, [], 'B5_ANCESTRY_MISMATCH_NOT_RETRIED');
  assert.equal(h.exists(ACTIVATION), false, 'B5_ANCESTRY_MISMATCH_NOT_RETRIED');
}

// THE PUSH IS A MUTATION AND IS NEVER RETRIED. A failing push refuses
// ACT_COMMAND_FAILED after exactly one attempt, exactly as it does today.
async function pushNotRetriedCheck(create, h) {
  const inner = h.boundary.run;
  let pushes = 0;
  h.boundary.readWait = async () => {};
  h.boundary.run = (exe, argv, options) => {
    if (argv.includes('push')) { pushes++; return { status: 1, stdout: '' }; }
    return inner(exe, argv, options);
  };
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_COMMAND_FAILED', 'B5_PUSH_NOT_RETRIED');
  assert.equal(pushes, 1, 'B5_PUSH_NOT_RETRIED');
  assert.equal(h.exists(ACTIVATION), false, 'B5_PUSH_NOT_RETRIED');
}

// The Linear issueUpdate is a mutation too, and it does not reach the retried
// door at all: a failing update is attempted once and refuses under its own name.
async function linearMutationNotRetriedCheck(create, h) {
  const inner = h.boundary.fetch;
  let mutations = 0;
  h.boundary.readWait = async () => {};
  h.boundary.fetch = async (url, options) => {
    if (url === 'https://api.linear.app/graphql' && JSON.parse(options.body).query.startsWith('mutation')) {
      mutations++; return failure(503);
    }
    return inner(url, options);
  };
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_API_FAILED', 'B5_LINEAR_MUTATION_NOT_RETRIED');
  assert.equal(mutations, 1, 'B5_LINEAR_MUTATION_NOT_RETRIED');
  assert.equal(result.api_failure?.operation, 'linear:mutation:Shu71Fixture', 'B5_LINEAR_MUTATION_NOT_RETRIED');
  assert.equal(h.exists(ACTIVATION), false, 'B5_LINEAR_MUTATION_NOT_RETRIED');
}

// THE BOUND IS OVERALL, NOT PER CALL. Four consecutive reads each race four times
// and succeed, spending the whole per-invocation sleep budget; the fifth read
// races and has nothing left, so it refuses immediately rather than extending the
// window further.
async function budgetCheck(create, h) {
  const reads = interceptReads(h, (route, attempt, within) => within <= 4 ? failure(503) : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_API_FAILED', 'B5_RETRY_BUDGET_BOUNDED');
  assert.equal(result.api_failure?.operation, `github:${REF254}`, 'B5_RETRY_BUDGET_BOUNDED');
  assert.equal(result.api_failure?.attempts, 1, 'B5_RETRY_BUDGET_BOUNDED');
  assert.equal(reads.delays.reduce((a, b) => a + b, 0), READ_RETRY.budgetMs, 'B5_RETRY_BUDGET_BOUNDED');
  assert.equal(result.api_read_retries?.length, 4, 'B5_RETRY_BUDGET_BOUNDED');
  assert.equal(h.exists(ACTIVATION), false, 'B5_RETRY_BUDGET_BOUNDED');
}

// A RETRY MAY NEVER OUTLIVE THE AUTHORIZATION IT SERVES. The read races, the
// approved window expires while the first backoff is waited out, and the second
// failure is refused rather than retried - even though a third attempt would have
// succeeded.
async function expiryCheck(create, h) {
  const reads = interceptReads(h, (route, attempt) => route === REF140 && attempt <= 2 ? failure(503) : undefined);
  h.boundary.readWait = async ms => { reads.delays.push(ms); h.expire(); };
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_API_FAILED', 'B5_RETRY_STOPS_AT_EXPIRY');
  assert.equal(result.api_failure?.attempts, 2, 'B5_RETRY_STOPS_AT_EXPIRY');
  assert.deepEqual(reads.delays, [1000], 'B5_RETRY_STOPS_AT_EXPIRY');
  assert.equal(h.exists(ACTIVATION), false, 'B5_RETRY_STOPS_AT_EXPIRY');
}

// ---------------------------------------------------------------- F2 controls

// The halt names WHICH call failed and WHAT the answer was, in the returned
// record and in the durable journal - and carries no token, header or body. 403
// is a definitive refusal rather than a race, so it is also never retried.
async function haltNamesCallCheck(create, h) {
  const route = compareRoute(h);
  const reads = interceptReads(h, r => r === route ? failure(403) : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  const expected = { operation: `github:${route}`, reason: 'response_not_ok', status: 403, attempts: 1 };
  assert.equal(result.code, 'ACT_API_FAILED', 'B5_HALT_NAMES_THE_CALL');
  assert.deepEqual(result.api_failure, expected, 'B5_HALT_NAMES_THE_CALL');
  assert.equal(reads.count(route), 1, 'B5_DEFINITIVE_STATUS_NOT_RETRIED');
  const halted = h.journal().filter(e => e.event === 'HALTED');
  assert.equal(halted.length, 1, 'B5_HALT_NAMES_THE_CALL');
  assert.deepEqual(halted[0].api_failure, expected, 'B5_HALT_NAMES_THE_CALL');
  assert.equal(halted[0].code, 'ACT_API_FAILED', 'B5_HALT_NAMES_THE_CALL');
  for (const secret of POISON) {
    assert.ok(!JSON.stringify(result).includes(secret), `B5_HALT_CARRIES_NO_SECRET ${secret}`);
    assert.ok(!JSON.stringify(halted[0]).includes(secret), `B5_HALT_CARRIES_NO_SECRET ${secret}`);
  }
}

// A GraphQL refusal arrives inside a 200. The halt names the reviewed operation
// and the error CODES, and nothing from the query, the variables or the body.
async function graphqlCodesCheck(create, h) {
  const inner = h.boundary.fetch;
  h.boundary.readWait = async () => {};
  let queries = 0;
  h.boundary.fetch = async (url, options) => {
    if (url === 'https://api.linear.app/graphql' && JSON.parse(options.body).query.startsWith('query')) {
      queries++;
      return replied({ errors: [{ message: `token ${'GITHUB_POISON'} rejected`, extensions: { code: 'AUTHENTICATION_ERROR' } }] });
    }
    return inner(url, options);
  };
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_API_FAILED', 'B5_GRAPHQL_CODES_NAMED');
  assert.deepEqual(result.api_failure, { operation: 'linear:query:Shu71Fixture', reason: 'graphql_errors', codes: ['AUTHENTICATION_ERROR'] }, 'B5_GRAPHQL_CODES_NAMED');
  assert.equal(queries, 1, 'B5_GRAPHQL_CODES_NAMED');
  for (const secret of POISON) assert.ok(!JSON.stringify(result).includes(secret), `B5_HALT_CARRIES_NO_SECRET ${secret}`);
}

// The reported detail is CLOSED, proved directly on the exported sanitizer: the
// only way anything but a route label, a status, a fault name, GraphQL codes and
// an attempt count can reach a record is through this function.
function detailClosureCheck(detail) {
  assert.deepEqual(detail({ operation: 'github:compare/a...b', reason: 'response_not_ok', status: 404, attempts: 3 }),
    { operation: 'github:compare/a...b', reason: 'response_not_ok', status: 404, attempts: 3 }, 'B5_DETAIL_ACCEPTS_REVIEWED_SHAPE');
  // A percent-encoded branch segment is a route and survives verbatim.
  assert.equal(detail({ operation: `github:${REF140}` }).operation, `github:${REF140}`, 'B5_DETAIL_OPERATION_CLOSED');
  // Anything that is not a route label is not reported as one - in particular a
  // URL with embedded credentials, a query string or a fragment.
  for (const operation of ['Bearer GITHUB_POISON', 'token=GITHUB_POISON', 'https://x:GITHUB_POISON@api.github.com/',
    'github:x?token=GITHUB_POISON', 'github:x#GITHUB_POISON', 'a'.repeat(121), 42, null, undefined])
    assert.equal(detail({ operation }).operation, 'unknown', 'B5_DETAIL_OPERATION_CLOSED');
  // Status is a number in the HTTP range and nothing else.
  for (const status of ['403', 42, 600, 1.5, 'GITHUB_POISON'])
    assert.equal(Object.hasOwn(detail({ status }), 'status'), false, 'B5_DETAIL_STATUS_CLOSED');
  // A reason outside the reviewed vocabulary is dropped, never echoed.
  assert.equal(Object.hasOwn(detail({ reason: 'GITHUB_POISON' }), 'reason'), false, 'B5_DETAIL_REASON_CLOSED');
  // Codes are short identifiers; a message, a header or a token is not one.
  assert.equal(Object.hasOwn(detail({ codes: ['Bearer GITHUB_POISON', 'x'.repeat(65), 7, null] }), 'codes'), false, 'B5_DETAIL_CODES_CLOSED');
  assert.deepEqual(detail({ codes: ['A', 'A', 'B'] }).codes, ['A', 'B'], 'B5_DETAIL_CODES_CLOSED');
  assert.equal(detail({ codes: Array.from({ length: 20 }, (_, i) => `C${i}`) }).codes.length, 8, 'B5_DETAIL_CODES_CLOSED');
  // A transport fault is named, not described.
  assert.equal(Object.hasOwn(detail({ fault: 'fetch failed: GITHUB_POISON' }), 'fault'), false, 'B5_DETAIL_FAULT_CLOSED');
  assert.equal(detail({ fault: 'TimeoutError' }).fault, 'TimeoutError', 'B5_DETAIL_FAULT_CLOSED');
  // Nothing unnamed survives, and re-sanitizing a sanitized detail is a no-op.
  const hostile = { operation: 'github:x', body: 'GITHUB_POISON', headers: { Authorization: 'Bearer GITHUB_POISON' }, url: PREFIX, attempts: -1 };
  assert.deepEqual(detail(hostile), { operation: 'github:x' }, 'B5_DETAIL_DROPS_EVERYTHING_ELSE');
  assert.deepEqual(detail(detail(hostile)), detail(hostile), 'B5_DETAIL_IDEMPOTENT');
}

// Which outcomes the bounded retry is allowed to treat as transient, proved on
// the exported predicate: a definitive refusal is the answer, not a race.
function retryableClosureCheck(retryable) {
  assert.equal(retryable({ api: { reason: 'transport', operation: 'github:x' } }), true, 'B5_RETRYABLE_TRANSPORT');
  for (const status of RETRYABLE_READ_STATUS)
    assert.equal(retryable({ api: { reason: 'response_not_ok', status } }), true, 'B5_RETRYABLE_TRANSIENT_STATUS');
  for (const status of [400, 401, 403, 410, 422, 451])
    assert.equal(retryable({ api: { reason: 'response_not_ok', status } }), false, 'B5_RETRYABLE_DEFINITIVE_REFUSED');
  for (const reason of ['response_too_large', 'graphql_errors'])
    assert.equal(retryable({ api: { reason, status: 503 } }), false, 'B5_RETRYABLE_REASON_CLOSED');
  for (const error of [undefined, null, {}, { api: null }, { api: 'transport' }, { code: 'ACT_REF_BINDING' }])
    assert.equal(retryable(error), false, 'B5_RETRYABLE_REQUIRES_MEASURED_DETAIL');
}

const controls = [
  ['a transient ref read-back is retried and the window arms', refRaceCheck],
  ['a landed push whose comparison is not answerable yet still arms', compareRaceCheck],
  ['a persistently failing read still refuses under the same name', persistentFailureCheck],
  ['a genuinely wrong ref sha refuses instead of being retried', refMismatchCheck],
  ['a genuinely wrong ancestry refuses instead of being retried', ancestryMismatchCheck],
  ['a failing push is never retried', pushNotRetriedCheck],
  ['a failing Linear issueUpdate is never retried', linearMutationNotRetriedCheck],
  ['the retry sleep budget is bounded across the whole invocation', budgetCheck],
  ['retrying stops at the authorization expiry', expiryCheck],
  ['the halt names the failing route and status and carries no secret', haltNamesCallCheck],
  ['a GraphQL refusal is named by its codes', graphqlCodesCheck],
];
for (const [name, check] of controls)
  test(`B5 post-push read-back: ${name}`, async t => { await check(createShu71Production, fixture(t)); });
test('B5 post-push read-back: the reported detail is closed to the reviewed fields',
  () => detailClosureCheck(apiFailureDetail));
test('B5 post-push read-back: only a measured transient outcome is retryable',
  () => retryableClosureCheck(retryableApiFailure));

// One anchored substitution, loaded from a disposable path. A module-load or
// syntax error cannot count as a kill.
async function loadMutant(t, before, after) {
  assert.equal(source.split(before).length, 2, 'B5_MUTATION_ANCHOR_UNIQUE');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-readback-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modified = source.replace(before, after).replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_, prefix, quote, relative) => `${prefix}${quote}${new URL(relative, moduleUrl).href}${quote}`);
  const file = path.join(root, 'production.mjs'); fs.writeFileSync(file, modified);
  return import(pathToFileURL(file));
}
// The killing assertion is reported, not merely counted.
async function killedBy(t, run) {
  let killed = null;
  await assert.rejects(run, error => {
    killed = error; return error.code === 'ERR_ASSERTION' && /B5_/.test(error.message);
  }, 'B5_MUTATION_NAMED_ASSERTION');
  t.diagnostic(`killed by ${/B5_[A-Z_0-9]+/.exec(killed.message)?.[0]}`);
}

const REF_READ = '      const readback = await githubRead(`git/ref/heads/${encodeURIComponent(fixture.branch)}`);';
const COMPARE_READ = '        const comparison = await githubRead(`compare/${old}...${next}`);';
const PUSH = "          git(spec, ['push', '--porcelain', `--force-with-lease=${ref}:${old}`, REMOTE, `${next}:${ref}`], { remote: true });";
const GIVE_UP = '          throw describeApiFailure(error, { attempts: attempt });';
const mutations = [
  // The retry removed, at the policy and at each retried call site.
  ['the retry policy allows a single attempt', 'attempts: 5, delaysMs', 'attempts: 1, delaysMs', refRaceCheck],
  ['the backoff schedule is emptied', 'Object.freeze([1000, 2000, 4000, 8000])', 'Object.freeze([])', compareRaceCheck],
  ['the ref read-back goes back to the unretried door', REF_READ, REF_READ.replace('githubRead(', 'github('), refRaceCheck],
  ['the post-push comparison goes back to the unretried door', COMPARE_READ, COMPARE_READ.replace('githubRead(', 'github('), compareRaceCheck],
  // The retry made accepting: a spent budget must never substitute an answer.
  ['an exhausted retry returns an empty answer instead of refusing', GIVE_UP, '          return {};', persistentFailureCheck],
  // The retry made unbounded, by each of its three bounds.
  ['the overall sleep budget is not enforced', '|| delay > readRetryBudgetMs', '|| false', budgetCheck],
  ['the authorization expiry does not stop the retry', '|| !(b.now() < authorizationEnds)', '|| false', expiryCheck],
  ['a definitive status is treated as transient', 'RETRYABLE_READ_STATUS = Object.freeze([404,', 'RETRYABLE_READ_STATUS = Object.freeze([403, 404,', haltNamesCallCheck],
  // The retry widened from the CALL to the COMPARISON, at both binding sites.
  ['the ref comparison itself is retried until it agrees', REF_READ,
    '      let readback = await githubRead(`git/ref/heads/${encodeURIComponent(fixture.branch)}`);\n'
    + '      for (let retry = 1; retry < READ_RETRY.attempts && readback.object?.sha !== expected; retry++)\n'
    + '        readback = await githubRead(`git/ref/heads/${encodeURIComponent(fixture.branch)}`);', refMismatchCheck],
  ['the ancestry comparison itself is retried until it agrees', COMPARE_READ,
    '        let comparison = await githubRead(`compare/${old}...${next}`);\n'
    + "        for (let retry = 1; retry < READ_RETRY.attempts && comparison.status !== 'ahead'; retry++)\n"
    + '          comparison = await githubRead(`compare/${old}...${next}`);', ancestryMismatchCheck],
  // The retry applied to a MUTATION.
  ['the push is retried like a read', PUSH,
    '          for (let attempt = 1; ; attempt++) {\n'
    + '            try { git(spec, [\'push\', \'--porcelain\', `--force-with-lease=${ref}:${old}`, REMOTE, `${next}:${ref}`], { remote: true }); break; }\n'
    + '            catch (error) { if (attempt >= READ_RETRY.attempts) throw error; await readWait(READ_RETRY.delaysMs[attempt - 1]); }\n'
    + '          }', pushNotRetriedCheck],
  // F2: the halt stops naming the call, by each of its two doors.
  ['the halt record drops the measured API detail',
    '      const detail = { ...apiFailureRecord(error), ...readRetryRecord() };', '      const detail = {};', haltNamesCallCheck],
  ['a failed call is no longer described at all',
    '    try { error.api = apiFailureDetail({ ...error.api, ...detail }); }', '    try { error.api = undefined; }', haltNamesCallCheck],
  ['the GraphQL error codes are not collected', '.flatMap(error => [error?.extensions?.code, error?.extensions?.type, error?.code])',
    '.flatMap(() => [])', graphqlCodesCheck],
];
for (const [name, before, after, check] of mutations)
  test(`B5 post-push read-back mutation: ${name}`, async t => {
    await check(createShu71Production, fixture(t));
    const mutant = await loadMutant(t, before, after);
    await killedBy(t, () => check(mutant.createShu71Production, fixture(t)));
  });

// The sanitizer's own doors. None is reachable through the entrypoint - every
// label this module builds is already a route - so each is killed by the direct
// closure control instead.
const closureMutations = [
  ['the operation label is echoed unsanitized', detailClosureCheck, apiFailureDetail,
    'API_OPERATION_PATTERN.test(detail.operation) ? detail.operation : \'unknown\'', 'true ? detail.operation : \'unknown\''],
  ['the status is echoed unchecked', detailClosureCheck, apiFailureDetail,
    'if (Number.isSafeInteger(detail.status) && detail.status >= 100 && detail.status <= 599) record.status = detail.status;',
    'record.status = detail.status;'],
  ['the GraphQL codes are echoed unfiltered', detailClosureCheck, apiFailureDetail,
    '.filter(code => typeof code === \'string\' && API_CODE_PATTERN.test(code));', '.slice();'],
  ['the transport fault is echoed unfiltered', detailClosureCheck, apiFailureDetail,
    'if (typeof detail.fault === \'string\' && API_CODE_PATTERN.test(detail.fault)) record.fault = detail.fault;',
    'if (typeof detail.fault === \'string\') record.fault = detail.fault;'],
  ['the reason vocabulary is opened', detailClosureCheck, apiFailureDetail,
    'if (API_REASONS.includes(detail.reason)) record.reason = detail.reason;', 'record.reason = detail.reason;'],
  ['a refusal with no measured detail is retryable', retryableClosureCheck, retryableApiFailure,
    "  if (detail === null || typeof detail !== 'object') return false;\n  if (detail.reason === 'transport') return true;",
    "  if (detail === null || typeof detail !== 'object') return true;\n  if (detail.reason === 'transport') return true;"],
  ['every reason is retryable once a status matches', retryableClosureCheck, retryableApiFailure,
    "  return detail.reason === 'response_not_ok' && RETRYABLE_READ_STATUS.includes(detail.status);",
    '  return RETRYABLE_READ_STATUS.includes(detail.status);'],
];
for (const [name, check, reviewed, before, after] of closureMutations)
  test(`B5 post-push read-back mutation: ${name}`, async t => {
    check(reviewed);
    const mutant = await loadMutant(t, before, after);
    await killedBy(t, async () => check(mutant[reviewed.name]));
  });
