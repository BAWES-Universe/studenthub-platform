// The reviewed unit always supplies the fixed activation path. Phase A has no
// activation request: disabled ticks still run and prove zero launch/write work.
//
// The unit's ExecStart is this file and nothing else. It has exactly two
// outcomes and takes one of them, never both:
//   - no recovery request present -> the tick, with exactly the arguments it has
//     always been given. This is the ordinary wake and it is unchanged.
//   - a single-use recovery request present -> ONLY the reviewed
//     reconciliation-only operation it names, and the tick does not run at all.
// See recovery-request.mjs for why the recovery has to happen in this process:
// the transport credential is pinned to this unit's own credential directory.
import { fileURLToPath } from 'node:url';
import { ACTIVATION_FILE } from './credential-delivery.mjs';
import { main } from '../reconcile.mjs';
import { runRecoveryRequest } from './recovery-request.mjs';
export function coordinatorTickArgs(argv, env) {
  if (argv.length !== 2 || argv[0] !== '--activation' || argv[1] !== ACTIVATION_FILE) throw new Error('ACT_ACTIVATION_PATH');
  return env.ENABLE_DISPATCH === 'true' ? ['--activation', ACTIVATION_FILE] : [];
}
// The argv contract is checked FIRST and unconditionally, so a unit whose
// ExecStart has drifted still fails ACT_ACTIVATION_PATH before anything is read,
// consumed or run.
export async function coordinatorEntry(argv, env, io = {}) {
  const args = coordinatorTickArgs(argv, env);
  const recovery = await (io.recovery ?? runRecoveryRequest)({ env, io: io.recoveryIo ?? {}, ...(io.stdout ? { out: io.stdout } : {}) });
  if (recovery.present) return recovery.exitCode;
  return (io.tick ?? main)(args, env);
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await coordinatorEntry(process.argv.slice(2), process.env); }
  catch (err) {
    process.stderr.write('ACT_COORDINATOR_TICK_FAILED\n');
    process.stderr.write(`${err?.stack ?? err?.message ?? String(err)}\n`);
    process.exitCode = 1;
  }
}
