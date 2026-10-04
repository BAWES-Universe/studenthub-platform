// WHAT THE AUTHORITY-SCOPE DECISION ANSWERS, AND WHAT IT REFUSES.
//
// The question is "does this candidate change the receipt authority", and the first implementation answered a
// different one: it compared the object id of each authority path ON MAIN with the id AT THE CANDIDATE and
// called any inequality an alteration. The first workflow_dispatch of the authority on main (run 35852850002,
// candidate 6feac016) refused a candidate that had altered nothing - it was cut from an older main and so
// carries no authority at all - because ABSENT and ALTERED are the same answer to an equality test.
//
// AND THE IDS ARE NOW READ OUT OF GIT TREES. The second version read them out of `GET /contents/{dir}?ref=`,
// and a review measured two ways past that form: a listing's blob id does not move when only the file MODE does
// (`chmod +x .github/workflows/verifier-receipt.yml` was admitted), and a listing never says whether it is the
// whole directory, so truncation had to be inferred from a length - which a 999-entry page omitting the
// authority walked straight past, and the decision came back admissible with `predates_authority: true`. A tree
// response carries `mode` per entry and an explicit `truncated`. Both are tested below, by name.
//
// Every case here is written down rather than fetched: `observeAuthorityScope` takes its `api` as an argument,
// so nothing here touches the network. Two of them are this repository's own commits - the candidate the first
// dispatch refused, and the commit the authority landed in - answered from
// test/fixtures/authority-scope/recorded-trees.json, which holds what api.github.com gave for those refs.
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

import { AUTHORITY_PATHS, authorityRefusalMessage, decideAuthorityScope, observeAuthorityScope,
  renderAuthorityScope } from '../authority-scope.mjs';
import { DIRECTORY_SHA, EXEC_MODE, FILE_MODE, TREE_MODE, WORKFLOW_SHA, treesFor } from './authority-trees.mjs';

const REPO = 'BAWES-Universe/studenthub-platform';
const PROTECTED = 'main';
const CANDIDATE = 'b'.repeat(40);
const BASE = '9'.repeat(40);

// A repository written down as the git trees the module walks, three per ref (the root, `.github`,
// `.github/workflows`) - see ./authority-trees.mjs. `compare` is the whole compare response, so a test can
// leave `merge_base_commit` out or put a `files` array in without either changing what the module may read.
const apiOver = ({ trees, compare }) => endpoint => {
  const comparison = `/repos/${REPO}/compare/${PROTECTED}...${CANDIDATE}`;
  if (endpoint === comparison) return compare ?? null;
  const asked = /^\/repos\/[^/]+\/[^/]+\/git\/trees\/(.+)$/.exec(endpoint);
  // A tree no ref in this world serves answers null, which is what the API does for a sha it will not serve.
  if (asked) return trees[asked[1]] ?? null;
  throw new Error(`this test's api was asked for ${endpoint}, which the module should not read`);
};

const forkedAt = (sha = BASE) => ({ status: 'diverged', ahead_by: 3, behind_by: 1, merge_base_commit: { sha } });

// `base`, `candidate` and `onProtected` are the options ./authority-trees.mjs takes: what the authority looks
// like at that ref. The default at every ref is the authority, unchanged, at mode 100644.
const decide = async ({ base = {}, candidate = {}, onProtected = {}, compare = forkedAt() } = {}) => {
  const trees = { ...treesFor(BASE, base), ...treesFor(CANDIDATE, candidate), ...treesFor(PROTECTED, onProtected) };
  return decideAuthorityScope(await observeAuthorityScope({
    repo: REPO, protectedRef: PROTECTED, candidateSha: CANDIDATE, api: apiOver({ trees, compare }),
  }));
};

const reasons = decision => decision.refuses.map(entry => entry.message).join(' | ');
const changeOf = (decision, pathName) => decision.entries.find(entry => entry.path === pathName)?.change;
const WORKFLOW_ENTRY = '.github/workflows/verifier-receipt.yml';
const DIRECTORY_ENTRY = '.github/verifier-receipt';

// ---- what counts as the authority ----------------------------------------------------------------------------

test('the authority is two objects, named as objects rather than as a pattern', () => {
  assert.deepEqual(AUTHORITY_PATHS.map(entry => `${entry.dir}/${entry.name}`),
    [WORKFLOW_ENTRY, DIRECTORY_ENTRY]);
  assert.deepEqual(AUTHORITY_PATHS.map(entry => entry.kind), ['file', 'directory']);
  // There is no path-pattern helper here and there must not be one: the decision is made by comparing object
  // ids, so a function that decided "is this string the authority" would be a check nobody consults. An earlier
  // version exported `isAuthorityPath`; the only thing that kept it alive was an assertion of its own.
});

test('the module names no listing cap, because truncation is read and never inferred', async () => {
  const source = fs.readFileSync(new URL('../authority-scope.mjs', import.meta.url), 'utf8');
  // The check this replaced was `listing.length >= LISTING_CAP`. It is gone rather than kept beside the new
  // one: a second, weaker answer to the same question is a second chance to get it wrong, and the review's
  // 999-entry page is exactly the input that slipped between them.
  assert.equal(/LISTING_CAP/.test(source), false, 'the cap constant is still in the module');
  assert.equal(/\.length\s*>=/.test(source), false, 'the module still infers something from a length');
});

// ---- the two bypasses this round exists to close ---------------------------------------------------------------

// F5, MEASURED: a contents listing reports a blob's object id, and that id does not move when only the file
// mode does. `chmod +x .github/workflows/verifier-receipt.yml` is a change to an authority file, and it was
// admitted. A tree entry carries `mode`, and the mode is part of the comparison.
test('a mode-only change to the authority workflow file is refused, named modified, with the mode move', async () => {
  const decision = await decide({
    base: {},
    candidate: { workflowMode: EXEC_MODE },
    onProtected: {},
  });
  assert.equal(decision.ok, false, 'chmod +x on the authority workflow file must not be admitted');
  assert.equal(changeOf(decision, WORKFLOW_ENTRY), 'modified');
  // The id is the SAME on both sides, which is why the id alone could not see this.
  const entry = decision.entries.find(item => item.path === WORKFLOW_ENTRY);
  assert.equal(entry.base_sha, entry.candidate_sha);
  assert.deepEqual([entry.base_mode, entry.candidate_mode], [FILE_MODE, EXEC_MODE]);
  assert.match(reasons(decision),
    /verifier-receipt\.yml is modified relative to the merge base: 1a1a1a1a1a1a at 999999999999, 1a1a1a1a1a1a at the candidate, and its mode moved from 100644 at the merge base to 100755 at the candidate/);
  // The directory is untouched, and the decision says so rather than lumping the two together.
  assert.equal(changeOf(decision, DIRECTORY_ENTRY), 'none');
});

// The other direction of the same rule: the mode comparison must not start refusing candidates that changed
// nothing. Identical in id AND in mode is admissible, and that is what the default world is.
test('a candidate identical in id and in mode is admitted, and the modes are reported', async () => {
  const decision = await decide();
  assert.equal(decision.ok, true, reasons(decision));
  assert.deepEqual(decision.entries.map(entry => [entry.base_mode, entry.candidate_mode, entry.protected_mode]),
    [[FILE_MODE, FILE_MODE, FILE_MODE], [TREE_MODE, TREE_MODE, TREE_MODE]]);
});

// A blob id can never equal the tree id it displaced, so replacing the authority DIRECTORY with a file of that
// name was already caught by the id. Keeping that property is part of the mode change, not a casualty of it.
test('a candidate that replaces the authority directory with a file of that name is refused', async () => {
  const decision = await decide({
    candidate: { directory: '7777'.repeat(10), directoryMode: FILE_MODE, directoryType: 'blob' },
  });
  assert.equal(decision.ok, false);
  assert.equal(changeOf(decision, DIRECTORY_ENTRY), 'modified');
  assert.match(reasons(decision), /\.github\/verifier-receipt is modified relative to the merge base/);
});

// F4, MEASURED: the module used to infer truncation from `listing.length >= LISTING_CAP`, and so could not see
// a page that was cut off SHORT of the cap - a Link-paginated or per_page-limited one. The review built a
// 999-entry page that omitted the authority and the decision came back admissible with `predates_authority:
// true`. A tree response says whether it was cut off, and saying so is a refusal by name at any length.
test('a tree that answers "truncated": true is refused, however short it is', async () => {
  // The shape the bypass presented: the authority nowhere in the response, which read literally is "absent at
  // the candidate" - the single answer that can admit an alteration. Three entries, and cut off.
  const decision = await decide({
    base: { directory: null, workflow: null, truncated: ['.github', '.github/workflows'] },
    candidate: { directory: null, workflow: null, truncated: ['.github', '.github/workflows'] },
    onProtected: {},
  });
  assert.equal(decision.ok, false, 'a tree that says it was cut off must never admit a candidate');
  assert.match(reasons(decision), /the tree of \.github at the candidate answered `"truncated": true`/);
  assert.match(reasons(decision), /may be past the cut rather than absent/);
  assert.equal(decision.predates_authority, false, 'a cut-off tree must not be named as a predating candidate');
  assert.equal(decision.stale_relative_to_protected, false, 'nor may it be named as stale');
  assert.equal(changeOf(decision, DIRECTORY_ENTRY), 'unknown');
});

// And the converse, which is what makes the flag the thing being read: a LONG response that does not say it was
// cut off is the whole directory, and an entry absent from it is absent. Under the old form this page was
// refused for its length alone; under this one the response is believed when it says it is complete.
test('a 999-entry tree that does not say it was cut off is read as the whole directory', async () => {
  const fill = Array.from({ length: 999 }, (unused, index) => ({
    path: `f${String(index).padStart(4, '0')}`, mode: TREE_MODE, type: 'tree', sha: '5e'.repeat(20) }));
  const decision = await decide({ base: { fill }, candidate: { fill }, onProtected: { fill } });
  assert.equal(decision.ok, true, reasons(decision));
  assert.deepEqual(decision.entries.map(entry => entry.change), ['none', 'none']);
});

// ---- the ten cases the baseline has to get right ---------------------------------------------------------------

// 1. THE CASE THAT WAS MEASURED WRONG. Absent at the candidate AND absent at the revision the candidate was cut
//    from is not an edit; it is a branch older than the authority. Against main it read as ALTERED, and run
//    35852850002 refused candidate 6feac016 on exactly this.
test('a candidate that predates the authority is admissible, and the result says which case it is', async () => {
  const decision = await decide({
    base: { workflow: null, directory: null },
    candidate: { workflow: null, directory: null },
    onProtected: {},
  });
  assert.equal(decision.ok, true, reasons(decision));
  assert.equal(decision.predates_authority, true);
  assert.deepEqual(decision.entries.map(entry => entry.change), ['none', 'none']);
  assert.deepEqual(decision.entries.map(entry => [entry.base_sha, entry.candidate_sha]),
    [[null, null], [null, null]]);
  // And the authority IS on the protected branch - which is what makes this a predating candidate rather than
  // a repository where the authority is nowhere.
  assert.deepEqual(decision.entries.map(entry => entry.protected_sha), [WORKFLOW_SHA, DIRECTORY_SHA]);
});

// 2.
test('a candidate that adds the authority directory its merge base had none of is refused, named added', async () => {
  const decision = await decide({
    base: { directory: null },
    candidate: { directory: '7777'.repeat(10) },
    onProtected: { directory: null },
  });
  assert.equal(decision.ok, false);
  assert.equal(changeOf(decision, DIRECTORY_ENTRY), 'added');
  assert.match(reasons(decision),
    /\.github\/verifier-receipt is added relative to the merge base: absent at 999999999999, 777777777777 at the candidate/);
});

// 3.
test('a candidate that modifies the workflow file is refused, named modified, with both ids', async () => {
  const decision = await decide({ candidate: { workflow: '8888'.repeat(10) } });
  assert.equal(decision.ok, false);
  assert.equal(changeOf(decision, WORKFLOW_ENTRY), 'modified');
  assert.match(reasons(decision),
    /verifier-receipt\.yml is modified relative to the merge base: 1a1a1a1a1a1a at 999999999999, 888888888888 at the candidate/);
  // An id that moved with the mode standing still says nothing about a mode, because nothing moved there.
  assert.equal(/mode moved/.test(reasons(decision)), false);
  // The other authority path is untouched, and the decision says so rather than lumping the two together.
  assert.equal(changeOf(decision, DIRECTORY_ENTRY), 'none');
});

// 4. A deletion includes the rename: a rename away IS a deletion of the path, which is the hole the diff
//    listing had, since it reports a rename under its new name only.
test('a candidate that deletes the authority directory is refused, named deleted', async () => {
  const decision = await decide({ candidate: { directory: null } });
  assert.equal(decision.ok, false);
  assert.equal(changeOf(decision, DIRECTORY_ENTRY), 'deleted');
  assert.match(reasons(decision),
    /\.github\/verifier-receipt is deleted relative to the merge base: 2b2b2b2b2b2b at 999999999999, absent at the candidate/);
});

// 5. THE REASON THE BASELINE IS THE FORK POINT AND NOT MAIN. Main moves after a branch is cut. A candidate
//    holding the copy it started from has touched nothing, whatever main holds now - and the merge resolves
//    that in main's favour anyway.
test('a candidate holding the copy it forked from is admissible when the protected ref has moved on', async () => {
  const decision = await decide({
    onProtected: { workflow: 'eeee'.repeat(10), directory: 'ffff'.repeat(10) },
  });
  assert.equal(decision.ok, true, reasons(decision));
  assert.deepEqual(decision.entries.map(entry => entry.change), ['none', 'none']);
  assert.equal(decision.stale_relative_to_protected, true);
  assert.equal(decision.predates_authority, false);
});

// 6.
test('a candidate identical to both its merge base and the protected ref is admissible and not stale', async () => {
  const decision = await decide();
  assert.equal(decision.ok, true, reasons(decision));
  assert.equal(decision.stale_relative_to_protected, false);
  assert.equal(decision.predates_authority, false);
  assert.equal(decision.merge_base, BASE);
});

// 7. FAIL CLOSED. Without the fork point there is no baseline, and the two comparisons left are the one that
//    was measured wrong and none at all.
test('a comparison that names no merge base is refused, and says that is why', async () => {
  const decision = await decide({ compare: { status: 'diverged', ahead_by: 3, behind_by: 1 } });
  assert.equal(decision.ok, false);
  assert.equal(decision.merge_base, null);
  assert.match(reasons(decision), /cannot establish the merge base of main and bbbbbbbbbbbb/);
  assert.match(reasons(decision), /names no merge_base_commit\.sha/);
});

test('a comparison the API will not serve is refused, and says that is why', async () => {
  const decision = await decide({ compare: null });
  assert.equal(decision.ok, false);
  assert.match(reasons(decision), /the API cannot compare main with bbbbbbbbbbbb/);
});

// 8. A tree the API will not serve is refused at EVERY ref it is read at, because a run that cannot read one
//    side of the comparison has not made it. Three refs, three refusals, each naming its own.
test('an unreadable tree at the candidate is refused, not skipped', async () => {
  const decision = await decide({ candidate: { unreadable: ['.github'] } });
  assert.equal(decision.ok, false);
  assert.match(reasons(decision), /the API will not serve the tree of \.github at bbbbbbbbbbbb/);
  assert.equal(changeOf(decision, DIRECTORY_ENTRY), 'unknown');
});

test('an unreadable tree at the merge base is refused, not skipped', async () => {
  const decision = await decide({ base: { unreadable: ['.github/workflows'] } });
  assert.equal(decision.ok, false);
  assert.match(reasons(decision),
    /the API will not serve the tree of \.github\/workflows at the merge base 999999999999/);
  assert.equal(changeOf(decision, WORKFLOW_ENTRY), 'unknown');
  // And the OTHER path, whose own tree was served, is still decided: one unreadable tree is not an excuse to
  // stop reading.
  assert.equal(changeOf(decision, DIRECTORY_ENTRY), 'none');
});

test('an unreadable tree on the protected ref is refused, not skipped', async () => {
  const decision = await decide({ onProtected: { unreadable: ['.github'] } });
  assert.equal(decision.ok, false);
  assert.match(reasons(decision), /the API will not serve the tree of \.github on main/);
});

test('a root tree the API will not serve is refused, naming the root rather than a path under it', async () => {
  const decision = await decide({ candidate: { unreadable: [''] } });
  assert.equal(decision.ok, false);
  assert.match(reasons(decision),
    /the API will not serve the tree of the repository root at bbbbbbbbbbbb/);
});

// 9.
test('a candidate that touches only paths outside the authority is admissible', async () => {
  // The trees the module walks are the root, `.github` and `.github/workflows`, and `src/foo.ts` is under none
  // of them: a candidate that changed it and nothing else reports the same ids on both sides. Nothing here
  // classifies a path by name - the decision is made from object ids and modes - so there is no path matcher
  // to consult or to drift.
  const decision = await decide();
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
  const decision = await decide({ candidate: { workflow: '8888'.repeat(10) }, compare });
  assert.equal(decision.ok, false);
  assert.equal(changeOf(decision, WORKFLOW_ENTRY), 'modified');
});

test('a full 300-entry files page hides nothing, and a files array claiming no authority edit changes nothing', async () => {
  const filler = Array.from({ length: 300 }, (unused, index) => ({
    filename: `.github/aaa/${String(index).padStart(4, '0')}.json`, status: 'added' }));
  const decision = await decide({
    base: { directory: null },
    candidate: { directory: '7777'.repeat(10) },
    compare: { status: 'ahead', merge_base_commit: { sha: BASE }, files: filler },
  });
  assert.equal(decision.ok, false);
  assert.equal(changeOf(decision, DIRECTORY_ENTRY), 'added');
});

// ---- a refusal may not assert what it could not establish --------------------------------------------------------
//
// MEASURED: with a compare response naming no `merge_base_commit`, the refusal read "this candidate changes the
// receipt authority relative to its merge base (this run cannot establish the merge base of main and ...)".
// The leading clause states as fact the thing the parenthesis says is unknown, so a rate limit or an outage
// produced a log line accusing an innocent candidate of editing the authority. Both callers refuse through
// `authorityRefusalMessage`, so there is one sentence and it is prefixed on what was actually determined.

test('a refusal that established a change says the candidate changed it', async () => {
  const decision = await decide({ candidate: { workflow: '8888'.repeat(10) } });
  assert.match(authorityRefusalMessage(decision),
    /^this candidate changes the receipt authority relative to its merge base \(/);
});

test('a refusal that could not make the comparison does not accuse the candidate of anything', async () => {
  for (const decision of [await decide({ compare: null }),
    await decide({ compare: { status: 'diverged' } }),
    await decide({ candidate: { unreadable: ['.github'] } }),
    await decide({ candidate: { truncated: ['.github'] } })]) {
    const message = authorityRefusalMessage(decision);
    assert.equal(decision.ok, false);
    assert.match(message,
      /^this run cannot establish whether this candidate changes the receipt authority \(/);
    assert.equal(/this candidate changes the receipt authority relative to its merge base/.test(message), false,
      `a refusal that established no change still claims one: ${message}`);
  }
});

// A refusal that established a change AND could not read something else still names the change: the leading
// clause is about what was determined, not about whether everything was.
test('a refusal that established one change and failed one read still names the change', async () => {
  const decision = await decide({
    candidate: { directory: '7777'.repeat(10), unreadable: ['.github/workflows'] },
  });
  assert.equal(changeOf(decision, DIRECTORY_ENTRY), 'modified');
  assert.equal(changeOf(decision, WORKFLOW_ENTRY), 'unknown');
  assert.equal(decision.ok, false);
  assert.match(authorityRefusalMessage(decision),
    /^this candidate changes the receipt authority relative to its merge base \(/);
});

// ---- the same module, on this repository's own commits -----------------------------------------------------------
//
// NO NETWORK, AND NO GIT. The answers below are written down in
// test/fixtures/authority-scope/recorded-trees.json, taken from api.github.com's git trees endpoint for the
// three real refs this defect is about, with their provenance recorded in that file. Each entry's `sha` and
// `mode` there is what `git ls-tree <ref> <path>` reports, so a reviewer with no network can check the
// recording against the repository's own object store. An earlier version of this block answered the module
// out of that object store DIRECTLY (`git ls-tree`, `git merge-base`), which was fatal in CI: both jobs that
// run this suite check out with actions/checkout at its default fetch-depth: 1, so those three commits are not
// objects in the clone, four tests died with `fatal: Not a valid commit name`, and the emit job failed before
// the emitter ever ran. A written-down answer travels where history cannot.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = JSON.parse(
  fs.readFileSync(path.join(HERE, 'fixtures', 'authority-scope', 'recorded-trees.json'), 'utf8'));
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
  // The ids the refused run itself printed for the protected side, unchanged in the recording, with the modes
  // `git ls-tree` reports for them beside each.
  assert.deepEqual(decision.entries.map(entry => [entry.protected_sha, entry.candidate_sha]), [
    ['3615f6582e692f2c6042b2f807c393c32dee413e', null],
    ['03fe40baf7cb5ca86c3e28299a5eeae2f46bb270', null]]);
  assert.deepEqual(decision.entries.map(entry => [entry.protected_mode, entry.candidate_mode]),
    [[FILE_MODE, null], [TREE_MODE, null]]);
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

test('REAL: a tree is read once however many lookups want it', async () => {
  // The merge base and the protected ref are the same commit here, and both authority paths share `.github`:
  // six lookups, and the recording holds one answer for each distinct tree. Asking twice is a second chance
  // for the two answers to disagree, so the module does not.
  const asked = [];
  const counting = endpoint => { asked.push(endpoint); return recordedApi(endpoint); };
  await observeAuthorityScope({
    repo: REPO, protectedRef: BEFORE_AUTHORITY, candidateSha: AUTHORITY_LANDED, api: counting });
  assert.deepEqual(asked, [...new Set(asked)], `a tree was fetched twice: ${asked.join(', ')}`);
});

// ---- the CLI the trust job runs ------------------------------------------------------------------------------
//
// The trust job checks out no code: it fetches this module from the trusted commit and runs it with node. That
// entry point is what the defect was reported from, so it is exercised here as a process - arguments in, lines
// and an exit status out - against the same real commits, served through a stub `fetch` so nothing reaches the
// network. The token below is a placeholder the stub never reads; the real one is the job's `github.token`.
const MODULE = path.join(HERE, '..', 'authority-scope.mjs');
const FETCH_STUB = path.join(HERE, 'fetch-stub.mjs');

const runCli = (protectedRef, candidateSha, routes = FIXTURE.routes) => {
  // The same written-down answers, handed to the stub `fetch`. Nothing is derived from git here either: the
  // stub answers the endpoints this run asks for and 404s the rest, so a module that read something it should
  // not would be visible in the output rather than silent.
  const routesPath = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'authority-scope-')), 'routes.json');
  fs.writeFileSync(routesPath, JSON.stringify(routes, null, 2));
  return spawnSync(process.execPath, ['--import', FETCH_STUB, MODULE, REPO, protectedRef, candidateSha], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH, FETCH_STUB_ROUTES: routesPath, GH_TOKEN: 'the-fetch-stub-ignores-this' },
  });
};

test('CLI: the candidate the first dispatch refused exits 0, and the lines say why it is admissible', () => {
  const result = runCli(AUTHORITY_LANDED, REFUSED_CANDIDATE);
  assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /merge base of 9f0131a5df8687deccd1ac0c0b0dc08f9a3a689b and 6feac016e3a0: a51c8490dfb8/);
  assert.match(result.stdout,
    /\.github\/verifier-receipt: base=<absent>\/<absent> candidate=<absent>\/<absent> [0-9a-f]{40}=03fe40baf7cb\/040000 -> none/);
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
  const result = runCli('main', 'b'.repeat(40), {});  // every endpoint 404s
  assert.equal(result.status, 1);
  assert.match(result.stderr, /the API cannot compare main with bbbbbbbbbbbb/);
  // AND IT DOES NOT SAY THE CANDIDATE CHANGED ANYTHING. This is the line a rate limit or an outage produces,
  // through the real entry point rather than through the helper alone.
  assert.match(result.stderr,
    /^::error::this run cannot establish whether this candidate changes the receipt authority/m);
  assert.equal(/this candidate changes the receipt authority relative to its merge base/.test(result.stderr),
    false, result.stderr);
});

// ---- the assertion the trust step makes about this module's output ------------------------------------------------
//
// MEASURED: the step used to accept any output containing "merge base of", which renderAuthorityScope emits
// unconditionally as its first line - so a module identical to the real one except `AUTHORITY_PATHS = []`
// printed it, the step's case matched, and the step exited 0 having compared nothing. The step now counts the
// per-path lines. That assertion is shell inside a workflow file, so it is tested as shell, on the real bytes.
const WORKFLOW_FILE = fs.readFileSync(path.join(HERE, '..', '..', 'workflows', 'verifier-receipt.yml'), 'utf8');

test('the trust step refuses output that reports on fewer authority paths than the authority has', async () => {
  const step = WORKFLOW_FILE.slice(WORKFLOW_FILE.indexOf('- name: Refuse a candidate that alters the receipt authority'));
  const assertion = step.slice(step.indexOf('reported=$('), step.indexOf('\n  measure:'));
  assert.match(assertion, / -> /, 'the step no longer counts the per-path line');
  assert.equal(/"merge base of"/.test(assertion), false,
    'the step still accepts the header line renderAuthorityScope prints unconditionally');

  const run = verdict => spawnSync('bash',
    ['-c', `set -euo pipefail\nverdict='${verdict.replaceAll("'", "'\\''")}'\n${assertion}`], { encoding: 'utf8' });

  const rendered = renderAuthorityScope(await decide()).join('\n');
  assert.equal(run(rendered).status, 0, `the step rejects what the real module prints:\n${rendered}`);
  // The mutant: everything the real module prints EXCEPT the per-path lines - which is exactly what a module
  // whose AUTHORITY_PATHS is empty prints, header and verdict and nothing compared.
  const mutant = rendered.split('\n').filter(line => !line.includes(' -> ')).join('\n');
  assert.match(mutant, /^merge base of /);
  const refused = run(mutant);
  assert.equal(refused.status, 1, mutant);
  assert.match(refused.stdout + refused.stderr, /reported on 0 authority paths and this authority has 2/);
  // And one path short of the authority is refused too, not just none.
  assert.equal(run(rendered.split('\n').filter((line, index) => index !== 1).join('\n')).status, 1);
});
