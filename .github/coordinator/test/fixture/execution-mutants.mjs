// Each mutant lives only in a disposable copy; the working clone is never mutated.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export function killExecutionMutant(kind, mode, pattern, testFile) {
  const root = fs.mkdtempSync('/tmp/shu71-execution-mutant-');
  try {
    fs.cpSync(new URL('../../', import.meta.url), root, { recursive: true });
    const edits = [];
    if (kind === 'MISSING_BINDING') {
      edits.push(['execution-authorization.mjs', "return 'ACT_EXECUTION_BINDING_MISSING'", 'return null']);
      edits.push(mode === 'PACKAGE'
        ? ['shu71-activation-package.mjs', '&& SHA.test(pkg.coordinator_revision ?? "")', '&& true']
        : ['two-fixture-activation.mjs', "!SHA.test(record.coordinator_revision ?? '') ||", '']);
    } else if (kind === 'WRONG_REVISION') {
      edits.push(['execution-authorization.mjs', "if (!SHA.test(mainRevision ?? '') || record.coordinator_revision !== mainRevision)", 'if (false)']);
    } else if (kind === 'CHECKOUT_DRIFT') {
      edits.push(['execution-authorization.mjs', "if (!SHA.test(revision ?? '') || revision !== record.coordinator_revision)", 'if (false)']);
    } else if (kind === 'FOREIGN_KEY') {
      edits.push(['shu71-public-key.mjs', 'suppliedPem === undefined || suppliedPem === pem', 'true']);
    } else if (kind === 'EXPIRED_AUTHORIZATION') {
      edits.push(mode === 'PACKAGE'
        ? ['shu71-activation-package.mjs', '(phase === "revocation" || expiry > at)', 'true']
        : ['two-fixture-activation.mjs', 'expiry <= at ||', '']);
    } else { assert.fail(`unknown mutation ${kind}`); }
    const { NODE_TEST_CONTEXT, ...env } = process.env;
    for (const [file, from, to] of edits) {
      const target = path.join(root, file), source = fs.readFileSync(target, 'utf8');
      assert.equal(source.split(from).length, 2, `${pattern}: unique guard`);
      fs.writeFileSync(target, source.replace(from, to));
      const syntax = spawnSync(process.execPath, ['--check', target], { env, encoding: 'utf8' });
      assert.equal(syntax.status, 0, `${pattern}: node --check must pass: ${syntax.stderr}`);
    }
    const run = spawnSync(process.execPath, ['--test', `--test-name-pattern=^${pattern}:`, path.join(root, 'test', testFile)],
      { env, encoding: 'utf8', timeout: 30000 });
    const output = run.stdout + run.stderr;
    assert.equal(run.status, 1, `${pattern}: mutant must fail: ${output}`);
    assert.match(output, /failureType: 'testCodeFailure'/, `${pattern}: test assertion required: ${output}`);
    assert.match(output, /code: 'ERR_ASSERTION'/, `${pattern}: assertion code required: ${output}`);
    assert.ok(output.includes(`${pattern}: authorization must refuse`), `${pattern}: named assertion required: ${output}`);
    assert.doesNotMatch(output, /SyntaxError|TypeError|ERR_MODULE_NOT_FOUND|ERR_MODULE/, `${pattern}: load errors are not kills`);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
}
