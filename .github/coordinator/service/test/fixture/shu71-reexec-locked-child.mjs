// The INNER process of the locked re-exec, as far as this harness can carry it.
//
// It is started by the REAL constructed command - real `/usr/bin/env -i`, real
// `PATH=/usr/bin:/bin`, real `SHU71_LOCKED=1`, real invocation element - with
// the whole tail from `/usr/bin/node` on replaced - that pair and the
// `expire <id>` argv alike - because `/usr/local/lib/shu71/...` is a root-owned
// path absent on a suite host running as the service identity. It inherits
// the environment the boundary really hands the inner process, and reports:
//
//   1. the environment it actually received, by KEY - never by operator value;
//   2. what the module's own measurement port makes of the propagated value,
//      and whether a timer-triggered teardown driven by that value completes.
//
// The companion unit's reported InvocationID is planted from argv, which is the
// durable systemd fact `systemctl show -p InvocationID` answers with. This
// process's own identity is NOT passed in argv: it can only reach the exclusion
// by having crossed `env -i`, which is the whole point of the control.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { generateKeyPairSync } from 'node:crypto';
import { createShu71Production, shu71Boundary } from '../../shu71-production.mjs';
import { productionFixture } from '../shu71-production-fixture.mjs';
import { SHU71_PUBLIC_KEY_PATH } from '../../../shu71-public-key.mjs';

const [output, planted] = process.argv.slice(2);
const carried = shu71Boundary.invocationId();
const report = {
  environment_keys: Object.keys(process.env).sort(),
  path: process.env.PATH ?? null,
  locked: process.env.SHU71_LOCKED ?? null,
  carried: carried ?? null,
  planted,
};
// The same disposable public source the suite's own fixture builds, inlined so
// this process owns its own cleanup and imports no test runner.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'shu71-reexec-child-'));
const cleanups = [() => fs.rmSync(scratch, { recursive: true, force: true })];
try {
  const pair = generateKeyPairSync('ed25519');
  const publicFile = path.join(scratch, 'public.pem');
  fs.writeFileSync(publicFile, pair.publicKey.export({ type: 'spki', format: 'pem' }));
  const read = fs.readFileSync.bind(fs);
  fs.readFileSync = (name, ...args) => read(name === SHU71_PUBLIC_KEY_PATH ? publicFile : name, ...args);
  const h = productionFixture({ after: fn => cleanups.push(fn) }, pair);
  const companion = `shu71-expiry-${h.id}.service`;
  const show = (unit, property) => String(h.boundary.run('/usr/bin/systemctl', ['show', `--property=${property}`, '--value', unit], {}).stdout ?? '').trim();
  const create = () => createShu71Production(h.id, h.boundary);
  report.armed = (await create().execute('run')).state;
  h.active.set(companion, 'activating');
  h.unitInvocations.set(companion, planted);
  // The ONLY source of this process's claimed identity is the propagated value.
  h.selfInvocation.id = carried ?? null;
  report.companion_invocation = show(companion, 'InvocationID');
  report.companion_state = show(companion, 'ActiveState');
  h.expire();
  const start = h.events.length;
  report.result = await create().execute('expire');
  report.units_present = [`/etc/systemd/system/${companion}`, `/etc/systemd/system/shu71-expiry-${h.id}.timer`].map(p => h.exists(p));
  report.teardown_complete = h.journal().some(e => e.event === 'TEARDOWN_COMPLETE');
  report.retirement_receipt = h.journal().some(e => e.event === 'EXPIRY_RETIREMENT_STARTED');
  report.stop_issued = h.events.slice(start).some(e => e.includes(`:stop ${companion}`));
  report.kill_issued = h.events.slice(start).some(e => e.includes(':kill') && e.includes(companion));
  report.companion_still_live = show(companion, 'ActiveState');
  report.companion_still_this_invocation = show(companion, 'InvocationID');
} catch (error) {
  report.threw = error?.code ?? String(error?.message ?? error);
} finally {
  for (const cleanup of cleanups) { try { cleanup(); } catch {} }
}
fs.writeFileSync(output, JSON.stringify(report) + '\n');
