import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { runtimeClosure } from './stage-workspaces.mjs';

// Compare the built gateway/migrator closure, not unrelated workspace sources.
// Revision metadata is intentionally excluded: it must not turn a docs merge into a deployment.
export function runtimeFingerprint(root) {
  const closure = runtimeClosure(root);
  const files = new Set([
    ...closure.code, ...closure.packages.map(({ path }) => `${path}/package.json`),
    'Dockerfile', '.dockerignore', 'package.json', 'package-lock.json',
    ...['gateway-entrypoint.sh', 'preflight.mjs', 'assert-image-content.mjs', 'stage-workspaces.mjs', 'prune-workspace-links.mjs'].map((file) => `deploy/coolify/${file}`),
  ]);
  if (closure.code.includes('packages/db/dist/migrate.js')) {
    for (const file of readdirSync(resolve(root, 'packages/db/migrations'))) files.add(`packages/db/migrations/${file}`);
  }
  const hash = createHash('sha256');
  hash.update(JSON.stringify(closure));
  for (const file of [...files].sort()) hash.update(file + '\0').update(readFileSync(resolve(root, file))).update('\0');
  return hash.digest('hex');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) console.log(runtimeFingerprint(resolve(process.argv[2] ?? '.')));
