import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { runMintControls, repositoryControls, mintControlName } from './mint-shu71-controls.mjs';
test(mintControlName, () => runMintControls());
test('SHU71 mint actual Git derivation and named remote mutations', () => repositoryControls());
test('SHU71 mint source mutants die at named assertions', t => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-mint-mutants-'));
  t.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
  const moduleURL = new URL('../mint-shu71-package.mjs', import.meta.url);
  const controlURL = new URL('./mint-shu71-controls.mjs', import.meta.url);
  const absolutize = (text, base) => text.replace(/from (['"])(\.[^'"]+)\1/g, (_, q, spec) => `from ${q}${new URL(spec, base).href}${q}`);
  const original = absolutize(fs.readFileSync(moduleURL, 'utf8'), moduleURL);
  // controls use import.meta.url for the repository root: retain that authority.
  const controls = absolutize(fs.readFileSync(controlURL, 'utf8'), controlURL).replace('new URL(\'../../../../\', import.meta.url)', `new URL('../../../../', ${JSON.stringify(controlURL.href)})`);
  const mutants = [
    ['revision guard removed', 'MINT_REVISION', 'stale revision'],
    ['unused ID guard removed', 'MINT_ID_REUSED', 'reused activation'],
    ['unknown ID guard removed', 'MINT_ID_UNKNOWN', 'unknown activation'],
    ['fixture guard removed', 'MINT_FIXTURES', 'fixture substitution'],
    ['lineage guard removed', 'MINT_LINEAGE', 'rewritten parent'],
    ['patch guard removed', 'MINT_PATCH', 'patch digest'],
    ['evidence guard removed', 'MINT_EVIDENCE', 'evidence escape'],
    ['signature guard removed', 'MINT_SIGNATURE', 'package signature'],
    ['agreement guard removed', 'MINT_DISAGREEMENT', 'spec disagreement'],
    ['determinism guard removed', 'MINT_NONDETERMINISTIC', 'nondeterministic timestamp'],
    ['required field guard removed', 'MINT_REQUIRED', 'omitted required field'],
    ['commands guard removed', 'MINT_COMMANDS', 'driver commands'],
    ['ledger digest guard removed', 'MINT_ID_LEDGER_DIGEST', 'ledger digest'],
    ['expiry guard removed', 'MINT_EXPIRY', 'expiry exceeds twelve hours'],
  ];
  const modulePath = path.join(tmp, 'mint.mjs'), runner = path.join(tmp, 'control.mjs');
  fs.writeFileSync(runner, controls.replace(moduleURL.href, new URL(`file://${modulePath}`).href) + '\nrunMintControls();\n');
  const run = () => spawnSync(process.execPath, [runner], { encoding: 'utf8', timeout: 30000 });
  fs.writeFileSync(modulePath, original);
  assert.equal(run().status, 0, 'MINT_MUTATION_POSITIVE');
  for (const [name, code, assertion] of mutants) {
    const text = original.replace('if (!ok) throw', `if (code === '${code}') return; if (!ok) throw`);
    assert.notEqual(text, original, 'MINT_MUTATION_APPLIED');
    fs.writeFileSync(modulePath, text);
    const out = run();
    assert.notEqual(out.status, 0, `${name}: survived`);
    assert.ok(out.stderr.includes('AssertionError') && out.stderr.includes(`${assertion}: ${code}`), `${name}: wrong death ${out.stderr}`);
  }
  fs.writeFileSync(modulePath, original.replace('created_at: new Date(at).toISOString()', 'created_at: new Date(now).toISOString()'));
  const random = run();
  assert.notEqual(random.status, 0, 'clock-dependent output: survived');
  assert.ok(random.stderr.includes('MINT_IDENTICAL_REPEATS'), 'clock-dependent output: named determinism assertion');
});
