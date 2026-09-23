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
// own permission list and ships beside it.
//
// A FIELD THE RULE READS THAT IS ABSENT IS A REASON, NEVER A SKIP. An absent field is not a satisfied
// condition: a receipt that does not say whether its suite was green has not said its suite was green.
import fs from 'node:fs';
import path from 'node:path';

// The protected branch, as the emitter names it in the reason it has always written.
export const PROTECTED_REF = 'main';
// Named only in ground (d)'s wording, and only when the receipt itself does not say which workflow it is.
export const WORKFLOW_PATH = '.github/workflows/verifier-receipt.yml';
// The authorized-skip list: an explicit, NAMED allow-list. Permission, not a hint.
export const TOLERATED_SKIPS_PATH = path.join(import.meta.dirname, 'tolerated-skips.json');
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
export const loadToleratedSkips = (file = TOLERATED_SKIPS_PATH) => {
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
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
const suiteIsClean = (receipt, reasons, toleratedSkipsPath) => {
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
  const authorized = loadToleratedSkips(toleratedSkipsPath);
  const skipped = readCount(suite, 'skipped', reasons, 'suite');
  const namedSkips = Array.isArray(suite.skipped_tests)
    ? suite.skipped_tests.map(String)
    : (Array.isArray(receipt?.named_tests)
      ? receipt.named_tests.filter(row => row?.status === 'skip').map(row => String(row?.name)) : []);
  if (skipped !== null && skipped > 0 && authorized.problem) reasons.push(authorized.problem);
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
};

// THE PREDICATE. `reasons` empty is the only admissible state; `admissible` is exactly `reasons.length === 0`.
//
// The grounds are checked in a fixed order - the verdict, the suite, the authority, the event, the branch, the
// origin of the authority files, and whether that authority commit is on main - so that two readers of the same
// receipt produce the same list in the same order and can be compared literally.
export const deriveAdmissibility = (receipt, { toleratedSkipsPath = TOLERATED_SKIPS_PATH } = {}) => {
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
  suiteIsClean(receipt, reasons, toleratedSkipsPath);

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
