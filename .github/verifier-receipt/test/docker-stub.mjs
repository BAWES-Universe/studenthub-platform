#!/usr/bin/env node
// A STAND-IN FOR `docker` THAT EXERCISES THE REAL INVOCATION AND RUNS THE COMMAND ON THIS HOST.
//
// It exists because the capture program and the controller now invoke every measurement through a container,
// and the emitter's own suite has to keep running on a machine with no docker daemon - and, on the machine
// this branch was written on, with `docker` denied outright by policy. What it does is read the argv the
// authority built, ASSERT that it is the sandboxed one, map the two bind mounts back onto host paths, and
// exec the command with exactly the environment `env -i` would have left.
//
// WHAT THE TESTS THAT USE IT THEREFORE ESTABLISH, and what they do not:
//
//   THEY ESTABLISH that the authority builds the right invocation - every required flag present, the source
//   mount read-only, no docker socket, no capability added, the environment exactly the allowlist - and that
//   everything downstream of the container (the streaming digest, the trailer, the meta, the job outputs, the
//   emitter's refusals) behaves on bytes a real runner produced. `assertNoEscape` runs here, on the real argv,
//   so a weakened flag fails these tests rather than passing them quietly.
//
//   THEY DO NOT ESTABLISH the kernel properties themselves: the uid boundary, the read-only mount, the
//   dropped capabilities, the absent network. A stub cannot enforce what it is standing in for. Those are
//   properties of the container and they are proven by running it - which is what the first real dispatch
//   does, and what the boundary record names as the thing only a dispatch can show.
import os from 'node:os';
import { spawn } from 'node:child_process';
import { assertNoEscape } from '../sandbox.mjs';

const argv = process.argv.slice(2);
if (argv[0] === 'pull' || argv[0] === 'image') process.exit(0);
if (argv[0] !== 'run') { process.stderr.write(`docker-stub: unexpected subcommand ${argv[0]}\n`); process.exit(125); }

// The real check, on the real argv. A test that weakens a flag gets a refusal here, exactly as a measurement
// would - which is the point of running it in the stub rather than trusting the production path to have.
try { assertNoEscape(argv); }
catch (error) { process.stderr.write(`docker-stub: ${error.message}\n`); process.exit(125); }

const mounts = {};
for (let at = 0; at < argv.length; at++) {
  if (argv[at] !== '--mount') continue;
  const fields = Object.fromEntries(argv[at + 1].split(',').map(part => {
    const eq = part.indexOf('='); return eq < 0 ? [part, true] : [part.slice(0, eq), part.slice(eq + 1)];
  }));
  mounts[fields.target] = fields;
}
// One pass, longest target first: substituting mount by mount re-substitutes inside a path a previous mount
// just produced, and a scratch directory whose own name contains the other mount's target then yields a
// working directory that does not exist.
const targets = Object.keys(mounts).sort((a, b) => b.length - a.length);
const pattern = new RegExp(targets.map(t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'g');
const map = text => (typeof text === 'string' ? text.replace(pattern, target => mounts[target].source) : text);

const dashI = argv.indexOf('-i');
const rest = argv.slice(dashI + 1);
const env = {};
let at = 0;
for (; at < rest.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(rest[at]); at++) {
  const eq = rest[at].indexOf('=');
  env[rest[at].slice(0, eq)] = map(rest[at].slice(eq + 1));
}
const command = rest.slice(at).map(map);
// The image's node lives at /usr/local/bin/node; this host's lives wherever it lives.
const exe = command[0] === '/usr/local/bin/node' ? process.execPath : command[0];
const child = spawn(exe, command.slice(1), {
  cwd: map(argv[argv.indexOf('--workdir') + 1]),
  env,
  stdio: ['ignore', 'inherit', 'inherit'],
});
child.on('error', error => { process.stderr.write(`docker-stub: ${error.message}\n`); process.exit(125); });
child.on('close', (code, signal) => { process.exit(signal ? 128 + (os.constants.signals[signal] ?? 0) : (code ?? 0)); });
