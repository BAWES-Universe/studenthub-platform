// Test-only daemon and long-running worker. All paths are supplied by the
// private sandbox; readiness uses IPC, never systemd-notify.
import fs from 'node:fs';
import { fork } from 'node:child_process';
import { startSupervisor } from '../../supervisor-service.mjs';
import { recordSupervisorCompletion } from '../../../supervisor.mjs';

process.once('message', async message => {
  if (message.kind === 'worker') {
    const { stateDir, contract, release, journal } = message;
    fs.appendFileSync(journal, `started ${process.pid}\n`);
    const timer = setInterval(() => {
      if (!fs.existsSync(release)) return;
      clearInterval(timer);
      const result = recordSupervisorCompletion({ stateDir, completion: {
        ...contract, version: '2.0.0', exit_code: 0, signal: null,
        finished_at: new Date().toISOString(), result: { stage: 'COMPLETED' },
      } });
      if (!result.ok) process.exit(2);
      fs.appendFileSync(journal, `completed ${process.pid}\n`);
      process.exit(0);
    }, 20);
    // Keep alive across daemon death and enforce an outer orphan bound.
    process.on('disconnect', () => {});
    setTimeout(() => process.exit(3), 15000).unref();
    return;
  }
  const { stateDir, socketPath, secret, release, journal } = message;
  const service = await startSupervisor({ stateDir, socketPath, secret,
    env: { ENABLE_DISPATCH: 'true' }, ready: () => {},
    spawnWorker: (order, contract) => {
      const child = fork(new URL(import.meta.url), [], { detached: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'], env: {} });
      const stat = fs.readFileSync(`/proc/${child.pid}/stat`, 'utf8');
      child.processStartToken = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      child.send({ kind: 'worker', stateDir, contract, release, journal });
      return child;
    },
  });
  process.on('message', async command => {
    if (command.kind === 'stop') { await service.stop(); process.exit(0); }
  });
  process.send({ ready: true, pid: process.pid });
});
