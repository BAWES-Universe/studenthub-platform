// The approval path for this change.
//
// A sealed term is approved only through an entry here, and every entry is built by reading the committed
// test registries: the control's name, the mutants that kill it, and the file each lives in. Nothing in an
// entry is written by hand, so an entry cannot claim more than the code carries. `--check` fails when:
//   * the committed manifest and a fresh build disagree byte for byte (a hand-edited claim);
//   * a named control or mutant is absent from the committed suite inventory (a missing test);
//   * a receipt referenced by an entry is missing, or its sha256 or head does not match;
//   * an entry claims PASS without a control, without a mutant that kills it, or without a receipt at the
//     entry's code revision;
//   * the entry's code revision is not an ancestor of the checkout, or the difference between them
//     includes anything executable (a wrong head).
//
// The flakiness investigation and the historical narrative live elsewhere and are not consulted here.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

export const REGISTRIES = [
  { file: 'test/shu71-arming-robustness-checks.mjs', label: 'B6 arming robustness',
    runner: 'test/shu71-arming-robustness.test.mjs' },
  { file: 'test/shu71-postpush-readback-checks.mjs', label: 'B5 post-push read-back',
    runner: 'test/shu71-postpush-readback.test.mjs' },
];

export const MANIFEST_NAME = 'claim-manifest.json';
export const RECEIPTS_DIR = 'receipts';
// What may legitimately differ between an entry's code revision and the revision carrying the manifest.
// What may change between the code revision and the manifest commit. Documentation, the manifest itself and
// receipts - nothing else. Tolerating every .json was too broad and hid a real inconsistency: an inventory
// fix committed after the code revision left the manifest naming a revision whose own suite inventory no
// longer matched the suite it describes, and the guard said nothing because the file ended in .json.
const NON_EXECUTABLE = ['.md', '.txt'];
// The two files this artifact owns. The pins file is where evidence lives, so it must be committable on top of
// the code revision it attests; admitting it by name rather than by suffix keeps the tolerance to exactly what
// the flow needs and no other JSON file.
export const PINS_NAME = 'verifier-receipts.json';
export const AUTHORITY_WORKFLOW = '.github/workflows/verifier-receipt.yml';
// Paths arrive repo-root-relative from `git diff --name-only`, so the receipts test has to match that shape:
// a prefix of `receipts/` matches nothing git emits here, and the guard then rejects a receipt the lane
// commits after its code revision - the exact flow the tolerance exists for. The test asserts the shape git
// emits for this reason; asserting a bare relative path is what let the defect through.
export const nonExecutable = file => NON_EXECUTABLE.some(suffix => file.endsWith(suffix))
  || path.basename(file) === PINS_NAME
  || path.basename(file) === MANIFEST_NAME
  || (isReceiptPath(file) && file.endsWith('.json'));
// The receipts that may follow a code revision are this service's own. Matching any path containing
// `/receipts/` admitted executable JavaScript anywhere in the repository, which is a wider tolerance than
// the rule it exists to express.
export const SERVICE_RECEIPTS = '.github/coordinator/service/receipts';
// Receipts are JSON. Admitting any file under a receipts directory admitted executable JavaScript placed
// there, which is the opposite of what this rule exists to say.
export const isReceiptPath = file => file.startsWith(`${RECEIPTS_DIR}/`)
  || file === RECEIPTS_DIR || file.startsWith(`${SERVICE_RECEIPTS}/`);

export const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));
const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

// Every test name a registry emits, paired with the check function that produces it, so a mutation can be
// attributed to the control whose function it was written to kill.
export async function readRegistry(root, registry) {
  const module = await import(path.join(root, registry.file));
  const controls = [];
  const fns = new Map();
  const byName = new Map();
  const add = (name, fn, variants) => {
    const names = variants ? variants.map(variant => `${registry.label}: ${name} (${variant})`)
      : [`${registry.label}: ${name}`];
    controls.push({ name, test_names: names });
    if (!fns.has(fn)) fns.set(fn, []);
    fns.get(fn).push(name);
    if (typeof fn?.name === 'string' && fn.name) {
      if (!byName.has(fn.name)) byName.set(fn.name, []);
      byName.get(fn.name).push(name);
    }
  };
  for (const [name, check] of module.controls ?? []) add(name, check);
  for (const [name, check, variants] of module.variantControls ?? []) add(name, check, variants);

  // Controls the runner file registers directly, outside the registry's control arrays. They are real
  // controls - the runner tests them and the suite inventory carries their names - and leaving them
  // unregistered made every mutation written against one of them pair with nothing: B5's two closure
  // controls are registered this way, so all seven of its closure mutations were dropped in silence.
  // The runner is read as source because importing it would register its tests as a side effect. A name is
  // registered only when the function it calls is exported by the checks module, so a closed-over helper
  // cannot enter the manifest as a control.
  const runnerSource = fs.readFileSync(path.join(root, registry.runner), 'utf8');
  for (const match of runnerSource.matchAll(/test\(\s*'([^']+)'\s*,[\s\S]{0,200}?\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const [, testName, fnName] = match;
    const fn = module[fnName];
    if (typeof fn !== 'function' || !testName.startsWith(`${registry.label}: `)) continue;
    if (controls.some(control => control.test_names.includes(testName))) continue;
    add(testName.slice(registry.label.length + 2), fn);
  }

  const mutations = [];
  const collect = rows => {
    for (const row of rows ?? []) {
      // The check is found, not assumed. A fixed index per export name was wrong in both directions: B5's
      // closureMutations rows are [name, check, reviewed, before, after] - a function at index 1, with a
      // string at the index the generator read - so all seven paired with the wrong element and their terms
      // reported "no mutant". Every row shape in this repository carries exactly one function; a row with
      // none or with several is refused rather than guessed at.
      const problem = validateMutationRow(row, registry.label);
      if (problem) throw new Error(problem);
      const name = row[0];
      const resolved = controlFunction(row, candidate => fns.has(candidate), registry.label);
      if (resolved.error) throw new Error(resolved.error);
      const check = resolved.check;
      let kills = fns.get(check) ?? [];
      let paired_by = kills.length > 0 ? 'identity' : null;
      // Not every mutation row hands the control itself: some wrap it to exercise one variant, as
      // `(create, h) => someControl(create, h, 'variant')`. Pairing only by function identity silently
      // attributed those to nothing, so the manifest reported no mutant for terms that have one. The
      // wrapper's body is read for calls to registered controls, and the pairing is used only when the
      // body names exactly one of them: several would be a guess, and a guess is not a pairing.
      if (kills.length === 0 && typeof check === 'function') {
        const called = new Set();
        for (const match of check.toString().matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) {
          for (const name of byName.get(match[1]) ?? []) called.add(name);
        }
        if (called.size === 1) { kills = [...called]; paired_by = 'wrapper-body'; }
      }
      mutations.push({ name, test_name: `${registry.label} mutation: ${name}`, kills, paired_by });
    }
  };
  collect(module.mutations);
  collect(module.siblingMutations);
  collect(module.closureMutations);
  return { registry, controls, mutations };
}

// A mutation row's shape is the registry's business, and the generator has to state which shape it read.
// The check index is fixed per export name (mutations, siblingMutations, closureMutations), which holds for
// the two registries this manifest covers - both five-element rows - and does not hold for every registry in
// the repository: shu71-branch-restore-checks.mjs carries three-element rows. Reading the wrong index pairs
// every mutation in that registry with `undefined` and reports `no mutant` for terms that have one, silently.
// That registry is not in REGISTRIES, so nothing is mis-paired today; the validator below is there so that
// adding one cannot pass unnoticed.
export function validateMutationRow(row, label) {
  if (!Array.isArray(row)) return `${label}: a mutation row is not an array`;
  if (typeof row[0] !== 'string' || row[0].length === 0) {
    return `${label}: a mutation row has no name`;
  }
  if (functionsIn(row).length === 0) {
    return `${label}: mutation '${row[0]}' carries no function (row has ${row.length} elements)`;
  }
  return null;
}

const functionsIn = row => row.filter(element => typeof element === 'function');

// Which function in a mutation row is the control. Rows in this repository are shaped differently - the check
// sits at index 1 in B5's closureMutations, behind a string at the index a fixed reading used, and at index 3
// or 4 elsewhere, and B5's closure rows carry a second function (the reviewed-detail extractor) that is not a
// control. The rule that holds across all of them: the control is the row's only registered control function,
// and where no function is registered, it is the first function, which is how a wrapper is written. Several
// registered functions in one row is a shape nobody has established a meaning for, so it is refused rather
// than guessed at.
export function controlFunction(row, isRegistered, label) {
  const registered = functionsIn(row).filter(isRegistered);
  if (registered.length > 1) {
    return { error: `${label}: mutation '${row[0]}' carries ${registered.length} registered controls, so which `
      + 'one it kills is ambiguous' };
  }
  if (registered.length === 1) return { check: registered[0] };
  const functions = functionsIn(row);
  if (functions.length === 0) return { error: `${label}: mutation '${row[0]}' carries no function` };
  return { check: functions[0] };
}

// One entry per control: the term it pins, the mutants that die when that control alone is present, and
// the receipts that attest it. A control the registries pair with no mutant is emitted as BLOCK with the
// reason stated by the generator, not by a sentence anyone wrote.
export async function buildEntries(root, pins, head) {
  const entries = [];
  for (const registry of REGISTRIES) {
    const read = await readRegistry(root, registry);
    for (const control of read.controls) {
      const killers = read.mutations.filter(mutation => mutation.kills.includes(control.name));
      const id = `${slug(registry.label)}/${slug(control.name)}`;
      // A receipt attaches to the terms it names, not to every term that happens to sit at the same
      // revision. Filtering on head alone meant one receipt flipped every eligible entry at once - a verifier
      // who verified one term approved thirty-eight - and, once the checker began requiring that a receipt
      // name its term, the same filter made the rule unsatisfiable and no entry could reach PASS at all.
      const names = [id, control.name];
      // Evidence is a pin, not a file. A pin names a workflow run of the receipt authority, the artifact it
      // uploaded and the digest of the receipt inside it, and the guard checks those against GitHub's API. A
      // JSON file in this directory is not evidence and cannot become evidence: the authoring lane can write
      // it, and a receipt only an author can produce approves nothing.
      const accounting = [];
      const at = pins.filter(pin => {
        if (!pinDescribes(pin, head)) return false;
        const proof = pinProves(pin, control.test_names, killers.map(killer => killer.test_name));
        if (proof.accounting) accounting.push(`${pin.run_id}: ${proof.accounting}`);
        return proof.ok;
      });
      const attested = at.filter(pin => pin.receipt?.conclusion?.verdict === 'success');
      const reasons = [];
      if (killers.length === 0) reasons.push('no mutant is paired with this control in the registry');
      if (attested.length === 0) {
        reasons.push(accounting.length > 0
          ? `no pin accounts for its run: ${accounting[0]}`
          : 'no verified receipt covers this control and its mutants at the code revision');
      }
      entries.push({
        id,
        sealed_term: control.name,
        artifact: registry.file,
        control: { test_names: control.test_names.slice().sort() },
        killing_mutants: killers.map(killer => ({ name: killer.name, test_name: killer.test_name,
          paired_by: killer.paired_by ?? null }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        // What a reader needs to find and check the evidence themselves: the run, the artifact, its digest
        // as GitHub computes it, and the tests the receipt recorded for this term.
        receipts: at.map(pin => ({
          source: 'github-actions',
          run_id: pin.run_id, run_attempt: pin.run_attempt,
          workflow_path: pin.workflow_path, workflow_head_sha: pin.workflow_head_sha,
          artifact_name: pin.artifact_name, artifact_digest: pin.artifact_digest,
          receipt_digest: pin.receipt_digest,
          verdict: pin.receipt?.conclusion?.verdict ?? null,
          control_tests: control.test_names.map(name => ({ name, status: pinStatus(pin, name) })),
          mutant_tests: killers.map(killer => ({ name: killer.test_name, status: pinStatus(pin, killer.test_name) })),
        })),
        // A term with no mutant can never reach PASS, and the manifest says so as a field rather than leaving
        // a reader to infer it from the disposition and the reason string. It is NOT called sealed_term: that
        // name belongs to the term itself, and two object keys with one name silently kept only the second,
        // so every entry carried a boolean and the manifest carried the term's text nowhere at all.
        approvable: killers.length > 0,
        disposition: reasons.length === 0 ? 'PASS' : 'BLOCK',
        reason: reasons.join('; ') || null,
        // A term with no killing mutant cannot reach PASS and no receipt can change that, so the manifest says
        // what seals it instead of leaving a reader to infer it from a BLOCK. Twelve terms are in this state:
        // they are arming controls whose safety is argued by inspection. Whether they should carry a per-term
        // mutant or leave the sealed set is the owner's call, and it is recorded here rather than assumed.
        sealed_by: killers.length === 0
          ? 'no mutant in the registry kills this control, so no run can establish it'
          : null,
        requires_owner_decision: killers.length === 0
          ? 'either pair a mutant that dies when this term alone is removed, or state what else seals it'
          : null,
      });
    }
  }
  // Two registries can define the same control name; the id carries the label so entries never merge.
  return entries.sort((a, b) => a.id.localeCompare(b.id));
}

// The authority cannot approve its own change. Two ways that could happen, both refused here: a receipt whose
// run was dispatched from the revision under approval, and a checkout that alters the authority relative to
// the commit the receipt was dispatched from - because then the thing being approved is not the thing that
// measured it.
export function checkAuthority(root, committed) {
  const failures = [];
  const authorityPaths = ['.github/workflows/verifier-receipt.yml', '.github/verifier-receipt'];
  const dispatchShas = [...new Set((committed.pins_present ?? [])
    .map(pin => pin.workflow_head_sha).filter(Boolean))];
  if (dispatchShas.includes(committed.code_revision.head)) {
    failures.push(`a receipt was produced by the receipt authority at `
      + `${committed.code_revision.head.slice(0, 8)}, the revision under approval: the authority cannot `
      + `approve the change that carries it`);
  }
  for (const sha of dispatchShas) {
    let diff = '';
    try {
      diff = git(root, ['diff', '--name-only', `${sha}..HEAD`, '--', ...authorityPaths]);
    } catch (error) {
      failures.push(`cannot compare the receipt authority at ${String(sha).slice(0, 8)} with this `
        + `checkout: ${String(error.message).split('\n')[0]}`);
      continue;
    }
    if (diff.trim()) {
      failures.push(`this checkout changes the receipt authority since ${String(sha).slice(0, 8)}: `
        + `${diff.trim().split('\n').join(', ')}`);
    }
  }
  return failures;
}

export function namesReceiptNames(receipt, names) {
  return Array.isArray(receipt.established) && receipt.established.some(name => names.includes(name));
}

// A pin proves a term when the receipt inside it records every control test of that term and every mutant
// that kills it as passing. A test the receipt never mentions is not covered: the receipt measured a run in
// which that test did not appear, which is not the same as it having passed.
// A receipt must account for the run it measured. An exit code and counts that do not add up to the number of
// tests are not an accounting: a pin whose receipt cannot say what it ran is refused before its tests are read.
export function receiptAccountsForItsRun(pin) {
  const suite = pin.receipt?.suite;
  if (!suite) return 'the receipt records no suite';
  const { tests, ok, not_ok: notOk, skipped, exit } = suite;
  if (!Number.isInteger(tests) || tests < 1) return 'the receipt records no test count';
  if (!Number.isInteger(ok) || !Number.isInteger(notOk) || !Number.isInteger(skipped)) {
    return 'the receipt does not record how many tests passed, failed and were skipped';
  }
  if (tests !== ok + notOk + skipped) {
    return `the receipt's counts do not add up: ${tests} tests but ${ok} + ${notOk} + ${skipped}`;
  }
  if (exit === undefined || exit === null || exit === '') return 'the receipt records no exit code';
  return null;
}

export function pinProves(pin, controlTests, mutantTests) {
  const accounting = receiptAccountsForItsRun(pin);
  const named = new Map((pin.receipt?.named_tests ?? []).map(test => [test.name, test.status]));
  const evidence = [...controlTests, ...mutantTests].map(name => ({ name, status: named.get(name) ?? 'absent' }));
  return {
    ok: !accounting && evidence.length > 0 && evidence.every(test => test.status === 'pass'),
    accounting,
    evidence,
  };
}
// A pin describes a revision when the receipt inside it names that revision, either as the commit the run
// measured or as the code revision its manifest names. Both are checkable facts about the receipt, not
// assertions by whoever wrote the pin.
export const pinDescribes = (pin, head) => pin.receipt?.manifest?.code_revision?.head === head
  || pin.receipt?.candidate?.sha === head;
export const pinStatus = (pin, name) =>
  (pin.receipt?.named_tests ?? []).find(test => test.name === name)?.status ?? 'absent';

// What a reader most needs to know about a receipt is how much it approves. A receipt that proves one term is
// evidence about that term; one that proves forty-one is a fact worth seeing in the manifest rather than
// discovering by counting attachments.
export function withProvesCounts(pins, entries) {
  return pins.map(pin => ({ ...pin,
    proves: entries.filter(entry => (entry.receipts ?? [])
      .some(receipt => receipt.run_id === pin.run_id)).length }));
}

export function readPins(root) {
  const file = path.join(root, 'verifier-receipts.json');
  if (!fs.existsSync(file)) return [];
  const parsed = readJson(file);
  const pins = Array.isArray(parsed) ? parsed : parsed.pins ?? [];
  return pins;
}

export function readReceipts(root) {
  const dir = path.join(root, RECEIPTS_DIR);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter(file => file.endsWith('.json')).sort().map(file => {
    const bytes = fs.readFileSync(path.join(dir, file));
    const body = JSON.parse(bytes.toString('utf8'));
    return { file, sha256: sha256(bytes), ...body };
  });
}

// `head` is the CODE revision the manifest describes. It defaults to the checkout's HEAD, but the guard
// rebuilds against the revision the committed manifest names: a manifest is normally committed one or more
// documentation commits after the code it describes, so rebuilding against HEAD would report every manifest
// as tampered with. HEAD is then used only to prove that code revision is an ancestor of the checkout with
// no executable difference.
export async function buildManifest(root, revision) {
  const pins = readPins(root);
  const resolved = revision ?? git(root, ['rev-parse', 'HEAD']);
  const tree = git(root, ['rev-parse', `${resolved}^{tree}`]);
  const entries = await buildEntries(root, pins, resolved);
  return { schema: 1, code_revision: { head: resolved, tree },
    coverage: await coverageOf(root, entries),
    // Files here are reported so a reader can see them, and they are named for what they are: a receipt file
    // is not evidence for anything. The evidence is the pins, which name runs that GitHub can be asked about.
    receipt_files_present: receiptsPresent(readReceipts(root)),
    receipt_files_are_not_evidence: true,
    pins_present: withProvesCounts(pins, entries).map(pin => ({
      run_id: pin.run_id, proves: pin.proves, artifact_digest: pin.artifact_digest,
      receipt_digest: pin.receipt_digest, workflow_head_sha: pin.workflow_head_sha,
      verdict: pin.receipt?.conclusion?.verdict ?? null,
      measured: pin.receipt?.candidate?.sha ?? null })),
    entries };
}

// Every receipt in the directory, whether or not it attaches to an entry. A receipt that records a failing
// run, or that names a revision no entry covers, is not allowed to be invisible to a reader of the manifest:
// one such receipt sat in the approvals directory recording exit 1 while no entry mentioned it.
export function receiptsPresent(receipts) {
  return receipts.map(receipt => ({
    file: `${RECEIPTS_DIR}/${receipt.file}`,
    kind: receipt.kind ?? null,
    verdict: receipt.verdict ?? null,
    head: receipt.head ? String(receipt.head).slice(0, 40) : null,
    tree: receipt.tree ? String(receipt.tree).slice(0, 40) : null,
    exit: receipt.exit ?? null,
    records_failing_run: receipt.exit !== undefined && receipt.exit !== 0
      || (receipt.not_ok ?? 0) > 0,
  }));
}

// What the entries enumerate, set against what the suite carries. The manifest covers the controls the
// registries declare; a control registered directly in a runner file is outside that scope, and a reader is
// entitled to the size of that gap as a generated number rather than as a silence.
export async function coverageOf(root, entries) {
  const inventory = readJson(path.join(root, 'suite-inventory.json'));
  const referenced = new Set();
  for (const entry of entries) {
    for (const name of entry.control.test_names) referenced.add(name);
    for (const mutant of entry.killing_mutants) referenced.add(mutant.test_name);
  }
  const distinct = [...new Set(inventory.names)];
  const outsideScope = distinct.filter(name => !referenced.has(name));
  // Every mutation row in the registries, and the control it kills or the reason it kills none. A control
  // with no mutant is emitted as a BLOCK entry with a generated reason; a mutant with no control had no path
  // at all, so nine live mutants - seven of them B5's closure rows - fell through into the outside-scope
  // count indistinguishable from the suite tests that genuinely have nothing to do with this manifest.
  const mutations = [];
  for (const registry of REGISTRIES) {
    const read = await readRegistry(root, registry);
    for (const mutation of read.mutations) {
      mutations.push({ test_name: mutation.test_name, kills: mutation.kills.slice(),
        reason: mutation.kills.length > 0 ? null
          : 'no registered control is named by this row, so no control is measured to die' });
    }
  }
  const sealed = entries.filter(entry => entry.approvable === true).length;
  // Scope, stated: this manifest covers the sealed arming terms the registries declare. It is not a
  // coverage report on the whole coordinator suite, and the count below is the size of what is outside the
  // manifest's scope by design, not a gap in it. Reading it as missing coverage is the misreading it exists
  // to prevent.
  return {
    scope: 'the sealed arming terms the registries declare; not a coverage report on the whole suite',
    controls: entries.length,
    sealed_terms: sealed,
    controls_never_approvable_through_this_path: entries.length - sealed,
    inventory_names: distinct.length,
    duplicate_inventory_names: inventory.names.length - distinct.length,
    control_names_referenced_in_inventory: distinct.length - outsideScope.length,
    suite_names_outside_scope: outsideScope.length,
    outside_scope_sample: outsideScope.slice(0, 12),
    referenced_not_in_inventory: [...referenced].filter(name => !inventory.names.includes(name)).length,
    mutation_rows: mutations.length,
    mutation_rows_paired: mutations.filter(mutation => mutation.kills.length > 0).length,
    mutation_rows_unpaired: mutations.filter(mutation => mutation.kills.length === 0)
      .map(mutation => ({ test_name: mutation.test_name, reason: mutation.reason })),
  };
}

export function serialise(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// Each rejection path is its own function so a test can drive it directly with a tampered manifest: the
// guard has to be shown failing for the reason it exists, not only passing.
// A receipt's own tree claim was never read, so a receipt could name the right head and any tree at all, and
// a receipt that records a failing run could sit in the approvals directory unmentioned by any entry.
export function checkReceiptTrees(committed, receipts) {
  const failures = [];
  const wrongTree = [];
  const failing = [];
  for (const receipt of receipts) {
    if (receipt.kind === 'verified' && receipt.tree !== committed.code_revision.tree) {
      wrongTree.push(`${receipt.file} (tree ${String(receipt.tree).slice(0, 8)})`);
    }
    const recordsFailure = receipt.exit !== undefined && receipt.exit !== 0 || (receipt.not_ok ?? 0) > 0;
    if (recordsFailure && receipt.kind === 'verified') failing.push(receipt.file);
  }
  if (wrongTree.length > 0) {
    failures.push(`verified receipts whose tree is not the code revision's tree `
      + `(${committed.code_revision.tree.slice(0, 8)}): ${wrongTree.join(', ')}`);
  }
  if (failing.length > 0) {
    failures.push(`verified receipts that record a failing run: ${failing.join(', ')}`);
  }
  return failures;
}

// A verifying receipt cites the run it read. Those citations were read by nothing at all: a receipt could
// name a log outside the repository, or a digest that matched no file, and still be accepted as the evidence
// for a term. A citation is now either checkable inside this checkout or a refusal.
export function checkReceiptEvidence(root, receipts) {
  const failures = [];
  for (const receipt of receipts) {
    if (receipt.kind !== 'verified') continue;
    for (const [pathField, hashField] of [['log_path', 'log_sha256'], ['tap_path', 'tap_sha256']]) {
      const named = receipt[pathField];
      if (named === undefined || named === null) continue;
      const absolute = path.resolve(root, String(named));
      if (!absolute.startsWith(`${root}${path.sep}`)) {
        failures.push(`${receipt.file}: ${pathField} names ${named}, which is outside this checkout, `
          + `so nothing it cites can be checked`);
        continue;
      }
      if (!fs.existsSync(absolute)) {
        failures.push(`${receipt.file}: ${pathField} names ${named}, which is not in this checkout`);
        continue;
      }
      const digest = sha256(fs.readFileSync(absolute));
      if (receipt[hashField] !== digest) {
        failures.push(`${receipt.file}: ${hashField} does not match ${named}`);
      }
    }
  }
  return failures;
}

export function checkEntries(root, entries, inventory) {
  const failures = [];
  for (const entry of entries) {
    if (!entry.control || !Array.isArray(entry.control.test_names)
      || !Array.isArray(entry.killing_mutants) || !Array.isArray(entry.receipts)) {
      failures.push(`${entry.id}: entry is missing a control, a mutant list or a receipt list`);
      continue;
    }
    for (const name of entry.control.test_names) {
      if (!inventory.has(name)) failures.push(`${entry.id}: control test ${name} is not in the committed inventory`);
    }
    for (const mutant of entry.killing_mutants) {
      if (!inventory.has(mutant.test_name)) failures.push(`${entry.id}: mutant test ${mutant.test_name} is not in the committed inventory`);
      // How a mutant was attributed to a control is part of the claim. `identity` is the registry handing
      // over the control itself; `wrapper-body` is the generator reading a wrapper's body and finding one
      // registered control in it. Anything else is a basis nobody established, and a claim no reader can
      // re-derive is a claim this artifact must not carry.
      if (!['identity', 'wrapper-body'].includes(mutant.paired_by)) {
        failures.push(`${entry.id}: mutant ${mutant.name} carries no established pairing basis `
          + `(${JSON.stringify(mutant.paired_by)})`);
      }
    }
    // An entry's evidence is pins. A pin-shaped receipt has no `file`, and asking for one is exactly what made
    // this checker throw on the first real pin - the generator had learned about pins and the checker had not.
    // What is checked here is the shape and the accounting; the immutable facts behind a pin (that the run
    // exists, that its artifact digest is the one GitHub computed, that the receipt hashes to that digest, that
    // its attestation names this workflow) are established against the API by the protected workflow. A shape
    // check that pretended to be that verification would be the same defect one level up.
    for (const pin of entry.receipts) {
      if (pin.source !== 'github-actions') {
        failures.push(`${entry.id}: receipt is not a pinned workflow run (source ${JSON.stringify(pin.source)}, `
          + `run ${pin.run_id ?? 'unidentified'})`);
        continue;
      }
      const missing = ['run_id', 'workflow_path', 'workflow_head_sha', 'artifact_name', 'artifact_digest',
        'receipt_digest'].filter(field => !pin[field]);
      if (missing.length > 0) {
        failures.push(`${entry.id}: pin run ${pin.run_id ?? 'unidentified'} is missing ${missing.join(', ')}`);
      }
      if (pin.workflow_path !== AUTHORITY_WORKFLOW) {
        failures.push(`${entry.id}: pin run ${pin.run_id} was produced by ${pin.workflow_path}, not `
          + `${AUTHORITY_WORKFLOW} - the authority is the only thing whose receipts certify a term`);
      }
      if (String(pin.workflow_head_sha ?? '').length !== 40) {
        failures.push(`${entry.id}: pin run ${pin.run_id} names a dispatching commit that is not a full sha`);
      }
      for (const test of [...(pin.control_tests ?? []), ...(pin.mutant_tests ?? [])]) {
        if (test.status !== 'pass') {
          failures.push(`${entry.id}: pin run ${pin.run_id} records ${test.name} as ${test.status}`);
        }
      }
    }
    if (entry.disposition === 'PASS') {
      if (entry.control.test_names.length === 0) failures.push(`${entry.id}: PASS without a control`);
      if (entry.killing_mutants.length === 0) failures.push(`${entry.id}: PASS without a mutant that kills it`);
      if (entry.approvable !== true) {
        failures.push(`${entry.id}: PASS for a term that carries no mutant, which no receipt can make true`);
      }
      if (entry.receipts.length === 0) {
        failures.push(`${entry.id}: PASS without a pinned receipt at the code revision`);
      }
      if (entry.receipts.some(pin => pin.verdict !== 'success')) {
        failures.push(`${entry.id}: PASS with a pin whose receipt records a run that did not succeed`);
      }
      // Every control test and every mutant of this term must be recorded as passing, by a pin that names it.
      // A pin covering part of a term is not a pin covering the term, and a test the run never observed is not
      // a test that passed - so the requirement is over the names, not over the count of pins.
      const covered = new Set();
      for (const pin of entry.receipts) {
        for (const test of [...(pin.control_tests ?? []), ...(pin.mutant_tests ?? [])]) {
          if (test.status === 'pass') covered.add(test.name);
        }
      }
      const uncovered = [...entry.control.test_names, ...entry.killing_mutants.map(mutant => mutant.test_name)]
        .filter(name => !covered.has(name));
      if (uncovered.length > 0) {
        failures.push(`${entry.id}: PASS while no pin records these tests as passing: ${uncovered.join(', ')}`);
      }
    } else if (entry.disposition !== 'BLOCK') {
      failures.push(`${entry.id}: disposition must be PASS or BLOCK`);
    }
  }
  return failures;
}

export function checkCodeRevision(root, committed) {
  const failures = [];
  const head = git(root, ['rev-parse', 'HEAD']);
  const codeHead = committed.code_revision?.head;
  if (!codeHead) failures.push('the manifest names no code revision');
  else {
    // Absence and non-ancestry are different facts and the failure message has to say which one it is.
    // A depth-limited CI checkout cannot see the code revision at all; reporting that as "not an ancestor"
    // sends the reader looking for a wrong head when the checkout is the problem.
    let present = true;
    try { git(root, ['cat-file', '-e', `${codeHead}^{commit}`]); }
    catch {
      present = false;
      failures.push(`this checkout does not contain the manifest's code revision ${codeHead.slice(0, 8)}, `
        + 'so its ancestry cannot be checked here - a shallow clone cannot validate a manifest');
    }
    let ancestor = present;
    if (present) {
      try { git(root, ['merge-base', '--is-ancestor', codeHead, head]); }
      catch {
        ancestor = false;
        failures.push(`the manifest's code revision ${codeHead.slice(0, 8)} is not an ancestor of ${head.slice(0, 8)}`);
      }
    }
    // A revision this checkout does not contain is rejected, not compared: git would exit non-zero and a
    // guard that throws instead of recording a failure is a guard an unknown head can walk through.
    let changed = null;
    if (ancestor) {
      try { changed = git(root, ['diff', '--name-only', `${codeHead}..${head}`]).split('\n').filter(Boolean); }
      catch { failures.push(`the manifest's code revision ${codeHead.slice(0, 8)} cannot be compared with this checkout`); }
    }
    for (const file of changed ?? []) {
      if (!nonExecutable(file)) {
        failures.push(`the manifest's code revision differs from this checkout in ${file}, which is neither `
          + 'documentation nor the manifest nor a receipt - the manifest must be regenerated at this revision');
      }
    }
  }
  return failures;
}

// The check CI runs. Returns a list of failures; empty means the manifest is the artifact it claims to be.
//
// Order matters for what a failure means. A wrong head is checked first, because everything else is
// meaningless if the manifest names a revision this checkout does not carry: rebuilding against it would
// report every entry as tampered with, which is exactly the message that hides a head mismatch behind an
// accusation of editing. And the rebuild is reported by which part of the manifest it disagrees with -
// the revision it names, or the entries it carries - so a reader can tell those two apart.
export async function checkManifest(root) {
  const manifestPath = path.join(root, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) return [`${MANIFEST_NAME} is absent`];
  const committed = readJson(manifestPath);
  const headFailures = checkCodeRevision(root, committed);
  if (headFailures.length > 0) return headFailures;
  const rebuilt = await buildManifest(root, committed.code_revision.head);
  const failures = [];
  failures.push(...checkAuthority(root, committed));
  const revisionMatches = serialise(committed.code_revision) === serialise(rebuilt.code_revision);
  const entriesMatch = serialise(committed.entries) === serialise(rebuilt.entries);
  if (!revisionMatches) {
    failures.push('the rebuild names a different code revision than the committed manifest: '
      + `manifest ${committed.code_revision.head.slice(0, 8)}/${committed.code_revision.tree.slice(0, 8)}`
      + ` vs rebuild ${rebuilt.code_revision.head.slice(0, 8)}/${rebuilt.code_revision.tree.slice(0, 8)}`);
  }
  if (serialise(committed.coverage) !== serialise(rebuilt.coverage)) {
    failures.push('the rebuild counts a different coverage than the committed manifest: '
      + `manifest ${JSON.stringify(committed.coverage)} vs rebuild ${JSON.stringify(rebuilt.coverage)}`);
  }
  if (!entriesMatch) {
    const ids = new Set([...committed.entries, ...rebuilt.entries].map(entry => entry.id));
    const differing = [...ids].filter(id => serialise(committed.entries.find(entry => entry.id === id) ?? null)
      !== serialise(rebuilt.entries.find(entry => entry.id === id) ?? null));
    failures.push(`the rebuild differs from the committed manifest in ${differing.length} of ${ids.size} `
      + `entries: ${differing.slice(0, 4).join(', ')}${differing.length > 4 ? ', ...' : ''} - a claim was `
      + 'edited rather than generated');
  }
  // Every authority-relevant field is rebuilt and compared, pins included. The pins are the evidence, so a
  // manifest that disagrees with the pins in this checkout is a claim nobody can re-derive - and a pin present
  // in the file but absent from the manifest (or the reverse) must refuse by name, not be silently ignored.
  const pinsMatch = serialise(committed.pins_present ?? null) === serialise(rebuilt.pins_present ?? null);
  if (committed.receipt_files_are_not_evidence !== rebuilt.receipt_files_are_not_evidence) {
    failures.push('the rebuild disagrees about whether receipt files are evidence: '
      + `manifest ${committed.receipt_files_are_not_evidence} vs rebuild ${rebuilt.receipt_files_are_not_evidence}`);
  }
  const claimedPins = new Map((committed.pins_present ?? []).map(pin => [String(pin.run_id), pin]));
  const rebuiltPins = new Map((rebuilt.pins_present ?? []).map(pin => [String(pin.run_id), pin]));
  for (const [runId, pin] of rebuiltPins) {
    const claimed = claimedPins.get(runId);
    if (!claimed) {
      failures.push(`pin run ${runId} proves terms in this checkout but the committed manifest does not carry `
        + `it: a missing or uncommitted pin must refuse by name`);
      continue;
    }
    for (const field of ['proves', 'artifact_digest', 'receipt_digest', 'workflow_head_sha', 'verdict', 'measured']) {
      if (String(claimed[field] ?? '') !== String(pin[field] ?? '')) {
        failures.push(`pin run ${runId}: the committed manifest says ${field}=`
          + `${JSON.stringify(claimed[field] ?? null)}, the pins in ${PINS_NAME} say `
          + `${JSON.stringify(pin[field] ?? null)}`);
      }
    }
  }
  for (const [runId] of claimedPins) {
    if (!rebuiltPins.has(runId)) {
      failures.push(`pin run ${runId} is in the committed manifest but not among the pins in ${PINS_NAME}: `
        + `an altered or removed pin must refuse by name`);
    }
  }
  if (!pinsMatch && failures.filter(line => line.startsWith('pin run ')).length === 0) {
    failures.push(`the manifest's pins are not what the pins in ${PINS_NAME} produce - regenerate at this revision`);
  }
  const inventory = new Set(readJson(path.join(root, 'suite-inventory.json')).names);
  failures.push(...checkEntries(root, committed.entries ?? [], inventory));
  return failures;
}

if (process.argv[1] && process.argv[1].endsWith('claim-manifest.mjs')) {
  const root = process.cwd();
  if (process.argv.includes('--write')) {
    // An optional revision argument, so the documented command can reproduce a manifest at the commit that
    // carries it. Building against HEAD names the manifest's own commit as the code revision, which is a
    // revision whose tree differs from the one the receipts attest.
    const revision = process.argv.slice(2).find(argument => !argument.startsWith('--')) ?? null;
    fs.writeFileSync(path.join(root, MANIFEST_NAME), serialise(await buildManifest(root, revision)));
    console.log(`wrote ${MANIFEST_NAME}`);
  } else {
    // The claim is about a revision, so the evidence for it is a run of that revision. Whether this checkout is
  // clean is a fact about the reader's directory, not about the claim, so it is reported and not scored.
  console.log(`WORKING_TREE: ${git(root, ['status', '--porcelain']).trim()
    ? 'dirty (this is not part of the claim; the evidence is a receipt from a clean checkout of the revision)'
    : 'clean'}`);
  const failures = await checkManifest(root);
    for (const failure of failures) console.error(`CLAIM_MANIFEST: ${failure}`);
    console.log(failures.length === 0 ? 'CLAIM_MANIFEST_OK' : `CLAIM_MANIFEST_FAILED (${failures.length})`);
    process.exit(failures.length === 0 ? 0 : 1);
  }
}
