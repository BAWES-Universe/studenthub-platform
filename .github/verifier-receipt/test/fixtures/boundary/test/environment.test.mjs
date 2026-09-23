// WHAT THE MEASUREMENT CAN SEE OF THE JOB THAT INVOKED IT. It prints its own environment, the paths it was
// told about, and whether any of the runner's output channels are reachable - so the boundary's env-stripping
// claim is measured from inside rather than asserted from outside.
import test from 'node:test';
import fs from 'node:fs';

test('report what this measurement can reach', () => {
  const report = {
    env: Object.keys(process.env).sort(),
    uid: process.getuid(),
    gid: process.getgid(),
    cwd: process.cwd(),
    github_output: process.env.GITHUB_OUTPUT ?? null,
    writes: {},
  };
  for (const [what, target] of Object.entries(JSON.parse(process.env.PROBE_PATHS ?? '{}'))) {
    try { fs.writeFileSync(target, 'forged'); report.writes[what] = 'WROTE'; }
    catch (error) { report.writes[what] = error.code; }
  }
  process.stdout.write(`PROBE ${JSON.stringify(report)}\n`);
});
