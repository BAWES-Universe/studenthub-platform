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
// Paths arrive repo-root-relative from `git diff --name-only`, so the receipts test has to match that shape:
// a prefix of `receipts/` matches nothing git emits here, and the guard then rejects a receipt the lane
// commits after its code revision - the exact flow the tolerance exists for. The test asserts the shape git
// emits for this reason; asserting a bare relative path is what let the defect through.
export const nonExecutable = file => NON_EXECUTABLE.some(suffix => file.endsWith(suffix))
  || path.basename(file) === MANIFEST_NAME
  || file.startsWith(`${RECEIPTS_DIR}/`) || file.includes(`/${RECEIPTS_DIR}/`);

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
export async function buildEntries(root, receipts, head) {
  const entries = [];
  for (const registry of REGISTRIES) {
    const read = await readRegistry(root, registry);
    for (const control of read.controls) {
      const killers = read.mutations.filter(mutation => mutation.kills.includes(control.name));
      const id = `${slug(registry.label)}/${slug(control.name)}`;
      const at = receipts.filter(receipt => receipt.head === head);
      const attested = at.filter(receipt => receipt.kind === 'verified');
      const reasons = [];
      if (killers.length === 0) reasons.push('no mutant is paired with this control in the registry');
      if (attested.length === 0) reasons.push('no verifying receipt at the code revision');
      if (attested.length > 0 && !attested.every(receipt => receipt.verdict === 'PASS')) {
        reasons.push('the verifying receipt at the code revision is not a PASS');
      }
      entries.push({
        id,
        sealed_term: control.name,
        artifact: registry.file,
        control: { test_names: control.test_names.slice().sort() },
        killing_mutants: killers.map(killer => ({ name: killer.name, test_name: killer.test_name,
          paired_by: killer.paired_by ?? null }))
          .sort((a, b) => a.name.localeCompare(b.name)),
        receipts: at.map(receipt => ({ file: `${RECEIPTS_DIR}/${receipt.file}`, kind: receipt.kind,
          sha256: receipt.sha256, verdict: receipt.verdict ?? null })),
        disposition: reasons.length === 0 ? 'PASS' : 'BLOCK',
        reason: reasons.join('; ') || null,
      });
    }
  }
  // Two registries can define the same control name; the id carries the label so entries never merge.
  return entries.sort((a, b) => a.id.localeCompare(b.id));
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
export async function buildManifest(root, head) {
  const revision = head ?? git(root, ['rev-parse', 'HEAD']);
  const tree = git(root, ['rev-parse', `${revision}^{tree}`]);
  const receipts = readReceipts(root);
  const entries = await buildEntries(root, receipts, revision);
  return { schema: 1, code_revision: { head: revision, tree }, coverage: coverageOf(root, entries), entries };
}

// What the entries enumerate, set against what the suite carries. The manifest covers the controls the
// registries declare; a control registered directly in a runner file is outside that scope, and a reader is
// entitled to the size of that gap as a generated number rather than as a silence.
export function coverageOf(root, entries) {
  const inventory = readJson(path.join(root, 'suite-inventory.json'));
  const referenced = new Set();
  for (const entry of entries) {
    for (const name of entry.control.test_names) referenced.add(name);
    for (const mutant of entry.killing_mutants) referenced.add(mutant.test_name);
  }
  const outsideScope = inventory.names.filter(name => !referenced.has(name));
  // Scope, stated: this manifest covers the sealed arming terms the registries declare. It is not a
  // coverage report on the whole coordinator suite, and the count below is the size of what is outside the
  // manifest's scope by design, not a gap in it. Reading it as missing coverage is the misreading it exists
  // to prevent.
  return {
    scope: 'the sealed arming terms the registries declare; not a coverage report on the whole suite',
    sealed_terms: entries.length,
    inventory_names: inventory.names.length,
    control_names_referenced_in_inventory: inventory.names.length - outsideScope.length,
    suite_names_outside_scope: outsideScope.length,
    outside_scope_sample: outsideScope.slice(0, 12),
    referenced_not_in_inventory: [...referenced].filter(name => !inventory.names.includes(name)).length,
  };
}

export function serialise(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

// Each rejection path is its own function so a test can drive it directly with a tampered manifest: the
// guard has to be shown failing for the reason it exists, not only passing.
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
    for (const receipt of entry.receipts) {
      const file = path.join(root, receipt.file);
      if (!fs.existsSync(file)) { failures.push(`${entry.id}: receipt ${receipt.file} is absent`); continue; }
      const digest = sha256(fs.readFileSync(file));
      if (digest !== receipt.sha256) failures.push(`${entry.id}: receipt ${receipt.file} digest does not match`);
    }
    if (entry.disposition === 'PASS') {
      if (entry.control.test_names.length === 0) failures.push(`${entry.id}: PASS without a control`);
      if (entry.killing_mutants.length === 0) failures.push(`${entry.id}: PASS without a mutant that kills it`);
      const verifying = entry.receipts.filter(receipt => receipt.kind === 'verified');
      if (verifying.length === 0) failures.push(`${entry.id}: PASS without a verifying receipt at the code revision`);
      if (!verifying.every(receipt => receipt.verdict === 'PASS')) {
        failures.push(`${entry.id}: PASS with a verifying receipt whose verdict is not PASS`);
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
  // A receipt that claims verification at a revision this history does not cover verifies nothing here.
  // Filtering it out of the entries is what protects the dispositions; it is not what protects the tree, so
  // the guard rejects it rather than passing over it in silence.
  const stray = [];
  for (const receipt of readReceipts(root)) {
    if (receipt.kind !== 'verified' || receipt.head === committed.code_revision.head) continue;
    let covered = false;
    try {
      git(root, ['cat-file', '-e', `${receipt.head}^{commit}`]);
      git(root, ['merge-base', '--is-ancestor', receipt.head, committed.code_revision.head]);
      covered = true;
    } catch { covered = false; }
    if (!covered) stray.push(`${receipt.file} (head ${String(receipt.head).slice(0, 8)})`);
  }
  if (stray.length > 0) {
    failures.push(`verified receipts at a revision this manifest does not cover: ${stray.join(', ')}`);
  }
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
  const inventory = new Set(readJson(path.join(root, 'suite-inventory.json')).names);
  failures.push(...checkEntries(root, committed.entries ?? [], inventory));
  return failures;
}

if (process.argv[1] && process.argv[1].endsWith('claim-manifest.mjs')) {
  const root = process.cwd();
  if (process.argv.includes('--write')) {
    fs.writeFileSync(path.join(root, MANIFEST_NAME), serialise(await buildManifest(root)));
    console.log(`wrote ${MANIFEST_NAME}`);
  } else {
    const failures = await checkManifest(root);
    for (const failure of failures) console.error(`CLAIM_MANIFEST: ${failure}`);
    console.log(failures.length === 0 ? 'CLAIM_MANIFEST_OK' : `CLAIM_MANIFEST_FAILED (${failures.length})`);
    process.exit(failures.length === 0 ? 0 : 1);
  }
}
