import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { IMAGE } from './select-artifact.mjs';
import { DeploymentOutcome } from './trigger-selected.mjs';

const sha = /^[a-f0-9]{40}$/;
const digestPattern = /^sha256:[a-f0-9]{64}$/;
const fail = (detail) => { throw new DeploymentOutcome('PRECONDITION_NOT_MET', detail); };
export const execute = (command, args) => execFileSync(command, args, {
  encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000,
});

// An existing SSH alias and exact container ID are trusted operator inputs, never
// inferred from latest. These commands only read host state; they do not pull/run.
export function readRunningArtifact(env, run = execute) {
  const host = env.ROLLBACK_SSH_HOST, container = env.ROLLBACK_CONTAINER_ID;
  if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]*$/.test(host ?? '') || !/^[a-f0-9]{64}$/.test(container ?? '')) {
    fail('ROLLBACK_RUNNING_ARTIFACT_REQUIRED: existing SSH host alias and full running container ID required');
  }
  const remote = (...args) => run('ssh', ['-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'UpdateHostKeys=no', host, 'docker', ...args]);
  const before = JSON.parse(remote('inspect', container))[0];
  if (before?.Id !== container || !digestPattern.test(before.Image ?? '') || before.State?.Running !== true || before.State?.Health?.Status !== 'healthy') fail('ROLLBACK_RUNNING_ARTIFACT_REQUIRED: container must be running and healthy');
  const image = JSON.parse(remote('image', 'inspect', before.Image))[0];
  const pins = [...new Set((image?.RepoDigests ?? []).filter((pin) => pin.startsWith(`${IMAGE}@`)))];
  if (image?.Id !== before.Image || pins.length !== 1) fail('ROLLBACK_RUNNING_ARTIFACT_REQUIRED: unambiguous gateway repository digest required');
  const revision = remote('exec', container, 'cat', '/image-source-revision').trim();
  const after = JSON.parse(remote('inspect', container))[0];
  if (after?.Id !== before.Id || after.Image !== before.Image || after.State?.StartedAt !== before.State.StartedAt
    || after.State?.Running !== true || after.State?.Health?.Status !== 'healthy') fail('ROLLBACK_RUNNING_ARTIFACT_REQUIRED: container changed during observation');
  return { image: IMAGE, digest: pins[0].slice(IMAGE.length + 1), revision };
}

export async function discoverRollback(io) {
  const running = await io.readRunning();
  if (running?.image !== IMAGE || !digestPattern.test(running.digest ?? '') || !sha.test(running.revision ?? '')) fail('ROLLBACK_RUNNING_ARTIFACT_REQUIRED: verified running digest and embedded revision required');
  const { digest, revision } = running;
  const pin = `${IMAGE}@${digest}`, tag = `main-${revision}`;
  // Registry failures are errors, not evidence that a tag is absent.
  const published = await io.inspect(`${IMAGE}:${tag}`);
  if (published === null) return {
    outcome: 'ROLLBACK_RUNNING_REVISION_UNTAGGED', image: IMAGE, revision, digest, pin, tag,
    remediation: `Publish immutable tag ${IMAGE}:${tag} for revision ${revision} at verified running digest ${digest}, or address ${pin} directly and repeat digest, embedded revision, health and image smoke validation. Never substitute latest.`,
  };
  if (published !== digest || await io.inspect(pin) !== digest) fail('rollback registry digest does not match running artifact');
  await io.pull(pin);
  if (await io.readRevision(pin) !== revision) fail('rollback revision does not match running embedded revision');
  const response = await io.health();
  const health = await response.json();
  if (!response.ok || health.status !== 'ok' || health.component !== 'gateway' || health.revision !== revision) fail('rollback artifact is not the healthy running revision');
  await io.smoke(pin);
  const after = await io.readRunning();
  if (after?.image !== IMAGE || after.digest !== digest || after.revision !== revision) fail('ROLLBACK_RUNNING_ARTIFACT_REQUIRED: running artifact changed during validation');
  return { outcome: 'ROLLBACK_READY', image: IMAGE, digest, pin, revision };
}

export function rollbackIO(env, run = execute, request = fetch) {
  return {
    readRunning: () => readRunningArtifact(env, run),
    inspect: (ref) => {
      try { return JSON.parse(run('docker', ['buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Manifest}}'])).digest; }
      catch (error) {
        if (/manifest unknown|MANIFEST_UNKNOWN/.test(String(error.stderr ?? ''))) return null;
        fail('rollback registry artifact unreadable');
      }
    },
    pull: (pin) => run('docker', ['pull', pin]),
    readRevision: (pin) => run('docker', ['run', '--rm', '--entrypoint', 'cat', pin, '/image-source-revision']).trim(),
    health: () => request('https://staging.studenthub.co/health', { redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { 'Cache-Control': 'no-cache' } }),
    smoke: (pin) => run('bash', ['deploy/coolify/image-smoke.sh', pin]),
  };
}

// previous() requires READY and returns exactly the immutable rollback selection.
// Untagged is non-fatal for discovery, but cannot authorize automatic deployment.
export async function previous(io) {
  const result = await discoverRollback(io);
  if (result.outcome !== 'ROLLBACK_READY') fail(`${result.outcome}: ${result.remediation}`);
  const { image, digest, pin, revision } = result;
  return { image, digest, pin, revision };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { console.log(JSON.stringify(await discoverRollback(rollbackIO(process.env)))); }
  catch { console.error('PRECONDITION_NOT_MET: rollback discovery could not verify the running artifact'); process.exitCode = 1; }
}
