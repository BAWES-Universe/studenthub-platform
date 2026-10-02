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

// NEXT-3 made the summary a checked field, so these bodies have to carry an HONEST one. The emitter builds
// `named_tests_summary` by counting `named_tests` - one array, counted once - so a written body that sets the
// rows and leaves a stale summary beside them is a body no run could produce, and the rule now says so. This
// counts the rows the same way the emitter does, so a case that replaces the rows gets a summary that matches
// them and every case below keeps testing the one ground it is about. A case that wants the two to DISAGREE
// passes `named_tests_summary` explicitly, which is exactly what the NEXT-3 case does.
const summaryOf = rows => ({
  named: rows.length,
  distinct_names: new Set(rows.map(row => String(row?.name))).size,
  pass: rows.filter(row => row?.status === 'pass').length,
  fail: rows.filter(row => row?.status === 'fail').length,
  absent: rows.filter(row => row?.status === 'absent').length,
  skipped: rows.filter(row => row?.status === 'skip').length,
  todo: rows.filter(row => row?.status === 'todo').length,
  suite_points: rows.filter(row => row?.status === 'suite').length,
  misplaced: rows.filter(row => row?.status === 'misplaced').length,
  unbound: rows.filter(row => row?.status === 'unbound').length,
  unclaimed: rows.filter(row => row?.status === 'unclaimed').length,
});

// WRITTEN DOWN, NOT MEASURED. Every ground satisfied, and nothing in it happened.
const baseBody = () => ({
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
  conclusion: { verdict: 'success', suite_state: 'green', qualifications: [], reasons: [] },
});
const admissibleBody = (patch = {}) => {
  const body = { ...baseBody(), ...patch };
  if (!('named_tests_summary' in patch)) {
    body.named_tests_summary = summaryOf(Array.isArray(body.named_tests) ? body.named_tests : []);
  }
  return body;
};

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

// NEXT-2. `suite.state` is DERIVED from `suite.exit` by the emitter - `const suiteRed = exitCode !== 0 ||
// unfinished > 0` - and nothing read the field it was derived from. A body carrying `exit: "1"` beside
// `state: "green"` is D7's shape one field over: the derived value flipped, the source left where it was.
test('NEXT-2: the runner\'s own exit code is read, so a green state over a failing exit is refused', () => {
  const forged = withSuite({ exit: '1' });
  const why = joined(forged);
  assert.match(why, /the runner that measured this suite exited "1", not "0"/);
  assert.match(why, /whatever suite\.state records beside it/);
  assert.equal(deriveAdmissibility(forged).admissible, false);
  // Only this ground fires: the body is otherwise the admissible one, which is what makes it the seam.
  assert.equal(reasonsOf(forged).length, 1, `expected exactly one reason, got: ${why}`);

  // A numeric exit is read the same way a string one is: the field is compared as what it says, not coerced
  // into a boolean by its presence.
  assert.match(joined(withSuite({ exit: 2 })), /exited "2", not "0"/);
  // And an absent exit is a reason, on the standing rule that an absent field is not a satisfied condition.
  for (const absent of [undefined, null, '']) {
    assert.match(joined(withSuite({ exit: absent })),
      /records no suite\.exit[^|]*suite\.state is derived from exactly that/,
      `exit=${JSON.stringify(absent)} must be a reason`);
  }
  // The positive control: exit "0" is what the shipped admissible body carries, and it satisfies the ground.
  assert.deepEqual(reasonsOf(admissibleBody()), []);
});

// NEXT-1. `suite.tests` is the runner's total and the five category counts partition it, so a body claiming
// ten tests while accounting for three has not said what happened to the other seven - and every exclusion
// counter reading zero is precisely how such a body passed every other check.
test('NEXT-1: the suite counts must reconcile with suite.tests when the body carries them', () => {
  // The review's case: tests 10, ok 3, every exclusion counter zero.
  const short = withSuite({ tests: 10, ok: 3 });
  const why = joined(short);
  assert.match(why, /records 10 test\(s\) in suite\.tests and accounts for 3 of them \(ok 3 \+ not_ok 0 \+ cancelled 0 \+ skipped 0 \+ todo 0\)/);
  assert.match(why, /7 point\(s\) are in neither the total nor the categories that partition it/);
  assert.equal(deriveAdmissibility(short).admissible, false);
  assert.equal(reasonsOf(short).length, 1, `expected exactly one reason, got: ${why}`);

  // And the other direction: more accounted for than the total claims.
  assert.match(joined(withSuite({ tests: 2, ok: 4 })), /records 2 test\(s\).*accounts for 4 of them/);

  // MEASURED: on node v22.22.3 a file with one passing, one failing, one timing-out, one skipped and one
  // `todo` test reports `# tests 5 / # pass 1 / # fail 1 / # cancelled 1 / # skipped 1 / # todo 1`, so
  // `cancelled` is a category that sums into the total alongside the other four. A body shaped like that
  // reconciles here, and is refused for the cancellation itself rather than for arithmetic it did not get
  // wrong - which is the point of putting `cancelled` in the sum.
  const cancelled = withSuite({ tests: 5, ok: 1, not_ok: 1, cancelled: 1, skipped: 1, todo: 1,
    state: 'red', exit: '1', failing_tests: ['one that failed'], skipped_tests: ['one that was skipped'] });
  cancelled.conclusion.suite_state = 'red';
  assert.doesNotMatch(joined(cancelled), /do not add up|accounts for/,
    'a body whose counts DO reconcile must not be accused of arithmetic');
  assert.match(joined(cancelled), /the measured run did not finish/);

  // Checked only when every count is READABLE: an unreadable one is its own reason (see the case below, which
  // is what closed the escape) and a second sentence accusing the body of arithmetic would say nothing new.
  assert.doesNotMatch(joined(withSuite({ ok: undefined })), /accounts for/);

  // The real receipt's own numbers satisfy the identity, which is why requiring it costs nothing.
  assert.equal(3581 + 60 + 0 + 8 + 0, 3649);
});

// NEXT-1(E). THE ESCAPE FROM THE IDENTITY, CLOSED. The block above ran only when all six counts were readable,
// and only four of them were required anywhere - so DELETING `tests` or `ok` made the reconciliation not run
// rather than fail. A review demonstrated it: `[ADMISSIBLE] ok DELETED, tests 3649`. The argument this rule
// already made for requiring `suite.exit` - the emitter always writes it - holds for both of these verbatim.
test('NEXT-1(E): deleting suite.tests or suite.ok is a reason, not an escape from the identity', () => {
  for (const field of ['tests', 'ok']) {
    // DELETED, which is the review's word: the key is not there at all, not set to something unreadable.
    const gutted = admissibleBody();
    delete gutted.suite[field];
    const why = joined(gutted);
    assert.match(why, new RegExp(`records no readable suite\\.${field} \\(null\\)`),
      `suite.${field} deleted must be a reason, got: ${why}`);
    assert.match(why, /an absent field is not a satisfied condition/);
    assert.equal(deriveAdmissibility(gutted).admissible, false,
      `a body with suite.${field} deleted must not be admissible`);
    // Exactly one reason: the identity does not ALSO fire, because a body missing one of its terms has not
    // got the arithmetic wrong - it has not stated it. One defect, one sentence.
    assert.equal(reasonsOf(gutted).length, 1, `expected exactly one reason, got: ${why}`);
  }

  // The review's own shape, with the counts of this repository's real 3649-test receipt: `ok` gone and
  // everything else honest. It used to read ADMISSIBLE.
  const review = withSuite({ tests: 3649, ok: undefined, not_ok: 0, cancelled: 0, skipped: 0, todo: 0 });
  assert.equal(deriveAdmissibility(review).admissible, false, 'ok DELETED, tests 3649 must be refused');
  assert.match(joined(review), /records no readable suite\.ok \(null\)/);
});

// NEXT-1(E), THE OTHER HALF: WHICH FIELDS ARE NUMBERS AND WHICH IS A STRING, DECIDED AND PINNED HERE.
//
// The forged body a review built carried `"exit":"0"` as a STRING, so the coercion rule is not academic. The
// emitter writes `suite.exit` as a string - `const suiteExit = String(meta.suite_exit ?? '')` - and the
// counts as JSON numbers, so the rule reads each as what its producer writes: `exit` is compared as a string,
// and a count that is not a number is REFUSED BY NAME rather than parsed. This case is the record of that
// choice, so that changing either side fails here instead of going unnoticed.
test('NEXT-1(E): a count rendered as a string is refused by name, and suite.exit is a string by design', () => {
  for (const field of ['tests', 'ok', 'not_ok', 'cancelled', 'skipped', 'todo']) {
    const stringy = withSuite({ [field]: String(admissibleBody().suite[field]) });
    const why = joined(stringy);
    assert.match(why, new RegExp(`records no readable suite\\.${field} \\("\\d+"\\)`),
      `suite.${field} as a string must be refused by name, got: ${why}`);
    assert.equal(deriveAdmissibility(stringy).admissible, false);
  }
  // Nor is a number-shaped string accepted anywhere it would change the arithmetic: `tests` as "4" beside an
  // `ok` of 4 is not a body that reconciles, it is a body that did not say how many tests there were.
  assert.doesNotMatch(joined(withSuite({ tests: '4' })), /accounts for/);

  // AND THE DELIBERATE EXCEPTION, ASSERTED SO THAT IT IS ONE. `exit: "0"` is what the emitter writes and what
  // the shipped admissible body carries; it is read on its merits and satisfies the ground.
  assert.equal(typeof admissibleBody().suite.exit, 'string');
  assert.deepEqual(reasonsOf(admissibleBody()), []);
  // A numeric exit is read the same way, which is the existing NEXT-2 rule and is restated here only to make
  // the contrast with the counts explicit: `exit` is compared as text either way, a count never is.
  assert.match(joined(withSuite({ exit: 1 })), /exited "1", not "0"/);
});

// NEXT-1(E), THE LAST WAY INTO THE IDENTITY: A COUNT TOO LARGE TO DO ARITHMETIC ON.
//
// `Number.isInteger` accepts every integral double, including ones whose neighbours are not representable,
// and the reconciliation is float arithmetic - so a review walked two bodies past it. Neither smuggles a
// failing test past anything else in this rule; both are bodies whose own counters this file cannot add up
// while claiming it checked them, which is the property the identity exists to assert.
test('NEXT-1(E): a count too large to be a safe integer is refused instead of reconciling with itself', () => {
  // THE ARITHMETIC THAT USED TO ADMIT THEM, asserted first so the cases below are about the rule and not
  // about a claim made in a comment.
  assert.equal(1e308 + 0 + 0 + 0 + 0, 1e308, 'the sum that used to reconcile');
  assert.equal(2 ** 53 + 1, 2 ** 53, 'two different JSON literals, one double');
  assert.equal(Number.isInteger(1e308) && Number.isInteger(2 ** 53 + 1), true,
    'both are integers by the old test, which is why it admitted them');

  // The review's first shape: tests and ok both 1e308, every exclusion counter zero, nothing else touched.
  const huge = withSuite({ tests: 1e308, ok: 1e308 });
  const why = joined(huge);
  assert.match(why, /records no readable suite\.tests \(1e\+308\)/, `got: ${why}`);
  assert.match(why, /records no readable suite\.ok \(1e\+308\)/);
  assert.equal(deriveAdmissibility(huge).admissible, false, '1e308 test(s) must not be admissible');
  // And it is refused for being unreadable, not accused of arithmetic it did not get wrong.
  assert.doesNotMatch(why, /accounts for/);

  // The review's second shape: 2**53 + 1 tests beside 2**53 ok, which are the same double and so reconcile.
  const unsafe = withSuite({ tests: 2 ** 53 + 1, ok: 2 ** 53 });
  assert.equal(deriveAdmissibility(unsafe).admissible, false, '2**53+1 tests must not be admissible');
  assert.match(joined(unsafe), /records no readable suite\.tests \(9007199254740992\)/);

  // The other four counts are read to the same standard, because an unsafe one there makes the same sum
  // uncheckable: `tests` honest, one category beyond the safe range.
  for (const field of ['not_ok', 'cancelled', 'skipped', 'todo']) {
    const body = withSuite({ [field]: Number.MAX_SAFE_INTEGER + 2 });
    assert.equal(deriveAdmissibility(body).admissible, false,
      `suite.${field} beyond the safe range must not be admissible`);
    // The identity is not asserted over an unreadable term: that count is null, so the sum does not run.
    assert.doesNotMatch(joined(body), /accounts for/, `suite.${field}: ${joined(body)}`);
  }

  // THE BOUNDARY, BOTH SIDES, so this is a rule about safety and not about size. The largest safe integer is
  // read; one more is not. A body of 2**53 - 1 tests is refused for its arithmetic, which is the sentence a
  // body with readable counts that do not add up is supposed to get.
  const atTheEdge = withSuite({ tests: Number.MAX_SAFE_INTEGER, ok: 1 });
  assert.match(joined(atTheEdge), /accounts for 1 of them/, `got: ${joined(atTheEdge)}`);
  assert.doesNotMatch(joined(atTheEdge), /records no readable suite\.tests/);

  // The positive control: this repository's real counts are ordinary safe integers and satisfy every ground.
  assert.deepEqual(reasonsOf(admissibleBody()), []);
});

// NEXT-3. The emitter builds `named_tests_summary` by counting `named_tests`, so the two can only disagree in
// a body somebody wrote. Every block above reads the ROWS, so a summary claiming failures the rows do not
// carry went unread entirely.
test('NEXT-3: a summary that disagrees with the rows it summarises is refused, without choosing a side', () => {
  // The review's case: the summary says four failed and the rows carry the pass row.
  const lying = admissibleBody({ named_tests_summary: { named: 1, pass: 1, fail: 4 } });
  const why = joined(lying);
  assert.match(why, /named_tests_summary\.fail is 4 and named_tests carries 0 `fail` row\(s\)/);
  assert.match(why, /nothing in it says which of the two is the forgery/);
  assert.equal(deriveAdmissibility(lying).admissible, false);

  // NEITHER SIDE IS CHOSEN. The rows say every named test passed and the summary says four failed; the rule
  // refuses the receipt rather than believing one of them, so no reason here says the rows are right.
  assert.equal(reasonsOf(lying).length, 1, `expected only the disagreement, got: ${why}`);
  assert.doesNotMatch(why, /recorded `fail` rather than passing/);

  // Every count the summary states is compared, under its own name.
  for (const [field, value, expected] of [
    ['named', 7, /named_tests_summary\.named is 7 and named_tests carries 1 row\(s\)/],
    ['distinct_names', 3, /distinct_names is 3 and named_tests carries 1 distinct name\(s\)/],
    ['pass', 0, /named_tests_summary\.pass is 0 and named_tests carries 1 `pass` row\(s\)/],
    ['absent', 2, /named_tests_summary\.absent is 2 and named_tests carries 0 `absent` row\(s\)/],
    ['skipped', 1, /named_tests_summary\.skipped is 1 and named_tests carries 0 `skip` row\(s\)/],
    ['todo', 1, /named_tests_summary\.todo is 1 and named_tests carries 0 `todo` row\(s\)/],
    ['suite_points', 1, /named_tests_summary\.suite_points is 1 and named_tests carries 0 `suite` row\(s\)/],
    ['misplaced', 1, /named_tests_summary\.misplaced is 1 and named_tests carries 0 `misplaced` row\(s\)/],
    ['unbound', 1, /named_tests_summary\.unbound is 1 and named_tests carries 0 `unbound` row\(s\)/],
    ['unclaimed', 1, /named_tests_summary\.unclaimed is 1 and named_tests carries 0 `unclaimed` row\(s\)/],
    ['pass', '1', /named_tests_summary\.pass is "1" and named_tests carries 1 `pass` row/],
  ]) {
    const body = admissibleBody({ named_tests_summary: { ...summaryOf(baseBody().named_tests), [field]: value } });
    assert.match(joined(body), expected, `summary.${field}=${JSON.stringify(value)} must be refused`);
  }

  // ONLY WHAT THE SUMMARY STATES IS COMPARED. A summary that omits a key has made no claim about it, and
  // inventing a claim of zero on its behalf would be reading absence as a statement. It hides nothing: the
  // rows are read directly by every block above, so a `fail` row is still a reason with no summary at all.
  assert.deepEqual(reasonsOf(admissibleBody({ named_tests_summary: { named: 1 } })), []);
  assert.deepEqual(reasonsOf(admissibleBody({ named_tests_summary: undefined })), []);
  const badRow = admissibleBody({ named_tests: [{ name: 'a control', status: 'absent' }],
    named_tests_summary: { named: 1 } });
  assert.match(joined(badRow), /1 named test\(s\) are recorded `absent` rather than passing/);

  // The real receipt's own summary and rows agree - 132 `unbound` rows and `unbound: 132` - so this ground
  // adds no reason to a body a run really produced.
  const real = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, 'fixtures',
    'receipt-35869844952', 'receipt.trimmed.json'), 'utf8'));
  assert.equal(real.named_tests_summary.unbound, 132);
  assert.equal(real.named_tests.filter(row => row.status === 'unbound').length, 132);
  assert.equal(deriveAdmissibility(real).reasons.filter(reason => reason.includes('named_tests_summary')).length,
    0, 'the real receipt\'s summary and rows agree, so NEXT-3 must add nothing to its refusal');
});

// THE PERMISSION LIST CAN DECIDE AS BYTES, which is what closes the consumer's TOCTOU: a caller that has
// verified bytes hands those over rather than a path, so there is nothing left to re-read between the check
// and the decision. See THE BYTES THAT DECIDE in fetch-receipt.mjs.
test('the authorized list decides from verified BYTES when it is given them, and not from a path', () => {
  const skipped = withSuite({ skipped: 1, ok: 3, skipped_tests: ['a check that needs a docker daemon'] });
  const bytes = Buffer.from(JSON.stringify({ authorized: [{ test: 'a check that needs a docker daemon',
    reason: 'the runner image has no docker daemon', authorized_by: 'the owner, in this test and nowhere else' }] }));
  assert.deepEqual(deriveAdmissibility(skipped, { toleratedSkipsBytes: bytes }).reasons, []);

  // Bytes WIN over a path, so a caller that supplies both cannot have the path quietly decide.
  const permissivePath = listing([{ test: 'a check that needs a docker daemon', reason: 'x', authorized_by: 'y' }]);
  const refusing = deriveAdmissibility(skipped,
    { toleratedSkipsBytes: Buffer.from(JSON.stringify({ authorized: [] })), toleratedSkipsPath: permissivePath });
  assert.match(refusing.reasons.join(' | '), /are not in the authorized list/,
    'the bytes must decide, not the path beside them');

  // A Uint8Array is read the same way a Buffer is, because that is what a fetch hands back.
  assert.deepEqual(deriveAdmissibility(skipped, { toleratedSkipsBytes: new Uint8Array(bytes) }).reasons, []);

  // Bytes that are not a readable list are a problem of the list, reported rather than read as "nothing is
  // authorized" - the same answer the path form gives.
  assert.match(deriveAdmissibility(skipped, { toleratedSkipsBytes: Buffer.from('{ not json') })
    .reasons.join(' | '), /authorized-skip list[^|]*could not be read/);

  // And a rule loaded from BYTES rather than from a file has no directory to resolve a default list against,
  // so the default is null and a caller that passes nothing is told so rather than reading a path it guessed.
  assert.match(loadToleratedSkips(null).problem ?? '',
    /could not be read[^|]*no default path to resolve one against/);
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
