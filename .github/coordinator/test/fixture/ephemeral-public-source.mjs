// Unit-test filesystem double only. Production has no injectable key loader.
// Ephemeral signing objects stay in memory; only their public half goes to /tmp.
import { mock, after } from 'node:test';
import { generateKeyPairSync } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { SHU71_PUBLIC_KEY_PATH } from '../../shu71-public-key.mjs';

export function ephemeralPublicSource() {
  const pair = generateKeyPairSync('ed25519');
  const root = fs.mkdtempSync('/tmp/shu71-public-test-');
  const file = path.join(root, 'public.pem');
  fs.writeFileSync(file, pair.publicKey.export({ type: 'spki', format: 'pem' }));
  const read = fs.readFileSync.bind(fs);
  mock.method(fs, 'readFileSync', (name, ...args) => read(name === SHU71_PUBLIC_KEY_PATH ? file : name, ...args));
  after(() => fs.rmSync(root, { recursive: true, force: true }));
  return pair;
}
