// A recording double for the ONE call the production CLI makes across the
// kernel lock, substituted for `node:child_process` in the CLI process only and
// only for the module under test (see shu71-reexec-cli-preload.mjs). Nothing in
// the module is rewritten: the real top-level entry runs, the real
// lockedReexecCommand() builds the real argv, and this records exactly what was
// handed to spawnSync so the controls can measure it and then execute it
// themselves with the trailing program replaced. Everything else this module
// might need from node:child_process is re-exported unchanged.
import fs from 'node:fs';
export * from 'node:child_process';
export function spawnSync(file, args, options) {
  fs.writeFileSync(process.env.SHU71_REEXEC_RECORD, JSON.stringify({ file, args, options: { ...options } }) + '\n');
  return { status: 0, signal: null, stdout: null, stderr: null, pid: 0, output: [] };
}
