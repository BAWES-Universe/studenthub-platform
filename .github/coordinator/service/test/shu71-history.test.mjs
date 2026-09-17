import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { historicalSource } from './shu71-history.mjs';

test('historical custody validates all six recorded sources', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('./fixtures/shu71-history/sha256.json', import.meta.url)));
  let count = 0;
  for (const [revision, files] of Object.entries(manifest)) for (const name of Object.keys(files)) {
    assert.ok(historicalSource(revision, name).length > 0); count++;
  }
  assert.equal(count, 6);
});

test('historical custody refuses an unrecorded revision with an actionable error', () => {
  assert.throws(() => historicalSource('0'.repeat(40), 'shu71-production.mjs'),
    { code: 'SHU71_HISTORY_UNRESOLVED' });
});

test('historical custody detects fixture drift and coordinated manifest drift against Git', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-custody-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const dir = path.join(root, '.github/coordinator/service/test');
  fs.mkdirSync(dir, { recursive: true });
  fs.copyFileSync(new URL('./shu71-history.mjs', import.meta.url), path.join(dir, 'shu71-history.mjs'));
  const git = args => execFileSync('git', args, { cwd: root, env: { ...process.env, GIT_DIR: path.join(root, '.git'), GIT_WORK_TREE: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init']);
  fs.writeFileSync(path.join(dir, '../shu71-production.mjs'), 'historical bytes');
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '-m', 'historical fixture']);
  const revision = git(['rev-parse', 'HEAD']).toString().trim();
  const fixtures = path.join(dir, 'fixtures/shu71-history');
  fs.mkdirSync(path.join(fixtures, revision), { recursive: true });
  const file = path.join(fixtures, revision, 'shu71-production.mjs');
  const record = bytes => fs.writeFileSync(path.join(fixtures, 'sha256.json'), JSON.stringify({ [revision]: {
    'shu71-production.mjs': createHash('sha256').update(bytes).digest('hex')
  } }));
  fs.writeFileSync(file, 'historical bytes'); record('historical bytes');
  const { historicalSource: read } = await import(pathToFileURL(path.join(dir, 'shu71-history.mjs')));
  assert.equal(read(revision, 'shu71-production.mjs'), 'historical bytes');
  fs.writeFileSync(file, 'drift');
  assert.throws(() => read(revision, 'shu71-production.mjs'), { code: 'SHU71_HISTORY_DIGEST_MISMATCH' });
  record('drift');
  assert.throws(() => read(revision, 'shu71-production.mjs'), { code: 'SHU71_HISTORY_GIT_MISMATCH' });
  fs.rmSync(file);
  assert.throws(() => read(revision, 'shu71-production.mjs'), { code: 'SHU71_HISTORY_FIXTURE_MISSING' });
});
