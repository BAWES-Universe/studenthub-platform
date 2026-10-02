// The comparison step of `verify-claim.yml`, which is the step that gates a candidate.
//
// It used to be a `node -e` string inside the workflow, and this file is half the reason it no longer is: a
// string in a YAML step body is a thing no test can reach, so the one defect in it - `pins.find(...)` handed
// straight to a property read - sat there as a TypeError waiting for a manifest that did not name the run
// being verified. Fails-closed-by-crash is not this repository's standard. A refusal names what it refused.
//
// No network, no git, no token: the module reads two files and writes a sentence.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const TOOL = path.join(import.meta.dirname, '..', 'compare-pin.mjs');

// The pin `fetch-receipt.mjs` emits, in the shape it emits it - EVERY key of it, because this file now
// refuses a fetched pin carrying a key it was not written for, and that check is only worth having if the
// fixture is the real shape. Nothing here was measured.
const FETCHED = {
  schema: 1,
  repository: 'owner/name',
  workflow_path: '.github/workflows/verifier-receipt.yml',
  workflow_ref: 'refs/heads/main',
  workflow_head_sha: 'a'.repeat(40),
  run_id: '4242',
  run_attempt: '1',
  artifact_name: 'verifier-receipt',
  artifact_id: '77',
  artifact_digest: `sha256:${'d'.repeat(64)}`,
  receipt_digest: `sha256:${'e'.repeat(64)}`,
  attestation_digest: `sha256:${'e'.repeat(64)}`,
  attestation_workflow_ref: 'refs/heads/main',
  admissibility: {
    module: '.github/verifier-receipt/admissibility.mjs',
    module_blob: '1'.repeat(40),
    tolerated_skips: '.github/verifier-receipt/tolerated-skips.json',
    tolerated_skips_blob: '2'.repeat(40),
    protected_ref: 'refs/heads/main',
    derived_reasons: [],
  },
  // BOTH CHANNELS, because the fetch tool records both: `gh` answered the API and `python3` opened the
  // archive the receipt body came out of. This block is never compared - see the module - and since a review
  // showed that "not compared" was being read as "not there", it is now PRINTED, which the cases below pin.
  fetched_with: { gh: '/usr/bin/gh', gh_version: 'gh version 2.0.0', expected_gh: null,
    expected_gh_version: null, python: '/usr/bin/python3', python_version: 'Python 3.11.16',
    expected_python: null, expected_python_version: null, zip_reader: '/usr/lib/python3.11/zipfile.py' },
  receipt: {
    schema: 2,
    admissible_as_pin: true,
    conclusion: { verdict: 'success', suite_state: 'green' },
    candidate: { sha: 'a'.repeat(40), authority_identity: [] },
    manifest: { sha256: 'c'.repeat(64) },
    suite: { tests: 10, ok: 10, not_ok: 0, cancelled: 0, skipped: 0, todo: 0, exit: '0', state: 'green' },
    named_tests: [{ term: 'a/term', name: 'a control', status: 'pass' }],
    named_tests_summary: { named: 1, pass: 1 },
  },
};
// What a candidate commits: the same object, minus the fields a pin file does not have to carry.
const claimedFrom = (patch = {}) => ({ ...JSON.parse(JSON.stringify(FETCHED)), ...patch });

const run = ({ fetched = FETCHED, manifest = { pins: [claimedFrom()] } } = {}) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'compare-pin-'));
  const fetchedPath = path.join(dir, 'pin.json');
  const manifestPath = path.join(dir, 'verifier-receipts.json');
  fs.writeFileSync(fetchedPath, JSON.stringify(fetched));
  fs.writeFileSync(manifestPath, typeof manifest === 'string' ? manifest : JSON.stringify(manifest));
  try {
    return { code: 0, stdout: execFileSync('node',
      [TOOL, '--fetched', fetchedPath, '--manifest', manifestPath], { encoding: 'utf8' }), stderr: '' };
  } catch (error) {
    return { code: error.status ?? 1, stdout: error.stdout?.toString() ?? '',
      stderr: error.stderr?.toString() ?? '' };
  }
};

test('a manifest that carries the pin it should agrees with the run the API describes', () => {
  const result = run();
  assert.equal(result.code, 0, `expected success, got: ${result.stderr}`);
  assert.match(result.stdout, /pin for run 4242 matches the API on every compared field/);
  assert.match(result.stdout, /verdict success/);
  // The success line says what was compared, so a reader of a green log is not left to assume it was all of it.
  assert.match(result.stdout, /the receipt and admissibility blocks/);
  assert.match(result.stdout, /fetched_with is not compared/);

  // A bare array is the other shape a pin file is written in, and it is read the same way.
  assert.equal(run({ manifest: [claimedFrom()] }).code, 0);
});

// ITEM 5. `pins.find(...)` answers `undefined` for a manifest that does not name this run, and the line after
// it read a field off that. The refusal now says what was looked for and what was there.
test('a manifest with no pin for the run being verified is a named refusal, not a TypeError', () => {
  const empty = run({ manifest: { pins: [] } });
  assert.notEqual(empty.code, 0, 'a manifest with no pin for this run must be refused');
  assert.match(empty.stderr, /carries no pin for run 4242, which is the run this verification fetched/);
  assert.match(empty.stderr, /it holds 0 pin\(s\)/);
  assert.doesNotMatch(empty.stderr, /TypeError/, `refused by crashing: ${empty.stderr}`);
  assert.match(empty.stderr, /its absence is refused by name rather than read off an undefined object/);

  // A manifest that names OTHER runs says which, so a reader can see whether a run id was edited.
  const others = run({ manifest: { pins: [claimedFrom({ run_id: '1' }), claimedFrom({ run_id: '2' })] } });
  assert.notEqual(others.code, 0);
  assert.match(others.stderr, /it holds 2 pin\(s\) naming 1, 2/);
  assert.doesNotMatch(others.stderr, /TypeError/);

  // A pin file with no array in it at all, and one that is not JSON, are refusals of their own.
  assert.match(run({ manifest: { pins: 'a string' } }).stderr, /carries no array of pins \("string"\)/);
  assert.match(run({ manifest: '{ not json' }).stderr,
    /the candidate's committed pin file could not be read as JSON/);
});

// C10. Two fields a previous round added to the pin and never compared. A field computed at fetch time and
// never compared is a field the candidate is free to write anything into.
test('the claimed pin must agree on every field, including attestation_workflow_ref and schema', () => {
  for (const [field, value] of [
    ['schema', 2],
    ['attestation_workflow_ref', 'refs/pull/167/merge'],
    ['workflow_path', '.github/workflows/ci.yml'],
    ['workflow_ref', 'refs/heads/topic'],
    ['workflow_head_sha', 'b'.repeat(40)],
    ['run_attempt', '2'],
    ['artifact_name', 'something-else'],
    ['artifact_digest', `sha256:${'0'.repeat(64)}`],
    ['receipt_digest', `sha256:${'0'.repeat(64)}`],
  ]) {
    const result = run({ manifest: { pins: [claimedFrom({ [field]: value })] } });
    assert.notEqual(result.code, 0, `a claimed ${field} of ${value} must be refused`);
    assert.match(result.stderr,
      new RegExp(`disagrees with the run it names on: ${field} \\(claimed `), `${field} gave: ${result.stderr}`);
  }
});

// C9. The step used to ask only that the two objects AGREE about the verdict, so a pin honestly copying
// `verdict: "failure"` passed the step that gates the candidate. Agreement is not success.
test('the fetched receipt must record a success that is admissible as a pin, not merely one both agree on', () => {
  const agreedFailure = {
    ...FETCHED,
    receipt: { ...FETCHED.receipt, conclusion: { verdict: 'failure', suite_state: 'red' } },
  };
  const result = run({ fetched: agreedFailure,
    manifest: { pins: [claimedFrom({ receipt: agreedFailure.receipt })] } });
  assert.notEqual(result.code, 0, 'an honestly copied failure must still be refused');
  assert.match(result.stderr,
    /the pin names a run whose receipt records verdict "failure", and only a success establishes anything/);

  const noVerdict = { ...FETCHED, receipt: { ...FETCHED.receipt, conclusion: {} } };
  assert.match(run({ fetched: noVerdict, manifest: { pins: [claimedFrom({ receipt: noVerdict.receipt })] } })
    .stderr, /records verdict null/);

  for (const value of [false, undefined, 'true']) {
    const receipt = { ...FETCHED.receipt, admissible_as_pin: value };
    const inadmissible = { ...FETCHED, receipt };
    const result = run({ fetched: inadmissible, manifest: { pins: [claimedFrom({ receipt })] } });
    assert.notEqual(result.code, 0, `admissible_as_pin=${JSON.stringify(value)} must be refused`);
    assert.match(result.stderr, /names a receipt that is not admissible as a pin/,
      `gave: ${result.stderr}`);
  }
});

test('the claimed verdict must be the fetched one, and the disagreement names both', () => {
  const lying = claimedFrom({ receipt: { ...FETCHED.receipt, conclusion: { verdict: 'failure' } } });
  const result = run({ manifest: { pins: [lying] } });
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /the claimed pin reports verdict "failure" and the receipt it names reports "success"/);
});

// ITEM 4. THE BODY, NOT JUST THE BOOLEAN. Only `receipt.conclusion.verdict` used to be compared, so the whole
// `receipt` block, the whole `admissibility` block, `artifact_id` and `attestation_digest` were free text: a
// review committed a pin publishing a red suite with 60 failures under renamed tests, naming an all-`f` module
// blob, and this step said ACCEPTED because the one string it read was honest.
test('ITEM 4: the committed pin\'s whole receipt body must be the one this verification fetched', () => {
  for (const [what, receiptPatch, expected] of [
    ['a rewritten suite', { suite: { ...FETCHED.receipt.suite, not_ok: 60, ok: 3581, tests: 3649,
      state: 'red', exit: '1' } }, /receipt\.suite \(claimed /],
    ['renamed tests', { named_tests: [{ term: 'a/term', name: 'a test that was never run', status: 'pass' }] },
      /receipt\.named_tests \(claimed /],
    ['a rewritten summary', { named_tests_summary: { named: 99, pass: 99 } },
      /receipt\.named_tests_summary \(claimed /],
    ['another candidate', { candidate: { sha: 'b'.repeat(40), authority_identity: [] } },
      /receipt\.candidate \(claimed /],
    ['another manifest', { manifest: { sha256: '0'.repeat(64) } }, /receipt\.manifest \(claimed /],
    ['a dropped block', { suite: undefined }, /receipt\.suite \(claimed null/],
  ]) {
    const result = run({ manifest: { pins: [claimedFrom({
      receipt: { ...FETCHED.receipt, ...receiptPatch } })] } });
    assert.notEqual(result.code, 0, `${what} must be refused`);
    assert.match(result.stderr, /publishes a receipt block that is not the one this verification fetched/,
      `${what} gave: ${result.stderr}`);
    assert.match(result.stderr, expected, `${what} gave: ${result.stderr}`);
    assert.match(result.stderr, /a body nobody compares is a body that can say anything/);
  }

  // The rest of the review's committed forgery: a DIFFERENT admissibility rule, which is the block that says
  // under which rule the pin was admitted at all.
  const forgedRule = claimedFrom({ admissibility: { ...FETCHED.admissibility,
    module_blob: 'f'.repeat(40), protected_ref: 'refs/heads/topic',
    derived_reasons: ['the suite was red and we pinned it anyway'] } });
  const rule = run({ manifest: { pins: [forgedRule] } });
  assert.notEqual(rule.code, 0, 'a pin naming another admissibility rule must be refused');
  assert.match(rule.stderr, /publishes a admissibility block that is not the one this verification fetched/);
  assert.match(rule.stderr, /admissibility\.module_blob \(claimed "f{40}", fetched "1{40}"\)/);
  assert.match(rule.stderr, /admissibility\.protected_ref/);
  assert.match(rule.stderr, /admissibility\.derived_reasons/);

  // And the two scalars a previous round put in the pin and never compared.
  for (const [field, value] of [['artifact_id', '999'], ['attestation_digest', `sha256:${'0'.repeat(64)}`]]) {
    const result = run({ manifest: { pins: [claimedFrom({ [field]: value })] } });
    assert.notEqual(result.code, 0, `a claimed ${field} of ${value} must be refused`);
    assert.match(result.stderr, new RegExp(`disagrees with the run it names on: ${field} \\(claimed `),
      `${field} gave: ${result.stderr}`);
  }

  // Key ORDER is not a difference: the comparison is canonical, so a committed pin written by another
  // serialiser is not refused for something that is not a disagreement.
  const reordered = claimedFrom({ receipt: Object.fromEntries(
    Object.entries(FETCHED.receipt).reverse()) });
  assert.equal(run({ manifest: { pins: [reordered] } }).code, 0, 'key order is not a disagreement');

  // A block replaced wholesale by something that is not an object has no keys to name, so the refusal reports
  // the whole block rather than dying on `Object.keys` of a string.
  const notAnObject = run({ manifest: { pins: [claimedFrom({ admissibility: 'trust me' })] } });
  assert.notEqual(notAnObject.code, 0);
  assert.match(notAnObject.stderr, /on the whole block \(claimed "trust me", fetched \{/);
  assert.doesNotMatch(notAnObject.stderr, /TypeError/);

  // A field the COMMITTED pin carries and the fetched one does not is printed rather than refused: what else
  // a manifest pin may carry is the manifest schema's business and the owner's decision, not this step's.
  const annotated = run({ manifest: { pins: [claimedFrom({ term: 'a/term', note: 'why this pin is here' })] } });
  assert.equal(annotated.code, 0, `an annotated committed pin must not be refused: ${annotated.stderr}`);
  assert.match(annotated.stdout,
    /carries 2 field\(s\) the fetched pin does not \(term, note\); they are not compared and establish nothing/);
});

// `fetched_with` describes the binary THIS verification read the API through, not the receipt. The candidate's
// pin was produced by another run on another machine, so requiring the two to agree would refuse honest pins.
// It is named as uncompared rather than left out, so "never compared" is a statement and not an oversight.
test('ITEM 4: fetched_with is deliberately not compared, and an unknown field fails closed', () => {
  const different = claimedFrom({ fetched_with: { gh: '/opt/somewhere/gh', gh_version: 'gh version 9.9.9',
    expected_gh: null, expected_gh_version: null } });
  assert.equal(run({ manifest: { pins: [different] } }).code, 0,
    'a pin fetched on another machine must not be refused for saying so');

  // A field of the FETCHED pin that is in neither list is how artifact_id came to be uncompared in the first
  // place, so it is refused rather than passed over.
  const extended = run({ fetched: { ...FETCHED, something_new: 'a field nobody decided about' },
    manifest: { pins: [claimedFrom()] } });
  assert.notEqual(extended.code, 0, 'an unknown pin field must fail closed');
  assert.match(extended.stderr, /carries 1 field\(s\) this comparison does not know about \(something_new\)/);
  assert.match(extended.stderr,
    /a field that is neither compared nor named as uncompared is a field a candidate is free to write anything into/);
});

// ITEM 3. NOT COMPARED WAS BEING READ AS NOT THERE, AND THE DURABLE RECORD IS THE ONE A READER OPENS.
//
// The reasoning behind not comparing this block is right; the silence that came with it was not. A review
// committed a pin whose `fetched_with` named a trust root that never existed and got ACCEPTED without a word,
// and committed a pin with no `fetched_with` at all and got the same - while `fetch-receipt.mjs` claimed a
// reader of a pin can see which binaries the evidence rested on. The pin a reader gets is the COMMITTED one.
//
// LOGGED, NOT REFUSED, and the reason is in the module: the honest workflow is to commit the pin the fetch
// tool emitted, and that pin carries this block, so refusing its presence would refuse the producer's own
// output. These cases pin the log line, its wording about what it establishes, and that it is not a refusal.
test('ITEM 3: a committed fetched_with is printed beside the fetched one, fabricated or absent', () => {
  // FABRICATED: a trust root that never existed, on a pin that matches the API on every compared field.
  const fabricated = claimedFrom({ fetched_with: { gh: '/opt/attacker/gh',
    gh_version: 'gh version 99.0.0 (trust me)', expected_gh: null, expected_gh_version: null,
    python: '/opt/attacker/python3', python_version: 'Python 9.9.9', expected_python: null,
    expected_python_version: null, zip_reader: '/opt/attacker/zipfile.py' } });
  const said = run({ manifest: { pins: [fabricated] } });
  assert.equal(said.code, 0, `a pin fetched on another machine must not be refused for saying so: ${said.stderr}`);
  assert.match(said.stdout, /matches the API on every compared field/);

  // Both values are in the log, each attributed: what THIS run measured, and what the committed file states.
  assert.match(said.stdout, /This run measured: [^\n]*gh="\/usr\/bin\/gh"/);
  assert.match(said.stdout, /This run measured: [^\n]*python="\/usr\/bin\/python3"/);
  assert.match(said.stdout, /the committed pin for run 4242 states: [^\n]*gh="\/opt\/attacker\/gh"/);
  assert.match(said.stdout, /the committed pin for run 4242 states: [^\n]*gh_version="gh version 99\.0\.0 \(trust me\)"/);
  assert.match(said.stdout, /the committed pin for run 4242 states: [^\n]*zip_reader="\/opt\/attacker\/zipfile\.py"/);
  // And the line says what it is worth, so a reader cannot mistake a printed claim for a checked one.
  assert.match(said.stdout,
    /That statement was not verified by anything and establishes nothing: it is printed so that a trust root a candidate wrote into the durable record is visible rather than silent/);

  // OMITTED ENTIRELY: the other half of the review's finding. An absence is reported as an absence rather
  // than as an empty line, and it is still not a refusal.
  const bare = claimedFrom();
  delete bare.fetched_with;
  const quiet = run({ manifest: { pins: [bare] } });
  assert.equal(quiet.code, 0, `a committed pin may omit an uncompared block: ${quiet.stderr}`);
  assert.match(quiet.stdout, /the committed pin for run 4242 states: absent\./);

  // A block of the wrong SHAPE is printed as what it is, not crashed on: this step's whole reason for
  // existing is that a property read on an unexpected shape is not a refusal a reader can act on.
  for (const [value, expected] of [[null, /states: null\./], [{}, /states: \{\}\./],
    ['a string', /states: "a string"\./], [['a list'], /states: \["a list"\]\./]]) {
    const odd = run({ manifest: { pins: [claimedFrom({ fetched_with: value })] } });
    assert.equal(odd.code, 0, `fetched_with ${JSON.stringify(value)} must not be a refusal: ${odd.stderr}`);
    assert.match(odd.stdout, expected);
  }

  // Every pin naming the run gets its own line, because every one of them is a statement somebody committed.
  // (Duplicates for one run are refused elsewhere; this is the shape the filter exists to keep honest.)
  const honest = run();
  assert.equal((honest.stdout.match(/the committed pin for run 4242 states:/g) ?? []).length, 1);
});

// ITEM 5. `pins.find(...)` answers the FIRST match. A manifest carrying an honest pin for run 4242 and a
// forged second one for the same run was verified twice against the honest one, and the forgery - a different
// artifact_digest over a rewritten body - was never looked at, because the workflow's loop iterates the
// manifest's own run ids and asked about that run twice.
test('ITEM 5: a duplicate run_id is refused by name, and no pin naming the run goes unexamined', () => {
  const honest = claimedFrom();
  const forged = claimedFrom({ artifact_digest: `sha256:${'0'.repeat(64)}`,
    receipt: { ...FETCHED.receipt, suite: { ...FETCHED.receipt.suite, not_ok: 60, state: 'red' } } });
  const result = run({ manifest: { pins: [honest, forged] } });
  assert.notEqual(result.code, 0, 'two pins for one run must be refused');
  assert.match(result.stderr, /carries more than one pin for the same run: run 4242 \(2 pins\)/);
  assert.match(result.stderr, /rather than reading the first of them and never looking at the second/);
  assert.doesNotMatch(result.stdout, /matches the API/, 'a duplicated run must not report a match');

  // Duplicates of a run this verification is NOT about are refused too: the manifest has still said two
  // things about one measurement, and the loop that drives this step iterates every run id in the file.
  const elsewhere = run({ manifest: { pins: [honest, claimedFrom({ run_id: '99' }),
    claimedFrom({ run_id: '99', artifact_digest: `sha256:${'0'.repeat(64)}` })] } });
  assert.notEqual(elsewhere.code, 0);
  assert.match(elsewhere.stderr, /run 99 \(2 pins\)/);

  // Three pins for one run say so as three.
  assert.match(run({ manifest: { pins: [honest, honest, honest] } }).stderr, /run 4242 \(3 pins\)/);

  // AND THE COMPARISON ITSELF IS A FILTER, NOT A FIND. The refusal above makes the set a singleton today;
  // this asserts the property holds on its own by driving the comparison with a manifest whose only pin for
  // the run is the forged one - it is examined rather than shadowed by an honest neighbour for another run.
  const shadowed = run({ manifest: { pins: [claimedFrom({ run_id: '1' }), forged] } });
  assert.notEqual(shadowed.code, 0, 'the forged pin must be examined');
  assert.match(shadowed.stderr, /disagrees with the run it names on: artifact_digest/);
});
