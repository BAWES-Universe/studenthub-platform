// THE CONTROLLER. It runs only code from protected main, it runs NO candidate code, and every outcome it
// records is one it observed itself.
//
// THE CORRECTION THIS FILE IS. The container that controller.mjs drives establishes PROVENANCE - where an
// outcome came from and who could have written it. It does not make a candidate-authored claim true, and an
// earlier posture confused the two: the capture was authenticated to the byte and then PARSED into
// authoritative per-term PASS points, so a candidate's own test body printing well-formed TAP created
// approved points out of text it wrote itself. Hashing that text harder does not help; neither does a
// stricter parser. What helps is that no parse of candidate output is ever authority.
//
// So for every claimed term this file, and not the candidate:
//
//   * takes the required test/mutation matrix from .github/verifier-receipt/matrix.json and the runner
//     command from .github/verifier-receipt/runners.json - BOTH on protected main, both pinned by the
//     dispatching SHA, neither readable from the candidate's tree. A claim may name no term, no test and no
//     mutant the matrix does not require, and may omit none that it does: both directions are refused BY
//     NAME, so a claim can neither add a requirement nor widen one nor quietly drop one.
//   * runs that term's required controls, unmutated, in the sandbox, and takes the EXIT STATUS from waitpid
//     on the container - not from a line in the stream, not from a file, not from a job output.
//   * applies each required mutation to a PRIVATE OVERLAY of its own candidate checkout - copy, patch, run -
//     and never to the checkout the normal run is measured from, so no measurement can see a tree another
//     measurement left behind.
//   * runs each mutant against the controller-defined subset of tests that should kill it, and observes
//     that run's exit status itself.
//
// A TERM IS ESTABLISHED ONLY WHEN its required controls pass in a controller-observed run AND every
// required mutant is observed to die. Candidate stdout and stderr are kept as DIAGNOSTIC evidence, labelled
// as such, and can never create, name or widen an approved point.
//
// WHY THE MUTANT IS NOT AN EXTRA, BUT THE THING THAT MAKES AN EXIT STATUS MEAN ANYTHING. An exit status on
// its own says a process ended well; it does not say a test ran, that it asserted anything, or that the
// name the claim uses is the body that executed. An empty test body exits 0. A test whose pattern matched
// nothing exits 0. A test that asserts `true` exits 0. Every one of those ALSO exits 0 with the mutation
// applied - and a mutant that does not die refuses its term by name. That is the whole reason this file
// does not need to read, trust or parse a single byte the candidate printed.
//
// AND WHAT IT STILL CANNOT DO, stated here rather than left for a review to find. The mutation matrix
// establishes that SOMETHING in the candidate's tree distinguishes the mutated source from the unmutated
// source. A candidate whose test body reads its own source and fails on purpose when it finds the mutation
// reproduces that distinction without testing anything. Closing that needs an oracle outside the
// candidate's tree, which no CI boundary provides; what this boundary does is make the forgery have to be
// written on purpose, in the candidate's committed source, against a mutation set the candidate cannot read
// at authoring time without also committing the reader.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runSandbox, measurementEnv, SOURCE_MOUNT, SCRATCH_MOUNT } from './sandbox.mjs';

const sha256 = bytes => crypto.createHash('sha256').update(bytes).digest('hex');
export const readJson = file => JSON.parse(fs.readFileSync(file, 'utf8'));

// A node --test name pattern that matches exactly the names given and nothing else. Anchored at both ends
// and fully escaped: a matrix entry is a literal test name, never a pattern, so a name containing regex
// metacharacters selects itself rather than a family.
export function namePattern(names) {
  if (!Array.isArray(names) || names.length === 0) throw new Error('a scoped run needs at least one test name');
  const escaped = names.map(name => name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  return `^(?:${escaped.join('|')})$`;
}

// THE SCOPED COMMAND, BUILT BY THE CONTROLLER AND NEVER READ FROM A TREE. The per-file bound is the
// protected enum's, taken from runners.json so that one measurement sets it for every run of this
// authority; the reporter is TAP because its output is DIAGNOSTIC and a diagnostic stream a human reads is
// worth more than a machine format nothing is allowed to believe.
export function scopedArgv({ file, testNames, timeoutMs }) {
  return ['/usr/local/bin/node', '--test', '--test-reporter=tap', `--test-timeout=${timeoutMs}`,
    `--test-name-pattern=${namePattern(testNames)}`, `${SOURCE_MOUNT}/${file}`];
}

// The protected runner command, split into argv by the controller. runners.json carries a command STRING
// because that is what a human reads and reviews; it is never handed to a shell, here or anywhere, so a
// key whose text grew a `;` cannot become two commands.
export function runnerArgv(command) {
  const parts = command.trim().split(/\s+/);
  if (parts[0] !== 'node') throw new Error(`the protected runner enum names ${JSON.stringify(parts[0])}, and this controller invokes node`);
  const expanded = [];
  for (const part of parts.slice(1)) {
    // The enum's commands name test files by glob because that is how the suite is defined. The controller
    // expands the glob ITSELF, against its own checkout, rather than handing a shell a pattern: a shell
    // expansion is the candidate's tree choosing which files run.
    if (part.includes('*')) expanded.push({ glob: part });
    else expanded.push(part);
  }
  return ['/usr/local/bin/node', ...expanded];
}

// The glob expansion, done by the controller against its own candidate checkout. Only `dir/*.suffix` is
// supported, which is the only shape the protected enum uses; anything else is refused rather than guessed.
export function expandGlobs(argv, candidateDir) {
  return argv.flatMap(part => {
    if (typeof part === 'string') return [part];
    const pattern = part.glob;
    const at = pattern.lastIndexOf('/');
    const dir = pattern.slice(0, at);
    const name = pattern.slice(at + 1);
    if (at < 0 || name.indexOf('*') !== name.lastIndexOf('*') || !name.startsWith('*'))
      throw new Error(`the protected runner enum carries a glob this controller will not expand: ${pattern}`);
    const suffix = name.slice(1);
    const entries = fs.readdirSync(path.join(candidateDir, dir)).filter(entry => entry.endsWith(suffix)).sort();
    if (entries.length === 0) throw new Error(`the protected runner enum's ${pattern} matches no file in this candidate`);
    return entries.map(entry => `${SOURCE_MOUNT}/${dir}/${entry}`);
  });
}

// ---------------------------------------------------------------------------------------------------
// MATRIX FIDELITY. The claim's surface, against the protected matrix's, in both directions and by name.
// ---------------------------------------------------------------------------------------------------
//
// A claim is the candidate asking for something. The matrix is what this authority requires. Nothing in a
// claim may ADD a term, a test or a mutant the matrix does not require - that is a candidate writing its
// own requirement - and nothing in a claim may OMIT one the matrix does require - that is a candidate
// quietly narrowing what it has to survive. Both are refused, each naming the term and the exact name.
export function checkMatrixFidelity(matrixTerms, claimEntries) {
  const refusals = [];
  const byId = new Map(matrixTerms.map(term => [term.id, term]));
  const claimed = new Map();
  for (const entry of claimEntries) {
    if (claimed.has(entry.id)) refusals.push({ kind: 'duplicate_term', term: entry.id, detail: `the claim names the term ${JSON.stringify(entry.id)} more than once` });
    claimed.set(entry.id, entry);
  }
  for (const id of claimed.keys()) {
    if (!byId.has(id)) refusals.push({ kind: 'unrequired_term', term: id, detail: `the claim names the term ${JSON.stringify(id)}, which the protected matrix does not require` });
  }
  for (const id of byId.keys()) {
    if (!claimed.has(id)) refusals.push({ kind: 'omitted_term', term: id, detail: `the claim omits the term ${JSON.stringify(id)}, which the protected matrix requires` });
  }
  for (const [id, entry] of claimed) {
    const term = byId.get(id);
    if (!term) continue;
    const required = new Set(term.control.test_names);
    const named = new Set(entry.control?.test_names ?? []);
    for (const name of named) if (!required.has(name))
      refusals.push({ kind: 'unrequired_test', term: id, name, detail: `the claim names the test ${JSON.stringify(name)} for ${JSON.stringify(id)}, which the protected matrix does not require` });
    for (const name of required) if (!named.has(name))
      refusals.push({ kind: 'omitted_test', term: id, name, detail: `the claim omits the test ${JSON.stringify(name)}, which the protected matrix requires for ${JSON.stringify(id)}` });
    const requiredMutants = new Set(term.mutants.map(mutant => mutant.name));
    const namedMutants = new Set((entry.killing_mutants ?? []).map(mutant => mutant.name));
    for (const name of namedMutants) if (!requiredMutants.has(name))
      refusals.push({ kind: 'unrequired_mutant', term: id, name, detail: `the claim names the mutant ${JSON.stringify(name)} for ${JSON.stringify(id)}, which the protected matrix does not require` });
    for (const name of requiredMutants) if (!namedMutants.has(name))
      refusals.push({ kind: 'omitted_mutant', term: id, name, detail: `the claim omits the mutant ${JSON.stringify(name)}, which the protected matrix requires for ${JSON.stringify(id)}` });
  }
  return refusals;
}

// ---------------------------------------------------------------------------------------------------
// THE PRIVATE OVERLAY. Copy, patch, run - and never the checkout the normal run is measured from.
// ---------------------------------------------------------------------------------------------------
//
// The copy is by hard link, which is what makes 66 overlays of a 16 MB tree affordable, and the patched
// file is UNLINKED AND REWRITTEN rather than edited in place - writing through a hard link would rewrite
// the controller's own candidate checkout, which is the one thing an overlay exists not to do. The check
// after the write reads the original back and refuses if it moved.
export function buildOverlay(candidateDir, overlayDir, patch, { link = fs.linkSync } = {}) {
  fs.mkdirSync(overlayDir, { recursive: true });
  const copy = (from, to) => {
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const source = path.join(from, entry.name);
      const target = path.join(to, entry.name);
      if (entry.isDirectory()) { fs.mkdirSync(target, { recursive: true }); copy(source, target); }
      else if (entry.isSymbolicLink()) fs.symlinkSync(fs.readlinkSync(source), target);
      else link(source, target);
    }
  };
  copy(candidateDir, overlayDir);

  const target = path.join(overlayDir, patch.file);
  const before = fs.readFileSync(target, 'utf8');
  const originalPath = path.join(candidateDir, patch.file);
  const originalBefore = fs.readFileSync(originalPath);
  // The anchor must be present EXACTLY ONCE. Absent means the candidate changed the code the protected
  // mutation was written against, and a mutation that cannot be applied is not a mutation that died.
  // Several means the mutation is ambiguous, and an ambiguous mutation is not a requirement anyone can
  // check. Both refuse, by name, rather than patching the first occurrence.
  const occurrences = before.split(patch.find).length - 1;
  if (occurrences !== 1) return { applied: false, occurrences, reason: occurrences === 0
    ? `the protected mutation's anchor is not present in ${patch.file} at this candidate, so this mutation cannot be applied to it`
    : `the protected mutation's anchor occurs ${occurrences} times in ${patch.file} at this candidate, so which occurrence it names is undefined` };
  const after = before.replace(patch.find, () => patch.replace);
  if (after === before) return { applied: false, occurrences, reason: `the protected mutation for ${patch.file} changes nothing at this candidate` };
  fs.rmSync(target);                       // break the hard link before writing, or this writes the original
  fs.writeFileSync(target, after);
  if (!fs.readFileSync(originalPath).equals(originalBefore))
    throw new Error(`applying the overlay patch for ${patch.file} modified the controller's own candidate checkout`);
  return { applied: true, occurrences, before_sha256: sha256(before), after_sha256: sha256(after) };
}

// ---------------------------------------------------------------------------------------------------
// THE MEASUREMENT.
// ---------------------------------------------------------------------------------------------------
let RUN_SEQ = 0;
async function observe(label, spec, io, extra = {}) {
  const id = `run-${String(++RUN_SEQ).padStart(4, '0')}`;
  const observed = await runSandbox(spec, io);
  // The stream is DIAGNOSTIC. It is digested and its size recorded so a reader can find it and tell it from
  // any other bytes; nothing downstream may read a point out of it.
  const record = {
    run_id: id,
    label,
    observed_by: 'controller',
    argv: observed.argv,
    exit: observed.exit,
    signal: observed.signal,
    sandbox_fault: observed.sandbox_fault,
    duration_ms: observed.duration_ms,
    diagnostic_stream: { sha256: observed.sha256, bytes: observed.bytes, truncated: observed.truncated, authority: 'none: candidate output, kept for a human' },
    ...extra,
  };
  if (io.keepStream) record.stream = observed.stdout;
  return record;
}

export async function measure({ matrix, scope, runners, runnerKey, candidateDir, scratchDir, image, claim, io,
  normalRun = null, measurementScratch = null }) {
  const scopeSpec = matrix.scopes?.[scope];
  if (!scopeSpec) throw new Error(`the protected matrix has no scope ${JSON.stringify(scope)}`);
  const runner = runners.runners?.[runnerKey];
  if (!runner?.command) throw new Error(`the protected runner enum has no key ${JSON.stringify(runnerKey)}`);
  const timeoutMs = Number(/--test-timeout=(\d+)/.exec(runner.command)?.[1]);
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
    throw new Error(`the protected runner enum's ${runnerKey} command carries no --test-timeout, so a scoped run of it would be unbounded`);

  // THE ONE DIRECTORY THE MEASUREMENT MAY WRITE, AND WHY THIS FUNCTION DOES NOT CREATE IT.
  //
  // It has to be owned by 10001, and chowning a directory to another uid needs root - which this process does
  // not have and must not have. So the caller prepares it (the workflow does, with one `sudo chown`) and
  // hands the path in. A first attempt had this function create `<scratchDir>/measurement` itself and swallow
  // the EPERM from its own chown; the directory was then owned by the runner user, the container could not
  // write its own TMPDIR, and the preflight refused the whole run with EACCES. That refusal was right - a
  // measurement whose tests cannot write a temporary file fails for reasons that are not about the tests -
  // and the fix is to stop pretending this process can create that directory.
  //
  // Everything else under `scratchDir` stays 0700 under the runner's own uid and is never mounted anywhere.
  if (!measurementScratch) throw new Error('the controller was given no measurement scratch: the one directory the measurement may write has to be created and chowned to 10001 by the caller, because chowning to another uid needs root');
  const overlayRoot = path.join(scratchDir, 'overlays');
  fs.mkdirSync(overlayRoot, { recursive: true });

  const sandboxFor = (sourceDir, argv) => ({ image, sourceDir, scratchDir: measurementScratch, argv, env: measurementEnv() });

  // 1. MATRIX FIDELITY, before anything is run. A claim that does not match the matrix is refused by name,
  //    and the refusal is the answer: there is nothing to measure for a requirement nobody agreed on.
  const fidelity = checkMatrixFidelity(scopeSpec.terms, claim.entries ?? []);

  // 2. THE NORMAL RUN: the protected runner command, whole, in the sandbox, with the controller taking its
  //    exit status from waitpid. This is the measured baseline. Its stream is DIAGNOSTIC and the counts a
  //    reader sees below are parsed out of it for a human, never to establish a term.
  // THE NORMAL RUN IS OBSERVED ONCE, NOT TWICE. `normalRun` is the record capture-stream.mjs made when it
  // invoked the protected runner command in this same sandbox, in this same job, and took its exit status
  // from waitpid on the container. capture-stream.mjs IS this controller - protected code, in the job that
  // holds contents: read and nothing else - so re-running the whole suite here to observe the same number
  // would cost a second suite run and establish nothing the first did not. When no such record is handed in,
  // this runs it itself.
  let normal;
  let stream = '';
  if (normalRun) {
    normal = normalRun;
  } else {
    const normalArgv = expandGlobs(runnerArgv(runner.command), candidateDir);
    normal = await observe('normal-run', sandboxFor(candidateDir, normalArgv), { ...io, keepStream: true },
      { runner_key: runnerKey, runner_command: runner.command });
    stream = normal.stream ? normal.stream.toString('utf8') : '';
    delete normal.stream;
    const count = name => { const m = new RegExp(`^# ${name} (\\d+)$`, 'm').exec(stream); return m ? Number(m[1]) : null; };
    normal.diagnostic_counts = { authority: 'none: parsed from candidate output for a human to read',
      tests: count('tests'), pass: count('pass'), fail: count('fail'), cancelled: count('cancelled'), skipped: count('skipped') };
  }

  // 3 and 4. PER TERM: the control, unmutated, then every required mutant in its own private overlay.
  const terms = [];
  for (const term of scopeSpec.terms) {
    const refusals = fidelity.filter(refusal => refusal.term === term.id);
    const control = await observe(`control:${term.id}`,
      sandboxFor(candidateDir, scopedArgv({ file: term.control.file, testNames: term.control.test_names, timeoutMs })), io,
      { term: term.id, test_names: term.control.test_names });
    const mutants = [];
    for (const mutant of term.mutants) {
      const overlayDir = path.join(overlayRoot, `${term.id.replace(/[^a-z0-9]+/gi, '-')}--${mutants.length}`);
      let overlay;
      try { overlay = buildOverlay(candidateDir, overlayDir, mutant.patch); }
      catch (error) { overlay = { applied: false, reason: `the overlay could not be built: ${error.message}` }; }
      let run = null;
      if (overlay.applied) {
        run = await observe(`mutant:${term.id}:${mutant.name}`,
          sandboxFor(overlayDir, scopedArgv({ file: mutant.killed_by.file, testNames: mutant.killed_by.test_names, timeoutMs })), io,
          { term: term.id, mutant: mutant.name, patched: mutant.patch.file, killed_by: mutant.killed_by.test_names });
      }
      fs.rmSync(overlayDir, { recursive: true, force: true });
      // A MUTANT DIES WHEN THE CONTROLLER OBSERVES ITS KILLING RUN FAIL. Not when the candidate says so, and
      // not when the container itself failed to start: 125/126/127 are docker refusing, and reading one of
      // those as a dead mutant would establish a term off a missing image.
      const died = Boolean(overlay.applied && run && run.sandbox_fault === null && run.exit !== 0);
      mutants.push({ name: mutant.name, observed_by: 'controller', patch: { file: mutant.patch.file, ...overlay },
        killing_run: run?.run_id ?? null, killing_run_exit: run?.exit ?? null, died,
        why: died ? null : overlay.applied
          ? (run?.sandbox_fault !== null && run ? `the sandbox itself failed (docker exit ${run.sandbox_fault}), so this run measured nothing`
            : `the killing run exited ${run?.exit}, so this mutation survived every test the protected matrix requires to kill it`)
          : overlay.reason,
        run: run ?? null });
    }
    const controlsPass = control.sandbox_fault === null && control.exit === 0;
    const allDead = term.mutants.length > 0 && mutants.every(mutant => mutant.died);
    const why = [];
    if (!term.establishable) why.push(term.not_establishable_because ?? 'the protected matrix does not make this term establishable');
    if (refusals.length > 0) why.push(...refusals.map(refusal => refusal.detail));
    if (!controlsPass) why.push(control.sandbox_fault !== null
      ? `the sandbox itself failed for the control run (docker exit ${control.sandbox_fault}), so this run measured nothing`
      : `the controller-observed control run exited ${control.exit}, so the required controls did not pass`);
    for (const mutant of mutants) if (!mutant.died) why.push(`the required mutant ${JSON.stringify(mutant.name)} was not observed to die: ${mutant.why}`);
    terms.push({
      id: term.id,
      // THE CLAIM ENTRY THIS OBSERVATION BELONGS TO, BY INDEX, NEVER ONLY BY ID. The emitter learned this the
      // hard way and recorded it: ten entries with the same id pooled into one bucket that all ten then
      // reported as their own coverage, because a shared id is a shared key. An index cannot be shared. The
      // id travels too, for a human; the index is what anything downstream matches on.
      claim_entry: (claim.entries ?? []).findIndex(entry => entry?.id === term.id),
      sealed_term: term.sealed_term,
      observed_by: 'controller',
      establishable: term.establishable === true,
      matrix_refusals: refusals,
      control: { file: term.control.file, test_names: term.control.test_names, run: control.run_id, exit: control.exit, passed: controlsPass },
      mutants,
      established: term.establishable === true && refusals.length === 0 && controlsPass && allDead,
      why_not: why,
      runs: [control, ...mutants.map(mutant => mutant.run).filter(Boolean)],
    });
  }

  return {
    schema: 'verifier-controller-observation/v1',
    observed_by: 'controller',
    scope,
    runner_key: runnerKey,
    matrix: { path: matrix._path ?? null, sha256: matrix._sha256 ?? null, terms: scopeSpec.terms.length },
    image,
    normal_run: normal,
    matrix_fidelity: { refused: fidelity.length > 0, refusals: fidelity },
    terms,
    established: terms.filter(term => term.established).map(term => term.id),
  };
}
