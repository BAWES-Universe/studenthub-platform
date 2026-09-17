import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createShu71Production } from '../shu71-production.mjs';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
import { gateRecoveryCheck, serviceRecoveryCheck, retirementWindowCheck, activationRecoveryCheck, onceOnlyRestoreCheck, boundedReplayCheck } from './shu71-recovery-checks.mjs';
const keys = ephemeralPublicSource();
for (const [name, before, after, check, target = 'journal', assertion = /B4_/] of [
  ['gate DONE suppresses repair', "['gate', 'activation', 'workers', 'reload', 'evidence-broker']", "['activation', 'workers', 'reload', 'evidence-broker']", gateRecoveryCheck],
  ['broker DONE suppresses repair', "'reload', 'evidence-broker'", "'reload'", serviceRecoveryCheck],
  ['service DONE suppresses repair', " || step.startsWith('stop-')", '', (create, h) => serviceRecoveryCheck(create, h, 'shu-supervisor.service')],
  ['P1 retirement re-observation removed', '        observeTeardown();\n        command', '        command', retirementWindowCheck, 'production', /B4_RETIREMENT_REOBSERVATION/],
  ['P4 activation DONE suppresses repair', "'gate', 'activation', 'workers'", "'gate', 'workers'", activationRecoveryCheck, 'journal', /B4_ACTIVATION_DRIFT_RECOVERED/],
  ['P5 all effects repeat', 'effect, repeat);', 'effect, true);', onceOnlyRestoreCheck, 'journal', /B4_RESTORES_ONCE_ONLY/],
  ['P3 automatic budget removed', 'if (attempts >= 32)', 'if (false)', boundedReplayCheck, 'production', /B4_AUTOMATIC_REPLAY_BOUNDED/],
]) test(`recovery mutation: ${name}`, async t => {
  await check(createShu71Production, productionFixture(t, keys));
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-recovery-mutant-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const journalUrl = new URL('../shu71-journal.mjs', import.meta.url);
  const url = new URL('../shu71-production.mjs', import.meta.url);
  const source = fs.readFileSync(target === 'journal' ? journalUrl : url, 'utf8');
  assert.equal(source.split(before).length, 2, 'B4_UNIQUE_MUTATION');
  fs.writeFileSync(path.join(root, 'journal.mjs'), target === 'journal' ? source.replace(before, after) : fs.readFileSync(journalUrl, 'utf8'));
  const production = (target === 'production' ? source.replace(before, after) : fs.readFileSync(url, 'utf8')).replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g,
    (_, p, q, r) => `${p}${q}${r === './shu71-journal.mjs' ? pathToFileURL(path.join(root, 'journal.mjs')).href : new URL(r, url).href}${q}`);
  fs.writeFileSync(path.join(root, 'production.mjs'), production);
  const mutant = await import(pathToFileURL(path.join(root, 'production.mjs')));
  await assert.rejects(() => check(mutant.createShu71Production, productionFixture(t, keys)),
    e => e.code === 'ERR_ASSERTION' && assertion.test(e.message), 'B4_NAMED_ASSERTION_KILL');
});
