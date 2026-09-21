// SHU-71 post-push read-back robustness: the round's controls, its mutations and
// the mutant loader, kept out of the .test.mjs file so the same checks can be
// driven test-by-test by node --test and, unchanged, by the round's mutant x
// control matrix and by its RED measurement against the pre-fix revision.
//
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
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { READ_RETRY, RETRYABLE_READ_STATUS, apiFailureDetail, retryableApiFailure } from '../shu71-production.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
export const keys = ephemeralPublicSource();
export const moduleUrl = new URL('../shu71-production.mjs', import.meta.url);
export const source = fs.readFileSync(moduleUrl, 'utf8');
const ACTIVATION = '/srv/shu/state/shu71-activation.json';
const PREFIX = 'https://api.github.com/repos/BAWES-Universe/studenthub-platform/';
const REF140 = 'git/ref/heads/coordinator%2FSHU-140';
const REF254 = 'git/ref/heads/coordinator%2FSHU-254';
const MAIN = 'git/ref/heads/main';
const commitRoute = h => `git/commits/${h.spec.pkg.reseed.expected_seed_head}`;
const compareRoute = h => `compare/${h.spec.pkg.reseed.expected_parent}...${h.spec.pkg.reseed.expected_seed_head}`;
// Secrets the disposable fixture plants behind every call this module makes.
const POISON = ['GITHUB_POISON', 'LINEAR_POISON', 's'.repeat(40), 'Authorization', 'Bearer', 'x-access-token'];

export const fixture = t => productionFixture(t, keys);
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
export async function refRaceCheck(create, h) {
  const reads = interceptReads(h, (route, attempt) => route === REF140 && attempt === 1 ? failure(503) : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.state, 'ARMED', 'B5_REF_READ_RACE_RETRIED');
  assert.equal(result.code ?? null, null, 'B5_REF_READ_RACE_RETRIED');
  assert.deepEqual(result.api_read_retries, [{ operation: `github:${REF140}`, attempts: 2 }], 'B5_REF_READ_RACE_RETRIED');
  assert.deepEqual(reads.delays, [1000], 'B5_REF_READ_RACE_RETRIED');
  assert.ok(h.exists(ACTIVATION), 'B5_REF_READ_RACE_RETRIED');
}

// The exact shape the target host produced: the push LANDS, and the read that
// establishes the ancestry is not answerable yet. Two transient 404s and the
// window still arms.
export async function compareRaceCheck(create, h) {
  const route = commitRoute(h);
  const reads = interceptReads(h, (r, attempt) => r === route && attempt <= 2 ? failure(404) : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.state, 'ARMED', 'B5_COMPARE_RACE_RETRIED');
  assert.deepEqual(result.api_read_retries, [{ operation: `github:${route}`, attempts: 3 }], 'B5_COMPARE_RACE_RETRIED');
  assert.deepEqual(reads.delays, [1000, 2000], 'B5_COMPARE_RACE_RETRIED');
  assert.equal(reads.count(route), 3, 'B5_COMPARE_RACE_RETRIED');
}

// THE READ IS BOUNDED AND STAYS BOUNDED. A window that arms does not ask for the
// patch-bearing comparison at all - the body that refused a landed push in
// production cannot be requested again by a successful run - and the relation is
// read from the commit object instead.
export async function boundedReadCheck(create, h) {
  const inner = h.boundary.fetch;
  const routes = [];
  h.boundary.readWait = async () => {};
  h.boundary.fetch = async (url, options) => {
    if (url.startsWith(PREFIX)) routes.push(url.slice(PREFIX.length));
    return inner(url, options);
  };
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.state, 'ARMED', 'B5_ANCESTRY_READ_STAYS_BOUNDED');
  assert.equal(routes.includes(compareRoute(h)), false, 'B5_ANCESTRY_READ_STAYS_BOUNDED');
  assert.ok(routes.includes(commitRoute(h)), 'B5_ANCESTRY_READ_STAYS_BOUNDED');
}

// Retry is not tolerance. When EVERY attempt fails the window still refuses
// under the same name it refuses under today, the budget is spent exactly once,
// and nothing is armed: no activation file, no fixture card written.
export async function persistentFailureCheck(create, h) {
  const route = commitRoute(h);
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
export async function refMismatchCheck(create, h) {
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

// The same claim at the ancestry the post-push step reads: a reseed commit whose
// own object is not the signed one refuses ACT_REMOTE_ANCESTRY on the first
// answer and is never retried into acceptance, however correct a later answer
// would be. This control corrupts EVERY answer to the route, so a mutant that
// retries until the answer agrees cannot walk out of it either.
export async function ancestryMismatchCheck(create, h) {
  const route = commitRoute(h);
  const reads = interceptReads(h, (r, attempt) =>
    r === route ? { rewrite: body => ({ ...body, sha: 'f'.repeat(40) }) } : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_REMOTE_ANCESTRY', 'B5_ANCESTRY_MISMATCH_NOT_RETRIED');
  assert.equal(reads.count(route), 1, 'B5_ANCESTRY_MISMATCH_NOT_RETRIED');
  assert.deepEqual(reads.delays, [], 'B5_ANCESTRY_MISMATCH_NOT_RETRIED');
  assert.equal(h.exists(ACTIVATION), false, 'B5_ANCESTRY_MISMATCH_NOT_RETRIED');
}

// THE PARENTS ARE THE PAIR, IN ORDER. The merge's first parent is the one this
// package retained and its second is the approved execution revision; the same
// two shas the other way round are not that pair, and neither is a list of the
// wrong length. Both disagreeing shapes refuse under the ancestry name on the
// first answer.
export async function parentOrderCheck(create, h) {
  const route = commitRoute(h);
  const reads = interceptReads(h, r =>
    r === route ? { rewrite: body => ({ ...body, parents: [...body.parents].reverse() }) } : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_REMOTE_ANCESTRY', 'B5_ANCESTRY_PARENT_ORDER_REQUIRED');
  assert.equal(reads.count(route), 1, 'B5_ANCESTRY_PARENT_ORDER_REQUIRED');
  assert.deepEqual(reads.delays, [], 'B5_ANCESTRY_PARENT_ORDER_REQUIRED');
  assert.equal(h.exists(ACTIVATION), false, 'B5_ANCESTRY_PARENT_ORDER_REQUIRED');
}

// ...and EXACTLY TWO parents is its own term: a three-parent commit whose first
// two parents are the bound pair - a merge that also brings a third parent in -
// has the right pair in the right order and is still not the commit this package
// bound. This is the case the count term alone can see.
export async function parentCountCheck(create, h) {
  const route = commitRoute(h);
  const reads = interceptReads(h, r =>
    r === route ? { rewrite: body => ({ ...body, parents: [...body.parents, { sha: 'f'.repeat(40) }] }) } : undefined);
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_REMOTE_ANCESTRY', 'B5_ANCESTRY_PARENT_COUNT_REQUIRED');
  assert.equal(reads.count(route), 1, 'B5_ANCESTRY_PARENT_COUNT_REQUIRED');
  assert.deepEqual(reads.delays, [], 'B5_ANCESTRY_PARENT_COUNT_REQUIRED');
  assert.equal(h.exists(ACTIVATION), false, 'B5_ANCESTRY_PARENT_COUNT_REQUIRED');
}

// Observe the reseed-ref answers as the fixture actually serves them, so a control can
// ASSERT the ref term instead of leaving it true by construction. Reads the body once and
// re-serves it, because the fixture's answers are plain objects with a single-use text().
function observeRefAnswers(h, route, seen) {
  const inner = h.boundary.fetch;
  h.boundary.fetch = async (url, options) => {
    const response = await inner(url, options);
    if (url.startsWith(PREFIX) && url.slice(PREFIX.length) === route && typeof response?.text === 'function') {
      const body = await response.text();
      try { seen.push(JSON.parse(body)?.object?.sha ?? null); } catch { seen.push(null); }
      return { ok: response.ok, status: response.status, text: async () => body };
    }
    return response;
  };
}

// EACH PARENT POSITION IS ITS OWN TERM. "The pair, in order" is not one claim
// but two - the retained parent must be the FIRST parent and the approved
// execution revision the SECOND - and reversing the pair (above) can be refused
// for either position alone, so it pins neither. This control corrupts ONLY
// position 0 and leaves every other term of the claim true: the signed reseed
// sha is still the commit's own sha, the count is still two, position 1 is still
// the approved execution revision, and the ref still carries the commit. It is
// refused under the ancestry name on the first answer by this control's own
// assertion, and the shape it served is asserted before the refusal is read, so
// a mutant that drops this position alone is killed here and nowhere else.
export async function parentPositionZeroCheck(create, h) {
  const route = commitRoute(h);
  const genuine = [h.spec.pkg.reseed.expected_parent, h.spec.binding.approvedExecutionRevision];
  const foreign = 'f'.repeat(40);
  let served = null;
  const reads = interceptReads(h, (r, attempt) => (r === route && attempt === 1
    ? { rewrite: body => (served = { ...body, parents: [{ sha: foreign }, ...body.parents.slice(1)] }) }
    : undefined));
  const refShas = [];
  observeRefAnswers(h, REF140, refShas);
  const result = await create(h.id, h.boundary).execute('run');
  assert.ok(served, 'B5_ANCESTRY_PARENT_0_REQUIRED');
  // The ref term is MEASURED here, not left true by construction: the last ref answer this
  // run received must still carry the signed reseed commit.
  assert.ok(refShas.length > 0, 'B5_ANCESTRY_PARENT_0_REQUIRED');
  assert.equal(refShas[refShas.length - 1], h.spec.pkg.reseed.expected_seed_head,
    'B5_ANCESTRY_PARENT_0_REQUIRED');
  assert.equal(served.sha, h.spec.pkg.reseed.expected_seed_head, 'B5_ANCESTRY_PARENT_0_REQUIRED');
  assert.equal(served.parents.length, 2, 'B5_ANCESTRY_PARENT_0_REQUIRED');
  assert.equal(served.parents[1].sha, genuine[1], 'B5_ANCESTRY_PARENT_0_REQUIRED');
  assert.equal(served.parents.filter((parent, index) => parent.sha !== genuine[index]).length, 1,
    'B5_ANCESTRY_PARENT_0_REQUIRED');
  assert.equal(served.parents[0].sha, foreign, 'B5_ANCESTRY_PARENT_0_REQUIRED');
  assert.equal(result.code, 'ACT_REMOTE_ANCESTRY', 'B5_ANCESTRY_PARENT_0_REQUIRED');
  assert.equal(reads.count(route), 1, 'B5_ANCESTRY_PARENT_0_REQUIRED');
  assert.deepEqual(reads.delays, [], 'B5_ANCESTRY_PARENT_0_REQUIRED');
  assert.equal(h.exists(ACTIVATION), false, 'B5_ANCESTRY_PARENT_0_REQUIRED');
}

// ...and the mirror: ONLY position 1 is corrupted, the count, the signed sha,
// position 0 and the ref all remain true, and this control's own assertion is
// the one that fires.
export async function parentPositionOneCheck(create, h) {
  const route = commitRoute(h);
  const genuine = [h.spec.pkg.reseed.expected_parent, h.spec.binding.approvedExecutionRevision];
  const foreign = 'f'.repeat(40);
  let served = null;
  const reads = interceptReads(h, (r, attempt) => (r === route && attempt === 1
    ? { rewrite: body => (served = { ...body, parents: [...body.parents.slice(0, 1), { sha: foreign }] }) }
    : undefined));
  const refShas = [];
  observeRefAnswers(h, REF140, refShas);
  const result = await create(h.id, h.boundary).execute('run');
  assert.ok(served, 'B5_ANCESTRY_PARENT_1_REQUIRED');
  assert.ok(refShas.length > 0, 'B5_ANCESTRY_PARENT_1_REQUIRED');
  assert.equal(refShas[refShas.length - 1], h.spec.pkg.reseed.expected_seed_head,
    'B5_ANCESTRY_PARENT_1_REQUIRED');
  assert.equal(served.sha, h.spec.pkg.reseed.expected_seed_head, 'B5_ANCESTRY_PARENT_1_REQUIRED');
  assert.equal(served.parents.length, 2, 'B5_ANCESTRY_PARENT_1_REQUIRED');
  assert.equal(served.parents[0].sha, genuine[0], 'B5_ANCESTRY_PARENT_1_REQUIRED');
  assert.equal(served.parents.filter((parent, index) => parent.sha !== genuine[index]).length, 1,
    'B5_ANCESTRY_PARENT_1_REQUIRED');
  assert.equal(served.parents[1].sha, foreign, 'B5_ANCESTRY_PARENT_1_REQUIRED');
  assert.equal(result.code, 'ACT_REMOTE_ANCESTRY', 'B5_ANCESTRY_PARENT_1_REQUIRED');
  assert.equal(reads.count(route), 1, 'B5_ANCESTRY_PARENT_1_REQUIRED');
  assert.deepEqual(reads.delays, [], 'B5_ANCESTRY_PARENT_1_REQUIRED');
  assert.equal(h.exists(ACTIVATION), false, 'B5_ANCESTRY_PARENT_1_REQUIRED');
}

// A REF THAT MOVED BETWEEN THE TWO READS IS SOMEONE ELSE'S WRITE. The commit
// object still agrees with the signed reseed sha and its parents still agree, so
// only the ref read that follows it can see the third value - and it refuses
// under the ancestry name on the first answer rather than being retried, which
// the single observed read proves.
export async function refMovedAfterPushCheck(create, h) {
  const inner = h.boundary.fetch;
  const route = commitRoute(h);
  let commits = 0, refsAfterCommit = 0;
  h.boundary.readWait = async () => {};
  h.boundary.fetch = async (url, options) => {
    if (url.startsWith(PREFIX)) {
      const read = url.slice(PREFIX.length);
      if (read === route) commits++;
      if (read === REF140 && commits > 0) { refsAfterCommit++; return replied({ object: { sha: 'f'.repeat(40) } }); }
    }
    return inner(url, options);
  };
  const result = await create(h.id, h.boundary).execute('run');
  assert.equal(result.code, 'ACT_REMOTE_ANCESTRY', 'B5_ANCESTRY_REF_MOVED_NOT_RETRIED');
  assert.equal(refsAfterCommit, 1, 'B5_ANCESTRY_REF_MOVED_NOT_RETRIED');
  assert.equal(h.exists(ACTIVATION), false, 'B5_ANCESTRY_REF_MOVED_NOT_RETRIED');
}

// THE PUSH IS A MUTATION AND IS NEVER RETRIED. A failing push refuses
// ACT_COMMAND_FAILED after exactly one attempt, exactly as it does today.
export async function pushNotRetriedCheck(create, h) {
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
export async function linearMutationNotRetriedCheck(create, h) {
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
export async function budgetCheck(create, h) {
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
export async function expiryCheck(create, h) {
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
export async function haltNamesCallCheck(create, h) {
  const route = commitRoute(h);
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
export async function graphqlCodesCheck(create, h) {
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
  // The Linear QUERY now reaches the retried read door, so a failed call on
  // that route reports its attempt count exactly as the GitHub routes do. A
  // GraphQL refusal arrives inside a 200 and is never a race, so the count is
  // one: it gave up on the first answer rather than retrying a refusal.
  assert.deepEqual(result.api_failure, { operation: 'linear:query:Shu71Fixture', reason: 'graphql_errors', codes: ['AUTHENTICATION_ERROR'], attempts: 1 }, 'B5_GRAPHQL_CODES_NAMED');
  assert.equal(queries, 1, 'B5_GRAPHQL_CODES_NAMED');
  for (const secret of POISON) assert.ok(!JSON.stringify(result).includes(secret), `B5_HALT_CARRIES_NO_SECRET ${secret}`);
}

// The reported detail is CLOSED, proved directly on the exported sanitizer: the
// only way anything but a route label, a status, a fault name, GraphQL codes and
// an attempt count can reach a record is through this function.
export function detailClosureCheck(detail) {
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
export function retryableClosureCheck(retryable) {
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

export const controls = [
  ['a transient ref read-back is retried and the window arms', refRaceCheck],
  ['a landed push whose reseed commit read is not answerable yet still arms', compareRaceCheck],
  ['arming never asks for the patch-bearing comparison', boundedReadCheck],
  ['a persistently failing read still refuses under the same name', persistentFailureCheck],
  ['a genuinely wrong ref sha refuses instead of being retried', refMismatchCheck],
  ['a genuinely wrong ancestry refuses instead of being retried', ancestryMismatchCheck],
  ['parents in the other order refuse instead of being retried', parentOrderCheck],
  ['a third parent refuses instead of being retried', parentCountCheck],
  ['the first parent position alone is wrong and refuses under its own name',
    parentPositionZeroCheck],
  ['the second parent position alone is wrong and refuses under its own name',
    parentPositionOneCheck],
  ['a ref that moved after the push refuses instead of being retried', refMovedAfterPushCheck],
  ['a failing push is never retried', pushNotRetriedCheck],
  ['a failing Linear issueUpdate is never retried', linearMutationNotRetriedCheck],
  ['the retry sleep budget is bounded across the whole invocation', budgetCheck],
  ['retrying stops at the authorization expiry', expiryCheck],
  ['the halt names the failing route and status and carries no secret', haltNamesCallCheck],
  ['a GraphQL refusal is named by its codes', graphqlCodesCheck],
];
// One anchored substitution, loaded from a disposable path. A module-load or
// syntax error cannot count as a kill.
export async function loadMutant(t, before, after) {
  assert.equal(source.split(before).length, 2, 'B5_MUTATION_ANCHOR_UNIQUE');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-readback-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const modified = source.replace(before, after).replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_, prefix, quote, relative) => `${prefix}${quote}${new URL(relative, moduleUrl).href}${quote}`);
  const file = path.join(root, 'production.mjs'); fs.writeFileSync(file, modified);
  return import(pathToFileURL(file));
}
// The killing assertion is reported, not merely counted.
export async function killedBy(t, run) {
  let killed = null;
  await assert.rejects(run, error => {
    killed = error; return error.code === 'ERR_ASSERTION' && /B5_/.test(error.message);
  }, 'B5_MUTATION_NAMED_ASSERTION');
  t.diagnostic(`killed by ${/B5_[A-Z_0-9]+/.exec(killed.message)?.[0]}`);
}

const REF_READ = '      const readback = await githubRead(`git/ref/heads/${encodeURIComponent(fixture.branch)}`);';
// The post-push ancestry read this round bounded: one commit object, no patch
// array, plus the ref that must still carry it.
const COMMIT_READ = '        const reseedCommit = await githubRead(`git/commits/${next}`);';
const RESEED_REF_READ = '        const reseedRef = await githubRead(`git/ref/heads/${encodeURIComponent(pkg.reseed.branch)}`);';
const ANCESTRY_SHA = 'reseedCommit.sha === next && ';
const ANCESTRY_PARENTS = 'reseedParents[0] === spec.binding.expected_parent && reseedParents[1] === spec.binding.approvedExecutionRevision';
const ANCESTRY_COUNT = 'reseedParents.length === 2\n          && ';
// F3 closed: the two positions used to be one clause, pinned by a control that
// reversed BOTH parents, so a mutant that dropped either position alone survived
// the whole control set. Each position now has its own anchor, its own control
// and its own killing mutant - and each survivor of the earlier arrangement is
// killed here by the position control alone, which the reported killing
// assertion names.
const ANCESTRY_PARENT_0 = 'reseedParents[0] === spec.binding.expected_parent && ';
const ANCESTRY_PARENT_1 = ' && reseedParents[1] === spec.binding.approvedExecutionRevision';
const ANCESTRY_REF = '\n          && reseedRef.object?.sha === next';
// The route that answered 200 with 1,667,573 bytes of file patches and refused a
// landed push. It is never requested by a successful run - and this round's
// mutants are the ones that have to prove that stays true.
const COMPARE_READ = 'const comparison = await githubRead(`compare/${old}...${next}`);';
const PUSH = "          try { git(spec, ['push', '--porcelain', `--force-with-lease=${ref}:${old}`, REMOTE, `${next}:${ref}`], { remote: true }); }";
const GIVE_UP = '          throw describeApiFailure(error, { attempts: attempt });';
const BOUND = '        if (attempt >= READ_RETRY.attempts || delay === undefined || !retryableApiFailure(error)\n'
  + '          || delay > readRetryBudgetMs || !(b.now() < authorizationEnds)) {';
const HALT_DETAIL = '      const detail = { ...apiFailureRecord(error), ...commandFailureRecord(error), ...bindingLegRecord(error),\n'
  + "        ...(reviewedCode(error?.package_code) ? { package_code: error.package_code } : {}),\n"
  + '        ...readRetryRecord(), ...commandRetryRecord() };';
export const mutations = [
  // The retry removed, at the policy and at each retried call site.
  ['the retry policy allows a single attempt', 'attempts: 5, delaysMs', 'attempts: 1, delaysMs', refRaceCheck],
  ['the backoff schedule is emptied', 'Object.freeze([1000, 2000, 4000, 8000])', 'Object.freeze([])', compareRaceCheck],
  ['the ref read-back goes back to the unretried door', REF_READ, REF_READ.replace('githubRead(', 'github('), refRaceCheck],
  ['the post-push ancestry read goes back to the unretried door', COMMIT_READ, COMMIT_READ.replace('githubRead(', 'github('), compareRaceCheck],
  // The retry made accepting: a spent budget must never substitute an answer.
  ['an exhausted retry returns an empty answer instead of refusing', GIVE_UP, '          return {};', persistentFailureCheck],
  // The retry made unbounded, by each of its three bounds.
  // Both bounds now also guard the post-update Linear read-back loop, so each
  // anchor names the retried-read door's own giving-up condition rather than
  // the bare clause. Same bound, same control, same killing assertion.
  ['the overall sleep budget is not enforced', BOUND, BOUND.replace('|| delay > readRetryBudgetMs', '|| false'), budgetCheck],
  ['the authorization expiry does not stop the retry', BOUND, BOUND.replace('|| !(b.now() < authorizationEnds)', '|| false'), expiryCheck],
  ['a definitive status is treated as transient', 'RETRYABLE_READ_STATUS = Object.freeze([404,', 'RETRYABLE_READ_STATUS = Object.freeze([403, 404,', haltNamesCallCheck],
  // The retry widened from the CALL to the COMPARISON, at both binding sites.
  ['the ref comparison itself is retried until it agrees', REF_READ,
    '      let readback = await githubRead(`git/ref/heads/${encodeURIComponent(fixture.branch)}`);\n'
    + '      for (let retry = 1; retry < READ_RETRY.attempts && readback.object?.sha !== expected; retry++)\n'
    + '        readback = await githubRead(`git/ref/heads/${encodeURIComponent(fixture.branch)}`);', refMismatchCheck],
  ['the ancestry read itself is retried until it agrees', COMMIT_READ,
    '        let reseedCommit = await githubRead(`git/commits/${next}`);\n'
    + '        for (let retry = 1; retry < READ_RETRY.attempts && reseedCommit.sha !== next; retry++)\n'
    + '          reseedCommit = await githubRead(`git/commits/${next}`);', ancestryMismatchCheck],
  // Each term of the ancestry claim removed in turn: the signed reseed sha, the
  // exact pair of parents IN ORDER, the count, and the ref that must still carry
  // it. Every one of them is load-bearing, and each is killed by the control that
  // measures that term alone.
  ['the signed reseed sha is not compared', ANCESTRY_SHA, '', ancestryMismatchCheck],
  ['the parent order is not required', ANCESTRY_PARENTS,
    'reseedParents.includes(spec.binding.expected_parent) && reseedParents.includes(spec.binding.approvedExecutionRevision)', parentOrderCheck],
  ['the exact parent count is not required', ANCESTRY_COUNT, '', parentCountCheck],
  // Each POSITION of the pair removed alone. Neither survivor of the old
  // arrangement is caught by the reversal control above - with one position
  // dropped the other still disagrees with the reversed pair - so each is killed
  // only by the control that measures that position.
  ['the first parent position is not required', ANCESTRY_PARENT_0, '', parentPositionZeroCheck],
  ['the second parent position is not required', ANCESTRY_PARENT_1, '', parentPositionOneCheck],
  ['the ref is not required to still carry the reseed commit', ANCESTRY_REF, '', refMovedAfterPushCheck],
  // ...and the route whose 1,667,573-byte body refused a landed push cannot come
  // back without a control failing: this mutant puts the comparison read back in
  // place of the bounded one.
  ['the patch-bearing comparison comes back', COMMIT_READ,
    '        const reseedCommit = await githubRead(`compare/${old}...${next}`);', boundedReadCheck],
  // The retry applied to a MUTATION.
  // Anchor updated in place for the re-read recovery the push now has; the
  // mutant still replaces the single push with a retry LOOP over the mutation.
  ['the push is retried like a read', PUSH,
    '          try { for (let attempt = 1; ; attempt++) {\n'
    + '            try { git(spec, [\'push\', \'--porcelain\', `--force-with-lease=${ref}:${old}`, REMOTE, `${next}:${ref}`], { remote: true }); break; }\n'
    + '            catch (error) { if (attempt >= READ_RETRY.attempts) throw error; await readWait(READ_RETRY.delaysMs[attempt - 1]); }\n'
    + '          } }', pushNotRetriedCheck],
  // F2: the halt stops naming the call, by each of its two doors.
  ['the halt record drops the measured API detail', HALT_DETAIL, '      const detail = {};', haltNamesCallCheck],
  ['a failed call is no longer described at all',
    '    try { error.api = apiFailureDetail({ ...error.api, ...detail }); }', '    try { error.api = undefined; }', haltNamesCallCheck],
  ['the GraphQL error codes are not collected', '.flatMap(error => [error?.extensions?.code, error?.extensions?.type, error?.code])',
    '.flatMap(() => [])', graphqlCodesCheck],
];

// The sanitizer's own doors. None is reachable through the entrypoint - every
// label this module builds is already a route - so each is killed by the direct
// closure control instead.
export const closureMutations = [
  ['the operation label is echoed unsanitized', detailClosureCheck, apiFailureDetail,
    'API_OPERATION_PATTERN.test(detail.operation) ? detail.operation : \'unknown\'', 'true ? detail.operation : \'unknown\''],
  ['the status is echoed unchecked', detailClosureCheck, apiFailureDetail,
    'if (Number.isSafeInteger(detail.status) && detail.status >= 100 && detail.status <= 599) record.status = detail.status;',
    'record.status = detail.status;'],
  ['the GraphQL codes are echoed unfiltered', detailClosureCheck, apiFailureDetail,
    '.filter(code => typeof code === \'string\' && API_CODE_PATTERN.test(code));', '.slice();'],
  ['the transport fault is echoed unfiltered', detailClosureCheck, apiFailureDetail,
    'if (typeof detail.fault === \'string\' && API_CODE_PATTERN.test(detail.fault)) record.fault = detail.fault;\n  const codes =',
    'if (typeof detail.fault === \'string\') record.fault = detail.fault;\n  const codes ='],
  ['the reason vocabulary is opened', detailClosureCheck, apiFailureDetail,
    'if (API_REASONS.includes(detail.reason)) record.reason = detail.reason;', 'record.reason = detail.reason;'],
  ['a refusal with no measured detail is retryable', retryableClosureCheck, retryableApiFailure,
    "  if (detail === null || typeof detail !== 'object') return false;\n  if (detail.reason === 'transport') return true;",
    "  if (detail === null || typeof detail !== 'object') return true;\n  if (detail.reason === 'transport') return true;"],
  ['every reason is retryable once a status matches', retryableClosureCheck, retryableApiFailure,
    "  return detail.reason === 'response_not_ok' && RETRYABLE_READ_STATUS.includes(detail.status);",
    '  return RETRYABLE_READ_STATUS.includes(detail.status);'],
];
