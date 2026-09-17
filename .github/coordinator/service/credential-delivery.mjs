// systemd supplies one private, read-only credential to the coordinator unit.
// It is parsed only at the transport call site, never exported to process.env.
import fs from 'node:fs';
export const ACTIVATION_FILE = '/srv/shu/state/shu71-activation.json';
export const EVIDENCE_SOCKET = '/run/shu71-evidence/fixture.sock';
export function supervisorTransportSecret(env, read = fs.readFileSync) {
  if (Object.hasOwn(env, 'SHU_SUPERVISOR_SECRET')) return checkedSecret(env.SHU_SUPERVISOR_SECRET);
  if (env.CREDENTIALS_DIRECTORY !== '/run/credentials/shu-coordinator.service') throw new Error('ACT_CREDENTIAL_UNAVAILABLE');
  const source = read('/run/credentials/shu-coordinator.service/supervisor-transport', 'utf8');
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
