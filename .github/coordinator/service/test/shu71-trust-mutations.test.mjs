import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { productionFixture } from './shu71-production-fixture.mjs';
import { ephemeralPublicSource } from '../../test/fixture/ephemeral-public-source.mjs';
import { trustChecks, journalCheck } from './shu71-trust-checks.mjs';
const keys = ephemeralPublicSource();
const cases = [
  ['NV1 installation omitted', 'production', 'verifyInstallation(spec);', '/* omitted */', 'installation'],
    // Anchor updated in place for the field comparison; name and assertion unchanged.
  ['NV2 transition readback omitted', 'production', "result.issueUpdate?.success === true && sameFixtureCard(await issue(t), target)", 'result.issueUpdate?.success === true', 'transition'],
  ['NV3 atomic file fsync omitted', 'production', 'f.fchmodSync(fd, mode); f.fsyncSync(fd);', 'f.fchmodSync(fd, mode);', 'durability'],
  ['NV5 active conflict bypassed', 'production', "if (active && active.activation_id !== id) return { ok: false", "if (false) return { ok: false", 'conflict'],
  ['NV6 owner signature bypassed', 'production', "verify(null, canonicalBytes(doc.payload, false), ownerKey, Buffer.from(doc.signature, 'base64'))", 'true', 'owner'],
  // Anchor updated in place for the retired-expiry observation; name and assertion unchanged.
  ['F1 receipt observation omitted', 'production', 'try { observeTeardown(); observeRetiredExpiry(); }', 'try { /* omitted */ }', 'receipt'],
  ['NV4 journal hash chain removed', 'journal', 'payload.seq === index && payload.previous === previous && sha256 === digest(JSON.stringify(payload))', 'payload.seq === index', 'hash'],
  ['journal previous link removed', 'journal', 'payload.previous === previous && ', '', 'link'],
  ['journal sequence removed', 'journal', 'payload.seq === index && ', '', 'sequence'],
  ['journal torn guard removed', 'journal', "!source || source.endsWith('\\n')", 'true', 'torn'],
  ['journal custody guard removed', 'journal', 'stat.isFile() && stat.uid === 0 && stat.nlink === 1 && !(stat.mode & 0o077)', 'true', 'custody'],
];
for (const [name, type, before, after, checkName] of cases) test(`trust mutation: ${name}`, async t => {
  const url = new URL(`../shu71-${type}.mjs`, import.meta.url), source = fs.readFileSync(url, 'utf8');
  const check = m => type === 'production' ? trustChecks[checkName](m.createShu71Production, productionFixture(t, keys)) : journalCheck(m.openActivationJournal, productionFixture(t, keys), checkName);
  await check(await import(url));
  assert.equal(source.split(before).length, 2, 'B4_UNIQUE_MUTATION');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-trust-mutant-')); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const target = path.join(root, 'mutant.mjs');
  fs.writeFileSync(target, source.replace(before, after).replace(/(from\s+)(['"])(\.{1,2}\/[^'"]+)\2/g, (_, p, q, r) => `${p}${q}${new URL(r, url).href}${q}`));
  const mutant = await import(pathToFileURL(target));
  await assert.rejects(async () => check(mutant), e => e.code === 'ERR_ASSERTION' && /B[124]_/.test(e.message), 'B4_NAMED_ASSERTION_KILL');
});
