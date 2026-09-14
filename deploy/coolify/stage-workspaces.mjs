import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { resolve, relative, dirname, isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import ts from 'typescript';

const json = path => JSON.parse(readFileSync(path, 'utf8'));
export const forbidden = path => /(^|\/)(test|tests|__tests__|fixtures|tools|docs)(\/|$)|\.(?:ts|tsx|map)$|\.(?:test|spec)\.[cm]?js$/.test(path);
function files(root) {
  return readdirSync(root, { withFileTypes: true }).flatMap(entry => {
    const path = resolve(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`runtime files must not be symlinks: ${path}`);
    return entry.isDirectory() ? files(path) : [path];
  });
}

// Fixed point, seeded only by the processes in gateway-entrypoint.sh. Lockfile
// links discover workspace identities, never grant runtime membership. For each
// reached workspace follow dependencies (not devDependencies), then parse emitted
// JS imports/exports, literal import()/require(), and new URL(..., import.meta.url)
// worker references. Relative edges discover workspaces omitted from manifests
// and non-workspace code (observability). Type-only imports have already vanished.
// Keep iterating both queues until neither grows; sort the result for repeatability.
export function runtimeClosure(root, entries = ['dist/apps/gateway/src/index.js', 'packages/db/dist/migrate.js']) {
  const lock = json(resolve(root, 'package-lock.json'));
  const workspaces = new Map();
  for (const entry of Object.values(lock.packages).filter(entry => entry.link)) {
    const path = relative(root, resolve(root, entry.resolved));
    if (!path || path.startsWith('..') || isAbsolute(path)) throw new Error(`invalid workspace: ${entry.resolved}`);
    const manifest = json(resolve(root, path, 'package.json'));
    workspaces.set(manifest.name, { path, manifest });
  }
  if (!workspaces.size) throw new Error('no locked workspaces found');
  const packages = new Set(), code = new Set(), pending = [...entries];
  function include(name) {
    if (packages.has(name) || !workspaces.has(name)) return;
    packages.add(name);
    const { path, manifest } = workspaces.get(name);
    for (const dependency of Object.keys(manifest.dependencies ?? {})) include(dependency);
    // Only public runtime entrypoints grant further authority, not arbitrary
    // unused modules emitted alongside them (e.g. a maintenance CLI).
    function exports(value) {
      if (typeof value === 'string') {
        if (value.includes('*')) throw new Error(`unsupported runtime export pattern: ${name} ${value}`);
        pending.push(relative(root, resolve(root, path, value)));
      } else if (value && typeof value === 'object') {
        for (const [condition, target] of Object.entries(value)) {
          if (!['types', 'browser', 'development'].includes(condition)) exports(target);
        }
      }
    }
    if (manifest.exports) exports(manifest.exports);
    else if (manifest.main) exports(manifest.main);
    else if (existsSync(resolve(root, path, 'index.js'))) exports('./index.js');
  }
  include(json(resolve(root, 'apps/gateway/package.json')).name);
  while (pending.length) {
    const file = pending.pop();
    if (code.has(file)) continue;
    if (file.startsWith('..') || isAbsolute(file) || (/(^|\/)src\//.test(file) && !file.startsWith('dist/')) || forbidden(file) || !/\.[cm]?js$/.test(file)) throw new Error(`invalid runtime code: ${file}`);
    code.add(file);
    for (const [name, { path }] of workspaces) {
      if (file.startsWith(`${path}/`) || file.startsWith(`dist/${path}/`)) include(name);
    }
    const source = ts.createSourceFile(file, readFileSync(resolve(root, file), 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    function edge(value) {
      if (value.startsWith('.')) pending.push(relative(root, resolve(root, dirname(file), value)));
      else include(value.startsWith('@') ? value.split('/').slice(0, 2).join('/') : value.split('/')[0]);
    }
    function visit(node) {
      if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier) edge(node.moduleSpecifier.text);
      if (ts.isCallExpression(node) && (node.expression.kind === ts.SyntaxKind.ImportKeyword || node.expression.getText(source) === 'require')) {
        if (!node.arguments[0] || !ts.isStringLiteralLike(node.arguments[0])) throw new Error(`nonliteral runtime import in ${file}`);
        edge(node.arguments[0].text);
      }
      if (ts.isNewExpression(node) && node.expression.getText(source) === 'URL' && node.arguments?.[1]?.getText(source) === 'import.meta.url') {
        if (!ts.isStringLiteralLike(node.arguments[0])) throw new Error(`nonliteral runtime URL in ${file}`);
        edge(node.arguments[0].text);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
  return { packages: [...packages].sort().map(name => ({ name, path: workspaces.get(name).path })), code: [...code].sort(), workspaces: [...workspaces.values()].map(({ path, manifest }) => ({ path, name: manifest.name })) };
}

export function stage(root, destination) {
  const closure = runtimeClosure(root);
  mkdirSync(destination, { recursive: true });
  const copy = file => {
    mkdirSync(dirname(resolve(destination, file)), { recursive: true });
    cpSync(resolve(root, file), resolve(destination, file));
  };
  for (const { path } of closure.packages) copy(`${path}/package.json`);
  for (const file of closure.code) copy(file);
  // migrate.js reads ../migrations/*.sql. No general asset glob or package files
  // field can authorize credentials, fixtures, or arbitrary repository material.
  const assets = [];
  if (closure.code.includes('packages/db/dist/migrate.js')) {
    for (const file of files(resolve(root, 'packages/db/migrations'))) {
      if (!file.endsWith('.sql')) throw new Error(`unexpected migration asset: ${file}`);
      const path = relative(root, file); copy(path); assets.push(path);
    }
    if (!assets.length) throw new Error('runtime migrations must not be empty');
  }
  // npm prune retains links for unused workspaces. Remove those links before COPY
  // so excluded packages cannot become runtime authority or dangle in the image.
  for (const { name } of closure.workspaces) {
    if (!closure.packages.some(pkg => pkg.name === name)) rmSync(resolve(root, 'node_modules', name), { force: true });
  }
  // External production packages may need JS under src/ (debug, OpenTelemetry).
  // Remove only development file classes, keeping their published runtime JS.
  function clean(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (forbidden(relative(root, path))) rmSync(path, { recursive: true, force: true });
      else if (entry.isDirectory()) clean(path);
    }
  }
  clean(resolve(root, 'node_modules'));
  writeFileSync(resolve(destination, 'runtime-closure.json'), JSON.stringify({ ...closure, assets }, null, 2) + '\n');
  return closure;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  if (!process.argv[2]) throw new Error('workspace staging destination is required');
  stage(process.cwd(), resolve(process.argv[2]));
}
