#!/usr/bin/env node
// One typed composition of the existing signed, journaled lifecycle. No hooks,
// caller commands, provider selection or unsigned fallback in the CLI.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { drive, defaultIO, canonical, hash, refuse, approve } from './phase-a-driver.mjs';
export const SERVICE_PLANE_STEPS = Object.freeze(['pin', 'preflight', 'install', 'start', 'readiness']);
export const SERVICE_PLANE_ROLLBACK = Object.freeze(['host-rollback', 'pin-restore']);
const safeCode = error => /^(SHU251|CLOSURE)_[A-Z_]+$/.test(error?.code) ? error.code : 'CLOSURE_SERVICE_PLANE_IO';
export async function servicePlane(action, spec, options = {}, io = defaultIO) {
  if (!['start', 'rollback'].includes(action) || !spec?.lifecycle || !/^[a-f0-9]{40}$/.test(spec.window?.approved_sha)) refuse('CLOSURE_SERVICE_PLANE_SPEC');
  const steps = action === 'start' ? SERVICE_PLANE_STEPS : SERVICE_PLANE_ROLLBACK;
  const identity = { activation_id: spec.lifecycle.activation_id, approved_sha: spec.window.approved_sha,
    spec_sha256: hash(canonical(spec)), approval_sha256: spec.lifecycle.approval_sha256 };
  if (!options.execute) return { version: 'shu251-service-plane-plan-v1', ...identity, dry_run: true,
    steps, rollback: SERVICE_PLANE_ROLLBACK, acceptance: false };
  // Refuse missing explicit authorization before creating a provider or effects.
  for (const step of [...steps, ...SERVICE_PLANE_ROLLBACK]) approve(step, spec, options);
  const receipts = [], failures = [];
  let current, lifecycleIO = io;
  try {
    if (io === defaultIO) lifecycleIO = { ...io, lifecycle: await io.lifecycleProvider(spec) };
    for (current of steps) {
      try { receipts.push(await drive(current, spec, options, lifecycleIO)); }
      catch (error) {
        if (action !== 'rollback') throw error;
        failures.push({ step: current, code: safeCode(error) });
      }
    }
  } catch (error) {
    failures.push({ step: current ?? 'provider', code: safeCode(error) });
    // Attempt every cleanup operation even if an earlier cleanup refuses. Its
    // own custody checks decide whether restoration can safely proceed.
    if (action === 'start' && lifecycleIO.lifecycle) {
      for (const step of SERVICE_PLANE_ROLLBACK) {
        try { receipts.push(await drive(step, spec, options, lifecycleIO)); }
        catch (cleanup) { failures.push({ step, code: safeCode(cleanup) }); }
      }
    }
  }
  const result = { version: 'shu251-service-plane-receipt-v1', ...identity,
    ok: failures.length === 0, action, state: failures.length ? 'HALT' : action === 'start' ? 'READY_GATE_OFF' : 'ROLLED_BACK',
    receipts, failures };
  return { ...result, receipt_sha256: hash(canonical(result)) };
}
export async function main(argv = process.argv.slice(2)) {
  const [action, file, ...flags] = argv;
  if (!path.isAbsolute(file ?? '') || ![0, 3].includes(flags.length)
    || flags.length && (flags[0] !== '--execute' || flags[1] !== '--approved-host-mutation' || !/^[a-f0-9]{40}$/.test(flags[2]))) refuse('CLOSURE_SERVICE_PLANE_USAGE');
  const spec = JSON.parse(fs.readFileSync(file));
  return servicePlane(action, spec, { execute: flags.length === 3, approvedHostMutation: flags[2], env: process.env });
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const result = await main(); console.log(JSON.stringify(result)); if (result.ok === false) process.exitCode = 2; }
  catch (error) { console.error(JSON.stringify({ version: 'shu251-service-plane-refusal-v1', ok: false, code: safeCode(error) })); process.exitCode = 2; }
}
