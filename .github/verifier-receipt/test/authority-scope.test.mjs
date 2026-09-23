// WHAT THE AUTHORITY-SCOPE DECISION ANSWERS, AND WHAT IT REFUSES.
//
// The question is "does this candidate change the receipt authority", and the first implementation answered a
// different one: it compared the object id of each authority path ON MAIN with the id AT THE CANDIDATE and
// called any inequality an alteration. The first workflow_dispatch of the authority on main (run 35852850002,
// candidate 6feac016) refused a candidate that had altered nothing - it was cut from an older main and so
// carries no authority at all - because ABSENT and ALTERED are the same answer to an equality test.
//
// Every case below is written down rather than fetched: `observeAuthorityScope` takes its `api` as an
// argument, so nothing here touches the network. Two of them are this repository's own commits - the candidate
// the first dispatch refused, and the commit the authority landed in - answered from
// test/fixtures/authority-scope/recorded-api.json, which holds the answers api.github.com gave for those refs.
// AN EARLIER VERSION ANSWERED THEM OUT OF THE LOCAL GIT OBJECT STORE, and that was fatal in CI: both jobs that
// run this suite check out with actions/checkout at its default fetch-depth: 1, so those commits were not
// objects in the clone, four tests died with `fatal: Not a valid commit name`, and the emit job failed before
// the emitter ever ran. A written-down answer travels where history cannot - and that is the form the module's
// own header describes: the same decision, from the same answers, made by the same code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { AUTHORITY_PATHS, LISTING_CAP, decideAuthorityScope, observeAuthorityScope }
  from '../authority-scope.mjs';

const REPO = 'BAWES-Universe/studenthub-platform';
const PROTECTED = 'main';
const CANDIDATE = 'b'.repeat(40);
const BASE = '9'.repeat(40);
const WORKFLOW_DIR = '.github/workflows';
const WORKFLOW_NAME = 'verifier-receipt.yml';
const AUTHORITY_DIR = '.github';
const AUTHORITY_NAME = 'verifier-receipt';
const WORKFLOW_ID = '1a'.repeat(20);
const DIR_ID = '2b'.repeat(20);
const OTHER_WORKFLOW_ID = '3c'.repeat(20);

// A repository written down as listings: `{ [ref]: { [dir]: entries | null } }`, where null is a directory the
// API will not list at that ref and an absent name is a path that is not there. `compare` is the whole compare
// response, so a test can leave `merge_base_commit` out or put a `files` array in without either changing what
// the module is allowed to read.
const apiOver = ({ listings, compare }) => endpoint => {
  const comparison = `/repos/${REPO}/compare/${PROTECTED}...${CANDIDATE}`;
  if (endpoint === comparison) return compare ?? null;
  const contents = /^\/repos\/[^/]+\/[^/]+\/contents\/(.+)\?ref=(.+)$/.exec(endpoint);
  if (contents) {
    const [, dir, ref] = contents;
    const atRef = listings[ref];
    if (!atRef || !(dir in atRef)) return null;
    return atRef[dir];
  }
  throw new Error(`this test's api was asked for ${endpoint}, which the module should not read`);
};

// A ref holding the authority exactly as the entries below say. `workflow` and `directory` are the object ids
// to report, or null for "the path is not there"; `unlistable` names directories the API refuses to serve.
const refHolding = ({ workflow = WORKFLOW_ID, directory = DIR_ID, unlistable = [] } = {}) => {
  const listing = {
    [WORKFLOW_DIR]: [{ name: 'ci.yml', type: 'file', sha: OTHER_WORKFLOW_ID },
      ...(workflow === null ? [] : [{ name: WORKFLOW_NAME, type: 'file', sha: workflow }])],
    [AUTHORITY_DIR]: [{ name: 'coordinator', type: 'dir', sha: '4d'.repeat(20) },
      { name: 'workflows', type: 'dir', sha: '5e'.repeat(20) },
      ...(directory === null ? [] : [{ name: AUTHORITY_NAME, type: 'dir', sha: directory }])],
  };
  for (const dir of unlistable) listing[dir] = null;
  return listing;
};

const forkedAt = (sha = BASE) => ({ status: 'diverged', ahead_by: 3, behind_by: 1, merge_base_commit: { sha } });

const decide = async ({ base, candidate, onProtected, compare = forkedAt() }) => decideAuthorityScope(
  await observeAuthorityScope({
    repo: REPO,
    protectedRef: PROTECTED,
    candidateSha: CANDIDATE,
    api: apiOver({ compare, listings: { [BASE]: base, [CANDIDATE]: candidate, [PROTECTED]: onProtected } }),
  }));

const reasons = decision => decision.refuses.map(entry => entry.message).join(' | ');
const changeOf = (decision, pathName) => decision.entries.find(entry => entry.path === pathName)?.change;

// ---- what counts as the authority ----------------------------------------------------------------------------

test('the authority is two objects, named as objects rather than as a pattern', () => {
  assert.deepEqual(AUTHORITY_PATHS.map(entry => `${entry.dir}/${entry.name}`),
    ['.github/workflows/verifier-receipt.yml', '.github/verifier-receipt']);
  assert.deepEqual(AUTHORITY_PATHS.map(entry => entry.kind), ['file', 'directory']);
  // There is no path-pattern helper here and there must not be one: the decision is made by comparing object
  // ids, so a function that decided "is this string the authority" would be a check nobody consults. An earlier
  // version exported `isAuthorityPath`; the only thing that kept it alive was an assertion of its own.
});

test('a listing at the API cap is refused rather than read as "not there"', async () => {
  // The shape a truncated page presents: a full listing with no authority entry in it. Read literally that is
  // "absent at the candidate", which is the single answer that can admit an alteration - so it is refused.
  const atCap = () => ({
    [WORKFLOW_DIR]: Array.from({ length: LISTING_CAP },
      (unused, index) => ({ name: `f${index}.yml`, type: 'file', sha: '6f'.repeat(20) })),
    [AUTHORITY_DIR]: Array.from({ length: LISTING_CAP },
      (unused, index) => ({ name: `f${index}.json`, type: 'file', sha: '7a'.repeat(20) })),
  });
  const decision = await decide({ base: atCap(), candidate: atCap(), onProtected: refHolding() });
  assert.equal(LISTING_CAP, 1000);
  assert.equal(decision.ok, false, 'a page at the cap must never admit a candidate');
  assert.match(reasons(decision), /at the API's 1000-entry cap/);
  assert.equal(decision.predates_authority, false, 'a truncated page must not be named as a predating candidate');
  assert.equal(decision.stale_relative_to_protected, false, 'nor may it be named as stale');
});

// ---- the ten cases the baseline has to get right ---------------------------------------------------------------

// 1. THE CASE THAT WAS MEASURED WRONG. Absent at the candidate AND absent at the revision the candidate was cut
//    from is not an edit; it is a branch older than the authority. Against main it read as ALTERED, and run
//    35852850002 refused candidate 6feac016 on exactly this.
test('a candidate that predates the authority is admissible, and the result says which case it is', async () => {
  const decision = await decide({
    base: refHolding({ workflow: null, directory: null }),
    candidate: refHolding({ workflow: null, directory: null }),
    onProtected: refHolding(),
  });
  assert.equal(decision.ok, true, reasons(decision));
  assert.equal(decision.predates_authority, true);
  assert.deepEqual(decision.entries.map(entry => entry.change), ['none', 'none']);
  assert.deepEqual(decision.entries.map(entry => [entry.base_sha, entry.candidate_sha]),
    [[null, null], [null, null]]);
  // And the authority IS on the protected branch - which is what makes this a predating candidate rather than
  // a repository where the authority is nowhere.
  assert.deepEqual(decision.entries.map(entry => entry.protected_sha), [WORKFLOW_ID, DIR_ID]);
});

// 2.
test('a candidate that adds the authority directory its merge base had none of is refused, named added', async () => {
  const decision = await decide({
    base: refHolding({ directory: null }),
    candidate: refHolding({ directory: '7777'.repeat(10) }),
    onProtected: refHolding({ directory: null }),
  });
  assert.equal(decision.ok, false);
  assert.equal(changeOf(decision, '.github/verifier-receipt'), 'added');
  assert.match(reasons(decision),
    /\.github\/verifier-receipt is added relative to the merge base: absent at 999999999999, 777777777777 at the candidate/);
});

// 3.
test('a candidate that modifies the workflow file is refused, named modified, with both ids', async () => {
  const decision = await decide({
    base: refHolding(),
    candidate: refHolding({ workflow: '8888'.repeat(10) }),
    onProtected: refHolding(),
  });
  assert.equal(decision.ok, false);
  assert.equal(changeOf(decision, '.github/workflows/verifier-receipt.yml'), 'modified');
  assert.match(reasons(decision),
    /verifier-receipt\.yml is modified relative to the merge base: 1a1a1a1a1a1a at 999999999999, 888888888888 at the candidate/);
  // The other authority path is untouched, and the decision says so rather than lumping the two together.
  assert.equal(changeOf(decision, '.github/verifier-receipt'), 'none');
});

// 4. A deletion includes the rename: a rename away IS a deletion of the path, which is the hole the diff
//    listing had, since it reports a rename under its new name only.
test('a candidate that deletes the authority directory is refused, named deleted', async () => {
  const decision = await decide({
    base: refHolding(),
    candidate: refHolding({ directory: null }),
    onProtected: refHolding(),
  });
  assert.equal(decision.ok, false);
  assert.equal(changeOf(decision, '.github/verifier-receipt'), 'deleted');
  assert.match(reasons(decision),
    /\.github\/verifier-receipt is deleted relative to the merge base: 2b2b2b2b2b2b at 999999999999, absent at the candidate/);
});

// 5. THE REASON THE BASELINE IS THE FORK POINT AND NOT MAIN. Main moves after a branch is cut. A candidate
//    holding the copy it started from has touched nothing, whatever main holds now - and the merge resolves
//    that in main's favour anyway.
test('a candidate holding the copy it forked from is admissible when the protected ref has moved on', async () => {
  const decision = await decide({
    base: refHolding(),
    candidate: refHolding(),
    onProtected: refHolding({ workflow: 'eeee'.repeat(10), directory: 'ffff'.repeat(10) }),
  });
  assert.equal(decision.ok, true, reasons(decision));
  assert.deepEqual(decision.entries.map(entry => entry.change), ['none', 'none']);
  assert.equal(decision.stale_relative_to_protected, true);
  assert.equal(decision.predates_authority, false);
});

// 6.
test('a candidate identical to both its merge base and the protected ref is admissible and not stale', async () => {
  const decision = await decide({
    base: refHolding(), candidate: refHolding(), onProtected: refHolding(),
  });
  assert.equal(decision.ok, true, reasons(decision));
  assert.equal(decision.stale_relative_to_protected, false);
  assert.equal(decision.predates_authority, false);
  assert.equal(decision.merge_base, BASE);
});

// 7. FAIL CLOSED. Without the fork point there is no baseline, and the two comparisons left are the one that
//    was measured wrong and none at all.
test('a comparison that names no merge base is refused, and says that is why', async () => {
  const decision = await decide({
    base: refHolding(), candidate: refHolding(), onProtected: refHolding(),
    compare: { status: 'diverged', ahead_by: 3, behind_by: 1 },
  });
  assert.equal(decision.ok, false);
  assert.equal(decision.merge_base, null);
  assert.match(reasons(decision), /cannot establish the merge base of main and bbbbbbbbbbbb/);
  assert.match(reasons(decision), /names no merge_base_commit\.sha/);
});

test('a comparison the API will not serve is refused, and says that is why', async () => {
  const decision = await decide({
    base: refHolding(), candidate: refHolding(), onProtected: refHolding(), compare: null,
  });
  assert.equal(decision.ok, false);
  assert.match(reasons(decision), /the API cannot compare main with bbbbbbbbbbbb/);
});

// 8. A listing the API will not serve is refused at EVERY ref it is read at, because a run that cannot read
//    one side of the comparison has not made it.
test('an unreadable listing at the candidate is refused, not skipped', async () => {
  const decision = await decide({
    base: refHolding(), candidate: refHolding({ unlistable: [AUTHORITY_DIR] }), onProtected: refHolding(),
  });
  assert.equal(decision.ok, false);
  assert.match(reasons(decision), /the API cannot list \.github at bbbbbbbbbbbb/);
  assert.equal(changeOf(decision, '.github/verifier-receipt'), 'unknown');
});

test('an unreadable listing at the merge base is refused, not skipped', async () => {
  const decision = await decide({
    base: refHolding({ unlistable: [WORKFLOW_DIR] }), candidate: refHolding(), onProtected: refHolding(),
  });
  assert.equal(decision.ok, false);
  assert.match(reasons(decision), /the API cannot list \.github\/workflows at the merge base 999999999999/);
});

test('an unreadable listing on the protected ref is refused, not skipped', async () => {
  const decision = await decide({
    base: refHolding(), candidate: refHolding(), onProtected: refHolding({ unlistable: [AUTHORITY_DIR] }),
  });
  assert.equal(decision.ok, false);
  assert.match(reasons(decision), /the API cannot list \.github on main/);
});

// 9.
test('a candidate that touches only paths outside the authority is admissible', async () => {
  // The listings the module reads are the two authority directories, and `src/foo.ts` is in neither: a candidate
  // that changed it and nothing else reports the same ids on both sides. Nothing here classifies a path by
  // name - the decision is made from object ids - so there is no path matcher to consult or to drift.
  const decision = await decide({
    base: refHolding(), candidate: refHolding(), onProtected: refHolding(),
  });
  assert.equal(decision.ok, true, reasons(decision));
  assert.deepEqual(decision.entries.map(entry => entry.change), ['none', 'none']);
});

// 10. THE 300-CAP HOLE IS NOT REINTRODUCED. `files` is capped at 300 entries, sorted by filename and truncated
//     with nothing in the response saying so, and a rename appears under its new name only. This module reads
//     `merge_base_commit.sha` out of the compare response and nothing else, so a response with no `files` at
//     all decides exactly the same thing - and so does one whose `files` claims the opposite.
test('a compare response carrying no files array still decides the scope', async () => {
  const compare = { status: 'ahead', ahead_by: 137, total_commits: 137, merge_base_commit: { sha: BASE } };
  assert.equal('files' in compare, false);
  const decision = await decide({
    base: refHolding(), candidate: refHolding({ workflow: '8888'.repeat(10) }), onProtected: refHolding(), compare });
  assert.equal(decision.ok, false);
  assert.equal(changeOf(decision, '.github/workflows/verifier-receipt.yml'), 'modified');
});

test('a full 300-entry files page hides nothing, and a files array claiming no authority edit changes nothing', async () => {
  const filler = Array.from({ length: 300 }, (unused, index) => ({
    filename: `.github/aaa/${String(index).padStart(4, '0')}.json`, status: 'added' }));
  const decision = await decide({
    base: refHolding({ directory: null }),
    candidate: refHolding({ directory: '7777'.repeat(10) }),
    onProtected: refHolding(),
    compare: { status: 'ahead', merge_base_commit: { sha: BASE }, files: filler },
  });
  assert.equal(decision.ok, false);
  assert.equal(changeOf(decision, '.github/verifier-receipt'), 'added');
});

// ---- the same module, on this repository's own commits -----------------------------------------------------------
//
// NO NETWORK, AND NO GIT. The answers below are written down in test/fixtures/authority-scope/recorded-api.json,
// taken from api.github.com for the three real refs this defect is about, with their provenance recorded in
// that file. An earlier version of this block answered the module out of the LOCAL git object store instead
// (`git ls-tree`, `git merge-base`), which was fatal in CI: both jobs that run this suite check out with
// actions/checkout at its default fetch-depth: 1, so those three commits are not objects in the clone, four
// tests died with `fatal: Not a valid commit name`, and the emit job failed before the emitter ever ran. A
// written-down answer travels where history cannot - and it is the form the module's own header describes: the
// same decision, from the same answers, made by the same code.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', 'authority-scope', 'recorded-api.json'), 'utf8'));
const recordedApi = endpoint => {
  if (!(endpoint in FIXTURE.routes)) {
    throw new Error(`the module asked for ${endpoint}, which this test's recorded answers do not hold`);
  }
  return FIXTURE.routes[endpoint];
};

// The commit the authority landed in (PR #163), its parent, and the candidate the first dispatch refused.
const AUTHORITY_LANDED = '9f0131a5df8687deccd1ac0c0b0dc08f9a3a689b';
const BEFORE_AUTHORITY = 'a51c8490dfb8572917049b3ab73dcf94409365c4';
const REFUSED_CANDIDATE = '6feac016e3a0796d0c7b21d86426af0f1491a9c1';

test('REAL: the candidate run 35852850002 refused predates the authority, and is admissible', async () => {
  const decision = decideAuthorityScope(await observeAuthorityScope({
    repo: REPO, protectedRef: AUTHORITY_LANDED, candidateSha: REFUSED_CANDIDATE, api: recordedApi }));
  assert.equal(decision.merge_base, BEFORE_AUTHORITY);
  assert.equal(decision.ok, true, reasons(decision));
  assert.equal(decision.predates_authority, true);
  assert.deepEqual(decision.entries.map(entry => entry.change), ['none', 'none']);
  // The ids the refused run itself printed for the protected side, unchanged in the recording.
  assert.deepEqual(decision.entries.map(entry => [entry.protected_sha, entry.candidate_sha]), [
    ['3615f6582e692f2c6042b2f807c393c32dee413e', null],
    ['03fe40baf7cb5ca86c3e28299a5eeae2f46bb270', null]]);
});

test('REAL: the commit that landed the authority adds it relative to its own merge base, and is refused', async () => {
  const decision = decideAuthorityScope(await observeAuthorityScope({
    repo: REPO, protectedRef: BEFORE_AUTHORITY, candidateSha: AUTHORITY_LANDED, api: recordedApi }));
  assert.equal(decision.merge_base, BEFORE_AUTHORITY);
  assert.equal(decision.ok, false);
  assert.deepEqual(decision.entries.map(entry => entry.change), ['added', 'added']);
  assert.match(reasons(decision), /verifier-receipt\.yml is added relative to the merge base/);
  assert.match(reasons(decision), /\.github\/verifier-receipt is added relative to the merge base/);
});

// ---- the CLI the trust job runs ------------------------------------------------------------------------------
//
// The trust job checks out no code: it fetches this module from the trusted commit and runs it with node. That
// entry point is what the defect was reported from, so it is exercised here as a process - arguments in, lines
// and an exit status out - against the same real commits, served through a stub `fetch` so nothing reaches the
// network. The token below is a placeholder the stub never reads; the real one is the job's `github.token`.
const MODULE = path.join(HERE, '..', 'authority-scope.mjs');
const FETCH_STUB = path.join(HERE, 'fetch-stub.mjs');

const runCli = (protectedRef, candidateSha) => {
  // The same written-down answers, handed to the stub `fetch`. Nothing is derived from git here either: the
  // stub answers the endpoints this run asks for and records the ones it was asked for, so a module that read
  // something it should not would be visible in the output rather than silent.
  const routesPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'authority-scope-')), 'routes.json');
  fs.writeFileSync(routesPath, JSON.stringify(FIXTURE.routes, null, 2));
  return spawnSync(process.execPath, ['--import', FETCH_STUB, MODULE, REPO, protectedRef, candidateSha], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, FETCH_STUB_ROUTES: routesPath, GH_TOKEN: 'the-fetch-stub-ignores-this' },
  });
};

test('CLI: the candidate the first dispatch refused exits 0, and the lines say why it is admissible', () => {
  const result = runCli(AUTHORITY_LANDED, REFUSED_CANDIDATE);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /merge base of 9f0131a5df8687deccd1ac0c0b0dc08f9a3a689b and 6feac016e3a0: a51c8490dfb8/);
  assert.match(result.stdout, /\.github\/verifier-receipt: base=<absent> candidate=<absent> [0-9a-f]{40}=03fe40baf7cb -> none/);
  assert.match(result.stdout, /it predates the authority/);
  assert.equal(result.stderr, '');
});

test('CLI: a candidate that adds the authority exits 1 with an ::error:: naming the change', () => {
  const result = runCli(BEFORE_AUTHORITY, AUTHORITY_LANDED);
  assert.equal(result.status, 1);
  assert.match(result.stderr, /^::error::this candidate changes the receipt authority relative to its merge base/m);
  assert.match(result.stderr, /verifier-receipt\.yml is added relative to the merge base/);
  assert.match(result.stdout, /-> added/);
});

test('CLI: an endpoint the API will not serve exits 1 rather than deciding on a missing answer', () => {
  const routesPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'authority-scope-')), 'routes.json');
  fs.writeFileSync(routesPath, JSON.stringify({}));  // every endpoint 404s
  const result = spawnSync(process.execPath,
    ['--import', FETCH_STUB, MODULE, REPO, 'main', 'b'.repeat(40)], {
      encoding: 'utf8',
      env: { PATH: process.env.PATH, FETCH_STUB_ROUTES: routesPath, GH_TOKEN: 'the-fetch-stub-ignores-this' },
    });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the API cannot compare main with bbbbbbbbbbbb/);
});
