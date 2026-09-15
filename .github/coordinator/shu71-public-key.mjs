import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

// Absolute within the running checkout; never an operator-selected host file.
export const SHU71_PUBLIC_KEY_PATH = fileURLToPath(new URL('./shu71-activation-public-key.pem', import.meta.url));

export function loadShu71PublicKey(publicKeyPath = SHU71_PUBLIC_KEY_PATH, suppliedPem) {
  assert.ok(typeof publicKeyPath === 'string'
    && /^\/[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)*$/.test(publicKeyPath)
    && !publicKeyPath.split('/').some(segment => segment === '.' || segment === '..')
    && publicKeyPath === SHU71_PUBLIC_KEY_PATH,
  'ACT_PUBLIC_KEY_PATH: exact committed absolute public-key path required');
  let pem;
  try {
    assert.ok(fs.lstatSync(publicKeyPath).isFile() && !fs.lstatSync(publicKeyPath).isSymbolicLink(),
      'ACT_PUBLIC_KEY_PATH: regular committed public-key file required');
    pem = fs.readFileSync(publicKeyPath, 'utf8');
  } catch {
    assert.fail('ACT_PUBLIC_KEY_PATH: committed public-key file missing or unreadable');
  }
  assert.ok(suppliedPem === undefined || suppliedPem === pem,
    'ACT_TRUST_ANCHOR_MISMATCH: supplied public key differs from the committed source');
  return pem;
}
