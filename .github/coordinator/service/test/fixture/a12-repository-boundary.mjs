// Verification-only boundary. Refusals are failures, never fabricated successes/skips.
import fs from 'node:fs';
import child from 'node:child_process';
import net from 'node:net';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
const preload = fileURLToPath(import.meta.url);
const root = process.env.L4_REPOSITORY_ROOT;
const deny = detail => { throw Object.assign(new Error(`L4_REPOSITORY_BOUNDARY: ${detail}`), { code: 'L4_REPOSITORY_BOUNDARY' }); };
const allowed = value => {
  if (typeof value === 'number' || value === undefined || value === null) return;
  const file = value instanceof URL ? fileURLToPath(value) : String(value);
  const absolute = path.resolve(file);
  if (absolute === '/dev/null' || absolute.startsWith('/tmp/') || absolute === root || absolute.startsWith(root + '/')) return;
  deny('filesystem ' + absolute);
};
for (const name of ['accessSync','openSync','readFileSync','writeFileSync','appendFileSync','statSync','lstatSync','realpathSync','readdirSync','readlinkSync','mkdirSync','rmSync','rmdirSync','unlinkSync','chmodSync','chownSync']) {
  const original = fs[name];
  fs[name] = function(file, ...args) { allowed(file); return original.call(this, file, ...args); };
}
for (const name of ['renameSync','copyFileSync','linkSync','symlinkSync']) {
  const original = fs[name];
  fs[name] = function(from, to, ...args) { allowed(from); allowed(to); return original.call(this, from, to, ...args); };
}
for (const name of ['access','open','readFile','writeFile','appendFile','stat','lstat','realpath','readdir','readlink','mkdir','rm','rmdir','unlink','chmod','chown']) {
  const original = fs.promises[name];
  fs.promises[name] = async function(file, ...args) { allowed(file); return original.call(this, file, ...args); };
}
function command(file, args, options = {}) {
  const base = path.basename(file);
  if (file !== process.execPath && base !== 'git') deny('command ' + file);
  const env = { ...(options.env ?? process.env), L4_REPOSITORY_ROOT: root,
    NODE_OPTIONS: `--import=${preload}`, GIT_ALLOW_PROTOCOL: 'file', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null' };
  if (base === 'git') args = ['-c', 'core.hooksPath=/dev/null', ...args];
  return [file, args, { ...options, env }];
}
for (const name of ['spawnSync','spawn','execFileSync']) {
  const original = child[name];
  child[name] = function(file, args = [], options = {}) { return original.apply(this, command(file, args, options)); };
}
const execFile = child.execFile;
child.execFile = function(file, args, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  return execFile.call(this, ...command(file, args, options), callback);
};
child.exec = child.execSync = () => deny('shell execution');
for (const name of ['connect','createConnection']) {
  const original = net[name];
  net[name] = function(...args) {
    const options = typeof args[0] === 'object' ? args[0] : { host: typeof args[1] === 'string' ? args[1] : 'localhost' };
    if (options.path) allowed(options.path);
    else if (options.host && !['localhost','127.0.0.1','::1'].includes(options.host)) deny('network');
    return original.apply(this, args);
  };
}
syncBuiltinESMExports();
