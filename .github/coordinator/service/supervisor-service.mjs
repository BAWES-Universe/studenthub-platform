// Host lifecycle composition of the merged SHU-250 interface. No installation.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DurableSupervisor, listenSupervisor } from '../supervisor.mjs';
import { createSupervisorSpawner } from '../supervisor-worker.mjs';

export function probeProcess(run) {
  try {
    const stat = fs.readFileSync(`/proc/${run.pid}/stat`, 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] === run.process_token;
  } catch (error) { return error.code === 'ENOENT' ? false : null; }
}

export function notifyReady() {
  const result = spawnSync('/usr/bin/systemd-notify', ['--ready', `--pid=${process.pid}`], { encoding: 'utf8' });
  assert.ok(!result.error && result.status === 0, 'SHU251_READINESS: systemd readiness notification must succeed');
}

export async function startSupervisor({ stateDir, socketPath, secret, env = process.env,
  spawnWorker = createSupervisorSpawner({ stateDir, env }), ready = notifyReady } = {}) {
  assert.ok(stateDir?.startsWith('/') && socketPath?.startsWith('/'), 'SHU251_SUPERVISOR_PATH: absolute state and socket paths required');
  // Refuse stale or occupied sockets before recovery can schedule any work.
  assert.ok(!fs.existsSync(socketPath), 'SHU251_SUPERVISOR_SOCKET: occupied or stale socket requires operator inspection');
  const parent = fs.lstatSync(dirname(socketPath));
  assert.ok(parent.isDirectory() && !parent.isSymbolicLink() && parent.uid === process.getuid() && !(parent.mode & 0o077), 'SHU251_SUPERVISOR_PATH: private owned socket parent required');
  assert.ok((typeof secret === 'string' || Buffer.isBuffer(secret)) && Buffer.byteLength(secret) >= 32,
    'SHU251_SUPERVISOR_SECRET: SHU_SUPERVISOR_SECRET must contain at least 32 bytes');
  let stopping = false;
  const supervisor = new DurableSupervisor({ stateDir, secret, spawnWorker, probeProcess });
  const launch = supervisor.launch.bind(supervisor);
  supervisor.launch = id => stopping || env.ENABLE_DISPATCH !== 'true' ? undefined : launch(id);
  const submit = supervisor.submit.bind(supervisor);
  supervisor.submit = request => stopping ? { ok: false, stage: 'HOLD', reason: 'supervisor stopping' }
    : request.operation !== 'status' && env.ENABLE_DISPATCH !== 'true'
      ? { ok: false, stage: 'HOLD', reason: 'dispatch disabled' } : submit(request);
  supervisor.recover();
  const server = await listenSupervisor({ supervisor, socketPath });
  const clients = new Set();
  server.on('connection', socket => { clients.add(socket); socket.once('close', () => clients.delete(socket)); });
  let stopped;
  const stop = ({ terminateChildren = false } = {}) => {
    if (stopped) return stopped;
    stopping = true; // Also blocks already queued launches before closing IPC.
    supervisor.shutdown({ terminateChildren });
    stopped = new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve());
      for (const socket of clients) socket.destroy();
    });
    return stopped;
  };
  try { await ready(); } catch (error) { await stop(); throw error; }
  return { supervisor, server, stop };
}

// Read-only inventory: include all durable trees, orphan launches, branch claims,
// temporary files and unknown entries. Never construct SupervisorStore here (it chmods).
export function supervisorState(stateDir) {
  const walk = root => {
    const stat = fs.lstatSync(root);
    assert.ok(!stat.isSymbolicLink() && (stat.isDirectory() || stat.isFile()), 'SHU251_SUPERVISOR_STATE: only real directories and regular durable files allowed');
    return stat.isDirectory()
      ? { mode: stat.mode & 0o777, entries: Object.fromEntries(fs.readdirSync(root).sort().map(name => [name, walk(join(root, name))])) }
      : { mode: stat.mode & 0o777, bytes: fs.readFileSync(root).toString('base64'), mtime: stat.mtimeMs, ctime: stat.ctimeMs };
  };
  const result = walk(stateDir);
  for (const name of ['branches', 'orders', 'runs', 'launches', 'completions']) {
    assert.ok(result.entries?.[name]?.entries, `SHU251_SUPERVISOR_STATE: missing durable ${name} directory`);
  }
  return result;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const service = await startSupervisor({ stateDir: process.env.SHU_SUPERVISOR_STATE_DIR,
    socketPath: process.env.SHU_SUPERVISOR_SOCKET, secret: process.env.SHU_SUPERVISOR_SECRET });
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => {
    void service.stop().then(() => process.exit(0), () => process.exit(1));
  });
}
