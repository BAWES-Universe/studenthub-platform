import assert from 'node:assert/strict';
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

export function assertImageContent(root = '/app') {
  const closure = JSON.parse(readFileSync(resolve(root, 'runtime-closure.json'), 'utf8'));
  assert.ok(closure.packages.length > 1 && closure.code.length > 1 && closure.assets.length > 0, 'IMAGE_CONTENT_NONEMPTY: closure, code and migrations must be populated');
  const allowed = new Set([...closure.code, ...closure.assets, ...closure.packages.map(pkg => `${pkg.path}/package.json`)]);
  const inventory = { typescript: 0, maps: 0, tests: 0, sourceDirectoriesOutsideBuiltOutput: 0, danglingWorkspaceLinks: 0 };
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name), file = relative(root, path);
      if (entry.isSymbolicLink()) {
        if (closure.workspaces.some(pkg => file === `node_modules/${pkg.name}`) || /^node_modules\/@(?:studenthub|bawes)\//.test(file)) {
          if (!existsSync(path)) inventory.danglingWorkspaceLinks++;
          else assert.ok(realpathSync(path).startsWith(root + '/'), 'IMAGE_CONTENT_LINK_TARGET: workspace links stay in the image');
        }
        continue;
      }
      if (entry.isDirectory()) {
        // These are emitted JS paths, not source trees. Published third-party JS
        // also uses src/ (debug and OpenTelemetry); required runtime exceptions.
        if (entry.name === 'src' && !file.startsWith('dist/') && !file.startsWith('node_modules/')) inventory.sourceDirectoriesOutsideBuiltOutput++;
        walk(path);
      } else {
        if (/\.(ts|tsx)$/.test(file)) inventory.typescript++;
        if (/\.map$/.test(file)) inventory.maps++;
        if (/(^|\/)(test|tests|__tests__|fixtures)(\/|$)|\.(test|spec)\.[cm]?js$/.test(file)) inventory.tests++;
        if (/^(apps|packages|tools|dist)\//.test(file)) assert.ok(allowed.has(file), `IMAGE_CONTENT_BOUNDED: unexpected first-party file ${file}`);
      }
    }
  }
  walk(root);
  assert.deepEqual(inventory, { typescript: 0, maps: 0, tests: 0, sourceDirectoriesOutsideBuiltOutput: 0, danglingWorkspaceLinks: 0 }, 'IMAGE_CONTENT_CLASSES: no TypeScript, source maps, tests, source trees or dangling workspace links');
  // Derive membership independently of closure.packages: a workspace must own a
  // reached built file. This catches a forged/over-inclusive package inventory.
  for (const { name, path } of closure.workspaces) {
    const reached = closure.code.some(file => file.startsWith(`${path}/`) || file.startsWith(`dist/${path}/`));
    const staged = existsSync(resolve(root, path, 'package.json'));
    assert.ok(!staged || reached, `CLOSURE_DECLARED_BUT_UNIMPORTED: staged workspace is not reachable: ${name}`);
    assert.ok(!reached || staged, `CLOSURE_REACHABLE_NOT_STAGED: IMAGE_CONTENT_COMPLETE: reachable workspace is not staged: ${name}`);
    const link = resolve(root, 'node_modules', name);
    assert.ok(!staged || existsSync(link), `CLOSURE_STAGED_NOT_LINKED: staged workspace has no resolution path: ${name}`);
    assert.ok(!existsSync(link) || reached, `CLOSURE_LINKED_NOT_REFERENCED: linked workspace is not reachable: ${name}`);
  }
  for (const file of allowed) assert.ok(existsSync(resolve(root, file)), `IMAGE_CONTENT_COMPLETE: missing ${file}`);
  for (const { name, path } of closure.workspaces) {
    const included = closure.packages.some(pkg => pkg.name === name);
    assert.equal(existsSync(resolve(root, path, 'package.json')), included, `IMAGE_CONTENT_EXACT_CLOSURE: ${name}`);
    const link = resolve(root, 'node_modules', name);
    if (included) {
      assert.ok(lstatSync(link).isSymbolicLink(), `IMAGE_CONTENT_WORKSPACE_LINK: ${name}`);
      assert.equal(realpathSync(link), resolve(root, path), `IMAGE_CONTENT_WORKSPACE_TARGET: ${name}`);
    } else assert.equal(existsSync(link), false, `IMAGE_CONTENT_NO_UNUSED_AUTHORITY: ${name}`);
  }
  return inventory;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) console.log('PASS: IMAGE_CONTENT', JSON.stringify(assertImageContent()));
