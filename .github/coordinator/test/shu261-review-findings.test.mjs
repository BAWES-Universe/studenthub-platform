import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { processCanaryMarker, runReviewEvidence, validateReviewWrapper } from '../review-execution.mjs';
import { inheritedDescriptorDenied, processInspectionDenied } from '../review-execution-child.mjs';
import { PROTECTED_CLASSES } from '../service/reviewer-isolation.mjs';
import { finalizeHostValidation } from '../service/reviewer-host-validation.mjs';

import { resolveCvtsudoers } from '../service/host-suite-contract.mjs';

const mutation = process.env.SHU261_MUTATION;
function source(relative) {
  const file = new URL(relative, import.meta.url);
  if (process.env.SHU261_BASELINE === 'true') {
    const relativePath = path.relative(process.cwd(), file.pathname);
    const run = spawnSync('git', ['show', `f3f89f5f50954eec8190ce69c46ba384fd603dae:${relativePath}`], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    return run.stdout;
  }
  return fs.readFileSync(file, 'utf8');
}
const keys = ['protected-paths-json', 'fd-canary', 'env-canary', 'process-canary'];
const valid = [JSON.stringify([{
  class: 'activation_records', path: '/protected',
  symlink_path: '/workspace/protected-link', traversal_path: '../protected',
}]),
  'SHU261_FD_0123456789abcdef0123456789abcdef', 'SHU261_ENV_0123456789abcdef0123456789abcdef', 'SHU261_PROCESS_0123456789abcdef0123456789abcdef'];

async function childProbe(overrides = {}, suppliedArgs = null) {
  let code = source('../review-execution-child.mjs');
  if (mutation?.startsWith('SHU261_CANARY_')) {
    const i = Number(mutation.at(-1));
    const controls = ['isolation.ok', 'fdDenied', 'environmentDenied', 'processDenied'];
    code = code.replace(`&& ${controls[i]}`, '&& true');
  }
  code = code.replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
  code = code.slice(0, code.indexOf('if (process.argv[1]'));
  const args = ['--cwd', '/workspace', '--expected-uid', '994', '--protected-path', '/protected',
    '--sibling-probe-path', '/sibling', '--probe-port', '1234', '--target-sha', '6'.repeat(40)];
  keys.forEach((key, i) => { const value = Object.hasOwn(overrides, key) ? overrides[key] : valid[i];
    if (value !== undefined) args.push(`--${key}`, value); });
  args.push('--', 'builder.test.mjs');
  let calls = 0, output = '';
  const builderRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'shu261-builder-'));
  const marker = path.join(builderRoot, 'ran');
  const builderTest = path.join(builderRoot, 'builder.test.mjs');
  fs.writeFileSync(builderTest, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'ran');`);
  const denied = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }); };
  const context = { PROTECTED_CLASSES, Buffer, Number, JSON, Object, String,
    fs: { constants: fs.constants, openSync: denied, writeFileSync: denied, readdirSync: () => [], statSync: () => ({ uid: 1000 }) },
    net: { createConnection: () => ({ once(event, cb) { if (event === 'error') queueMicrotask(cb); }, destroy() {}, setTimeout() {} }) },
    process: { argv: ['node', 'child', ...(suppliedArgs ?? args)], pid: 123, getuid: () => 994, env: {}, execPath: process.execPath,
      stdout: { write: (text) => { output += text; } } },
    spawnSync: () => { calls++; const env = { ...process.env }; delete env.NODE_TEST_CONTEXT; return spawnSync(process.execPath, ['--test', builderTest], { env, encoding: 'utf8' }); },
  };
  try {
    await vm.runInNewContext(`${code}\nmain()`, context);
    assert.equal(fs.existsSync(marker), calls === 1, 'SHU261_BUILDER_SIDE_EFFECT: real builder test must match invocation count');
    return { calls, report: JSON.parse(output), status: context.process.exitCode ?? 0 };
  } finally { fs.rmSync(builderRoot, { recursive: true, force: true }); }
}

for (const [i, key] of keys.entries()) test(`SHU261_CANARY_MISSING_MUST_FAIL_${i}: ${key}`, async () => {
  const positive = await childProbe();
  assert.equal(positive.calls, 1, 'SHU261_CANARY_POSITIVE: valid canaries must reach builder execution');
  for (const value of [undefined, '', 'unknown', i ? `SHU261_${['', 'FD', 'ENV', 'PROCESS'][i]}_unknown` : '[{"class":"unknown","path":"/protected"}]']) {
    const result = await childProbe({ [key]: value });
    console.log(`${key}=${String(value)} builder_calls=${result.calls} exit=${result.status}`);
    assert.equal(result.calls, 0, `SHU261_CANARY_MISSING_MUST_FAIL_${i}: ${key} must block builder execution`);
    assert.equal(result.report.tests.executed, false);
    assert.equal(result.status, 70);
  }
});

test('SHU261_CLEANUP_RUNS_ALL_CALLBACKS', async () => {
  const calls = [0, 0, 0]; let inventory = 0, caught;
  const finalize = mutation === 'SHU261_CLEANUP_RUNS_ALL_CALLBACKS'
    ? async ({ cleanupCallbacks, verifyInventory }) => {
      for (const callback of [...cleanupCallbacks].reverse()) await callback();
      await verifyInventory();
    }
    : finalizeHostValidation;
  const cleanupCallbacks = [
    () => { calls[0]++; }, () => { calls[1]++; }, () => { calls[2]++; throw new Error('early cleanup failure'); },
  ];
  try {
    await finalize({ cleanupCallbacks, verifyInventory: () => { inventory++; } });
  } catch (error) { caught = error; }
  console.log(`cleanup_calls=${JSON.stringify(calls)} inventory_calls=${inventory} error=${caught?.name}: ${caught?.message}`);
  assert.deepEqual(calls, [1, 1, 1], 'SHU261_CLEANUP_RUNS_ALL_CALLBACKS: every callback must run exactly once');
  assert.equal(inventory, 1, 'SHU261_CLEANUP_INVENTORY: final inventory must run after callback failure');
  assert.equal(caught?.name, 'AggregateError', 'SHU261_CLEANUP_AGGREGATE: report errors after every callback and inventory');
  assert.match(caught.errors[0].message, /early cleanup failure/);
  caught = undefined;
  const inventoryError = new Error('SHU261_HOST_WORKTREE: bounded validation must restore the exact worktree inventory');
  try {
    await finalize({
      cleanupCallbacks,
      verifyInventory: () => { inventory++; throw inventoryError; },
    });
  } catch (error) { caught = error; }
  assert.deepEqual(calls, [2, 2, 2], 'SHU261_CLEANUP_RUNS_ALL_CALLBACKS: inventory failure cannot skip callbacks');
  assert.equal(inventory, 2);
  assert.equal(caught.errors.length, 2, 'SHU261_CLEANUP_INVENTORY: retain callback and inventory failures');
  assert.equal(caught.errors[1].name, 'Error');
  assert.equal(caught.errors[1], inventoryError, 'SHU261_CLEANUP_INVENTORY_IDENTITY: retain the exact inventory error unchanged');
  assert.match(caught.errors[1].message, /SHU261_HOST_WORKTREE: bounded validation must restore the exact worktree inventory/);

});

function parsedReviewerPolicy(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu261-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let policy = source('../service/shu-reviewer.sudoers');
  if (mutation === 'SHU261_NO_SETENV') policy = policy.replace('NOPASSWD:NOSETENV:', 'NOPASSWD:SETENV:');
  if (mutation === 'SHU261_OAUTH_ENV_KEEP') policy = policy.replace('env_keep += "CLAUDE_CODE_OAUTH_TOKEN"', 'env_keep += "UNRELATED"');
  const file = path.join(root, 'sudoers'); fs.writeFileSync(file, policy);
  const resolved = resolveCvtsudoers(root, undefined, file);
  assert.equal(resolved.available, true, 'SHU251_SUITE_PARSER_REQUIRED');
  const config = resolved.parsed;
  const options = config.User_Specs[0].Cmnd_Specs[0].Options;
  const setenv = options.some((option) => option.setenv === true);
  const keep = config.Defaults.filter((entry) => entry.Binding.some((binding) => binding.command === '/usr/local/libexec/shu-reviewer-sandbox'))
    .flatMap((entry) => entry.Options.flatMap((option) => option.env_keep ?? []));
  return { root, options, setenv, keep };
}

test('SHU261_NO_SETENV_POLICY', (t) => {
  const { options, keep } = parsedReviewerPolicy(t);
  assert.ok(options.some((option) => option.setenv === false), 'SHU261_NO_SETENV: command-spec must carry NOSETENV');
  assert.ok(!options.some((option) => Object.hasOwn(option, 'setenv') && option.setenv !== false),
    'SHU261_NO_SETENV: command-spec must not carry a SETENV option');
  assert.deepEqual(keep, ['CLAUDE_CODE_OAUTH_TOKEN'], 'SHU261_OAUTH_ENV_KEEP: command-specific env_keep must preserve only OAuth');
});

// Option A: the former namespace-root startup technique is replaced by
// SHU261_NO_SETENV_POLICY above, SHU261 wrapper contract, and
// SHU261 root wrapper startup ignores PATH and BASH_ENV before parsing in
// shu261-reviewer-isolation.test.mjs. The real sudo/EUID-0 proof belongs to M3.

test('SHU261_CALLER_CANARIES: real caller supplies live canaries to loaded child', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu261-caller-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const attempt = '26126126-1261-4261-8261-261261261261';
  const workspace = path.join(root, attempt), evidence = path.join(root, 'evidence');
  fs.mkdirSync(workspace, { mode: 0o750 }); fs.mkdirSync(evidence, { mode: 0o700 });
  for (const omitted of [null, ...keys]) {
    let observed, processCanaryStarted, callerError;
    const result = await runReviewEvidence({ attempt_id: attempt, target_sha: '6'.repeat(40), cwd: workspace,
      env: { SHU_REVIEW_EXEC_UID: '994', SHU_REVIEW_EXEC_WRAPPER_JSON: '["/test/wrapper"]',
        SHU_REVIEW_MODEL_WRAPPER_JSON: '["/test/wrapper"]', SHU_REVIEW_TEST_FILES_JSON: '["builder.test.mjs"]', SHU_REVIEW_EVIDENCE_DIR: evidence },
      validateWrapperImpl: (wrapper) => wrapper,
      startProcessCanaryImpl: async (canary) => {
        processCanaryStarted = canary;
        return processCanaryMarker(canary);
      },
      listenProbeImpl: async () => ({ address: () => ({ port: 26123 }), close: (done) => done() }),
      execFileImpl: (_file, args, options, done) => {
        (async () => {
          const get = (key) => args[args.indexOf(`--${key}`) + 1];
          keys.forEach((key, i) => assert.ok(args.includes(`--${key}`), `SHU261_CALLER_CANARY_${i}: caller must supply ${key}`));
          assert.equal(fs.readFileSync(get('protected-path'), 'utf8'), get('fd-canary'));
          assert.equal(inheritedDescriptorDenied(get('fd-canary')), false, 'SHU261_CALLER_FD: open source descriptor must be live before confinement');
          await t.test(`wrapper environment contains probe canary; omitted child option=${omitted}`, () => {
            assert.equal(options.env.SHU261_ENV_CANARY, get('env-canary'),
              'SHU261_CALLER_ENVIRONMENT: wrapper environment must contain the exact canary supplied to the child probe');
          });
          assert.equal(processInspectionDenied(get('process-canary')), false,
            'SHU261_CALLER_PROCESS_VISIBLE: real marker must be observable before confinement');
          assert.equal(processCanaryStarted, get('process-canary'),
            'SHU261_CALLER_PROCESS: caller must start the exact process canary passed to the child');
          const childArgs = args.slice(args.indexOf('--cwd'));
          if (omitted) childArgs.splice(childArgs.indexOf(`--${omitted}`), 2);
          // The VM substitutes confined OS responses, but executes the loaded
          // production child predicates and builder phase unchanged.
          observed = await childProbe({}, childArgs);
          done(observed.status ? new Error('child refused') : null, JSON.stringify(observed.report), '');
        })().catch((error) => { callerError = error; done(error); });
      },
    });
    assert.ifError(callerError);
    assert.ok(observed, `SHU261_CALLER_CANARIES: ${result.detail ?? 'callback must reach loaded child'}`);
    assert.equal(observed.calls, omitted ? 0 : 1, `SHU261_CALLER_${omitted}: builder invocation count`);
    assert.equal(result.executed, !omitted);
  }
});

test('SHU261_MODEL_ARGV: contract pins length 3 and sandbox index 2', () => {
  const stat = { uid: 0, mode: 0o755, isFile: () => true, isDirectory: () => true, isSymbolicLink: () => false };
  const fsImpl = { realpathSync: (file) => file, lstatSync: () => stat };
  const expected = ['/usr/bin/sudo', '-n', '/usr/local/libexec/shu-reviewer-sandbox'];
  const actual = validateReviewWrapper(expected, fsImpl, { model: true });
  assert.deepEqual(actual, expected, 'SHU261_MODEL_ARGV: exact command form');
  assert.equal(actual.length, 3, 'SHU261_MODEL_ARGV_LENGTH: length must be 3');
  assert.equal(actual[2], expected[2], 'SHU261_MODEL_ARGV_INDEX: sandbox must be index 2');
  assert.throws(() => validateReviewWrapper([expected[0], '-n', '--preserve-env=CLAUDE_CODE_OAUTH_TOKEN', expected[2]], fsImpl, { model: true }), /fixed .*noninteractive/);
  for (const file of ['../SINGLE-RUN-ACTIVATION.md', '../../../docs/SHU-63-activation-contract.md']) {
    const doc = source(file);
    assert.ok(doc.includes(JSON.stringify(expected)), 'SHU261_MODEL_DOC: activation instructions must pin the same argv');
    assert.doesNotMatch(doc, /--preserve-env=CLAUDE_CODE_OAUTH_TOKEN/);
  }
});

import {
  reviewFindingsFromCallback, reviewFindingsContext, validReviewFindings,
  REVIEW_FINDINGS_SUMMARY_MAX, REVIEW_FINDINGS_CONTEXT_BYTES_MAX,
} from '../review-findings.mjs';

const truncationMarker = '\n[review summary truncated]';
const blockedFindings = (summary, links = []) =>
  reviewFindingsFromCallback({ stage: 'BLOCKED', target_sha: 'a'.repeat(40), summary, links });

test('feedback truncation: exact cap is intact, one over is visibly shortened', () => {
  assert.equal(REVIEW_FINDINGS_SUMMARY_MAX, 4000);
  assert.equal(REVIEW_FINDINGS_CONTEXT_BYTES_MAX, 16384);
  const exact = 'a'.repeat(4000);
  assert.equal(blockedFindings(exact).summary, exact);
  const over = blockedFindings(exact + 'b');
  assert.equal(over.summary, 'a'.repeat(4000 - truncationMarker.length) + truncationMarker);
  assert.equal(over.summary.length, 4000);
  assert.equal(validReviewFindings(over), true);
  assert.deepEqual(Object.keys(over).sort(), ['links', 'summary', 'target_sha', 'verdict_stage']);
});

test('feedback truncation: supplementary characters stay whole at both cuts', () => {
  const cut = 4000 - truncationMarker.length;
  for (const lead of [cut - 1, cut, cut + 1, 3999]) {
    const text = 'a'.repeat(lead) + '😀' + 'b'.repeat(100);
    const result = blockedFindings(text);
    assert.equal(result.summary.isWellFormed(), true);
    assert.ok(result.summary.endsWith(truncationMarker));
    assert.ok(text.startsWith(result.summary.slice(0, -truncationMarker.length)));
    assert.ok(result.summary.length <= 4000);
    assert.equal(validReviewFindings(result), true);
  }
  // The escaped-byte budget cuts independently of the UTF-16 length cap.
  const result = blockedFindings('<'.repeat(2000) + '😀'.repeat(1000));
  assert.ok(result.summary.endsWith(truncationMarker));
  assert.equal(result.summary.isWellFormed(), true);
  assert.equal(validReviewFindings(result), true);
});

test('feedback truncation: escaped-byte budget preserves the marker and redaction', () => {
  for (const char of ['<', '\u0001']) {
    const result = blockedFindings(char.repeat(4000), ['safe/path']);
    assert.deepEqual(result.links, [], 'trailing citations still go before summary text');
    assert.ok(result.summary.endsWith(truncationMarker));
    const context = reviewFindingsContext({ scope_phase: 'revision', review_findings: result });
    const encoded = context.match(/<review-findings>(.*)<\/review-findings>/)[1];
    assert.ok(Buffer.byteLength(JSON.stringify(encoded)) <= 16384);
    assert.equal(validReviewFindings(result), true);
  }
  const secret = 'ghp_' + 'x'.repeat(36);
  assert.equal(blockedFindings('a'.repeat(4001) + secret), null, 'redact before cutting, even for a secret beyond the cap');
  assert.equal(reviewFindingsFromCallback({ stage: 'PASS', summary: 'x'.repeat(4001) }), null);
});

test('feedback truncation: replay a recorded mid-sentence review through serialized revision context', () => {
  // Recorded terminal review receipt, comment 2714e393-dba3-4787-bcce-3d68d2033e6d.
  // Only the already-capped prefix is available. The continuation below is
  // deliberately synthetic, not a claim to have recovered the missing text.
  const recorded = {"verdict_stage":"BLOCKED","target_sha":"98b3c7718c68dfb146dcf34ab50c12e4f9e16d43","summary":"BLOCKED: the card's own acceptance suite contains three assertions that contradict the code at the bound head, which also disables the mutation script, and the required real-wiring proof is absent.\n\nD1 (item 1, OCRP_LINE): test/civil-id-suggestion-http.test.ts:13 asserts exactly 19 `data-state=\"unavailable\"` markers, but the rig projection at test:9 supplies 22 unavailable fields ([...OWN_PROFILE_FIELD_NAMES, \"phone\", \"handle\", \"kuwaitiMother\"]) and profileDocument renders a row for each (summary jobSearchStatus 1 + work 3 + personal 11 + background 1 + details 6 = 22), with the marker stamped per unavailable field at web-ui.ts:378. The 19/19 figure holds only for the real repository projection (test/web-ui.test.ts:285). Fix: drop phone/handle/kuwaitiMother from the rig projection.\n\nD2 (Review OCRP_ROWS): test:35 pins ids.slice(0,19) without `kuwaitiMother`, but web-ui.ts:405 includes the kuwaitiMother row whenever profile.fields.kuwaitiMother exists, which the same rig provides; actual index 12 is \"kuwaitiMother\", so the deepEqual fails.\n\nD3 (item 2, OCRP_ACCEPT): test:19 asserts the 409 body matches /changed since you opened/, but the handler writes CIVIL_ID_MESSAGES.stale_revision = \"Your civil ID details changed. Review them and try again.\" (civil-id-suggestion-http.ts:56, packages/profile/src/civil-id.ts:10); the /changed since you opened/ wording belongs to error.conflict/editor.conflict in ui/profile-copy.ts:28,177 and pageDocument (web-ui.ts:111-118) adds nothing.\n\nD4 (item 7): civil-id-suggestion-mutations.mjs:19 asserts `control.status === 0` before writing each mutant and selects tests with `--test-name-pattern=^OCRP_LINE `, which includes the test failing under D1, so the script aborts on its first control run and reports no KILLED line; the OCRP_ACCEPT control fails likewise under D3. `npm test` therefore cannot run to the end.\n\nD5 (Review OCRP_SEAM / OCRP_GATE): every test builds the gateway from a hand-written login object (test:10, `createGatewayServer(undefined, undefined, undefined, login as never)`) and CIVIL_ID_ENCRYPTION_KEY appears in no gateway test, so the real apps/gateway/src/wiring/profile.ts path (wiring/profile.ts:38-45,135) is never exercised, the session is not made by the real login path, and the counting store sits behind a fake login. The carried-forward faults state explicitly that OCRP_SEAM must not hand-build login and that OCRP_GATE must run through the real wiring with the key set.\n\nSound and not to be redone: route registration and order (routes/index.ts:33-37,67; test/routes-order.test.ts:21,23 bumped to 29 in place), the single suggestion read gated on requesterPrincipalId captured before the readOwn projection with a throwing read rendering no line and a foreign person_id making zero reads (index.ts:362,379-382), secrecy shape (last-four only, hidden field carries the suggestion id, exactly one vault.open in the service's open method), the status model (409 for stale/answered/replaced/foreign, submissionRecorded -> 303 on a finished retry, nothing_to_save -> resolve + 303, both raced accepts 303 with one CIV write), profile-copy.ts untouched so U1_COPY stays correct, and no edits to the OCR store or CIV store.\n\nAdvisory, non-blocking: index.ts has three edited regions (:346, :358-362, :379-384) and renames the existing const requesterPrincipalId where the brief allows one contiguous block; web-ui.ts has four edited regions against \"exactly two edits\"; the item-5 mutant mutates only the sec-fetch-site clause rather than the Origin equality and no mutant targets web-ui.js; the 403 branch does not request.resume() unlike civil-id-http.ts:20; OCRP_SECRECY greps one .ts file by a cwd-relative path and no test proves \"no store call\" for the no-session POST.\n\nMethod note: the confined evidence payload records tests.executed=false (whole-tree card, no build in the runner) and I am read-only, so D1-D4 are derived by reading the code paths and counting rendered rows, not from an executed run; a","links":["file:///srv/shu/state/reviewer-evidence/3b800e05-2257-47bf-873a-07bf73a40004.review-test.1.json","apps/gateway/test/civil-id-suggestion-http.test.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:9","apps/gateway/test/civil-id-suggestion-http.test.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:13","apps/gateway/test/civil-id-suggestion-http.test.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:19","apps/gateway/test/civil-id-suggestion-http.test.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:35","apps/gateway/test/civil-id-suggestion-http.test.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:10","apps/gateway/test/civil-id-suggestion-http.test.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:30","apps/gateway/test/civil-id-suggestion-http.test.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:36","apps/gateway/src/web-ui.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:378","apps/gateway/src/web-ui.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:405","apps/gateway/src/web-ui.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:337","apps/gateway/src/web-ui.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:404","apps/gateway/src/civil-id-suggestion-http.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:56","apps/gateway/src/civil-id-suggestion-http.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:49","packages/profile/src/civil-id.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:10","apps/gateway/src/ui/profile-copy.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:177","apps/gateway/test/civil-id-suggestion-mutations.mjs@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:19","apps/gateway/test/web-ui.test.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:285","apps/gateway/src/wiring/profile.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:38-45","apps/gateway/src/index.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:379-384","apps/gateway/src/index.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:358-362","apps/gateway/src/routes/index.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:33-37","apps/gateway/test/routes-order.test.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:21-23","packages/db/src/profile/index.ts@98b3c7718c68dfb146dcf34ab50c12e4f9e16d43:5-6"]};
  assert.equal(recorded.summary.length, 4000);
  assert.ok(recorded.summary.endsWith('not from an executed run; a'));
  const callback = { stage: 'BLOCKED', target_sha: recorded.target_sha,
    summary: recorded.summary + ' [synthetic continuation beyond the recorded cap]', links: recorded.links };
  const findings = reviewFindingsFromCallback(callback);
  assert.equal(findings.target_sha, recorded.target_sha);
  assert.equal(findings.verdict_stage, 'BLOCKED');
  assert.deepEqual(findings.links, recorded.links);
  assert.ok(findings.summary.endsWith(truncationMarker));
  assert.ok(findings.summary.startsWith("BLOCKED: the card's own acceptance suite"));
  assert.match(findings.summary, /D5 \(Review OCRP_SEAM/);
  const receipt = { scope_phase: 'revision', review_findings: findings };
  const context = reviewFindingsContext(JSON.parse(JSON.stringify(receipt)));
  assert.equal(context, reviewFindingsContext(structuredClone(receipt)), 'retry renders identical findings');
  const rendered = JSON.parse(context.match(/<review-findings>(.*)<\/review-findings>/)[1]);
  assert.equal(rendered.summary, findings.summary);
  assert.deepEqual(rendered.links, findings.links);
  assert.equal(reviewFindingsContext({ ...receipt, scope_phase: 'review' }), '');
  // Existing receipts cannot retroactively reveal whether they were truncated.
  assert.equal(reviewFindingsFromCallback({ ...callback, summary: recorded.summary }).summary, recorded.summary);
});
