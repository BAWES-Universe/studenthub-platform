// systemd supplies one private, read-only credential to the coordinator unit.
// It is parsed only at the transport call site, never exported to process.env.
import fs from 'node:fs';
export const ACTIVATION_FILE = '/srv/shu/state/shu71-activation.json';
export const EVIDENCE_SOCKET = '/run/shu71-evidence/fixture.sock';
export function supervisorTransportSecret(env, read = fs.readFileSync) {
  if (env.SHU_SUPERVISOR_SECRET) return env.SHU_SUPERVISOR_SECRET;
  if (env.CREDENTIALS_DIRECTORY !== '/run/credentials/shu-coordinator.service') throw new Error('ACT_CREDENTIAL_UNAVAILABLE');
  const source = read('/run/credentials/shu-coordinator.service/supervisor-transport', 'utf8');
  const match = /^SHU_SUPERVISOR_SECRET=(?:"([^"\r\n]+)"|'([^'\r\n]+)'|([^\s'"\\$\r\n]+))\r?\n?$/.exec(source);
  const value = match && (match[1] ?? match[2] ?? match[3]);
  if (!value || Buffer.byteLength(value) < 32 || /[\\$\x00-\x1f]/.test(value)) throw new Error('ACT_CREDENTIAL_UNAVAILABLE');
  return value;
}
export function supervisorChildEnvironment(env) {
  // Service transport credentials have no purpose in adapter children.
  return Object.fromEntries(Object.entries(env).filter(([key]) => !['SHU_SUPERVISOR_SECRET', 'GITHUB_TOKEN', 'GH_TOKEN', 'LINEAR_API_TOKEN', 'CREDENTIALS_DIRECTORY'].includes(key)));
}
