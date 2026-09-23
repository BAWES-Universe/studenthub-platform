// THE AUTHORITY BOUNDARY, TESTED AGAINST THE THINGS THAT DEFEATED EVERY VERSION BEFORE IT.
//
// Four properties are pinned here, and each one is the answer to a specific defeat:
//
//   1. THE SANDBOX IS THE SANDBOX. `assertNoEscape` reads the argv that is about to run and refuses it if any
//      flag has been weakened. An authority that only refuses candidates has not checked itself.
//   2. A CLAIM MAY NEITHER ADD NOR OMIT A REQUIREMENT. The protected matrix says what must be measured; a
//      claim that names a term, test or mutant it does not require is refused by name, and so is a claim that
//      omits one it does.
//   3. FABRICATED OUTPUT ESTABLISHES NOTHING. This is the decisive one. A candidate whose test body prints a
//      complete, well-formed TAP run claiming its term passed produces bytes that are hashed as faithfully as
//      the reporter's own - and the term is not established, because what establishes a term is an exit
//      status the controller observed for a run it chose, and a mutation it applied itself.
//   4. A MUTANT THAT DOES NOT DIE REFUSES ITS TERM BY NAME. Which is what makes 3 work: an empty body, an
//      unmatched name pattern and an assertion of `true` all exit 0, and every one of them ALSO exits 0 with
//      the mutation applied.
//
// Every measurement below runs through the docker stub, which asserts the real argv and then runs the command
// on this host. See its header for exactly what that establishes and what only a real dispatch can.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { sandboxArgv, assertNoEscape, measurementEnv, SANDBOX_FLAGS } from '../sandbox.mjs';
import { measure, checkMatrixFidelity, buildOverlay, namePattern, runnerArgv, expandGlobs } from '../controller.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.join(HERE, 'fixtures', 'boundary');
const IMAGE = JSON.parse(fs.readFileSync(path.join(HERE, '..', 'image.json'), 'utf8')).reference;
const STUB = path.join(HERE, 'docker-stub.mjs');

const stubExec = (argv, onChunk) => new Promise((resolve, reject) => {
  const child = spawn(process.execPath, [STUB, ...argv], { stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', onChunk);
  child.stderr.on('data', onChunk);
  child.on('error', reject);
  child.on('close', (code, signal) => resolve({ code, signal }));
});

// A candidate checkout of its own, so a test that patches one cannot disturb another.
const candidate = (patch = {}) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-candidate-'));
  const copy = (from, to) => {
    fs.mkdirSync(to, { recursive: true });
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      if (entry.isDirectory()) copy(path.join(from, entry.name), path.join(to, entry.name));
      else fs.copyFileSync(path.join(from, entry.name), path.join(to, entry.name));
    }
  };
  copy(FIXTURE, root);
  for (const [file, body] of Object.entries(patch)) {
    fs.mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
    fs.writeFileSync(path.join(root, file), body);
  }
  return root;
};

const RUNNERS = { runners: { boundary: { command: 'node --test --test-reporter=tap --test-timeout=60000 test/*.test.mjs' } } };
const TERM = {
  id: 'guard/refuses-a-stale-head',
  sealed_term: 'the guard refuses a stale head',
  control: { file: 'test/guard.test.mjs', test_names: ['the guard refuses a stale head'] },
  mutants: [{
    name: 'the head comparison is removed',
    patch: { file: 'src/guard.mjs', find: 'head === expected && ', replace: '' },
    killed_by: { file: 'test/guard.test.mjs', test_names: ['the guard refuses a stale head'] },
  }],
  establishable: true,
};
const matrixWith = terms => ({ schema: 'verifier-matrix/v1', _sha256: 'x'.repeat(64),
  scopes: { boundary: { claim_path: 'claim.json', normal_run_runner_key: 'boundary', terms } } });
const CLAIM = { entries: [{ id: TERM.id, control: { test_names: TERM.control.test_names },
  killing_mutants: [{ name: TERM.mutants[0].name }] }] };

const run = async ({ candidateDir, terms = [TERM], claim = CLAIM }) => {
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-scratch-'));
  // The one directory the measurement may write, prepared by the caller - as the workflow does, with a
  // `sudo chown` to 10001 that this process cannot do and must not be able to.
  const measurementScratch = path.join(scratchDir, 'measurement');
  fs.mkdirSync(path.join(measurementScratch, 'tmp'), { recursive: true });
  fs.mkdirSync(path.join(measurementScratch, 'home'), { recursive: true });
  try {
    return await measure({ matrix: matrixWith(terms), scope: 'boundary', runners: RUNNERS, runnerKey: 'boundary',
      candidateDir, scratchDir, measurementScratch, image: IMAGE, claim, io: { exec: stubExec },
      // The normal run is handed in, because these tests are about the per-term measurement and a whole-suite
      // run would add nothing to any of them.
      normalRun: { run_id: 'run-0000', label: 'normal-run', observed_by: 'controller', exit: 0, signal: null,
        sandbox_fault: null, duration_ms: 1, diagnostic_stream: { sha256: '0'.repeat(64), bytes: 0, truncated: false,
          authority: 'none: candidate output, kept for a human' } } });
  } finally { fs.rmSync(scratchDir, { recursive: true, force: true }); }
};

// ---- 1. the sandbox is the sandbox -----------------------------------------------------------------------

test('the sandbox invocation carries every flag the boundary rests on, and no escape', () => {
  const argv = assertNoEscape(sandboxArgv({ image: IMAGE, sourceDir: '/ctl/src', scratchDir: '/ctl/scratch',
    argv: ['/usr/local/bin/node', '--version'] }));
  for (const flag of ['--user', '10001:10001', '--read-only', '--cap-drop', 'ALL', '--security-opt',
    'no-new-privileges', '--network', 'none']) assert.ok(argv.includes(flag), `${flag} is absent`);
  assert.ok(argv.includes('--mount'), 'the source is not bind-mounted');
  assert.match(argv.join(' '), /type=bind,source=\/ctl\/src,target=\/src,readonly/);
  // NO DOCKER SOCKET, which would be root on the runner in one command and would make every flag decorative.
  assert.equal(argv.some(part => /docker\.sock/.test(String(part))), false);
  assert.equal(argv.includes('--privileged'), false);
  assert.equal(argv.includes('--cap-add'), false);
  // ENTERED THROUGH `env -i`: the environment is this authority's four names, not the runner's minus a
  // denylist. A denylist is a list somebody has to keep complete.
  assert.equal(argv[argv.indexOf('--entrypoint') + 1], '/usr/bin/env');
  const after = argv.slice(argv.indexOf('-i'));
  const named = after.filter(part => /^[A-Za-z_][A-Za-z0-9_]*=/.test(part)).map(part => part.slice(0, part.indexOf('=')));
  assert.deepEqual(named.sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
  assert.equal(named.some(name => /^GITHUB_|^ACTIONS_|^RUNNER_|^CI$|TOKEN/i.test(name)), false);
});

test('a weakened flag is refused before anything runs, and the refusal names the flag', () => {
  const sound = sandboxArgv({ image: IMAGE, sourceDir: '/ctl/src', scratchDir: '/ctl/scratch', argv: ['/usr/local/bin/node'] });
  const weakenings = [
    [argv => [...argv.slice(0, 1), '--privileged', ...argv.slice(1)], /--privileged/],
    [argv => [...argv.slice(0, 1), '--cap-add', 'SYS_ADMIN', ...argv.slice(1)], /adds a capability back/],
    [argv => argv.map(part => (part === '--read-only' ? '--rm' : part)), /--read-only is absent/],
    [argv => argv.map(part => (part === '10001:10001' ? '0:0' : part)), /--user 10001:10001 is absent/],
    [argv => argv.map(part => (part === 'none' ? 'bridge' : part)), /--network none is absent/],
    [argv => argv.map(part => (typeof part === 'string' ? part.replace(',readonly', '') : part)), /mount is not readonly/],
    [argv => [...argv.slice(0, 1), '--mount', 'type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock', ...argv.slice(1)], /docker socket/],
    [argv => [...argv.slice(0, 1), '-v', '/:/host', ...argv.slice(1)], /it uses -v/],
  ];
  for (const [weaken, expected] of weakenings) {
    assert.throws(() => assertNoEscape(weaken(sound)), error => {
      assert.match(error.message, /would not be sandboxed/);
      assert.match(error.message, expected);
      return true;
    }, `weakening matching ${expected} was not refused`);
  }
});

test('the flag list is frozen, and the measurement environment is the whole environment', () => {
  // Frozen so that weakening a flag is a diff to sandbox.mjs - a change to the receipt authority, which a
  // candidate may not make and a reviewer has to read - rather than a mutation at some call site.
  assert.equal(Object.isFrozen(SANDBOX_FLAGS), true);
  assert.throws(() => SANDBOX_FLAGS.push('--privileged'), TypeError);
  // THE WHOLE ENVIRONMENT, not the runner's minus a denylist: a denylist is a list somebody has to keep
  // complete, and the variable that matters is the one nobody added.
  assert.deepEqual(Object.keys(measurementEnv()).sort(), ['HOME', 'LANG', 'PATH', 'TMPDIR']);
  // HOME and TMPDIR both inside the controller-owned scratch, which is the only thing the measurement may
  // write. Anywhere else and a test fails on a read-only filesystem for a reason that is not about the test.
  assert.match(measurementEnv().TMPDIR, /^\/scratch\//);
  assert.match(measurementEnv().HOME, /^\/scratch\//);
  // NODE_OPTIONS only when the controller passes one, and this repository's suite does not need one.
  assert.equal('NODE_OPTIONS' in measurementEnv(), false);
  assert.equal(measurementEnv({ nodeOptions: '--max-old-space-size=4096' }).NODE_OPTIONS, '--max-old-space-size=4096');
});

// ---- 2. matrix fidelity ----------------------------------------------------------------------------------

test('a claim that adds a term, a test or a mutant the protected matrix does not require is refused by name', () => {
  const added = checkMatrixFidelity([TERM], [
    { id: TERM.id, control: { test_names: [...TERM.control.test_names, 'a test nobody required'] },
      killing_mutants: [{ name: TERM.mutants[0].name }, { name: 'a mutant nobody required' }] },
    { id: 'guard/a-term-nobody-required', control: { test_names: [] }, killing_mutants: [] },
  ]);
  const kinds = added.map(refusal => refusal.kind);
  assert.ok(kinds.includes('unrequired_term'), JSON.stringify(kinds));
  assert.ok(kinds.includes('unrequired_test'));
  assert.ok(kinds.includes('unrequired_mutant'));
  // BY NAME, each of them, because a refusal a reader cannot act on is a refusal nobody fixes.
  const detail = added.map(refusal => refusal.detail).join(' | ');
  assert.match(detail, /the claim names the term "guard\/a-term-nobody-required", which the protected matrix does not require/);
  assert.match(detail, /the claim names the test "a test nobody required"/);
  assert.match(detail, /the claim names the mutant "a mutant nobody required"/);
});

test('a claim that omits a term, a test or a mutant the protected matrix requires is refused by name', () => {
  const omittedMutant = checkMatrixFidelity([TERM], [{ id: TERM.id,
    control: { test_names: TERM.control.test_names }, killing_mutants: [] }]);
  assert.deepEqual(omittedMutant.map(refusal => refusal.kind), ['omitted_mutant']);
  assert.match(omittedMutant[0].detail, /the claim omits the mutant "the head comparison is removed"/);

  const omittedTest = checkMatrixFidelity([TERM], [{ id: TERM.id, control: { test_names: [] },
    killing_mutants: [{ name: TERM.mutants[0].name }] }]);
  assert.deepEqual(omittedTest.map(refusal => refusal.kind), ['omitted_test']);
  assert.match(omittedTest[0].detail, /the claim omits the test "the guard refuses a stale head"/);

  const omittedTerm = checkMatrixFidelity([TERM], []);
  assert.deepEqual(omittedTerm.map(refusal => refusal.kind), ['omitted_term']);
  assert.match(omittedTerm[0].detail, /the claim omits the term "guard\/refuses-a-stale-head"/);
});

test('a matrix refusal stops the term it names from being established, however the run went', async () => {
  const observed = await run({ candidateDir: candidate(),
    claim: { entries: [{ id: TERM.id, control: { test_names: TERM.control.test_names }, killing_mutants: [] }] } });
  const term = observed.terms[0];
  assert.equal(term.control.exit, 0, 'the control really passed');
  assert.equal(term.mutants[0].died, true, 'the required mutant really died');
  // And it still establishes nothing, because the claim did not name the mutant the matrix requires.
  assert.equal(term.established, false);
  assert.match(term.why_not.join(' | '), /the claim omits the mutant "the head comparison is removed"/);
  assert.equal(observed.matrix_fidelity.refused, true);
});

// ---- 3. fabricated output establishes nothing ------------------------------------------------------------

test('a candidate whose test body prints a complete, passing TAP run for its term establishes nothing', async () => {
  // The control file is REPLACED by one that asserts nothing and prints a fabricated run instead. The name the
  // claim rests on is declared, so the run really does execute a body with that name - it just does no work.
  const candidateDir = candidate({ 'test/guard.test.mjs': fs.readFileSync(path.join(FIXTURE, 'test/fabricating.test.mjs'), 'utf8') });
  const observed = await run({ candidateDir });
  const term = observed.terms[0];

  // THE FABRICATION IS IN THE BYTES, AND IT IS DIAGNOSTIC. The control run's own stream carries the forged
  // passing point - hashed exactly as faithfully as a reporter's line would be.
  assert.equal(term.control.exit, 0, 'a body that asserts nothing exits 0, which is the whole problem');
  assert.equal(term.runs[0].diagnostic_stream.authority, 'none: candidate output, kept for a human');

  // AND THE TERM IS NOT ESTABLISHED, because the mutation the controller applied itself did not kill a test
  // that tests nothing. This is the decisive assertion of the whole boundary.
  assert.equal(term.established, false);
  assert.equal(term.mutants[0].died, false);
  assert.equal(term.mutants[0].patch.applied, true, 'the mutation really was applied');
  assert.match(term.why_not.join(' | '),
    /the required mutant "the head comparison is removed" was not observed to die: the killing run exited 0, so this mutation survived every test the protected matrix requires to kill it/);
  assert.deepEqual(observed.established, []);
});

test('an honest control, measured the same way, IS established - so the boundary is not simply refusing everything', async () => {
  const observed = await run({ candidateDir: candidate() });
  const term = observed.terms[0];
  assert.equal(term.established, true);
  assert.deepEqual(term.why_not, []);
  assert.deepEqual(observed.established, [TERM.id]);
  // EVERY PER-TERM FIELD TRACES TO A SPECIFIC CONTROLLER-OBSERVED RUN.
  assert.equal(term.observed_by, 'controller');
  assert.equal(typeof term.control.run, 'string');
  assert.equal(term.mutants[0].killing_run, term.runs[1].run_id);
  assert.equal(term.runs.every(observedRun => observedRun.observed_by === 'controller'), true);
  assert.equal(term.runs.every(observedRun => Number.isInteger(observedRun.exit)), true);
  // The control run was scoped to the names the PROTECTED matrix gave, by the controller, and nothing else.
  assert.match(term.runs[0].argv.join(' '), /--test-name-pattern=\^\(\?:the guard refuses a stale head\)\$/);
});

// ---- 4. a mutant that does not die refuses its term by name ------------------------------------------------

test('a mutant whose anchor is no longer in the candidate refuses the term rather than passing it', async () => {
  // The candidate has changed the line the protected mutation was written against. The mutation cannot be
  // applied, so it cannot be observed to die - and a mutation that cannot be applied has measured nothing.
  const candidateDir = candidate({ 'src/guard.mjs':
    'export const allowsHead = (head, expected) => typeof head === "string" && head.length === 40 && expected === head;\n' });
  const observed = await run({ candidateDir });
  const term = observed.terms[0];
  assert.equal(term.control.exit, 0, 'the control still passes on the rewritten source');
  assert.equal(term.established, false);
  assert.equal(term.mutants[0].patch.applied, false);
  assert.match(term.why_not.join(' | '),
    /the protected mutation's anchor is not present in src\/guard\.mjs at this candidate/);
});

test('the controller refuses to measure at all without a scratch the measurement can write', async () => {
  // Chowning a directory to another uid needs root, which this process does not have and must not have. So
  // the caller prepares it and hands the path in; a controller that created it itself would own it as the
  // runner user, and every test needing a temporary file would fail for a reason that is not about the test.
  await assert.rejects(measure({ matrix: matrixWith([TERM]), scope: 'boundary', runners: RUNNERS,
    runnerKey: 'boundary', candidateDir: candidate(), scratchDir: fs.mkdtempSync(path.join(os.tmpdir(), 'no-scratch-')),
    image: IMAGE, claim: CLAIM, io: { exec: stubExec } }), /the controller was given no measurement scratch/);
});

test('a term the protected matrix requires no mutant for is not establishable, and says why', async () => {
  const observed = await run({ candidateDir: candidate(),
    terms: [{ ...TERM, mutants: [], establishable: false,
      not_establishable_because: 'the protected matrix requires no killing mutant for this control, so no controller-observed run can distinguish it from a control that asserts nothing' }],
    claim: { entries: [{ id: TERM.id, control: { test_names: TERM.control.test_names }, killing_mutants: [] }] } });
  assert.equal(observed.terms[0].established, false);
  assert.match(observed.terms[0].why_not.join(' | '), /requires no killing mutant for this control/);
});

// ---- the private overlay ------------------------------------------------------------------------------------

test('the overlay is private: patching it never touches the checkout the normal run is measured from', () => {
  const candidateDir = candidate();
  const before = fs.readFileSync(path.join(candidateDir, 'src/guard.mjs'));
  const overlayDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-overlay-'));
  fs.rmSync(overlayDir, { recursive: true, force: true });
  const applied = buildOverlay(candidateDir, overlayDir, TERM.mutants[0].patch);
  assert.equal(applied.applied, true);
  assert.notEqual(applied.before_sha256, applied.after_sha256);
  // The overlay really is mutated...
  assert.match(fs.readFileSync(path.join(overlayDir, 'src/guard.mjs'), 'utf8'), /^export const allowsHead = \(head, expected\) => typeof head/m);
  // ...and the checkout it was copied from is byte for byte what it was. The copy is by hard link, which is
  // what makes a matrix of overlays affordable - and is exactly why the patched file is unlinked before it is
  // rewritten, because writing through a hard link would rewrite the original.
  assert.deepEqual(fs.readFileSync(path.join(candidateDir, 'src/guard.mjs')), before);
  fs.rmSync(overlayDir, { recursive: true, force: true });
});

test('an ambiguous mutation is refused rather than applied to the first occurrence it finds', () => {
  const candidateDir = candidate({ 'src/guard.mjs':
    'export const a = (head, expected) => head === expected && true;\nexport const b = (head, expected) => head === expected && true;\n' });
  const overlayDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-overlay-')), 'o');
  const applied = buildOverlay(candidateDir, overlayDir, { file: 'src/guard.mjs', find: 'head === expected && ', replace: '' });
  assert.equal(applied.applied, false);
  assert.equal(applied.occurrences, 2);
  assert.match(applied.reason, /occurs 2 times in src\/guard\.mjs at this candidate, so which occurrence it names is undefined/);
});

// ---- the controller chooses the command, and no shell is involved ------------------------------------------

test('the runner command is split by the controller and its globs expanded against its own checkout', () => {
  const candidateDir = candidate();
  const argv = expandGlobs(runnerArgv(RUNNERS.runners.boundary.command), candidateDir);
  assert.equal(argv[0], '/usr/local/bin/node');
  // Every test file of the fixture, named one by one, in sorted order, prefixed with the read-only mount.
  assert.deepEqual(argv.slice(-3), ['/src/test/environment.test.mjs', '/src/test/fabricating.test.mjs', '/src/test/guard.test.mjs']);
  // A command whose text grew a shell metacharacter cannot become two commands, because nothing runs a shell.
  assert.equal(argv.some(part => part.includes(';')), false);
  assert.throws(() => runnerArgv('bash -c "rm -rf /"'), /this controller invokes node/);
});

test('a scoped run names its tests exactly, so a name carrying a regex metacharacter selects itself', () => {
  assert.equal(namePattern(['a.b*c']), '^(?:a\\.b\\*c)$');
  assert.ok(new RegExp(namePattern(['a.b*c'])).test('a.b*c'));
  assert.equal(new RegExp(namePattern(['a.b*c'])).test('axbbbc'), false);
  assert.equal(new RegExp(namePattern(['one'])).test('one and a half'), false);
});

// ---- the environment the measurement actually gets, measured from inside it --------------------------------

// THE ENV-STRIPPING CLAIM, MEASURED RATHER THAN ASSERTED. The fixture prints its own environment from inside
// the measurement, and this reads it back off the controller-owned pipe. `env -i` is enforced by the argv, and
// the argv is what runs - so this is real through the stub as well as through the container.
//
// WHAT IT DOES NOT SHOW, because the stub cannot: that uid 10001 could not write the controller's files even
// if it knew their paths, and that the source mount is read-only. Those are the kernel's and the container
// runtime's, and they are probed by measure-terms.mjs's preflight at the start of every real measurement -
// which refuses the run if any of them is writable.
test('inside the measurement the environment is exactly the allowlist, and GITHUB_OUTPUT is unset and absent', async () => {
  const candidateDir = candidate();
  let stream = '';
  const scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boundary-env-'));
  const measurementScratch = path.join(scratchDir, 'measurement');
  fs.mkdirSync(path.join(measurementScratch, 'tmp'), { recursive: true });
  const argv = assertNoEscape(sandboxArgv({ image: IMAGE, sourceDir: candidateDir, scratchDir: measurementScratch,
    argv: ['/usr/local/bin/node', '--test', '--test-reporter=tap', '/src/test/environment.test.mjs'] }));
  await stubExec(argv, chunk => { stream += chunk; });
  const report = JSON.parse(/PROBE (\{.*\})/.exec(stream)[1]);

  // THE WHOLE ENVIRONMENT, and it is the four names this authority chose plus the one node's own test runner
  // adds to the child it runs each test FILE in. NODE_TEST_CONTEXT is named explicitly rather than tolerated
  // by a pattern: the point of an allowlist is that every name in it was put there on purpose, and a check
  // that shrugs at unknown names is a denylist wearing an allowlist's clothes. measure-terms.mjs's preflight
  // probe runs `node -e` rather than `node --test`, so the environment it reports is exactly the four.
  assert.deepEqual(report.env, ['HOME', 'LANG', 'NODE_TEST_CONTEXT', 'PATH', 'TMPDIR']);
  // None of the channels that carried every previous defeat: no GITHUB_*, no ACTIONS_*, no RUNNER_*, no CI,
  // no token. The forger that beat the last two versions of this authority found $GITHUB_OUTPUT and
  // $CAPTURE_DIR in its own environment; there is nothing there to find.
  assert.deepEqual(report.env.filter(name => /^GITHUB_|^ACTIONS_|^RUNNER_|^CI$|^GH_|TOKEN|SECRET/i.test(name)), []);
  assert.equal(report.github_output, null);
  // HOME and TMPDIR are inside the controller-owned scratch the measurement may write, and nowhere else.
  const value = name => argv.find(part => String(part).startsWith(`${name}=`)).split('=')[1];
  assert.match(value('HOME'), /^\/scratch\//);
  assert.match(value('TMPDIR'), /^\/scratch\//);
  // The working directory is the READ-ONLY source mount. Asserted on the argv rather than on what the probe
  // reported: the stub runs the command on this host, so the cwd it observes is the host path the mount would
  // have pointed at. Which directory the container enters is a property of the invocation, and that is here.
  assert.equal(argv[argv.indexOf('--workdir') + 1], '/src');
  assert.match(report.cwd, new RegExp(`^${candidateDir}`), 'the stub ran the command in the mounted source');
  fs.rmSync(scratchDir, { recursive: true, force: true });
});
