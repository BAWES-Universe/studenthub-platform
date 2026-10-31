// systemd supplies one private, read-only credential to the coordinator unit.
// It is parsed only at the transport call site, never exported to process.env.
import fs from 'node:fs';
export const ACTIVATION_FILE = '/srv/shu/state/shu71-activation.json';
// M15: card workers. Worker 1 is today's single coordinator and keeps its
// activation path and units. Worker N > 1 has its own activation record and its
// own coordinator unit, and systemd names that unit's credential directory after
// it. Only the count in config.json (workers.max, default 1) turns more on.
export const MAX_CARD_WORKERS = 8;
export function cardWorkers(config) {
  const max = config?.workers?.max;
  return Number.isInteger(max) && max >= 1 && max <= MAX_CARD_WORKERS ? max : 1;
}
const validWorker = (worker) => Number.isInteger(worker) && worker >= 1 && worker <= MAX_CARD_WORKERS;
// M15: worker N's card-run lock (card-run.mjs cardRunPaths) and the one
// host-wide install lock (card-install.mjs INSTALL_LOCK), named here so the
// root provisioner can read them without importing either module.
export const CARD_INSTALL_LOCK = '/run/lock/shu-card-install.lock';
export function workerRunLock(worker) {
  if (!validWorker(worker)) throw new Error('ACT_ACTIVATION_PATH');
  return worker === 1 ? '/run/lock/shu-card-run.lock' : `/run/lock/shu-card-run-w${worker}.lock`;
}
export function workerActivationFile(worker) {
  if (!validWorker(worker)) throw new Error('ACT_ACTIVATION_PATH');
  return worker === 1 ? ACTIVATION_FILE : `/srv/shu/state/w${worker}/shu71-activation.json`;
}
// Every activation path a coordinator tick may be given: worker 1's, then each
// card worker's, and nothing else.
export const workerActivationFiles = () => Array.from({ length: MAX_CARD_WORKERS }, (_, i) => workerActivationFile(i + 1));
export const supervisorUnitName = (worker) => worker === 1 ? 'shu-supervisor.service' : `shu-supervisor-w${worker}.service`;
export const coordinatorUnitName = (worker) => worker === 1 ? 'shu-coordinator.service' : `shu-coordinator-w${worker}.service`;
const COORDINATOR_CREDENTIAL_DIRECTORIES = Array.from({ length: MAX_CARD_WORKERS }, (_, i) => `/run/credentials/${coordinatorUnitName(i + 1)}`);
export const EVIDENCE_SOCKET = '/run/shu71-evidence/fixture.sock';
export function supervisorTransportSecret(env, read = fs.readFileSync) {
  if (Object.hasOwn(env, 'SHU_SUPERVISOR_SECRET')) return checkedSecret(env.SHU_SUPERVISOR_SECRET);
  if (!COORDINATOR_CREDENTIAL_DIRECTORIES.includes(env.CREDENTIALS_DIRECTORY)) throw new Error('ACT_CREDENTIAL_UNAVAILABLE');
  const source = read(`${env.CREDENTIALS_DIRECTORY}/supervisor-transport`, 'utf8');
  const match = /^SHU_SUPERVISOR_SECRET=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s'"\\$\r\n]+))\r?\n?$/.exec(source);
  const value = match && (match[1] ?? match[2] ?? match[3]);
  return checkedSecret(value);
}
function checkedSecret(value) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) < 32 || /[\\$\x00-\x1f]/.test(value)) throw new Error('ACT_CREDENTIAL_UNAVAILABLE');
  return value;
}
export function supervisorChildEnvironment(env) {
  // Exact runtime keys and the two adapter model credentials only. GitHub,
  // Linear and supervisor transport authority never cross this boundary.
  // Unknown names and aliases remain excluded.
  const allowed = new Set([
    'PATH', 'HOME', 'LANG', 'LC_ALL', 'TZ', 'TMPDIR',
    'ENABLE_DISPATCH', 'DISPATCH_BRANCH', 'DISPATCH_TARGET_SHA',
    'SHU71_EVIDENCE_BROKER', 'SHU_SUPERVISOR_ACTIVATION_FILE',
    'SHU_WORKSPACE_STATE_DIR', 'SHU_WORKTREE_ROOT', 'SHU_WORKER_UID',
    'SHU_WORKER_LAUNCH_WRAPPER', 'SHU_REVIEW_EXEC_UID',
    'SHU_REVIEW_EXEC_WRAPPER_JSON', 'SHU_REVIEW_MODEL_WRAPPER_JSON',
    'SHU_REVIEW_EVIDENCE_DIR', 'SHU_REVIEW_TEST_FILES_JSON',
    'CLAUDE_CODE_OAUTH_TOKEN', 'WORKSPACE_AGENT_ACCESS_TOKEN',
    'WORKSPACE_AGENT_TRIGGER_ID', 'CODEX_HOME', 'HERMES_BIN',
    'SHU_PUSH_BROKER_ENABLED', 'SHU_PUSH_REMOTE_URL', 'SHU_PUSH_ALLOWED_HOST',
    'SHU_LANE_BRANCH_PREFIX',
  ]);
  return Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key)));
}
