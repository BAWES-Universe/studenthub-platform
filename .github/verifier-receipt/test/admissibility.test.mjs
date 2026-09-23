// The admission predicate, ground by ground, over receipts written down here.
//
// This is the rule the emitter records into every receipt, the rule the workflow's gate and guard call, and the
// rule the consumer re-derives with before it emits a pin. It used to be four hand-written copies; what this
// file tests is the one implementation all four now share, so a tightening that reaches only some of them is
// not a thing that can happen.
//
// THE BODIES BELOW ARE WRITTEN, NOT MEASURED, and say so: `admissibleBody()` is the smallest body that
// satisfies every ground, and each case turns exactly one thing off. The one body here that a run really
// produced is the fixture in `fixtures/receipt-35869844952/`, which is a FAILURE receipt - see its README.
//
// No network, no git, no history: this suite runs under actions/checkout at the default fetch-depth 1.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveAdmissibility, loadToleratedSkips, TOLERATED_SKIPS_PATH } from '../admissibility.mjs';

const HEAD = 'a'.repeat(40);

// WRITTEN DOWN, NOT MEASURED. Every ground satisfied, and nothing in it happened.
const admissibleBody = (patch = {}) => ({
  schema: 2,
  workflow: {
    path: '.github/workflows/verifier-receipt.yml',
    head_sha: HEAD,
    head_branch: 'main',
    event: 'workflow_dispatch',
    trusted_source_sha: HEAD,
    trusted_source_origin: 'protected-main',
    trusted_source_on_main: true,
  },
  candidate: {
    sha: HEAD,
    authority_identity: [
      { path: '.github/workflows/verifier-receipt.yml', protected_sha: 'b'.repeat(40), change: 'none' },
      { path: '.github/verifier-receipt', protected_sha: 'c'.repeat(40), change: 'none' },
    ],
  },
  suite: { tests: 4, ok: 4, not_ok: 0, cancelled: 0, skipped: 0, todo: 0, exit: '0', state: 'green',
    failing_tests: [] },
  named_tests: [{ term: 'a/term', kind: 'control', name: 'a control', status: 'pass' }],
  named_tests_summary: { named: 1, pass: 1 },
  conclusion: { verdict: 'success', suite_state: 'green', qualifications: [], reasons: [] },
  ...patch,
});

// A body with one field replaced at a path, so a case says what it changed and nothing else.
const withSuite = fields => admissibleBody({ suite: { ...admissibleBody().suite, ...fields } });
const withWorkflow = fields => admissibleBody({ workflow: { ...admissibleBody().workflow, ...fields } });
const reasonsOf = body => deriveAdmissibility(body).reasons;
const joined = body => reasonsOf(body).join(' | ');

// The allow-list this rule reads is a FILE, so a case that needs a different list writes one.
const listing = entries => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'skips-')), 'tolerated-skips.json');
  fs.writeFileSync(file, typeof entries === 'string' ? entries : JSON.stringify({ authorized: entries }));
  return file;
};

test('the positive control: a body that satisfies every ground is admissible, with no reason recorded', () => {
  const derived = deriveAdmissibility(admissibleBody());
  assert.deepEqual(derived.reasons, []);
  assert.equal(derived.admissible, true);
  // `admissible` is exactly "no reasons", never a separate judgement.
  assert.equal(derived.admissible, derived.reasons.length === 0);
});

// ---- (a) the verdict -----------------------------------------------------------------------------------------

test('a verdict that is not success is a reason, in the emitter\'s own long-standing words', () => {
  assert.equal(joined(admissibleBody({ conclusion: { verdict: 'failure', suite_state: 'green' } })),
    'this receipt\'s verdict is failure, so there is nothing in it for a manifest to pin');
  // Any other verdict is NAMED rather than called failure.
  assert.match(joined(admissibleBody({ conclusion: { verdict: 'cancelled', suite_state: 'green' } })),
    /this receipt's verdict is "cancelled", so there is nothing in it for a manifest to pin/);
  // And an absent verdict is a reason about the absent field, never a satisfied condition.
  assert.match(joined(admissibleBody({ conclusion: { suite_state: 'green' } })),
    /records no conclusion\.verdict, so nothing in it says a measurement succeeded/);
  assert.match(joined(admissibleBody({ conclusion: undefined })), /records no conclusion\.verdict/);
});

// ---- (b) the suite state, which is C5 ------------------------------------------------------------------------

test('A RED SUITE CANNOT ESTABLISH AN ADMISSIBLE PIN, however far outside a claim its failures fall', () => {
  // The case this rule was written for: the claim's own names all passed, and 60 tests elsewhere in the tree
  // failed. The verdict may still be a qualified success - it is scoped to the names - but the receipt is not
  // pinnable, and the refusal quotes the count and names what failed where the receipt records it.
  const red = withSuite({ not_ok: 2, ok: 2, state: 'red', exit: '1',
    failing_tests: ['an unrelated check', 'a second unrelated check'] });
  red.conclusion.suite_state = 'red';
  const why = joined(red);
  assert.match(why, /suite\.state is "red", not "green"/);
  assert.match(why, /conclusion\.suite_state is "red", not "green"/);
  assert.match(why, /the measured suite reports 2 failing test\(s\) out of 4[^|]*an unrelated check, a second unrelated check/);
  assert.equal(deriveAdmissibility(red).admissible, false);

  // A red suite that does not name its failures is still refused, and the refusal says the names are missing.
  const unnamed = withSuite({ not_ok: 1, ok: 3, state: 'red', exit: '1', failing_tests: undefined });
  unnamed.conclusion.suite_state = 'red';
  assert.match(joined(unnamed), /reports 1 failing test\(s\) out of 4[^|]*this receipt does not name them/);
});

test('a cancelled test and a `todo` are refusals: neither is a measurement of anything', () => {
  assert.match(joined(withSuite({ cancelled: 1, tests: 5 })),
    /the measured run did not finish: the runner reported 1 cancelled point\(s\)/);
  assert.match(joined(withSuite({ todo: 2, tests: 6 })),
    /reports 2 test\(s\) carrying a `# TODO` directive[^|]*an unmodelled exclusion is not a green suite/);
});

test('A SKIP IS A REFUSAL UNLESS THE AUTHORIZED LIST NAMES IT: the file is permission, not a hint', () => {
  const skipped = withSuite({ skipped: 1, ok: 3, skipped_tests: ['a check that needs a docker daemon'] });
  assert.match(joined(skipped), /1 skipped test\(s\) are not in the authorized list `?\.github\/verifier-receipt\/tolerated-skips\.json`?, which is permission rather than a hint: "a check that needs a docker daemon"/);

  // Named in the list, with a reason and an authorizer: tolerated, and the body is admissible again.
  const authorized = listing([{ test: 'a check that needs a docker daemon',
    reason: 'the runner image has no docker daemon; the claim describes behaviour that does not need one',
    authorized_by: 'the owner, in this test and nowhere else' }]);
  assert.deepEqual(deriveAdmissibility(skipped, { toleratedSkipsPath: authorized }).reasons, []);

  // A DIFFERENT test's name in the list authorizes nothing: the match is on the name, literally.
  const elsewhere = listing([{ test: 'some other test', reason: 'environmental', authorized_by: 'the owner' }]);
  assert.match(deriveAdmissibility(skipped, { toleratedSkipsPath: elsewhere }).reasons.join(' | '),
    /are not in the authorized list/);

  // An entry that names no reason or no authorizer is not permission, and the list it is in is not usable.
  const unsigned = listing([{ test: 'a check that needs a docker daemon', reason: 'environmental' }]);
  const why = deriveAdmissibility(skipped, { toleratedSkipsPath: unsigned }).reasons.join(' | ');
  assert.match(why, /do not name a test, a reason and an authorizer/);
  assert.match(why, /are not in the authorized list/);
});

// D7. A review produced a body carrying `not_ok: 0` beside a non-empty `failing_tests` and this rule read it
// as clean, because failures were counted from the counter alone: one integer, forged, and every name the
// same body had failed on became invisible. Every place the body records a failure is now read, and a counter
// that understates what the body itself names is refused as the disagreement it is.
test('D7: a non-empty failing list beside a zero counter is a disagreement, not a pass', () => {
  const forged = withSuite({ not_ok: 0, ok: 4, state: 'green',
    failing_tests: ['a check that failed', 'a second check that failed'] });
  const why = joined(forged);
  assert.match(why, /records suite\.not_ok=0 and names 2 failing test\(s\) in suite\.failing_tests, which is a receipt disagreeing with itself/);
  assert.match(why, /"a check that failed", "a second check that failed"/);
  assert.equal(deriveAdmissibility(forged).admissible, false);

  // The claim-scoped list the emitter writes beside it is read too, and so are the `fail` rows of
  // `named_tests`: a body cannot hide a failure by recording it somewhere the counter does not look.
  assert.match(joined(withSuite({ not_ok: 0, failing_tests_named_by_the_claim: ['a term the claim names'] })),
    /records suite\.not_ok=0 and names 1 failing test\(s\) in suite\.failing_tests_named_by_the_claim/);
  const rows = admissibleBody({ named_tests: [{ name: 'a control', status: 'pass' },
    { name: 'a named test that failed', status: 'fail' }] });
  assert.match(joined(rows), /records suite\.not_ok=0 and names 1 failing test\(s\) in named_tests/);

  // A counter that AGREES with the names is not a disagreement: the red-suite reason above is the one that
  // fires, and this check adds nothing to it.
  const honest = withSuite({ not_ok: 2, ok: 2, state: 'red', exit: '1',
    failing_tests: ['a check that failed', 'a second check that failed'] });
  honest.conclusion.suite_state = 'red';
  assert.doesNotMatch(joined(honest), /disagreeing with itself/);

  // Nor is a counter that names MORE than the list: a truncated list is a different defect, and `not_ok > 0`
  // has already refused this body. Only understating is read as a disagreement.
  const truncated = withSuite({ not_ok: 9, ok: 1, state: 'red', exit: '1', failing_tests: ['one of nine'] });
  truncated.conclusion.suite_state = 'red';
  assert.doesNotMatch(joined(truncated), /disagreeing with itself/);
  assert.match(joined(truncated), /reports 9 failing test\(s\) out of 4/);
});

// D15. A `named_tests` row whose status is `skip` was invisible whenever `suite.skipped_tests` was present as
// an ARRAY: one line exempted `skip` from the every-other-exclusion block on the understanding that the skip
// block judged it, and the skip block then read only the first source it found. `skipped_tests: []` beside a
// skip row therefore authorised nothing and refused nothing. The two shapes are now meshed.
test('D15: a skipped named test is visible whichever shape the body carries it in', () => {
  // The seam itself: an EMPTY `skipped_tests` array beside a `skip` row in `named_tests`.
  const hidden = admissibleBody({
    suite: { ...admissibleBody().suite, skipped: 1, ok: 3, skipped_tests: [] },
    named_tests: [{ name: 'a control', status: 'pass' },
      { name: 'a check that needs a docker daemon', status: 'skip' }],
  });
  const why = joined(hidden);
  assert.match(why, /1 skipped test\(s\) are not in the authorized list[^|]*"a check that needs a docker daemon"/);
  assert.equal(deriveAdmissibility(hidden).admissible, false);

  // And it is judged against the list rather than merely refused: named there, with a reason and an
  // authorizer, the same body is admissible again.
  const authorized = listing([{ test: 'a check that needs a docker daemon',
    reason: 'the runner image has no docker daemon', authorized_by: 'the owner, in this test and nowhere else' }]);
  assert.deepEqual(deriveAdmissibility(hidden, { toleratedSkipsPath: authorized }).reasons, []);

  // The two sources are UNIONED, not preferred: a skip named in each is judged, and both count towards the
  // number of skips this rule can name against `suite.skipped`.
  const both = admissibleBody({
    suite: { ...admissibleBody().suite, skipped: 2, ok: 2, skipped_tests: ['a skip only the suite names'] },
    named_tests: [{ name: 'a skip only the rows name', status: 'skip' }],
  });
  const union = joined(both);
  assert.match(union, /2 skipped test\(s\) are not in the authorized list/);
  assert.match(union, /"a skip only the suite names"/);
  assert.match(union, /"a skip only the rows name"/);
  assert.doesNotMatch(union, /cannot be checked against/);

  // A skip row with no counter beside it at all is still judged: `suite.skipped: 0` is not permission.
  const uncounted = admissibleBody({
    named_tests: [{ name: 'a skip the suite did not count', status: 'skip' }],
  });
  assert.match(joined(uncounted), /1 skipped test\(s\) are not in the authorized list[^|]*"a skip the suite did not count"/);

  // And an unreadable permission list is reported as soon as there is a NAMED skip to judge, not only when
  // the counter is above zero.
  const unreadable = deriveAdmissibility(uncounted,
    { toleratedSkipsPath: path.join(os.tmpdir(), 'no-such-tolerated-skips.json') }).reasons.join(' | ');
  assert.match(unreadable, /the authorized-skip list[^|]*could not be read/);
});

test('a skip the receipt COUNTS but does not NAME cannot be authorized, so it is refused', () => {
  // The real receipt is in exactly this state: `suite.skipped: 8` with no list of names anywhere in the body.
  const counted = withSuite({ skipped: 8, ok: 4, tests: 12 });
  assert.match(joined(counted),
    /records 8 skipped test\(s\) and names 0 of them, so 8 cannot be checked against/);
});

test('the shipped authorized list is empty, so nothing is tolerated in this repository yet', () => {
  const list = loadToleratedSkips();
  assert.equal(list.problem, null, 'the shipped list must be readable');
  assert.deepEqual(list.entries, [], 'this change authorizes no skip; adding one is a separate decision');
  assert.equal(list.names.size, 0);
  // And it is the file the rule reads by default, in the protected authority directory.
  assert.equal(path.basename(TOLERATED_SKIPS_PATH), 'tolerated-skips.json');
  assert.equal(path.basename(path.dirname(TOLERATED_SKIPS_PATH)), 'verifier-receipt');
  assert.ok(JSON.parse(fs.readFileSync(TOLERATED_SKIPS_PATH, 'utf8'))._comment.join(' ')
    .includes('PERMISSION, not a hint'));
});

test('a list this rule cannot read authorizes nothing, and says so rather than passing quietly', () => {
  const skipped = withSuite({ skipped: 1, ok: 3, skipped_tests: ['a skipped check'] });
  for (const [what, file] of [
    ['a file that is not there', path.join(os.tmpdir(), 'no-such-tolerated-skips.json')],
    ['a file that is not JSON', listing('{ not json')],
    ['a file with no `authorized` array', listing({ toString() { return ''; } })],
  ]) {
    const why = deriveAdmissibility(skipped, { toleratedSkipsPath: file }).reasons.join(' | ');
    assert.match(why, /authorized-skip list/, `${what} must be reported`);
    assert.match(why, /are not in the authorized list/, `${what} must still refuse the skip`);
  }
});

test('every other exclusion the receipt records is a reason, under the name the receipt gives it', () => {
  const excluded = admissibleBody({
    named_tests: [
      { name: 'a control', status: 'pass' },
      { name: 'a test reported in another file', status: 'misplaced' },
      { name: 'a test the runner reported no location for', status: 'unbound' },
      { name: 'a test whose entry names no artifact', status: 'unclaimed' },
      { name: 'a test the capture never reported', status: 'absent' },
    ],
  });
  const why = joined(excluded);
  assert.match(why, /1 named test\(s\) are recorded `absent` rather than passing[^|]*"a test the capture never reported"/);
  assert.match(why, /1 named test\(s\) are recorded `misplaced` rather than passing[^|]*"a test reported in another file"/);
  assert.match(why, /1 named test\(s\) are recorded `unbound` rather than passing/);
  assert.match(why, /1 named test\(s\) are recorded `unclaimed` rather than passing/);
  assert.equal(reasonsOf(excluded).length, 4, 'one reason per status, each naming its own tests');
});

test('a suite block, a count or a named_tests list the rule reads and cannot find is a reason of its own', () => {
  assert.match(joined(admissibleBody({ suite: undefined })),
    /records no `suite` block[^|]*nothing in it says whether the measured suite was green/);
  assert.match(joined(withSuite({ state: undefined })),
    /records no suite\.state, so nothing in it says the measured suite was green/);
  for (const field of ['not_ok', 'cancelled', 'skipped', 'todo']) {
    assert.match(joined(withSuite({ [field]: undefined })),
      new RegExp(`records no readable suite\\.${field} \\(null\\)`), `${field} must be read, not assumed`);
    assert.match(joined(withSuite({ [field]: '0' })),
      new RegExp(`records no readable suite\\.${field} \\("0"\\)`), `${field} must not be coerced`);
  }
  assert.match(joined(admissibleBody({ named_tests: undefined })),
    /carries no `named_tests` list[^|]*nothing in it says what the runner reported/);
});

// ---- (c) the authority on the protected branch ---------------------------------------------------------------

test('an authority that is absent on main means this run compared the candidate against nothing', () => {
  const body = admissibleBody();
  body.candidate.authority_identity[1].protected_sha = null;
  assert.equal(joined(body), 'the receipt authority is absent on main (.github/verifier-receipt), so this run '
    + 'compared the candidate against nothing and cannot establish that it leaves the authority alone');
  // Both absent, named in the order the receipt records them.
  const both = admissibleBody();
  for (const entry of both.candidate.authority_identity) entry.protected_sha = null;
  assert.match(joined(both),
    /absent on main \(\.github\/workflows\/verifier-receipt\.yml, \.github\/verifier-receipt\)/);
  // An entry that simply omits the key is absent too: a missing field is not an intact authority.
  const omitted = admissibleBody();
  delete omitted.candidate.authority_identity[0].protected_sha;
  assert.match(joined(omitted), /absent on main \(\.github\/workflows\/verifier-receipt\.yml\)/);
  // And a receipt with no authority_identity at all says nothing about the comparison it made.
  assert.match(joined(admissibleBody({ candidate: { sha: HEAD } })),
    /carries no candidate\.authority_identity/);
  assert.match(joined(admissibleBody({ candidate: { sha: HEAD, authority_identity: [] } })),
    /carries no candidate\.authority_identity/);
});

// ---- (d) to (g) the provenance of the run itself --------------------------------------------------------------

test('only a workflow_dispatch of the authority\'s own workflow, made on main, may be pinned', () => {
  assert.equal(joined(withWorkflow({ event: 'pull_request' })),
    'this run\'s event is pull_request; only a workflow_dispatch of .github/workflows/verifier-receipt.yml '
    + 'may be pinned');
  assert.match(joined(withWorkflow({ event: undefined })),
    /records no workflow\.event, so nothing in it says which event ran the authority/);
  assert.equal(joined(withWorkflow({ head_branch: 'verifier/one-admission-predicate' })),
    'this run was made on verifier/one-admission-predicate, not the protected default branch');
  assert.match(joined(withWorkflow({ head_branch: undefined })), /records no workflow\.head_branch/);
});

test('the authority files must have come from protected main, and that commit must be contained in main', () => {
  assert.equal(joined(withWorkflow({ trusted_source_origin: 'pull-request-head' })),
    'the authority files came from pull-request-head, not from protected main');
  assert.match(joined(withWorkflow({ trusted_source_origin: undefined })),
    /records no workflow\.trusted_source_origin/);
  assert.equal(joined(withWorkflow({ trusted_source_on_main: false })),
    `the authority commit ${HEAD.slice(0, 12)} is not contained in main`);
  // ABSENT IS NOT TRUE, and neither is the string "true": the field is read, not coerced.
  assert.match(joined(withWorkflow({ trusted_source_on_main: undefined })),
    /records no workflow\.trusted_source_on_main/);
  assert.match(joined(withWorkflow({ trusted_source_on_main: 'true' })), /is not contained in main/);
});

test('the grounds are reported in one fixed order, so two readers can compare their lists literally', () => {
  const body = admissibleBody({ conclusion: { verdict: 'failure', suite_state: 'red' } });
  body.suite = { ...body.suite, state: 'red', not_ok: 1, ok: 3, exit: '1', failing_tests: ['a failing check'] };
  body.candidate.authority_identity[0].protected_sha = null;
  body.workflow = { ...body.workflow, event: 'push', head_branch: 'a-lane',
    trusted_source_origin: 'pull-request-head', trusted_source_on_main: false };
  const why = reasonsOf(body);
  // (a) the verdict, then (b) the suite, then (c) the authority, then (d) to (g) the run's own provenance.
  const at = pattern => {
    const index = why.findIndex(reason => pattern.test(reason));
    assert.notEqual(index, -1, `no reason matched ${pattern}:\n${why.join('\n')}`);
    return index;
  };
  const order = [/^this receipt's verdict is failure/, /^suite\.state is "red"/,
    /^the receipt authority is absent on main/, /^this run's event is push/, /^this run was made on a-lane/,
    /^the authority files came from pull-request-head/, /is not contained in main$/].map(at);
  assert.deepEqual(order, [...order].sort((left, right) => left - right), why.join('\n'));
  assert.equal(order[0], 0, 'the verdict is the first ground');
  assert.equal(order[order.length - 1], why.length - 1, 'the authority commit is the last');
});

test('a thing that is not a receipt permits nothing, and does not throw', () => {
  for (const notAReceipt of [null, undefined, 'a string', 42, []]) {
    const derived = deriveAdmissibility(notAReceipt);
    assert.equal(derived.admissible, false);
    assert.deepEqual(derived.reasons, ['this is not a receipt object, so nothing in it permits a pin']);
  }
});

// ---- the real receipt ------------------------------------------------------------------------------------------

test('THE REAL RECEIPT of run 35869844952 is inadmissible, and the rule says so for its own reasons', () => {
  // A receipt a real dispatch of this authority on refs/heads/main produced, three unread keys removed and no
  // value edited: see fixtures/receipt-35869844952/README.md. It is a FAILURE receipt over a red suite.
  const real = JSON.parse(fs.readFileSync(
    path.join(import.meta.dirname, 'fixtures', 'receipt-35869844952', 'receipt.trimmed.json'), 'utf8'));
  const derived = deriveAdmissibility(real);
  assert.equal(derived.admissible, false);
  // The one reason that receipt itself recorded, re-derived here word for word.
  assert.equal(derived.reasons[0], real.provenance.inadmissibility_reasons[0]);
  assert.equal(derived.reasons[0],
    'this receipt\'s verdict is failure, so there is nothing in it for a manifest to pin');
  // And the grounds the receipt's body supports that the rule of the day did not yet ask about: 60 failing
  // tests, 8 skips it does not name, and 132 names the runner reported no location for.
  const why = derived.reasons.join(' | ');
  assert.match(why, /the measured suite reports 60 failing test\(s\) out of 3649/);
  assert.match(why, /records 8 skipped test\(s\) and names 0 of them/);
  assert.match(why, /132 named test\(s\) are recorded `unbound` rather than passing/);
  // Its PROVENANCE grounds all pass, which is what makes it the honest fixture: it was a real dispatch of main
  // with the authority present on the protected branch, and it is refused on what it measured.
  for (const provenanceGround of [/absent on main/, /this run's event is/, /this run was made on/,
    /authority files came from/, /is not contained in main/]) {
    assert.doesNotMatch(why, provenanceGround, `refused on the wrong ground: ${why}`);
  }
});
