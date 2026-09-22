// B7. The approval manifest is a generated artifact, and this file is what says so.
//
// One control: the committed manifest is exactly what the registries and the receipts build, so no entry
// can be hand-edited into claiming more. Then one mutant per rejection path the owner asked CI to
// enforce - a missing test, a missing mutant, an absent or tampered receipt, a wrong head, a PASS
// without the evidence for it - each driving the guard with a tampered manifest and asserting the guard
// fails for that reason and not another.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkManifest, checkEntries, checkCodeRevision, buildManifest, readJson, sha256, MANIFEST_NAME,
  coverageOf, nonExecutable, validateMutationRow, controlFunction } from '../claim-manifest.mjs';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const inventory = () => new Set(readJson(path.join(root, 'suite-inventory.json')).names);
const committed = () => readJson(path.join(root, MANIFEST_NAME));
const clone = value => JSON.parse(JSON.stringify(value));
const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();

const firstEntryWith = predicate => {
  const entry = committed().entries.find(predicate);
  assert.ok(entry, 'the committed manifest carries no entry of the kind this check needs');
  return entry;
};

// This guard reads the repository's history: it proves the manifest's code revision is an ancestor of this
// checkout with no executable difference between them. Where git cannot read the checkout it cannot do
// that, and a guard that degrades quietly can report a match it never compared - the environment is
// asserted rather than assumed. This is also what makes the file's registered capability `git` a measured
// fact rather than a claim: remove git and these tests fail rather than passing on empty values.
test('B7 claim manifest: the guard runs only where git can read this checkout', () => {
  assert.match(git(['rev-parse', 'HEAD']), /^[0-9a-f]{40}$/, 'git must be able to read this checkout');
  assert.match(git(['rev-parse', 'HEAD^{tree}']), /^[0-9a-f]{40}$/, 'git must be able to read this tree');
});

test('B7 claim manifest: the committed manifest is what the registries and receipts build', async () => {
  const failures = await checkManifest(root);
  assert.deepEqual(failures, [], failures.join('; '));
});

test('B7 claim manifest: an entry that names an uncommitted control is rejected', () => {
  const tampered = clone(committed());
  tampered.entries[0].control.test_names = ['B7 claim manifest: a control that is not committed anywhere'];
  const failures = checkEntries(root, tampered.entries, inventory());
  assert.ok(failures.some(line => /control test .* is not in the committed inventory/.test(line)),
    `expected a missing-control rejection, got: ${failures.join('; ') || 'none'}`);
});

test('B7 claim manifest: an entry that names an uncommitted mutant is rejected', () => {
  const entry = clone(firstEntryWith(candidate => candidate.killing_mutants.length > 0));
  entry.killing_mutants[0].test_name = 'B7 claim manifest mutation: a mutant that is not committed anywhere';
  const failures = checkEntries(root, [entry], inventory());
  assert.ok(failures.some(line => /mutant test .* is not in the committed inventory/.test(line)),
    `expected a missing-mutant rejection, got: ${failures.join('; ') || 'none'}`);
});

test('B7 claim manifest: an absent receipt is rejected', () => {
  const entry = clone(firstEntryWith(() => true));
  entry.receipts = [{ file: 'receipts/a-receipt-that-does-not-exist.json', kind: 'verified',
    sha256: '0'.repeat(64), verdict: 'PASS' }];
  const failures = checkEntries(root, [entry], inventory());
  assert.ok(failures.some(line => /receipt .* is absent/.test(line)),
    `expected an absent-receipt rejection, got: ${failures.join('; ') || 'none'}`);
});

test('B7 claim manifest: a receipt whose bytes changed is rejected', () => {
  const entry = clone(firstEntryWith(() => true));
  entry.receipts = [{ file: 'suite-inventory.json', kind: 'verified', sha256: '0'.repeat(64),
    verdict: 'PASS' }];
  const failures = checkEntries(root, [entry], inventory());
  assert.ok(failures.some(line => /digest does not match/.test(line)),
    `expected a tampered-receipt rejection, got: ${failures.join('; ') || 'none'}`);
});

test('B7 claim manifest: a PASS without a mutant that kills it is rejected', () => {
  const entry = clone(firstEntryWith(() => true));
  entry.disposition = 'PASS';
  entry.killing_mutants = [];
  const failures = checkEntries(root, [entry], inventory());
  assert.ok(failures.some(line => /PASS without a mutant that kills it/.test(line)),
    `expected a PASS-without-mutant rejection, got: ${failures.join('; ') || 'none'}`);
});

test('B7 claim manifest: a PASS whose verifying receipt is not a PASS is rejected', () => {
  const entry = clone(firstEntryWith(() => true));
  const receipt = path.join(root, 'suite-inventory.json');
  entry.disposition = 'PASS';
  entry.receipts = [{ file: 'suite-inventory.json', kind: 'verified',
    sha256: sha256(fs.readFileSync(receipt)), verdict: 'FAIL' }];
  const failures = checkEntries(root, [entry], inventory());
  assert.ok(failures.some(line => /verifying receipt whose verdict is not PASS/.test(line)),
    `expected a non-PASS-receipt rejection, got: ${failures.join('; ') || 'none'}`);
});

test('B7 claim manifest: a disposition that is neither PASS nor BLOCK is rejected', () => {
  const entry = clone(firstEntryWith(() => true));
  entry.disposition = 'PROBABLY';
  const failures = checkEntries(root, [entry], inventory());
  assert.ok(failures.some(line => /disposition must be PASS or BLOCK/.test(line)),
    `expected a disposition rejection, got: ${failures.join('; ') || 'none'}`);
});

test('B7 claim manifest: a code revision this checkout does not contain is rejected', () => {
  const failures = checkCodeRevision(root, { code_revision: { head: '0'.repeat(40) } });
  assert.ok(failures.some(line => /does not contain the manifest's code revision|is not an ancestor/.test(line)),
    `expected a wrong-head rejection, got: ${failures.join('; ') || 'none'}`);
});

test('B7 claim manifest: a wrong head is rejected, whether it differs executably or is not here at all', () => {
  // Which of the two rejections fires depends on the checkout: a shallow CI clone does not carry the
  // repository's early commits, so a head that is not present is rejected as such rather than compared.
  // Both are rejections of a wrong head, and this test asserts the rejection rather than the wording.
  const root_commit = git(['rev-list', '--max-parents=0', 'HEAD']).split('\n').pop();
  const failures = checkCodeRevision(root, { code_revision: { head: root_commit } });
  assert.ok(failures.length > 0, 'a head this checkout does not contain must be rejected');
  assert.ok(failures.some(line => /differs from this checkout in|is not an ancestor|cannot be compared|does not contain the manifest's code revision/.test(line)),
    `expected a wrong-head rejection, got: ${failures.join('; ') || 'none'}`);
});

test('B7 claim manifest: only documentation, the manifest and receipts may follow the code revision', () => {
  // The tolerance is what a manifest names as its code revision, so it is checked as a rule rather than
  // described in prose. A fixed revision of any kind must fail the guard: an inventory fix committed after
  // the code revision left this manifest naming a revision whose own suite inventory no longer matched the
  // suite it described, and a suffix test for .json said nothing about it.
  assert.equal(nonExecutable('.github/coordinator/service/SHU71-PREREQUISITES.md'), true);
  assert.equal(nonExecutable('.github/coordinator/service/claim-manifest.json'), true);
  // The shape git emits, not a shape the repository never produces: the receipts leg of this rule was
  // unreachable for a round because this assertion used a bare relative path.
  assert.equal(nonExecutable('.github/coordinator/service/receipts/verifier-left.json'), true);
  assert.equal(nonExecutable('receipts/verifier-left.json'), true);
  assert.equal(nonExecutable('.github/coordinator/service/suite-inventory.json'), false);
  assert.equal(nonExecutable('.github/coordinator/service/a12-evidence/file-requirements.json'), false);
  assert.equal(nonExecutable('.github/workflows/ci.yml'), false);
  assert.equal(nonExecutable('.github/coordinator/service/claim-manifest.mjs'), false);
});

test('B7 claim manifest: the coverage block counts what the entries enumerate and what they do not', async () => {
  const built = await buildManifest(root, committed().code_revision.head);
  const coverage = coverageOf(root, built.entries);
  const inventory = readJson(path.join(root, 'suite-inventory.json'));
  assert.equal(coverage.inventory_names, inventory.names.length);
  assert.match(coverage.scope, /sealed arming terms/, 'the coverage block states what the manifest covers');
  assert.equal(coverage.sealed_terms, built.entries.length);
  assert.equal(coverage.control_names_referenced_in_inventory + coverage.suite_names_outside_scope,
    coverage.inventory_names,
    'every inventory name is either referenced by a sealed term or counted as outside the manifest scope');
  assert.equal(coverage.referenced_not_in_inventory, 0,
    'an entry must not reference a test name the inventory does not carry');
  assert.deepEqual(coverage, built.coverage, 'the rebuild and the generator count the same coverage');
});

test('B7 claim manifest: a mutant attributed on an unestablished basis is rejected', () => {
  const entry = clone(firstEntryWith(candidate => candidate.killing_mutants.length > 0));
  entry.killing_mutants[0].paired_by = 'looks-about-right';
  const failures = checkEntries(root, [entry], inventory());
  assert.ok(failures.some(line => /no established pairing basis/.test(line)),
    `expected a pairing-basis rejection, got: ${failures.join('; ') || 'none'}`);
});

test('B7 claim manifest: a verified receipt at a revision the manifest does not cover is rejected', async () => {
  // Ignoring such a receipt is what protects the dispositions; it is not what protects the tree. This asserts
  // the guard says so out loud rather than passing over a receipt that verifies nothing here.
  const file = path.join(root, 'receipts', 'zz-test-stray-verified.json');
  const body = JSON.stringify({ head: 'd'.repeat(40), tree: 'd'.repeat(40), kind: 'verified',
    verdict: 'PASS', verifier: 'test', scope: 'test' });
  fs.writeFileSync(file, body);
  try {
    const failures = await checkManifest(root);
    assert.ok(failures.some(line => /verified receipts at a revision this manifest does not cover/.test(line)),
      `expected a stray-receipt rejection, got: ${failures.join('; ') || 'none'}`);
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('B7 claim manifest: a mutation row whose shape disagrees with the index read is refused', () => {
  // The check index is fixed per export name, which holds for the two registries this manifest covers and
  // does not hold for every registry in the repository: branch-restore rows are [name, edits, check]. Reading
  // the wrong index pairs every mutation there with undefined and reports "no mutant" for terms that have one.
  // Nothing is mis-paired today; this is the guard against adding a registry that is.
  // The check is found in the row rather than assumed at an index. A fixed index was wrong in both
  // directions in this repository: B5's closureMutations rows carry their check at index 1, behind a string
  // the generator used to read, and branch-restore rows carry it at index 2.
  const five = ['a term', 'from', 'to', (_create, _fixture) => {}];
  assert.equal(validateMutationRow(five, 'B6 arming robustness'), null);
  assert.equal(validateMutationRow(['a term', (_c, _f) => {}], 'branch restore'), null);
  assert.match(validateMutationRow(['a term', 'from', 'to', 'not a function'], 'x'), /carries no function/);
  assert.match(validateMutationRow([], 'x'), /has no name/);
  assert.match(validateMutationRow('not a row', 'x'), /is not an array/);

  // Which function is the control. B5's closure rows carry their check at index 1 and a second function - the
  // reviewed-detail extractor - that is not a control, and a fixed index read a string there instead.
  const closure = ['a term', (_c, _f) => {}, (_d) => {}];
  assert.equal(controlFunction(closure, fn => fn === closure[1], 'B5 closure').check, closure[1],
    'the registered function is chosen even when a later function sits in the row');
  const wrapper = ['a term', 'from', 'to', (_c, _f) => {}];
  assert.equal(controlFunction(wrapper, () => false, 'B6').check, wrapper[3],
    'with nothing registered, the first function is the wrapper the row was written as');
  assert.match(controlFunction(['x', (_c) => {}, (_c) => {}], () => true, 'y').error,
    /carries 2 registered controls/);
});

test('B7 claim manifest: every suite file list in the tree agrees with the committed tree', () => {
  // Three lists carry the suite's test files and two of them were updated by hand in one round while the
  // third was missed, and a fourth kind of drift was found later still. The lists are compared to the
  // derivation git performs, so a future list cannot be forgotten in silence.
  // --full-tree because this runs from the service directory, where ls-tree would otherwise report only
  // what is under it: a check that silently compares an empty list to an empty list is not a check.
  const tracked = git(['ls-tree', '-r', '--name-only', '--full-tree', 'HEAD']).split('\n');
  const roots = ['.github/coordinator/test/', '.github/coordinator/service/test/'];
  const expected = tracked.filter(file => roots.some(root => file.startsWith(root)
    && !file.slice(root.length).includes('/') && file.endsWith('.test.mjs'))).sort();
  // The lists that describe the suite as it is now: what the deriver writes, and the audit beside it. The
  // other JSON in a12-evidence that mentions test files is a historical comparison carrying its own
  // baseline revision and before/after counts; it records what a past round compared, so it is not a
  // current list and is deliberately not compared here.
  const lists = [
    { file: 'suite-inventory.json', value: readJson(path.join(root, 'suite-inventory.json')).files },
    { file: 'a12-evidence/required-files.json', value: readJson(path.join(root, 'a12-evidence/required-files.json')) },
    { file: 'a12-evidence/file-requirements.json',
      value: readJson(path.join(root, 'a12-evidence/file-requirements.json')).map(row => row.file) },
  ];
  assert.equal(lists.length, 3, 'the three current lists are the ones compared');
  for (const list of lists) {
    assert.deepEqual(list.value, expected, `${list.file} does not match the committed tree`);
  }
});

test('B7 claim manifest: a manifest committed after the code revision it names is accepted', async () => {
  // The shape every real manifest has: the code revision is committed, then the manifest on top of it. The
  // guard must rebuild against the code revision, not against HEAD, or every manifest reports as tampered
  // with - and a guard that cannot pass at the commit carrying the manifest is a guard that was never run
  // there. This asserts the shape, so the test cannot pass vacuously if those two revisions are ever equal.
  const manifest = committed();
  const head = git(['rev-parse', 'HEAD']);
  assert.notEqual(manifest.code_revision.head, head,
    'this repository state no longer has the shape under test: the manifest names HEAD itself');
  assert.deepEqual(await checkManifest(root), []);
  const rebuilt = await buildManifest(root, manifest.code_revision.head);
  assert.equal(rebuilt.code_revision.head, manifest.code_revision.head);
});

test('B7 claim manifest: a manifest whose entries were edited by hand is rejected', () => {
  const onDisk = path.join(root, MANIFEST_NAME);
  const original = fs.readFileSync(onDisk, 'utf8');
  try {
    const edited = clone(JSON.parse(original));
    edited.entries[0].sealed_term = `${edited.entries[0].sealed_term} and more than the code carries`;
    fs.writeFileSync(onDisk, `${JSON.stringify(edited, null, 2)}\n`);
    return checkManifest(root).then(failures => {
      assert.ok(failures.some(line => /a claim was edited rather than generated/.test(line)),
        `expected an edited-claim rejection, got: ${failures.join('; ') || 'none'}`);
    }).finally(() => fs.writeFileSync(onDisk, original));
  } catch (error) { fs.writeFileSync(onDisk, original); throw error; }
});
