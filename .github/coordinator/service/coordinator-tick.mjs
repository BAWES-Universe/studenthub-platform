// The reviewed unit always supplies the fixed activation path. Phase A has no
// activation request: disabled ticks still run and prove zero launch/write work.
import { fileURLToPath } from 'node:url';
import { ACTIVATION_FILE } from './credential-delivery.mjs';
import { main } from '../reconcile.mjs';
export function coordinatorTickArgs(argv, env) {
  if (argv.length !== 2 || argv[0] !== '--activation' || argv[1] !== ACTIVATION_FILE) throw new Error('ACT_ACTIVATION_PATH');
  return env.ENABLE_DISPATCH === 'true' ? ['--activation', ACTIVATION_FILE] : [];
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try { process.exitCode = await main(coordinatorTickArgs(process.argv.slice(2), process.env), process.env); }
  catch (err) {
    process.stderr.write('ACT_COORDINATOR_TICK_FAILED\n');
    process.stderr.write(`${err?.stack ?? err?.message ?? String(err)}\n`);
    process.exitCode = 1;
  }
}
