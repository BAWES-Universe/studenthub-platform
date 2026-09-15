import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { runReviewEvidence, validateReviewWrapper } from '../review-execution.mjs';
import { inheritedDescriptorDenied, processInspectionDenied } from '../review-execution-child.mjs';
import { PROTECTED_CLASSES } from '../service/reviewer-isolation.mjs';

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
const valid = [JSON.stringify([{ class: 'activation_records', path: '/protected' }]),
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
  let code = source('../service/reviewer-host-validation.mjs');
  if (mutation === 'SHU261_CLEANUP_RUNS_ALL_CALLBACKS') code = code.replace('try { await remove(); } catch (error) { cleanupErrors.push(error); }', 'await remove();');
  const start = code.lastIndexOf('  } finally {');
  const end = code.indexOf('  return evidence;', start);
  assert.ok(start > 0 && end > start, 'loaded cleanup region must be found');
  const region = `{{${code.slice(start + '  } finally {'.length, end)}}`;
  const calls = [0, 0, 0]; let inventory = 0, caught;
  const context = { assert, server: null, markerProcess: null, cleanup: [
    () => { calls[0]++; }, () => { calls[1]++; }, () => { calls[2]++; throw new Error('early cleanup failure'); },
  ], worktreesBefore: { stdout: 'original inventory' }, GIT: 'git', REPO: '/unused',
  spawnSync: () => { inventory++; return { status: 0, stdout: 'original inventory', stderr: '' }; } };
  try { await vm.runInNewContext(`(async () => ${region})()`, context); } catch (error) { caught = error; }
  console.log(`cleanup_calls=${JSON.stringify(calls)} inventory_calls=${inventory} error=${caught?.name}: ${caught?.message}`);
  assert.deepEqual(calls, [1, 1, 1], 'SHU261_CLEANUP_RUNS_ALL_CALLBACKS: every callback must run exactly once');
  assert.equal(inventory, 1, 'SHU261_CLEANUP_INVENTORY: final inventory must run after callback failure');
  assert.equal(caught?.name, 'AggregateError', 'SHU261_CLEANUP_AGGREGATE: report errors after every callback and inventory');
  assert.match(caught.errors[0].message, /early cleanup failure/);
  context.spawnSync = () => { inventory++; return { status: 0, stdout: 'leaked worktree', stderr: '' }; };
  try { await vm.runInNewContext(`(async () => ${region})()`, context); } catch (error) { caught = error; }
  assert.deepEqual(calls, [2, 2, 2], 'SHU261_CLEANUP_RUNS_ALL_CALLBACKS: inventory failure cannot skip callbacks');
  assert.equal(inventory, 2);
  assert.equal(caught.errors.length, 2, 'SHU261_CLEANUP_INVENTORY: retain callback and inventory failures');
  assert.equal(caught.errors[1].name, 'AssertionError');
  assert.match(caught.errors[1].message, /SHU261_HOST_WORKTREE: bounded validation must restore the exact worktree inventory/);

});

test('SHU261_NO_SETENV: parsed policy controls real wrapper startup and preserves OAuth', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu261-policy-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let policy = source('../service/shu-reviewer.sudoers');
  if (mutation === 'SHU261_NO_SETENV') policy = policy.replace('NOPASSWD:NOSETENV:', 'NOPASSWD:SETENV:');
  if (mutation === 'SHU261_OAUTH_ENV_KEEP') policy = policy.replace('env_keep += "CLAUDE_CODE_OAUTH_TOKEN"', 'env_keep += "UNRELATED"');
  const file = path.join(root, 'sudoers'); fs.writeFileSync(file, policy);
  const parsed = spawnSync('/usr/bin/cvtsudoers', ['-f', 'json', file], { encoding: 'utf8' });
  assert.equal(parsed.status, 0, parsed.stderr);
  const config = JSON.parse(parsed.stdout);
  const options = config.User_Specs[0].Cmnd_Specs[0].Options;
  const setenv = options.find((option) => Object.hasOwn(option, 'setenv')).setenv;
  const keep = config.Defaults.filter((entry) => entry.Binding.some((binding) => binding.command === '/usr/local/libexec/shu-reviewer-sandbox'))
    .flatMap((entry) => entry.Options.flatMap((option) => option.env_keep ?? []));
  const marker = path.join(root, 'startup');
  const bashEnv = path.join(root, 'bash-env');
  fs.writeFileSync(bashEnv, `printf '%s' "$(id -u):$CLAUDE_CODE_OAUTH_TOKEN" > '${marker}'\n`);
  // Model only sudo's environment admission using its real parsed policy. Execute
  // the unmodified wrapper as namespace root, with no arguments: it exits before
  // locks, ACLs, /srv access or systemd. This is not a deployed sudo integration test.
  const supplied = { BASH_ENV: bashEnv, CLAUDE_CODE_OAUTH_TOKEN: 'local-oauth-canary' };
  const env = { PATH: '/usr/bin:/bin' };
  for (const [key, value] of Object.entries(supplied)) if (setenv || keep.includes(key)) env[key] = value;
  const wrapper = new URL('../reviewer-sandbox.sh', import.meta.url).pathname;
  const result = spawnSync('/usr/bin/unshare', ['--user', '--map-root-user', '/bin/bash', wrapper], { env, encoding: 'utf8' });
  assert.equal(result.status, 64, result.stderr);
  const observed = fs.existsSync(marker) ? fs.readFileSync(marker, 'utf8') : null;
  console.log(`parsed_setenv=${setenv} namespace_root_startup=${observed} oauth_preserved=${env.CLAUDE_CODE_OAUTH_TOKEN === supplied.CLAUDE_CODE_OAUTH_TOKEN}`);
  assert.equal(observed, null, 'SHU261_NO_SETENV: uncontrolled BASH_ENV must not execute in privileged wrapper startup');
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, supplied.CLAUDE_CODE_OAUTH_TOKEN, 'SHU261_OAUTH_ENV_KEEP: command-specific env_keep must preserve OAuth');
  assert.deepEqual(keep, ['CLAUDE_CODE_OAUTH_TOKEN']);
});


test('SHU261_CALLER_CANARIES: real caller supplies live canaries to loaded child', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu261-caller-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const attempt = '26126126-1261-4261-8261-261261261261';
  const workspace = path.join(root, attempt), evidence = path.join(root, 'evidence');
  fs.mkdirSync(workspace, { mode: 0o750 }); fs.mkdirSync(evidence, { mode: 0o700 });
  for (const omitted of [null, ...keys]) {
    let observed;
    const result = await runReviewEvidence({ attempt_id: attempt, target_sha: '6'.repeat(40), cwd: workspace,
      env: { SHU_REVIEW_EXEC_UID: '994', SHU_REVIEW_EXEC_WRAPPER_JSON: '["/test/wrapper"]',
        SHU_REVIEW_MODEL_WRAPPER_JSON: '["/test/wrapper"]', SHU_REVIEW_TEST_FILES_JSON: '["builder.test.mjs"]', SHU_REVIEW_EVIDENCE_DIR: evidence },
      validateWrapperImpl: (wrapper) => wrapper,
      execFileImpl: (_file, args, options, done) => {
        (async () => {
          const get = (key) => args[args.indexOf(`--${key}`) + 1];
          keys.forEach((key, i) => assert.ok(args.includes(`--${key}`), `SHU261_CALLER_CANARY_${i}: caller must supply ${key}`));
          assert.equal(fs.readFileSync(get('protected-path'), 'utf8'), get('fd-canary'));
          assert.equal(inheritedDescriptorDenied(get('fd-canary')), false, 'SHU261_CALLER_FD: open source descriptor must be live before confinement');
          assert.equal(options.env.SHU261_ENV_CANARY, get('env-canary'));
          assert.equal(processInspectionDenied(get('process-canary')), false, 'SHU261_CALLER_PROCESS: live marker must be visible before confinement');
          const childArgs = args.slice(args.indexOf('--cwd'));
          if (omitted) childArgs.splice(childArgs.indexOf(`--${omitted}`), 2);
          // The VM substitutes confined OS responses, but executes the loaded
          // production child predicates and builder phase unchanged.
          observed = await childProbe({}, childArgs);
          done(observed.status ? new Error('child refused') : null, JSON.stringify(observed.report), '');
        })().catch((error) => done(error));
      },
    });
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
  assert.throws(() => validateReviewWrapper([expected[0], '-n', '--preserve-env=CLAUDE_CODE_OAUTH_TOKEN', expected[2]], fsImpl, { model: true }), /fixed noninteractive/);
  for (const file of ['../SINGLE-RUN-ACTIVATION.md', '../../../docs/SHU-63-activation-contract.md']) {
    const doc = source(file);
    assert.ok(doc.includes(JSON.stringify(expected)), 'SHU261_MODEL_DOC: activation instructions must pin the same argv');
    assert.doesNotMatch(doc, /--preserve-env=CLAUDE_CODE_OAUTH_TOKEN/);
  }
});
