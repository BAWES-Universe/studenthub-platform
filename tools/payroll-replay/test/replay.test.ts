import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { compareCells, fromLegacyFixture, parseCells } from '../src/replay.js';
import { main, isEntrypoint } from '../src/cli.js';
const fixturePath = path.resolve('docs/parity/bank-file-contract/fixtures.json');
const pack = JSON.parse(await readFile(fixturePath, 'utf8'));
const fixture = () => fromLegacyFixture(structuredClone(pack));
test('existing legacy fixture has 17 attributes, 2 rows and 30.130 KWD', () => {
  const a = fixture(), r = compareCells(a, a);
  assert.equal(a.column_attributes.length, 17); assert.equal(r.expectedTotalFils, '30130');
  assert.equal(r.exactRowCount, 2); assert.equal(r.status, 'PASS_SYNTHETIC_CELLS');
  assert.equal(r.productionReplay, false); assert.equal(r.nativeWorkbookFidelity, 'NOT_ESTABLISHED');
  assert.equal(r.bankAcceptance, 'UNKNOWN');
});
test('offsetting one-fils errors fail despite equal batch totals', () => {
  const a = fixture(); a.rows[0][11] = '10.126'; a.rows[1][11] = '20.004';
  const r = compareCells(fixture(), a); assert.equal(r.changedRowCount, 2); assert.equal(r.netDifferenceFils, '0'); assert.equal(r.status, 'FAIL_SYNTHETIC_CELLS');
});
test('beneficiary, bank and non-money fields are compared, not just total', () => {
  for (const index of [0, 1, 2, 4, 12, 13, 14, 16]) {
    const a = fixture(); a.rows[0][index] += ' changed'; assert.equal(compareCells(fixture(), a).changedRowCount, 1);
  }
});
test('missing, unexpected and reordered rows fail', () => {
  const a = fixture(); a.rows.pop(); assert.equal(compareCells(fixture(), a).missingRowCount, 1);
  const b = fixture(); b.rows[0][15] = 'S 999999'; assert.equal(compareCells(fixture(), b).unexpectedRowCount, 1);
  const c = fixture(); c.rows.reverse(); const r = compareCells(fixture(), c); assert.equal(r.exactRowCount, 2); assert.equal(r.orderMatches, false); assert.equal(r.status, 'FAIL_SYNTHETIC_CELLS');
});
test('duplicate identities are rejected before indexing', () => { const a = fixture(); a.rows[1][15] = a.rows[0][15]; assert.throws(() => parseCells(a), /DUPLICATE/); });
test('strict shape and unsupported scope are refused', () => {
  for (const mutation of [(a: any) => a.synthetic_only = false, (a: any) => a.header_values = ['invented'], (a: any) => a.extra = 1, (a: any) => a.rows[0].pop(), (a: any) => a.rows[0][10] = 'USD', (a: any) => a.rows = [], (a: any) => a.column_attributes.reverse()]) {
    const a = fixture(); mutation(a); assert.throws(() => parseCells(a));
  }
});
test('float, exponent, negative and sub-fils amounts are refused without rounding', () => {
  for (const value of [1.1, '1e3', '-1.000', '1.0005', 'NaN', '01.000']) { const a: any = fixture(); a.rows[0][11] = value; assert.throws(() => parseCells(a)); }
});
test('bad legacy provenance, duplicate format and wrong fixture totals refuse', () => {
  for (const mutation of [(a: any) => a.source_data_copied = true, (a: any) => a.formats.push(a.formats.find((f: any) => f.id === 'legacy-abk-workbook')), (a: any) => a.formats.find((f: any) => f.id === 'legacy-abk-workbook').total = '0.000']) {
    const a = structuredClone(pack); mutation(a); assert.throws(() => fromLegacyFixture(a));
  }
});
test('receipt contains no row identities or beneficiary/bank information', () => {
  const a = fixture(); const receipt = JSON.stringify(compareCells(a, a));
  for (const row of a.rows) for (const index of [1, 2, 13, 15]) assert.equal(receipt.includes(row[index]), false);
});
test('comparison preserves inputs and exact integer-fils arithmetic', () => {
  const a = fixture(); a.rows[0][11] = '999999999.999'; const before = JSON.stringify(a);
  assert.equal(compareCells(a, a).expectedTotalFils, '1000000020004'); assert.equal(JSON.stringify(a), before);
});
test('CLI returns 0/1/2 and never prints rejected input data', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'payroll-synthetic-'));
  const out: string[] = [], err: string[] = []; const candidate = path.join(dir, 'candidate.json');
  const run = () => main(['--synthetic-cells', fixturePath, candidate], s => out.push(s), s => err.push(s));
  try {
    await writeFile(candidate, JSON.stringify(fixture())); assert.equal(await run(), 0);
    const changed = fixture(); changed.rows[0][11] = '10.126'; await writeFile(candidate, JSON.stringify(changed)); assert.equal(await run(), 1);
    await writeFile(candidate, 'SECRET bad json'); assert.equal(await run(), 2); assert.equal(err.at(-1), 'PAYROLL_REPLAY_INPUT_REJECTED');
    assert.equal(JSON.stringify([...out, ...err]).includes('SECRET'), false);
    assert.equal(await main(['--staging'], () => {}, () => {}), 2);
    assert.equal(await main(['--synthetic-cells', fixturePath, path.join(dir, 'missing')], () => {}, () => {}), 2);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
test('entrypoint resolves symlink and spaces instead of silently skipping CLI', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'payroll entry '));
  try {
    const actual = path.join(dir, 'main.js'), link = path.join(dir, 'link.js'); await writeFile(actual, ''); await symlink(actual, link);
    assert.equal(await isEntrypoint(pathToFileURL(actual).href, link), true);
    assert.equal(await isEntrypoint(pathToFileURL(actual).href, undefined), false);
    assert.equal(await isEntrypoint(pathToFileURL(actual).href, path.join(dir, 'missing')), false);
  } finally { await rm(dir, { recursive: true, force: true }); }
});
