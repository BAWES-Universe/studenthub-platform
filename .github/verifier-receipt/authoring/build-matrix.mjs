// AUTHORING TOOL, RUN BY A HUMAN ON MAIN. Never run by the controller, never shipped into the measurement.
//
// It reads a candidate checkout's committed control/mutation registries and emits the PROTECTED matrix that
// the controller then uses. The output is committed on main and is authority from that moment: the controller
// reads the committed file and never re-derives it from any candidate tree.
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.argv[2];
const OUT = process.argv[3];
const FROZEN = process.argv[4] ?? null;
// Importing a candidate's check registry pulls in node:test, whose harness writes its own TAP preamble to
// STDOUT. The matrix therefore leaves on a named file descriptor of this tool's choosing, never on stdout:
// a generator that shares a stream with the thing it loads produces a file that is not what it computed.
if (!ROOT || !OUT || !FROZEN) { console.error('usage: build-matrix.mjs <checkout> <out.json> <frozen-against-sha>'); process.exit(2); }

const SERVICE = '.github/coordinator/service';
const REGISTRIES = [
  { file: `${SERVICE}/test/shu71-arming-robustness-checks.mjs`, label: 'B6 arming robustness',
    runner: `${SERVICE}/test/shu71-arming-robustness.test.mjs` },
  { file: `${SERVICE}/test/shu71-postpush-readback-checks.mjs`, label: 'B5 post-push read-back',
    runner: `${SERVICE}/test/shu71-postpush-readback.test.mjs` },
];
// The three modules a mutation of this repository may target, and the path each `target` name means. The
// controller applies a patch only to a file named here; a matrix naming anything else is refused when it is
// read, so an authoring slip cannot widen what a mutation may rewrite.
const TARGETS = {
  production: `${SERVICE}/shu71-production.mjs`,
  journal: `${SERVICE}/shu71-journal.mjs`,
  units: `${SERVICE}/units.mjs`,
};

const slug = text => text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

// Same reading claim-manifest.mjs does, kept deliberately separate: this tool must agree with the committed
// manifest builder about what a control IS, and a shared import would make the matrix a function of the
// candidate's own code at controller time rather than a frozen artefact of authoring time.
async function readRegistry(registry) {
  const module = await import(path.join(ROOT, registry.file));
  const controls = [];
  const fns = new Map();
  const byName = new Map();
  const add = (name, fn, variants) => {
    const names = variants ? variants.map(v => `${registry.label}: ${name} (${v})`) : [`${registry.label}: ${name}`];
    controls.push({ name, test_names: names, variants: variants ?? null });
    if (!fns.has(fn)) fns.set(fn, []);
    fns.get(fn).push(name);
    if (typeof fn?.name === 'string' && fn.name) {
      if (!byName.has(fn.name)) byName.set(fn.name, []);
      byName.get(fn.name).push(name);
    }
  };
  for (const [name, check] of module.controls ?? []) add(name, check);
  for (const [name, check, variants] of module.variantControls ?? []) add(name, check, variants);

  const runnerSource = fs.readFileSync(path.join(ROOT, registry.runner), 'utf8');
  for (const match of runnerSource.matchAll(/test\(\s*'([^']+)'\s*,[\s\S]{0,200}?\b([A-Za-z_$][\w$]*)\s*\(/g)) {
    const [, testName, fnName] = match;
    const fn = module[fnName];
    if (typeof fn !== 'function' || !testName.startsWith(`${registry.label}: `)) continue;
    if (controls.some(c => c.test_names.includes(testName))) continue;
    add(testName.slice(registry.label.length + 2), fn);
  }

  const byControlName = new Map(controls.map(c => [c.name, c]));
  const rows = [];
  const unpaired = [];
  // Every row shape in these registries carries exactly one function; the target module, the anchor and the
  // replacement are found by shape rather than by a fixed index, because the four shapes disagree on indices.
  const collect = (list, shape) => {
    for (const row of list ?? []) {
      // The four row shapes of these registries, spelled out rather than guessed at. A fixed index per shape
      // is only safe because the shape is named at the call site; a shape whose row does not match is refused.
      //   mutations          [name, find, replace, check]
      //   closureMutations   [name, check, reviewed, find, replace]   (TWO functions: check and the reviewed export)
      //   siblingMutations   [name, target, find, replace, check]
      const at = { mutations: 3, closureMutations: 1, siblingMutations: 4 }[shape];
      const check = row[at];
      if (typeof check !== 'function') throw new Error(`${shape} row ${JSON.stringify(row[0])} carries no check at index ${at}`);
      let kills = fns.get(check) ?? [];
      // A wrapper such as (create, h) => someControl(create, h, 'inactive') is not the control by identity.
      // Read its body for a call to a registered control, and use the pairing only when it names exactly one.
      let variant = null;
      if (kills.length === 0 && typeof check === 'function') {
        const called = new Set();
        for (const m of check.toString().matchAll(/([A-Za-z_$][\w$]*)\s*\(/g)) for (const n of byName.get(m[1]) ?? []) called.add(n);
        if (called.size === 1) {
          kills = [...called];
          const quoted = [...check.toString().matchAll(/'([^']+)'/g)].map(m => m[1]);
          const control = byControlName.get(kills[0]);
          variant = (control?.variants ?? []).find(v => quoted.includes(v)) ?? null;
        }
      }
      // A row whose check is not a registered control cannot be attributed to a term, so it cannot become a
      // requirement. It is reported rather than dropped in silence: an unattributable mutation is a gap in the
      // matrix that the owner has to see, not a row to quietly lose.
      if (kills.length !== 1) { unpaired.push(`${registry.label} / ${shape} / ${row[0]} (pairs with ${kills.length})`); continue; }
      rows.push({ name: row[0], control: kills[0], shape, variant,
        target: shape === 'siblingMutations' ? row[1] : 'production',
        find: shape === 'mutations' ? row[1] : (shape === 'closureMutations' ? row[3] : row[2]),
        replace: shape === 'mutations' ? row[2] : (shape === 'closureMutations' ? row[4] : row[3]) });
    }
  };
  collect(module.mutations, 'mutations');
  collect(module.closureMutations, 'closureMutations');
  collect(module.siblingMutations, 'siblingMutations');
  // PATTERN_MUTATION is a bare [name, target, before, after] row: the runner file pairs it with
  // haltCodeClosureCheck by hand rather than carrying the function in the row, so the pairing is read from the
  // runner the same way the unregistered controls above are, and refused if the runner stops naming it.
  if (module.PATTERN_MUTATION) {
    const [name, target, find, replace] = module.PATTERN_MUTATION;
    const paired = fns.get(module.haltCodeClosureCheck) ?? [];
    if (paired.length !== 1) throw new Error(`PATTERN_MUTATION pairs with ${paired.length} controls`);
    if (!/PATTERN_MUTATION/.test(runnerSource) || !/haltCodeClosureCheck\(mutant\.module\.haltCode\)/.test(runnerSource))
      throw new Error('the runner no longer pairs PATTERN_MUTATION with haltCodeClosureCheck');
    rows.push({ name, control: paired[0], shape: 'PATTERN_MUTATION', variant: null, target, find, replace });
  }
  return { registry, controls, rows, unpaired };
}

const terms = [];
const unattributable = [];
for (const registry of REGISTRIES) {
  const { controls, rows, unpaired } = await readRegistry(registry);
  unattributable.push(...unpaired);
  const prefix = slug(registry.label);
  for (const control of controls) {
    const mine = rows.filter(row => row.control === control.name);
    const mutants = mine.map(row => {
      const file = TARGETS[row.target];
      if (!file) throw new Error(`mutation ${JSON.stringify(row.name)} names target ${JSON.stringify(row.target)}`);
      const source = fs.readFileSync(path.join(ROOT, file), 'utf8');
      if (source.split(row.find).length !== 2) throw new Error(`anchor for ${JSON.stringify(row.name)} is not unique in ${file}`);
      // The tests this mutant must be observed to kill. Narrowed to the single variant the wrapper names
      // where it names one, because a mutant run is the expensive unit of this matrix.
      const killed = row.variant ? control.test_names.filter(n => n.endsWith(` (${row.variant})`)) : control.test_names;
      return { name: row.name, patch: { file, find: row.find, replace: row.replace }, killed_by: { file: registry.runner, test_names: killed } };
    });
    terms.push({
      id: `${prefix}/${slug(control.name)}`,
      sealed_term: control.name,
      control: { file: registry.runner, test_names: control.test_names },
      mutants,
      establishable: mutants.length > 0,
      not_establishable_because: mutants.length > 0 ? undefined
        : 'the protected matrix requires no killing mutant for this control, so no controller-observed run can distinguish it from a control that asserts nothing',
    });
  }
}

const matrix = {
  schema: 'verifier-matrix/v1',
  _comment: [
    'THE PROTECTED MATRIX: what this authority REQUIRES of a claim, and what the controller measures itself.',
    '',
    'This file is authority. It lives beside the workflow, on protected main, it is checked out BY SHA, and a',
    'candidate that alters any object under .github/verifier-receipt is refused before its suite is run. A',
    'claim may name no term, no test and no mutant this file does not require, and may omit none that it',
    'does: both directions are refused by name in controller.mjs. That is what stops a candidate widening',
    'its own requirement - the requirement is not in the candidate.',
    '',
    'WHAT A TERM IS ESTABLISHED BY, and it is never a line the candidate printed:',
    '  * control  - the file and the exact test names the controller runs, UNMUTATED, scoped by',
    '               --test-name-pattern, whose container exit status the controller takes from waitpid;',
    '  * mutants  - for each, a literal source substitution the controller applies to a PRIVATE OVERLAY of',
    '               its own candidate checkout, and the controller-defined subset of tests that must be',
    '               observed to FAIL with it applied.',
    'Both must hold. The mutant is not an extra: an exit status alone does not say a test ran, asserted',
    'anything, or matched the name the claim uses - an empty body, an unmatched pattern and an assertion of',
    '`true` all exit 0 - and every one of those ALSO exits 0 mutated, so the mutant refuses the term.',
    '',
    'HOW IT WAS AUTHORED. .github/verifier-receipt/authoring/build-matrix.mjs read the committed control and',
    'mutation registries of the candidate this matrix was frozen against and emitted this file, which was',
    'then reviewed and committed. The controller NEVER runs that tool and never re-derives this file from any',
    'candidate tree: a matrix a candidate can recompute is a requirement the candidate writes.',
    '',
    'A TERM WITH NO MUTANT IS NOT ESTABLISHABLE, and says so in its own row. Nothing distinguishes a control',
    'with no killing mutant from a control that asserts nothing, so this authority will not claim it does.',
    '',
    'AN ANCHOR THAT NO LONGER APPLIES IS A REFUSAL, NOT A PASS. If a candidate has changed the code a',
    'protected mutation was written against, the substitution cannot be applied, the mutant cannot be',
    'observed to die, and the term is refused by name. That is the safe direction: a mutation that cannot be',
    'applied has measured nothing.',
  ],
  frozen_against: FROZEN,
  scopes: {
    coordinator: {
      claim_path: `${SERVICE}/claim-manifest.json`,
      normal_run_runner_key: 'coordinator',
      patch_targets: TARGETS,
      unattributable_mutations: unattributable,
      terms,
    },
  },
};
fs.writeFileSync(OUT, JSON.stringify(matrix, null, 2) + '\n');
console.error(`unattributable ${unattributable.length}: ` + unattributable.join(' | '));
console.error(`terms ${terms.length}; establishable ${terms.filter(t => t.establishable).length}; mutants ${terms.reduce((n, t) => n + t.mutants.length, 0)}`);
