// THE ADMISSION PREDICATE. One implementation, in one file, of the question "may a manifest pin this receipt?".
//
// WHY THIS FILE EXISTS. The rule used to be written out by hand in every place that asked it: the emitter
// computed it, the workflow's gate re-derived it, the workflow's guard re-derived it, the attest job re-read it
// and a consumer on another branch read the recorded flag. A review flipped `provenance.admissible_as_pin` to
// true on a receipt whose body still recorded the authority as ABSENT on main, and every one of those readers
// passed it, because each was comparing a computed boolean with itself. Copies also DRIFT: a rule tightened in
// one copy and not in the others is a rule that says two different things about the same receipt. So the rule
// lives here, in the authority directory - a protected path - and each reader either calls this function or
// mechanically verifies that the file it loaded is the one the protected branch holds.
//
// WHAT IT READS. The receipt BODY, and nothing else. No API, no environment, no file of the workflow, no
// import from the emitter. The one thing it reads off disk is `tolerated-skips.json`, which is this rule's
// own permission list and ships beside it - and a caller that has already verified those bytes may hand them
// over DIRECTLY, so that the decision rests on the bytes that were checked rather than on a second read of a
// path. See `loadToleratedSkips` below and THE BYTES THAT DECIDE in fetch-receipt.mjs.
//
// THIS MODULE IS LOADED TWO WAYS, AND BOTH HAVE TO WORK. The emitter imports it as a file beside itself; the
// consumer imports the bytes the protected branch served, from a `data:` URL, with no path anywhere in the
// chain. A `data:` module has no `import.meta.dirname`, so the default permission-list path below is null
// there - which is correct rather than unfortunate: a module loaded from bytes has no directory to resolve a
// sibling against, and the consumer passes the verified bytes in instead.
//
// A FIELD THE RULE READS THAT IS ABSENT IS A REASON, NEVER A SKIP. An absent field is not a satisfied
// condition: a receipt that does not say whether its suite was green has not said its suite was green.
import fs from 'node:fs';
import path from 'node:path';

// The protected branch, as the emitter names it in the reason it has always written.
export const PROTECTED_REF = 'main';
// Named only in ground (d)'s wording, and only when the receipt itself does not say which workflow it is.
export const WORKFLOW_PATH = '.github/workflows/verifier-receipt.yml';
// The authorized-skip list: an explicit, NAMED allow-list. Permission, not a hint. Null when this module was
// loaded from bytes rather than from a file, because then there is no directory to resolve it against.
export const TOLERATED_SKIPS_PATH = import.meta.dirname === undefined
  ? null
  : path.join(import.meta.dirname, 'tolerated-skips.json');
export const TOLERATED_SKIPS_NAME = '.github/verifier-receipt/tolerated-skips.json';

// The emitter's own listing, so a reason this file writes reads like the reasons it replaced.
const listing = (names, limit = 10) => (names.length <= limit
  ? names.join(', ')
  : `${names.slice(0, limit).join(', ')}, and ${names.length - limit} more`);
const quote = value => JSON.stringify(value ?? null);

// THE AUTHORIZED SKIPS, READ FROM THE FILE THAT IS THE PERMISSION. Every entry must NAME a test, say why that
// test is environmental, and say who authorized it; an entry missing any of the three authorizes nothing, and
// a list that cannot be read authorizes nothing either. Both are reported as a defect of the list rather than
// silently treated as "no skips are authorized", because a rule whose permission file has gone missing is a
// rule that is not being applied as written.
//
// THE SOURCE IS EITHER A PATH OR THE BYTES THEMSELVES, and a caller that has already verified bytes hands
// them over rather than a path to them. Reading a path a second time is a time-of-check-to-time-of-use gap
// wherever the first read was the one that was checked; a Buffer has no such gap, because there is nothing
// left to re-read. A string is still a path, so every existing caller keeps its meaning.
export const loadToleratedSkips = (source = TOLERATED_SKIPS_PATH) => {
  let parsed;
  try {
    if (source === null || source === undefined) {
      throw new Error('this rule was given no authorized-skip list and was loaded from bytes, so it has no '
        + 'default path to resolve one against');
    }
    parsed = JSON.parse(ArrayBuffer.isView(source)
      ? Buffer.from(source).toString('utf8')
      : fs.readFileSync(source, 'utf8'));
  } catch (error) {
    return { names: new Set(), entries: [], problem: `the authorized-skip list ${TOLERATED_SKIPS_NAME} could `
      + `not be read (${error.message}), so no skip in this receipt can be judged authorized` };
  }
  const entries = parsed?.authorized;
  if (!Array.isArray(entries)) {
    return { names: new Set(), entries: [], problem: `the authorized-skip list ${TOLERATED_SKIPS_NAME} carries `
      + `no \`authorized\` array (${quote(entries === undefined ? null : typeof entries)}), so nothing in it `
      + 'authorizes a skip' };
  }
  const malformed = entries.filter(entry => !entry || typeof entry.test !== 'string' || entry.test === ''
    || typeof entry.reason !== 'string' || entry.reason === ''
    || typeof entry.authorized_by !== 'string' || entry.authorized_by === '');
  if (malformed.length > 0) {
    return { names: new Set(), entries, problem: `${malformed.length} entr(y/ies) of the authorized-skip list `
      + `${TOLERATED_SKIPS_NAME} do not name a test, a reason and an authorizer, so the list does not say what `
      + 'it permits' };
  }
  return { names: new Set(entries.map(entry => entry.test)), entries, problem: null };
};

// A count the rule reads: a non-negative integer, or an absence that is its own reason.
const readCount = (holder, field, reasons, where) => {
  const value = holder?.[field];
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    reasons.push(`this receipt records no readable ${where}.${field} (${quote(value)}), so nothing in it says `
      + 'whether the measured suite was clean, and an absent field is not a satisfied condition');
    return null;
  }
  return value;
};

// SECTION 2 OF THE DECISION, ENCODED ONCE: the suite state must be GREEN WITH ONLY AUTHORIZED SKIPS. Anything
// else - a failing test, a cancelled test, a `todo`, a skip nobody authorized by name, or any other exclusion
// the receipt records and this rule does not model - makes the receipt inadmissible. A red suite cannot
// establish an admissible pin, however far outside a claim's named set its failures fall.
const suiteIsClean = (receipt, reasons, toleratedSkips) => {
  const suite = receipt?.suite;
  if (!suite || typeof suite !== 'object' || Array.isArray(suite)) {
    reasons.push(`this receipt records no \`suite\` block (${quote(suite === undefined ? null : typeof suite)}), `
      + 'so nothing in it says whether the measured suite was green');
    return;
  }

  // The state the emitter recorded, in both places it records it. Neither is derived from the other here:
  // each is read, and each must say green.
  for (const [where, state] of [['suite.state', suite.state],
    ['conclusion.suite_state', receipt?.conclusion?.suite_state]]) {
    if (state === 'green') continue;
    reasons.push(state === undefined || state === null
      ? `this receipt records no ${where}, so nothing in it says the measured suite was green`
      : `${where} is ${quote(state)}, not "green": a suite that is not green cannot establish an admissible pin, `
        + 'however far outside the claim\'s named set its failures fall');
  }

  // NEXT-2. THE RUNNER'S OWN EXIT CODE, WHICH `suite.state` IS DERIVED FROM AND WHICH NOTHING USED TO READ.
  //
  // The emitter computes the state it records as `const suiteRed = exitCode !== 0 || unfinished > 0`
  // (emit-receipt.mjs), and writes BOTH `suite.exit` and `suite.state` out of that one quantity. So a body
  // carrying `exit: "1"` beside `state: "green"` is not a body any run of the emitter can produce: it is D7's
  // shape exactly, one field over - a derived field flipped while the field it was derived from was left
  // where it was. Reading the source of the derivation costs one comparison and closes it. The emitter always
  // writes this field and refuses a capture whose exit code is not numeric, so requiring it here asks for
  // nothing a real receipt does not already carry, and an absent exit is a reason on the standing rule that an
  // absent field is not a satisfied condition.
  const exit = suite.exit;
  if (exit === undefined || exit === null || exit === '') {
    reasons.push(`this receipt records no suite.exit (${quote(exit === undefined ? null : exit)}), so nothing `
      + 'in it says what the runner that measured it exited, and suite.state is derived from exactly that');
  } else if (String(exit) !== '0') {
    reasons.push(`the runner that measured this suite exited ${quote(String(exit))}, not "0": a run the runner `
      + 'reported as failing cannot establish an admissible pin, whatever suite.state records beside it');
  }

  // NEXT-1. THE COUNTS MUST RECONCILE, AND ALL SIX OF THEM ARE REQUIRED.
  //
  // `suite.tests` is the runner's total and the five category counts partition it, so a body claiming ten
  // tests while accounting for three has not said what happened to the other seven - and every exclusion
  // counter reading zero is precisely how such a body passes every check above.
  //
  // THE ESCAPE THAT USED TO BE LEFT OPEN HERE IS CLOSED. The round that wrote this block checked the identity
  // only when all six numbers were readable, and required just four of them: `not_ok`, `cancelled`, `skipped`
  // and `todo` are each read further down, but `tests` and `ok` were required nowhere, so DELETING EITHER made
  // the identity not run rather than fail - a review demonstrated `[ADMISSIBLE] ok DELETED, tests 3649`. The
  // argument this file already makes for requiring `suite.exit` applies to both of them verbatim: the emitter
  // always writes them (`emit-receipt.mjs` builds this block from `counts.tests` and `counts.ok`), so asking
  // for them refuses nothing a real receipt carries, and an absent field is a reason on the standing rule that
  // an absent field is not a satisfied condition. They are read with `readCount` like the other four, which
  // means the identity below now runs on every body that is not already refused for missing one of its terms.
  //
  // AND A NUMBER RENDERED AS A STRING IS REFUSED BY NAME, WHICH IS A DECISION AND NOT AN ACCIDENT. `readCount`
  // requires a JSON number, so `"tests": "3649"` is refused as unreadable rather than coerced: a body whose
  // own counters are not numbers is not a body any run of the emitter produced, and parsing it leniently would
  // be this file guessing what it meant. `suite.exit` is the deliberate exception beside it and reads as a
  // STRING, because that is what the emitter writes - `const suiteExit = String(meta.suite_exit ?? '')` - so
  // the comparison there is `String(exit) !== '0'`. The two rules differ because the two fields differ, and
  // the suite pins both: a forged body carrying `"exit":"0"` is read on its merits, and one carrying
  // `"tests":"3649"` is refused.
  //
  // MEASURED RATHER THAN ASSUMED, because the arithmetic is the runner's and not this file's. On node
  // v22.22.3, a file with one passing, one failing, one timing-out, one skipped and one `todo` test reports:
  //   # tests 5 / # pass 1 / # fail 1 / # cancelled 1 / # skipped 1 / # todo 1
  // so `cancelled` is a category of its own that sums into `tests` alongside the other four, and it is in the
  // sum below. This repository's real 3649-test receipt satisfies the same identity (3581 + 60 + 0 + 8 + 0),
  // which is why requiring it costs nothing.
  const testsCount = readCount(suite, 'tests', reasons, 'suite');
  const okCount = readCount(suite, 'ok', reasons, 'suite');
  const counts = [testsCount, okCount, ...['not_ok', 'cancelled', 'skipped', 'todo']
    .map(field => (typeof suite[field] === 'number' && Number.isInteger(suite[field]) && suite[field] >= 0
      ? suite[field] : null))];
  if (counts.every(value => value !== null)) {
    const [tests, ok, notOk, cancelledCount, skippedCount, todoCount] = counts;
    const accounted = ok + notOk + cancelledCount + skippedCount + todoCount;
    if (accounted !== tests) {
      reasons.push(`this receipt records ${tests} test(s) in suite.tests and accounts for ${accounted} of them `
        + `(ok ${ok} + not_ok ${notOk} + cancelled ${cancelledCount} + skipped ${skippedCount} + todo `
        + `${todoCount}), so ${Math.abs(tests - accounted)} point(s) are in neither the total nor the `
        + 'categories that partition it: a suite whose own counts do not add up has not said what it measured');
    }
  }

  const failing = readCount(suite, 'not_ok', reasons, 'suite');
  if (failing !== null && failing > 0) {
    const named = Array.isArray(suite.failing_tests) ? suite.failing_tests.map(String) : null;
    const total = typeof suite.tests === 'number' ? `${suite.tests}` : 'an unstated number of';
    reasons.push(`the measured suite reports ${failing} failing test(s) out of ${total}, and a red suite cannot `
      + 'establish an admissible pin: '
      + (named === null
        ? 'this receipt does not name them'
        : named.length === 0 ? 'this receipt names none of them' : listing(named)));
  }

  // D7. EVERY PLACE THE BODY RECORDS A FAILURE IS READ, AND A BODY THAT DISAGREES WITH ITSELF IS REFUSED.
  //
  // The block above counts failures from `suite.not_ok` alone, so a body carrying `not_ok: 0` beside a
  // non-empty `failing_tests` read as CLEAN: a review produced exactly that, changing one integer in a forged
  // body and leaving every name it had failed on in place. A counter and a list that contradict each other are
  // not a pass in either direction, so the list is read too - and so is the claim-scoped list beside it, and
  // the `fail` rows of `named_tests` - and a counter that UNDERSTATES what the same body names is the
  // disagreement it is. Understating is the only direction checked here: a list shorter than the counter is
  // already a refusal through `not_ok > 0`, and requiring exact agreement would refuse a receipt whose emitter
  // truncated a long list, which is a different defect and not this one.
  const failureLists = [
    ['suite.failing_tests', Array.isArray(suite.failing_tests) ? suite.failing_tests.map(String) : null],
    ['suite.failing_tests_named_by_the_claim',
      Array.isArray(suite.failing_tests_named_by_the_claim)
        ? suite.failing_tests_named_by_the_claim.map(String) : null],
    ['named_tests', Array.isArray(receipt?.named_tests)
      ? receipt.named_tests.filter(row => row?.status === 'fail').map(row => String(row?.name)) : null],
  ];
  for (const [where, names] of failureLists) {
    if (names === null || names.length === 0) continue;
    if (failing !== null && failing >= names.length) continue;
    reasons.push(`this receipt records suite.not_ok=${quote(suite.not_ok)} and names ${names.length} failing `
      + `test(s) in ${where}, which is a receipt disagreeing with itself about whether anything failed: `
      + `${listing(names.map(quote))}`);
  }
  const cancelled = readCount(suite, 'cancelled', reasons, 'suite');
  if (cancelled !== null && cancelled > 0) {
    reasons.push(`the measured run did not finish: the runner reported ${cancelled} cancelled point(s), and a `
      + 'cancelled point is a test - or a whole file - that the runner stopped rather than ran');
  }
  const todo = readCount(suite, 'todo', reasons, 'suite');
  if (todo !== null && todo > 0) {
    reasons.push(`the measured suite reports ${todo} test(s) carrying a \`# TODO\` directive, which the runner `
      + 'counts as neither pass nor fail: an unmodelled exclusion is not a green suite');
  }

  // THE SKIPS, BY NAME. A skip is tolerable only when it is written down in the authorized list, so the rule
  // needs the NAMES; a receipt that counts skips without naming them cannot be judged against that list, and
  // an unjudgeable skip is a refusal rather than a pass.
  //
  // D15. BOTH SHAPES THE BODY CAN CARRY A SKIPPED NAME IN ARE MESHED, because reading one OR the other left a
  // gap that cost nothing to walk through. A receipt carries skipped names either as `suite.skipped_tests` or
  // as `named_tests` rows whose status is `skip`; this used to prefer the first whenever it was an ARRAY, so a
  // body with `skipped_tests: []` beside a `skip` row was judged against an empty set - and the row itself is
  // invisible to the every-other-exclusion block below, which exempts `skip` on the understanding that this
  // block handles it. One line exempted the status and another never consulted the rows. So the two sources
  // are UNIONED: a skipped named test is visible to the authorization rule whichever shape carries it.
  //
  // The union is by name, so two records of the same skip count once. That can only LOWER the number of skips
  // this rule can name against `suite.skipped`, which is the closed direction: an unnameable skip is a reason.
  const authorized = loadToleratedSkips(toleratedSkips);
  const skipped = readCount(suite, 'skipped', reasons, 'suite');
  const namedSkips = [...new Set([
    ...(Array.isArray(suite.skipped_tests) ? suite.skipped_tests.map(String) : []),
    ...(Array.isArray(receipt?.named_tests)
      ? receipt.named_tests.filter(row => row?.status === 'skip').map(row => String(row?.name)) : []),
  ])];
  // A list that cannot be read matters as soon as there is anything to judge against it, which is a counted
  // skip OR a named one - the count alone used to gate this, and D15's whole point is that the count and the
  // names need not both be there.
  if (authorized.problem && ((skipped !== null && skipped > 0) || namedSkips.length > 0)) {
    reasons.push(authorized.problem);
  }
  const unauthorized = namedSkips.filter(name => !authorized.names.has(name));
  if (unauthorized.length > 0) {
    reasons.push(`${unauthorized.length} skipped test(s) are not in the authorized list `
      + `${TOLERATED_SKIPS_NAME}, which is permission rather than a hint: ${listing(unauthorized.map(quote))}`);
  }
  if (skipped !== null && skipped > namedSkips.length) {
    reasons.push(`this receipt records ${skipped} skipped test(s) and names ${namedSkips.length} of them, so `
      + `${skipped - namedSkips.length} cannot be checked against ${TOLERATED_SKIPS_NAME}: a skip this rule `
      + 'cannot name is not an authorized skip');
  }

  // EVERY OTHER EXCLUSION THE RECEIPT RECORDS. A named test the receipt reports as anything but a pass is a
  // name this run did not measure green: `misplaced` (reported in a file other than the one its claim names),
  // `unbound` (reported with no location at all, so nothing ties the point to the test its claim describes),
  // `unclaimed`, `absent`, `suite`, and the `fail`/`skip`/`todo` rows the blocks above also count. Each is
  // listed here under its own status, so the refusal says which exclusion it is.
  //
  // `skip` is exempted HERE because the skip block above judges it against the authorized list - and after
  // D15 that is true of a `skip` row whatever shape the body carries its names in, which is what makes the
  // exemption safe. `fail` is not exempted: it is a reason here and a disagreement above when the counter
  // denies it.
  const rows = receipt?.named_tests;
  if (!Array.isArray(rows)) {
    reasons.push(`this receipt carries no \`named_tests\` list (${quote(rows === undefined ? null : typeof rows)}), `
      + 'so nothing in it says what the runner reported for the names the claim rests on');
    return;
  }
  const excluded = rows.filter(row => row?.status !== 'pass' && row?.status !== 'skip');
  for (const status of [...new Set(excluded.map(row => String(row?.status)))].sort()) {
    const named = excluded.filter(row => String(row?.status) === status).map(row => String(row?.name));
    reasons.push(`${named.length} named test(s) are recorded \`${status}\` rather than passing, which is an `
      + `exclusion this rule does not tolerate: ${listing(named.map(quote))}`);
  }

  // NEXT-3. THE SUMMARY AND THE ROWS IT SUMMARISES, WHICH COULD SAY DIFFERENT THINGS AND WERE NEVER COMPARED.
  //
  // The emitter builds `named_tests_summary` by counting `named_tests` - one array, counted once - so the two
  // can only disagree in a body somebody wrote. The blocks above read the ROWS, so a summary claiming
  // failures the rows do not carry slipped past everything: a body saying `fail: 4` over a single passing row
  // was admissible.
  //
  // THE DISAGREEMENT IS REFUSED BY NAME, AND NO SIDE IS CHOSEN. This rule does not decide that the rows are
  // right and the summary is forged, or the reverse; it refuses a receipt that says two things about the same
  // measurement, which is the only honest answer when nothing in the body settles which is which.
  //
  // ONLY WHAT THE SUMMARY ACTUALLY STATES IS COMPARED. A summary that omits a key has not made a claim about
  // it, and inventing a claim of zero on its behalf would be reading absence as a statement - the thing this
  // file refuses to do everywhere else. Omitting a key hides nothing: the rows themselves are read directly by
  // every block above, so a summary cannot conceal a bad row by staying silent about it.
  const summary = receipt?.named_tests_summary;
  if (summary && typeof summary === 'object' && !Array.isArray(summary)) {
    const count = status => rows.filter(row => String(row?.status) === status).length;
    const observed = [
      ['named', rows.length, 'row(s) in named_tests'],
      ['distinct_names', new Set(rows.map(row => String(row?.name))).size, 'distinct name(s) among those rows'],
      ['pass', count('pass'), '`pass` row(s)'],
      ['fail', count('fail'), '`fail` row(s)'],
      ['absent', count('absent'), '`absent` row(s)'],
      ['skipped', count('skip'), '`skip` row(s)'],
      ['todo', count('todo'), '`todo` row(s)'],
      ['suite_points', count('suite'), '`suite` row(s)'],
      ['misplaced', count('misplaced'), '`misplaced` row(s)'],
      ['unbound', count('unbound'), '`unbound` row(s)'],
      ['unclaimed', count('unclaimed'), '`unclaimed` row(s)'],
    ];
    for (const [field, actual, what] of observed) {
      const stated = summary[field];
      if (stated === undefined || stated === null) continue;
      if (typeof stated === 'number' && Number.isInteger(stated) && stated === actual) continue;
      reasons.push(`named_tests_summary.${field} is ${quote(stated)} and named_tests carries ${actual} `
        + `${what}: a receipt whose summary and whose rows describe different measurements is refused on the `
        + 'disagreement, because nothing in it says which of the two is the forgery');
    }
  }
};

// THE PREDICATE. `reasons` empty is the only admissible state; `admissible` is exactly `reasons.length === 0`.
//
// The grounds are checked in a fixed order - the verdict, the suite, the authority, the event, the branch, the
// origin of the authority files, and whether that authority commit is on main - so that two readers of the same
// receipt produce the same list in the same order and can be compared literally.
//
// `toleratedSkipsBytes` wins over `toleratedSkipsPath` when both are given, and a caller that has verified
// bytes passes those: see THE BYTES THAT DECIDE in fetch-receipt.mjs for why a second read of a path is not
// the same thing as the bytes that were checked.
export const deriveAdmissibility = (receipt,
  { toleratedSkipsPath = TOLERATED_SKIPS_PATH, toleratedSkipsBytes = null } = {}) => {
  const reasons = [];
  if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt)) {
    return { admissible: false, reasons: ['this is not a receipt object, so nothing in it permits a pin'] };
  }

  // (a) THE VERDICT. A receipt that does not record a successful measurement has nothing in it to pin, so it
  // is not merely unattested for want of a dispatch - it is inadmissible on its own contents.
  const verdict = receipt.conclusion?.verdict;
  if (verdict === undefined || verdict === null) {
    reasons.push('this receipt records no conclusion.verdict, so nothing in it says a measurement succeeded, '
      + 'and an absent field is not a satisfied condition');
  } else if (verdict !== 'success') {
    // The emitter's own words, kept verbatim for the 'failure' case so that today's receipts and today's
    // tests keep their meaning; any other verdict is named rather than called failure.
    reasons.push(verdict === 'failure'
      ? 'this receipt\'s verdict is failure, so there is nothing in it for a manifest to pin'
      : `this receipt's verdict is ${quote(verdict)}, so there is nothing in it for a manifest to pin`);
  }

  // (b) THE SUITE STATE, by the rule in section 2 above.
  suiteIsClean(receipt, reasons, toleratedSkipsBytes ?? toleratedSkipsPath);

  // (c) THE AUTHORITY THE CANDIDATE WAS COMPARED AGAINST. A listing cannot distinguish "the authority is
  // intact" from "the authority is nowhere": it answers null on the protected branch, answers null at a
  // candidate that does not carry it either, and a comparison of two nulls is `change: 'none'`. A review
  // found this repository in exactly that second state - `.github/verifier-receipt` did not exist on main -
  // which is the state the FIRST receipts are produced in, so it is named here rather than passing quietly.
  // The merge-base baseline the emitter measures against does not answer it: the candidate really does leave
  // the authority alone in that state, and the reason such a receipt cannot be pinned is that there was no
  // authority on the protected branch for it to be judged against.
  const authority = receipt.candidate?.authority_identity;
  if (!Array.isArray(authority) || authority.length === 0) {
    reasons.push('this receipt carries no candidate.authority_identity, so nothing in it says whether this run '
      + 'compared the candidate against an authority at all');
  } else {
    const absent = authority.filter(entry => entry?.protected_sha === null || entry?.protected_sha === undefined)
      .map(entry => String(entry?.path));
    if (absent.length > 0) {
      reasons.push(`the receipt authority is absent on ${PROTECTED_REF} (${listing(absent)}), so this run `
        + 'compared the candidate against nothing and cannot establish that it leaves the authority alone');
    }
  }

  const workflow = receipt.workflow ?? {};
  // (d) THE EVENT. Only a dispatch of this authority's own workflow may be pinned.
  if (workflow.event === undefined || workflow.event === null) {
    reasons.push('this receipt records no workflow.event, so nothing in it says which event ran the authority');
  } else if (workflow.event !== 'workflow_dispatch') {
    reasons.push(`this run's event is ${workflow.event}; only a workflow_dispatch of `
      + `${workflow.path ?? WORKFLOW_PATH} may be pinned`);
  }

  // (e) THE BRANCH the run was made on.
  if (workflow.head_branch === undefined || workflow.head_branch === null) {
    reasons.push('this receipt records no workflow.head_branch, so nothing in it says which branch this run '
      + 'was made on');
  } else if (workflow.head_branch !== 'main') {
    reasons.push(`this run was made on ${workflow.head_branch}, not the protected default branch`);
  }

  // (f) WHERE THE AUTHORITY FILES CAME FROM.
  if (workflow.trusted_source_origin === undefined || workflow.trusted_source_origin === null) {
    reasons.push('this receipt records no workflow.trusted_source_origin, so nothing in it says where the '
      + 'authority files this run executed came from');
  } else if (workflow.trusted_source_origin !== 'protected-main') {
    reasons.push(`the authority files came from ${workflow.trusted_source_origin}, not from protected main`);
  }

  // (g) AND WHETHER THAT AUTHORITY COMMIT IS CONTAINED IN MAIN. The emitter settles this against the API and
  // records the answer; this rule reads the answer it recorded, and `true` is the only value that satisfies it.
  if (workflow.trusted_source_on_main !== true) {
    const sha = typeof workflow.trusted_source_sha === 'string' && workflow.trusted_source_sha.length >= 12
      ? workflow.trusted_source_sha.slice(0, 12)
      : quote(workflow.trusted_source_sha ?? null);
    reasons.push(workflow.trusted_source_on_main === undefined || workflow.trusted_source_on_main === null
      ? 'this receipt records no workflow.trusted_source_on_main, so nothing in it says the authority commit '
        + 'this run executed is contained in main'
      : `the authority commit ${sha} is not contained in main`);
  }

  return { admissible: reasons.length === 0, reasons };
};

export default deriveAdmissibility;
