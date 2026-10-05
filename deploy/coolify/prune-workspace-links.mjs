import { readFileSync, rmSync, mkdirSync, symlinkSync } from 'node:fs';
import { resolve, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

// npm prune can omit a needed link or recreate an unused one. Reconcile both
// directions using manifest identities (including scopes), not directory names.
export function reconcileWorkspaceLinks(root, closure) {
  for (const { name } of closure.workspaces) rmSync(resolve(root, 'node_modules', name), { force: true });
  for (const { name, path } of closure.packages) {
    const link = resolve(root, 'node_modules', name);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(relative(dirname(link), resolve(root, path)), link);
  }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  reconcileWorkspaceLinks(process.cwd(), JSON.parse(readFileSync(process.argv[2], 'utf8')));
}
