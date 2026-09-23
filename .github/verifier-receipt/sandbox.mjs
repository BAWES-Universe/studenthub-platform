// THE MEASUREMENT SANDBOX: the only place candidate code runs, and the only interface it has to the
// controller is BYTES ON A PIPE THE CONTROLLER OWNS AND AN EXIT STATUS THE CONTROLLER TOOK FROM waitpid.
//
// WHAT THE THREE-JOB SPLIT COULD NOT DO, AND WHY THIS FILE EXISTS. Every earlier version of this authority
// ran the candidate's suite as the runner user, in the runner's workspace, with the runner's environment.
// A review then defeated each of them the same way and the defeat was never about parsing: the measured
// suite shared a uid with the thing measuring it, so it could rename a forged stream over the capture, and
// when the capture moved into the trusted process's memory it could append `exit=0` and forged digests to
// $GITHUB_OUTPUT instead. Looking harder at the bytes cannot fix a channel the measured code can write.
// What fixes it is that the channel does not exist: a different uid, a read-only source, no credential, no
// output file, no socket, and a report that leaves on a pipe the container never holds a writable end of.
//
// AND WHAT THIS FILE DOES NOT ESTABLISH, said here rather than discovered later. The container establishes
// PROVENANCE - where an outcome came from and who could have written it. It does not make a candidate-
// authored claim true. Bytes the candidate prints are DIAGNOSTIC and nothing in this authority may turn
// them into an approved point; what establishes a term is the exit status the controller observes for a
// run the controller chose, which is controller.mjs's business, not this file's.
import crypto from 'node:crypto';

// THE FLAGS, AND WHY EACH IS NOT NEGOTIABLE. They are a frozen list rather than a string built at the call
// site so that `assertNoEscape` below can read back exactly what is about to be run, and so that weakening
// one is a diff to this file rather than an interpolation nobody reviews.
//
//   --user 10001:10001          A uid that is not the runner's and owns nothing on the runner. This is the
//                               whole of the defeat above: the measured suite cannot write the capture, the
//                               receipt, $GITHUB_OUTPUT or any controller file, because it is not the user
//                               those belong to and the kernel, not a policy, says so.
//   --read-only                 The container's own filesystem is immutable. The candidate source is mounted
//                               read-only besides, so a suite cannot rewrite the code it is being measured
//                               from between the controller's two readings of it.
//   --cap-drop ALL              No capability at all - not CAP_DAC_OVERRIDE, which would walk straight
//                               through the uid above, and not CAP_SETUID.
//   --security-opt no-new-privileges  A setuid binary inside the image cannot raise the uid back.
//   --network none              No egress. A measurement that can reach the network is a measurement whose
//                               result depends on something no receipt can name. If a test needs a host,
//                               this flag stays closed, that test fails, and the dependency is REPORTED -
//                               a weakened flag nobody noticed is worse than a failing test that says what
//                               it wants.
//   --pids-limit                A fork bomb in a candidate's test body is a denial of the runner, not of
//                               this authority; bounded so the failure is a refusal rather than a hung job.
//   --cgroupns private          The container does not observe the runner's cgroup tree.
//   --rm                        No container state survives one measurement into the next.
//
// NOT PRESENT, AND THAT IS THE POINT: no --privileged, no --cap-add, no --security-opt seccomp=unconfined,
// no --pid host, no --userns host, and above all NO DOCKER SOCKET. A mounted /var/run/docker.sock is root
// on the runner in one command and would make every flag above decorative.
export const SANDBOX_FLAGS = Object.freeze([
  '--rm',
  '--user', '10001:10001',
  '--read-only',
  '--cap-drop', 'ALL',
  '--security-opt', 'no-new-privileges',
  '--network', 'none',
  '--cgroupns', 'private',
  '--pids-limit', '2048',
]);

// WHERE THE CANDIDATE'S SOURCE AND ITS SCRATCH APPEAR INSIDE THE CONTAINER. Both are fixed: a path the
// caller could choose is a path a matrix could choose, and the matrix is read from a file.
export const SOURCE_MOUNT = '/src';
export const SCRATCH_MOUNT = '/scratch';

// THE ENVIRONMENT THE MEASUREMENT GETS, IN FULL. Not "the runner's environment minus a denylist" - a
// denylist is a list someone has to keep complete, and the variable that matters is the one nobody added.
// This is the whole environment: the container is entered through `env -i`, so the process the candidate's
// suite runs in holds these names and nothing else, whatever the image bakes in and whatever the runner
// happens to be carrying.
//
// HOME and TMPDIR are both inside the controller-owned scratch mount because node, npm and this
// repository's own fixtures all write there; pointing them anywhere else means a test failing on a
// read-only filesystem for a reason that has nothing to do with what it tests.
export function measurementEnv({ nodeOptions = null } = {}) {
  const env = {
    PATH: '/usr/local/bin:/usr/local/sbin:/usr/bin:/usr/sbin:/bin:/sbin',
    HOME: `${SCRATCH_MOUNT}/home`,
    TMPDIR: `${SCRATCH_MOUNT}/tmp`,
    LANG: 'C.UTF-8',
  };
  // NODE_OPTIONS only if the suite needs it, and only from the controller. It is listed because a suite may
  // legitimately need a heap bound; it is empty here because this repository's suite does not.
  if (nodeOptions) env.NODE_OPTIONS = nodeOptions;
  return env;
}

// The names that must never appear inside the measurement, checked rather than assumed. `env -i` already
// makes the environment exactly `measurementEnv`, so this is the second reader of that fact: it is applied
// to what the container reports about ITSELF, so a change to the entry form that silently reintroduced the
// runner's environment is caught by a probe rather than by a reviewer.
export const FORBIDDEN_ENV = Object.freeze([
  /^GITHUB_/, /^ACTIONS_/, /^RUNNER_/, /^CI$/, /^GH_/, /TOKEN/i, /SECRET/i, /PASSWORD/i, /^AWS_/, /^NPM_/,
]);

export function forbiddenEnvNames(names) {
  return names.filter(name => FORBIDDEN_ENV.some(pattern => pattern.test(name)));
}

// THE INVOCATION, BUILT IN ONE PLACE SO IT CAN BE READ BACK. `env -i` is the entrypoint rather than node,
// because the image's own ENV lines are part of the image and this authority does not want to reason about
// which of them a rebuild introduced. Everything after `-i` is this controller's, by name and by value.
export function sandboxArgv({ image, sourceDir, scratchDir, argv, env = measurementEnv(), workdir = SOURCE_MOUNT }) {
  if (!image) throw new Error('the sandbox was given no image to run the measurement in');
  if (!sourceDir || !scratchDir) throw new Error('the sandbox was given no source mount or no scratch mount');
  if (!Array.isArray(argv) || argv.length === 0) throw new Error('the sandbox was given no command to run');
  return [
    'run', ...SANDBOX_FLAGS,
    // --mount rather than -v: it fails loudly on a source that does not exist, where -v silently creates a
    // root-owned directory on the host, and `readonly` is a named field rather than a suffix nobody reads.
    '--mount', `type=bind,source=${sourceDir},target=${SOURCE_MOUNT},readonly`,
    '--mount', `type=bind,source=${scratchDir},target=${SCRATCH_MOUNT}`,
    '--workdir', workdir,
    '--entrypoint', '/usr/bin/env',
    image,
    '-i', ...Object.entries(env).map(([name, value]) => `${name}=${value}`),
    ...argv,
  ];
}

// THE SELF-CHECK, RUN BEFORE EVERY MEASUREMENT. A flag is weakened by editing this file, and editing this
// file is a change to the receipt authority that a candidate may not make - but an authority that only
// refuses candidates has not checked itself. This reads the argv that is ABOUT TO BE EXECUTED and refuses
// it if any of the escapes is present, so a future edit that reintroduces one fails closed at the first
// measurement rather than producing receipts nobody can tell apart from the sound ones.
const ESCAPES = [
  [argv => argv.includes('--privileged'), 'it grants --privileged'],
  [argv => argv.some(a => a === '--cap-add'), 'it adds a capability back'],
  [argv => argv.some(a => /^--security-opt$/.test(a)) && argv.some(a => /unconfined/.test(a)), 'it unconfines a security profile'],
  [argv => argv.some(a => /docker\.sock/.test(a)), 'it exposes a docker socket, which is root on the runner'],
  [argv => argv.some(a => a === '--pid' || a === '--userns' || a === '--ipc') , 'it shares a host namespace'],
  [argv => argv.some(a => /^--device/.test(a)), 'it passes a device through'],
  [argv => argv.some(a => /^-v$/.test(a) || /^--volume$/.test(a)), 'it uses -v, whose read-only suffix is easy to drop; use --mount'],
];
const REQUIRED = [
  [['--user', '10001:10001'], 'the measurement would run as the image default user, which may be root'],
  [['--read-only'], 'the container filesystem would be writable'],
  [['--cap-drop', 'ALL'], 'the measurement would keep capabilities'],
  [['--security-opt', 'no-new-privileges'], 'a setuid binary could raise the uid back'],
  [['--network', 'none'], 'the measurement could reach the network'],
];

export function assertNoEscape(argv) {
  const broken = [];
  for (const [present, why] of ESCAPES) if (present(argv)) broken.push(why);
  for (const [pair, why] of REQUIRED) {
    const at = argv.indexOf(pair[0]);
    if (at < 0 || (pair.length > 1 && argv[at + 1] !== pair[1])) broken.push(`${pair.join(' ')} is absent, so ${why}`);
  }
  // The source mount, read-only, by name. A bind that lost `readonly` lets a suite rewrite the code between
  // the run that measures it and the run that measures its mutant, which is the one thing a mutation matrix
  // must not permit.
  const source = argv.find(a => typeof a === 'string' && a.includes(`target=${SOURCE_MOUNT}`));
  if (!source) broken.push(`no ${SOURCE_MOUNT} mount is present, so the measurement has no source`);
  else if (!/(^|,)readonly(,|$)/.test(source)) broken.push(`the ${SOURCE_MOUNT} mount is not readonly: ${source}`);
  // And the environment: entered through `env -i`, with nothing forbidden after it.
  const dashI = argv.indexOf('-i');
  if (argv[argv.indexOf('--entrypoint') + 1] !== '/usr/bin/env' || dashI < 0)
    broken.push('the measurement is not entered through `env -i`, so it inherits an environment this file did not choose');
  else {
    const named = argv.slice(dashI + 1).filter(a => /^[A-Za-z_][A-Za-z0-9_]*=/.test(a)).map(a => a.slice(0, a.indexOf('=')));
    const forbidden = forbiddenEnvNames(named);
    if (forbidden.length > 0) broken.push(`the measurement is handed ${forbidden.join(', ')}`);
  }
  if (broken.length > 0) throw new Error(`this measurement would not be sandboxed: ${broken.join('; ')}`);
  return argv;
}

// THE RUN ITSELF. The controller owns both pipes; the container is handed no writable end of anything it
// could report through. stdin is /dev/null: a measurement that can be fed bytes is a measurement whose
// result depends on who fed it.
//
// The digest is taken IN THIS PROCESS'S MEMORY as the bytes arrive, never read back from a file, because a
// file is a thing with a path and a path is a thing something else can rename over. The exit status is the
// docker client's, which is the container's, taken from waitpid - not from any line in the stream.
export async function runSandbox(spec, { exec, onChunk = null, limitBytes = 64 * 1024 * 1024 } = {}) {
  if (typeof exec !== 'function') throw new Error('runSandbox needs an exec: the caller decides what invokes the container');
  const argv = assertNoEscape(sandboxArgv(spec));
  const hash = crypto.createHash('sha256');
  let bytes = 0;
  let truncated = false;
  const kept = [];
  const started = process.hrtime.bigint();
  const observed = await exec(argv, chunk => {
    hash.update(chunk);
    bytes += chunk.length;
    if (!truncated && kept.reduce((n, b) => n + b.length, 0) + chunk.length <= limitBytes) kept.push(chunk);
    else truncated = true;
    if (onChunk) onChunk(chunk);
  });
  const ms = Number(process.hrtime.bigint() - started) / 1e6;
  // DOCKER'S OWN FAILURES ARE NOT MEASUREMENTS. 125 is the client refusing to run, 126 a command that could
  // not be invoked, 127 one that is not there. Reading any of those as "the suite failed" would turn a
  // missing image into a dead mutant, which is a term established by an infrastructure error.
  const sandboxFault = [125, 126, 127].includes(observed.code) ? observed.code : null;
  return {
    argv,
    exit: observed.code,
    signal: observed.signal ?? null,
    sandbox_fault: sandboxFault,
    bytes,
    truncated,
    sha256: hash.digest('hex'),
    stdout: Buffer.concat(kept),
    duration_ms: Math.round(ms),
  };
}
