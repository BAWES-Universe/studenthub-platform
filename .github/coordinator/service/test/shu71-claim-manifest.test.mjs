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
import { checkManifest, checkEntries, checkCodeRevision, checkAuthority, withProvesCounts,
  buildEntries, buildManifest, readJson, sha256, MANIFEST_NAME, coverageOf, nonExecutable,
  validateMutationRow, controlFunction } from '../claim-manifest.mjs';

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



test('B7 claim manifest: a PASS without a mutant that kills it is rejected', () => {
  const entry = clone(firstEntryWith(() => true));
  entry.disposition = 'PASS';
  entry.killing_mutants = [];
  const failures = checkEntries(root, [entry], inventory());
  assert.ok(failures.some(line => /PASS without a mutant that kills it/.test(line)),
    `expected a PASS-without-mutant rejection, got: ${failures.join('; ') || 'none'}`);
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
  const coverage = await coverageOf(root, built.entries);
  const inventory = readJson(path.join(root, 'suite-inventory.json'));
  assert.equal(coverage.inventory_names, new Set(inventory.names).size);
  assert.match(coverage.scope, /sealed arming terms/, 'the coverage block states what the manifest covers');
  assert.equal(coverage.controls, built.entries.length);
  assert.equal(coverage.sealed_terms, built.entries.filter(entry => entry.approvable).length);
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

// The seven closure mutants were dropped in silence: their controls are registered by the runner file rather
// than by the registry's control arrays, so every row written against them paired with nothing and landed in
// the outside-scope count, indistinguishable from the suite tests that have nothing to do with this manifest.
// The test names are asserted as attributed, not as counted.
test('B7 claim manifest: the closure mutants are attributed to the controls that kill them', () => {
  const attributed = new Set();
  for (const entry of committed().entries) {
    for (const mutant of entry.killing_mutants) attributed.add(mutant.test_name);
  }
  for (const name of ['the operation label is echoed unsanitized', 'the reason vocabulary is opened']) {
    const match = [...attributed].filter(test_name => test_name.includes(name));
    assert.equal(match.length, 1, `${name} must be attributed to exactly one entry's control`);
  }
});

test('B7 claim manifest: every mutation row is counted, paired or with a stated reason', () => {
  const { mutation_rows, mutation_rows_paired, mutation_rows_unpaired } = committed().coverage;
  assert.equal(mutation_rows_paired + mutation_rows_unpaired.length, mutation_rows,
    'a mutation row that is neither paired nor explained is a mutation row the manifest hides');
  assert.ok(mutation_rows_unpaired.every(row => typeof row.reason === 'string' && row.reason.length > 0),
    'an unpaired mutation row must carry the reason it is unpaired');
});

test('B7 claim manifest: a term with no mutant is marked as one no receipt can approve', () => {
  const entries = committed().entries;
  for (const entry of entries) {
    assert.equal(entry.approvable, entry.killing_mutants.length > 0,
      `${entry.id}: approvable must be the fact that a mutant kills this control, not a claim about it`);
    // sealed_term is the term itself. A second object key of the same name silently won, and every entry
    // carried a boolean while the manifest carried the term's text nowhere.
    assert.equal(typeof entry.sealed_term, 'string');
    assert.ok(entry.sealed_term.length > 0);
  }
  const coverage = committed().coverage;
  assert.equal(coverage.sealed_terms, entries.filter(entry => entry.approvable).length);
  assert.equal(coverage.controls, entries.length);
  assert.equal(coverage.controls_never_approvable_through_this_path, entries.length - coverage.sealed_terms);
});

test('B7 claim manifest: every receipt in the directory is listed, with failing runs called out', () => {
  const present = committed().receipt_files_present;
  assert.ok(Array.isArray(present) && present.length > 0, 'the manifest must list the receipts it read');
  for (const receipt of present) {
    assert.match(receipt.file, /^receipts\/[^/]+$/, `receipt listed as ${receipt.file}`);
    assert.equal(typeof receipt.records_failing_run, 'boolean',
      'a reader must be able to tell a failing run from a passing one without opening the file');
  }
});




// Evidence is a pin naming a workflow run, not a file. A file in the receipts directory is written by the
// authoring lane and can approve nothing: with no pins at all, every entry is BLOCK however many files the
// directory holds.
test('B7 claim manifest: no pin means no PASS, however many receipt files exist', async () => {
  const entries = await buildEntries(root, [], committed().code_revision.head);
  const passing = entries.filter(entry => entry.disposition === 'PASS');
  assert.deepEqual(passing, [], `files approved ${passing.map(entry => entry.id).join(', ')}`);
  assert.equal(committed().receipt_files_are_not_evidence, true);
  for (const entry of committed().entries) {
    for (const receipt of entry.receipts) {
      assert.equal(receipt.source, 'github-actions',
        `${entry.id}: the only evidence an entry may carry is a run of the receipt authority`);
    }
  }
});

// A pin proves a term when the receipt inside it records every control test of that term and every mutant
// that kills it as passing. A mutant recorded as failing withdraws the term, and so does a mutant the receipt
// never mentions: a run in which a test did not appear is not a run in which it passed.
test('B7 claim manifest: a pin proves exactly the tests its receipt recorded as passing', async () => {
  const manifest = committed();
  const head = manifest.code_revision.head;
  const target = manifest.entries.find(entry => entry.approvable);
  const named = [
    ...target.control.test_names.map(name => ({ term: target.id, kind: 'control', name, status: 'pass' })),
    ...target.killing_mutants.map(mutant => ({ term: target.id, kind: 'mutant', name: mutant.test_name, status: 'pass' })),
  ];
  const pin = {
    run_id: '1', run_attempt: '1', workflow_path: '.github/workflows/verifier-receipt.yml',
    workflow_head_sha: 'f'.repeat(40), artifact_name: 'verifier-receipt',
    artifact_digest: `sha256:${'a'.repeat(64)}`, receipt_digest: `sha256:${'b'.repeat(64)}`,
    receipt: { candidate: { sha: head, tree: manifest.code_revision.tree },
      manifest: { sha256: 'c'.repeat(64), code_revision: { head, tree: manifest.code_revision.tree } },
      conclusion: { verdict: 'success' },
      suite: { tests: 3672, ok: 3663, not_ok: 9, skipped: 0, exit: '1' }, named_tests: named },
  };
  const withPin = await buildEntries(root, [pin], head);
  assert.equal(withPin.find(entry => entry.id === target.id).disposition, 'PASS',
    'a pin whose receipt records this term passing must reach PASS');
  assert.deepEqual(withPin.filter(entry => entry.receipts.length > 0).map(entry => entry.id), [target.id],
    'the pin proves the term it measured and no other');

  const failingMutant = clone(pin);
  failingMutant.receipt.named_tests = named.map(test =>
    test.kind === 'mutant' ? { ...test, status: 'fail' } : test);
  assert.equal((await buildEntries(root, [failingMutant], head)).find(entry => entry.id === target.id).disposition,
    'BLOCK', 'a mutant recorded as failing must withdraw the term');

  const absentMutant = clone(pin);
  absentMutant.receipt.named_tests = named.filter(test => test.kind !== 'mutant');
  assert.equal((await buildEntries(root, [absentMutant], head)).find(entry => entry.id === target.id).disposition,
    'BLOCK', 'a mutant the receipt never mentions is not a mutant that passed');

  const otherRevision = clone(pin);
  otherRevision.receipt.candidate.sha = '0'.repeat(40);
  otherRevision.receipt.manifest.code_revision.head = '0'.repeat(40);
  assert.equal((await buildEntries(root, [otherRevision], head)).find(entry => entry.id === target.id).disposition,
    'BLOCK', 'a pin measured at another revision must not approve this one');
});

// A receipt that cannot say what it ran is not evidence. The counts must add up, and a pin whose receipt
// cannot account for its run is refused before its list of passing tests is even read.
test('B7 claim manifest: a pin whose receipt cannot account for its run is refused', async () => {
  const manifest = committed();
  const head = manifest.code_revision.head;
  const target = manifest.entries.find(entry => entry.approvable);
  const named = [
    ...target.control.test_names.map(name => ({ term: target.id, kind: 'control', name, status: 'pass' })),
    ...target.killing_mutants.map(mutant => ({ term: target.id, kind: 'mutant', name: mutant.test_name, status: 'pass' })),
  ];
  const make = suite => ({ run_id: '7', run_attempt: '1', workflow_path: '.github/workflows/verifier-receipt.yml',
    workflow_head_sha: 'f'.repeat(40), artifact_name: 'verifier-receipt',
    artifact_digest: `sha256:${'a'.repeat(64)}`, receipt_digest: `sha256:${'b'.repeat(64)}`,
    receipt: { candidate: { sha: head, tree: manifest.code_revision.tree },
      manifest: { sha256: 'c'.repeat(64), code_revision: { head, tree: manifest.code_revision.tree } },
      conclusion: { verdict: 'success' }, suite, named_tests: named } });

  const coherent = make({ tests: 3672, ok: 3663, not_ok: 9, skipped: 0, exit: '1' });
  assert.equal((await buildEntries(root, [coherent], head)).find(entry => entry.id === target.id).disposition,
    'PASS', 'a receipt whose counts add up and whose tests passed must reach PASS');

  const notAddingUp = make({ tests: 3672, ok: 3663, not_ok: 1, skipped: 0, exit: '1' });
  const entry = (await buildEntries(root, [notAddingUp], head)).find(candidate => candidate.id === target.id);
  assert.equal(entry.disposition, 'BLOCK', 'counts that do not add up must not approve anything');
  assert.ok(/do not add up/.test(entry.reason ?? ''),
    `expected an accounting refusal, got: ${entry.reason}`);

  const noExit = make({ tests: 3672, ok: 3663, not_ok: 9, skipped: 0 });
  assert.equal((await buildEntries(root, [noExit], head)).find(candidate => candidate.id === target.id).disposition,
    'BLOCK', 'a receipt with no exit code must not approve anything');

  const noSuite = make(undefined);
  assert.equal((await buildEntries(root, [noSuite], head)).find(candidate => candidate.id === target.id).disposition,
    'BLOCK', 'a receipt that records no run of a suite must not approve anything');
});

// How much one receipt approves is a number a reader should be able to see, not infer by counting attachments.
test('B7 claim manifest: a pin records how many terms it proves', async () => {
  const manifest = committed();
  const pins = [{ run_id: '9', receipt_digest: 'sha256:x', artifact_digest: 'sha256:y' }];
  const counted = withProvesCounts(pins, manifest.entries);
  assert.equal(counted[0].proves, 0, 'a pin no entry carries proves nothing');
  const carried = withProvesCounts(pins, [{ receipts: [{ run_id: '9' }] }, { receipts: [] }]);
  assert.equal(carried[0].proves, 1, 'a pin one entry carries proves one term');
});

// The generator and the checker must agree, which is the defect that produced the exit-7 crash and the
// half-migrated PASS rules: the generator learned about pins and the checker did not. This is the agreement
// proof - build with a real pin, hand the result to the checker, and require that it accepts exactly what the
// generator produced, naming anything it would refuse.
const pinFor = (manifest, term, mutate = () => {}) => {
  const head = manifest.code_revision.head;
  const named = [
    ...term.control.test_names.map(name => ({ term: term.id, kind: 'control', name, status: 'pass' })),
    ...term.killing_mutants.map(mutant => ({ term: term.id, kind: 'mutant', name: mutant.test_name, status: 'pass' })),
  ];
  const pin = { run_id: '11', run_attempt: '1', workflow_path: '.github/workflows/verifier-receipt.yml',
    workflow_head_sha: 'f'.repeat(40), artifact_name: 'verifier-receipt',
    artifact_digest: `sha256:${'a'.repeat(64)}`, receipt_digest: `sha256:${'b'.repeat(64)}`,
    receipt: { candidate: { sha: head, tree: manifest.code_revision.tree },
      manifest: { sha256: 'c'.repeat(64), code_revision: { head, tree: manifest.code_revision.tree } },
      conclusion: { verdict: 'success' },
      suite: { tests: 3672, ok: 3663, not_ok: 9, skipped: 0, exit: '1' }, named_tests: named } };
  mutate(pin);
  return pin;
};

test('B7 claim manifest: the checker accepts what the generator produces from a pin, and refuses by name what it should', async () => {
  const manifest = committed();
  const head = manifest.code_revision.head;
  const target = manifest.entries.find(entry => entry.approvable);
  const inventory = new Set(readJson(path.join(root, 'suite-inventory.json')).names);

  // Agreement: a manifest the generator produced from a real pin must survive the checker untouched.
  const entries = await buildEntries(root, [pinFor(manifest, target)], head);
  assert.equal(entries.find(entry => entry.id === target.id).disposition, 'PASS',
    'the generator must reach PASS for the term its pin proves');
  assert.deepEqual(checkEntries(root, entries, inventory).filter(line => !/inventory/.test(line)), [],
    'the checker must accept what the generator produces from a pin');

  // A pin from anywhere but the authority refuses by name.
  const foreign = entries.find(entry => entry.id === target.id);
  const foreignPin = { ...foreign.receipts[0], workflow_path: '.github/workflows/ci.yml' };
  const foreignFailures = checkEntries(root, [{ ...foreign, receipts: [foreignPin] }], inventory);
  assert.ok(foreignFailures.some(line => /was produced by .*ci\.yml/.test(line)),
    `expected a refusal naming the producing workflow, got: ${foreignFailures.join('; ')}`);

  // A pin whose receipt records a test as failing cannot carry a PASS.
  const failing = entries.find(entry => entry.id === target.id);
  const failingPin = { ...failing.receipts[0],
    control_tests: (failing.receipts[0].control_tests ?? []).map(test => ({ ...test, status: 'fail' })) };
  const failingFailures = checkEntries(root, [{ ...failing, receipts: [failingPin] }], inventory);
  assert.ok(failingFailures.some(line => /records .* as fail/.test(line)),
    `expected a refusal naming the test, got: ${failingFailures.join('; ')}`);

  // A pin missing an immutable field refuses by name.
  const partial = { ...failing.receipts[0] };
  delete partial.artifact_digest;
  const partialFailures = checkEntries(root, [{ ...failing, receipts: [partial] }], inventory);
  assert.ok(partialFailures.some(line => /is missing artifact_digest/.test(line)),
    `expected a refusal naming the missing field, got: ${partialFailures.join('; ')}`);
});

// The authority cannot approve its own change: a receipt dispatched from the very revision under approval is
// refused, and so is a checkout that alters the authority since the commit the receipt was dispatched from.
test('B7 claim manifest: the receipt authority cannot approve its own change', () => {
  const revision = committed().code_revision.head;
  const selfDispatched = checkAuthority(root, { code_revision: { head: revision },
    pins_present: [{ workflow_head_sha: revision }] });
  assert.ok(selfDispatched.some(line => /cannot approve the change that carries it/.test(line)),
    `expected a self-approval refusal, got: ${selfDispatched.join('; ') || 'none'}`);
  const elsewhere = checkAuthority(root, { code_revision: { head: revision },
    pins_present: [{ workflow_head_sha: git(['rev-list', '--max-parents=0', 'HEAD']).split('\n').pop() }] });
  assert.ok(elsewhere.every(line => !/cannot approve/.test(line)),
    `a dispatch from another revision must not be refused as self-approval, got: ${elsewhere.join('; ')}`);
});


test('B7 claim manifest: executable script is not admitted under a receipts directory', () => {
  assert.equal(nonExecutable('.github/coordinator/service/receipts/evil.mjs'), false,
    'receipts are JSON; a directory named receipts is not a place executables may follow a code revision');
  assert.equal(nonExecutable('receipts/evil.mjs'), false);
});

test('B7 claim manifest: the tolerance admits this service receipts and nothing else under that name', () => {
  assert.equal(nonExecutable('apps/gateway/receipts/exploit.mjs'), false,
    'a path is not a receipts directory just because it is called one');
  assert.equal(nonExecutable('.github/coordinator/service/receipts/verifier-left.json'), true);
});

test('B7 claim manifest: the inventory denominator counts distinct names', () => {
  const coverage = committed().coverage;
  const names = readJson(path.join(root, 'suite-inventory.json')).names;
  assert.equal(coverage.inventory_names, new Set(names).size,
    'the denominator must count the names, not the rows that repeat them');
  assert.equal(coverage.duplicate_inventory_names, names.length - new Set(names).size);
});
