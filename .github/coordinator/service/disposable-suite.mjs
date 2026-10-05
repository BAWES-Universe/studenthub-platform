// Run as the bound service identity. Never chown, sudo, setpriv or change Git trust.
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { suiteBoundary, suiteIdentity, suiteGit, bindSuite } from './suite-runner-spec.mjs';
import { halt } from './host-suite-contract.mjs';

function locations(spec, io) {
  suiteIdentity(spec, io);
  if (!/^[a-z][a-z0-9-]{7,63}$/.test(spec.activation_id ?? '') ||
      !path.isAbsolute(spec.disposable_parent ?? '') || !path.isAbsolute(spec.source_checkout ?? '') ||
      path.resolve(spec.disposable_parent) !== spec.disposable_parent ||
      spec.checkout !== `${spec.disposable_parent}/${spec.activation_id}/checkout` ||
      spec.temp_dir !== `${spec.disposable_parent}/${spec.activation_id}/tmp`) halt('SHU251_SUITE_DISPOSABLE');
  const root = path.dirname(spec.checkout), evidence = `${spec.disposable_parent}/${spec.activation_id}.a12.json`;
  for (let current = spec.disposable_parent; ; current = path.dirname(current)) {
    const st = io.fs.lstatSync(current);
    if (!st.isDirectory() || st.isSymbolicLink() || (st.mode & 0o022) || !(st.mode & 0o001) ||
        (current === spec.disposable_parent && st.uid !== spec.service_uid)) halt('SHU251_SUITE_DISPOSABLE');
    if (current === '/') break;
  }
  const binding = createHash('sha256').update(JSON.stringify(spec)).digest('hex');
  return { root, evidence, binding };
}
function durable(file, receipt, io, initial = false) {
  const target = initial ? file : `${file}.next-${randomUUID()}`;
  const fd = io.fs.openSync(target, io.fs.constants.O_WRONLY | io.fs.constants.O_CREAT |
    io.fs.constants.O_EXCL | io.fs.constants.O_NOFOLLOW, 0o600);
  try { io.fs.writeFileSync(fd, JSON.stringify(receipt) + '\n'); io.fs.fsyncSync(fd); }
  finally { io.fs.closeSync(fd); }
  if (!initial) io.fs.renameSync(target, file);
  const dir = io.fs.openSync(path.dirname(file), io.fs.constants.O_RDONLY | io.fs.constants.O_DIRECTORY);
  try { io.fs.fsyncSync(dir); } finally { io.fs.closeSync(dir); }
}
const inode = stat => `${stat.dev}:${stat.ino}`;
export function createDisposableSuite(spec, io = suiteBoundary) {
  const { root, evidence, binding } = locations(spec, io);
  if (io.fs.existsSync(root) || io.fs.existsSync(evidence)) halt('SHU251_SUITE_DISPOSABLE');
  const receipt = { version: 'shu251-disposable-suite-v1', binding, root, state: 'creating', inode: null };
  durable(evidence, receipt, io, true);
  io.fs.mkdirSync(root, { mode: 0o755 });
  receipt.inode = inode(io.fs.lstatSync(root));
  durable(evidence, receipt, io);
  // Failure leaves custody outside the clone for the separately reviewed removal action.
  suiteGit(spec.source_checkout, ['clone', '--no-local', '--no-hardlinks', '--no-checkout', '--', spec.source_checkout, spec.checkout], io);
  suiteGit(spec.checkout, ['checkout', '--detach', spec.revision], io);
  io.fs.mkdirSync(spec.temp_dir, { mode: 0o755 });
  const bound = bindSuite(spec, io);
  receipt.state = 'ready'; receipt.identity = bound.identity; receipt.revision = spec.revision; receipt.tree = spec.tree;
  receipt.suite_binding = bound.binding;
  durable(evidence, receipt, io);
  return receipt;
}
export function verifyDisposableSuite(spec, io = suiteBoundary) {
  const { root, evidence, binding } = locations(spec, io);
  const st = io.fs.lstatSync(evidence), rootStat = io.fs.lstatSync(root);
  let receipt;
  try { receipt = JSON.parse(io.fs.readFileSync(evidence, 'utf8')); }
  catch { halt('SHU251_SUITE_DISPOSABLE'); }
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== spec.service_uid || (st.mode & 0o777) !== 0o600 ||
      !rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== spec.service_uid ||
      receipt.version !== 'shu251-disposable-suite-v1' || receipt.binding !== binding || receipt.root !== root ||
      receipt.inode !== inode(rootStat) || receipt.state !== 'ready') halt('SHU251_SUITE_DISPOSABLE');
  return receipt;
}
export function recordDisposableSuite(spec, result, io = suiteBoundary) {
  const receipt = verifyDisposableSuite(spec, io);
  const { evidence } = locations(spec, io);
  receipt.suite = result;
  durable(evidence, receipt, io);
  return receipt;
}
export function removeDisposableSuite(spec, io = suiteBoundary) {
  const { root, evidence, binding } = locations(spec, io);
  const st = io.fs.lstatSync(evidence);
  if (!st.isFile() || st.isSymbolicLink() || st.uid !== spec.service_uid || (st.mode & 0o777) !== 0o600) halt('SHU251_SUITE_DISPOSABLE');
  const receipt = JSON.parse(io.fs.readFileSync(evidence, 'utf8'));
  if (receipt.version !== 'shu251-disposable-suite-v1' || receipt.binding !== binding || receipt.root !== root ||
      !['creating', 'ready', 'removing', 'removed'].includes(receipt.state)) halt('SHU251_SUITE_DISPOSABLE');
  if (io.fs.existsSync(root)) {
    const rootStat = io.fs.lstatSync(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink() || rootStat.uid !== spec.service_uid ||
        inode(rootStat) !== receipt.inode || receipt.state === 'removed') halt('SHU251_SUITE_DISPOSABLE');
    receipt.state = 'removing'; durable(evidence, receipt, io);
    io.fs.rmSync(root, { recursive: true, force: false });
  }
  receipt.state = 'removed'; durable(evidence, receipt, io);
  return receipt;
}
