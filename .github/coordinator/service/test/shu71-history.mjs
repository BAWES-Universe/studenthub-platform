// Historical bytes are mandatory fixtures, even when Git history is absent.
import fs from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const fixtures = new URL('./fixtures/shu71-history/', import.meta.url);
const repo = new URL('../../../../', import.meta.url);
const fail = (code, detail) => { throw Object.assign(new Error(`${code}: ${detail}`), { code }); };
const digest = bytes => createHash('sha256').update(bytes).digest('hex');

export function historicalSource(revision, name) {
  const identity = `${revision}:.github/coordinator/service/${name}`;
  let manifest, bytes;
  try { manifest = JSON.parse(fs.readFileSync(new URL('sha256.json', fixtures), 'utf8')); }
  catch { fail('SHU71_HISTORY_MANIFEST', 'restore fixtures/shu71-history/sha256.json'); }
  const expected = manifest[revision]?.[name];
  if (!/^[a-f0-9]{64}$/.test(expected ?? ''))
    fail('SHU71_HISTORY_UNRESOLVED', `${identity}; vendor the historical bytes and record their SHA-256`);
  try { bytes = fs.readFileSync(new URL(`${revision}/${name}`, fixtures)); }
  catch { fail('SHU71_HISTORY_FIXTURE_MISSING', `${identity}; restore the checked-in historical fixture`); }
  if (digest(bytes) !== expected)
    fail('SHU71_HISTORY_DIGEST_MISMATCH', `${identity}; restore the historical bytes matching sha256.json`);

  const git = args => spawnSync('git', args, { cwd: repo, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_NO_LAZY_FETCH: '1' } });
  const available = git(['cat-file', '-e', `${revision}^{commit}`]);
  if (available.error || available.signal || ![0, 1, 128].includes(available.status))
    fail('SHU71_HISTORY_GIT_CHECK', `${identity}; ensure Git can inspect the local object database`);
  if (available.status === 0) {
    const historical = git(['show', identity]);
    if (historical.status !== 0)
      fail('SHU71_HISTORY_SOURCE_UNRESOLVED', `${identity}; restore this revision's source object`);
    if (digest(historical.stdout) !== expected || !bytes.equals(historical.stdout))
      fail('SHU71_HISTORY_GIT_MISMATCH', `${identity}; fixture and manifest must match the historical Git bytes`);
  }
  return bytes.toString('utf8');
}
