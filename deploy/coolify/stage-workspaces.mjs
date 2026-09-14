import { cpSync, mkdirSync, readFileSync } from 'node:fs';
import { resolve, relative, isAbsolute } from 'node:path';

// npm ci validates this lockfile against the source manifests. Preserve every
// linked workspace, including its built output and runtime assets. Keeping the
// complete workspace costs some image space but avoids an asset allowlist too.
const root = process.cwd();
const destination = process.argv[2];
if (!destination) throw new Error('workspace staging destination is required');
const lock = JSON.parse(readFileSync('package-lock.json', 'utf8'));
const workspaces = [...new Set(Object.values(lock.packages)
  .filter(entry => entry.link).map(entry => entry.resolved))].sort();
if (!workspaces.length) throw new Error('no locked workspaces found');
for (const workspace of workspaces) {
  const path = relative(root, resolve(workspace));
  if (!path || path.startsWith('..') || isAbsolute(path)) {
    throw new Error(`workspace must be inside the build context: ${workspace}`);
  }
  // Fail the build if a locked workspace is missing its manifest.
  readFileSync(resolve(path, 'package.json'));
  mkdirSync(resolve(destination, path, '..'), { recursive: true });
  cpSync(path, resolve(destination, path), { recursive: true, verbatimSymlinks: true });
}
