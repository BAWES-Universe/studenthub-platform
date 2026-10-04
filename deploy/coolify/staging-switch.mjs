import { execFileSync } from 'node:child_process';
import { appendFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { IMAGE } from './select-artifact.mjs';
import { assertStagingTag, featureSmoke } from './automatic-staging.mjs';
import { DeploymentOutcome, triggerSelected, diagnostic } from './trigger-selected.mjs';

// Puts one smoke-tested image on staging for hands-on testing (the `on-dev` label).
// Staging is a test site: there is no rollback or freeze here. Switching back is
// the same operation with the main build, which the workflow does when the label
// is removed or the pull request is merged or closed.
const fail = (code, detail) => { throw new DeploymentOutcome(code, detail); };

export function selection(revision, digest) {
  if (!/^[a-f0-9]{40}$/.test(revision ?? '')) fail('PRECONDITION_NOT_MET', 'revision must be a full lowercase 40-character SHA');
  if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) fail('PRECONDITION_NOT_MET', 'digest must be a sha256 digest');
  return { revision, image: IMAGE, digest, pin: `${IMAGE}@${digest}` };
}

// All IO is injected so tests never contact Coolify, GHCR or staging.
export async function switchStaging(selected, io) {
  await io.preflight(selected);
  await io.promote(selected);
  await io.assertDigest(selected);
  const receipt = await io.trigger(selected);
  await io.assertDigest(selected);
  return { outcome: receipt.outcome, revision: selected.revision, digest: selected.digest };
}

function liveIO(env) {
  const execute = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  if (env.GITHUB_REPOSITORY !== 'BAWES-Universe/studenthub-platform') fail('PRECONDITION_NOT_MET', 'staging switch runs only in the platform repository');
  for (const name of ['COOLIFY_BASE', 'COOLIFY_TOKEN', 'COOLIFY_STUDENTHUB_GATEWAY_UUID']) {
    if (!env[name]) fail('PRECONDITION_NOT_MET', `missing ${name}`);
  }
  let base;
  try { base = new URL(env.COOLIFY_BASE); } catch { fail('PRECONDITION_NOT_MET', 'invalid Coolify base URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    fail('PRECONDITION_NOT_MET', 'Coolify base must be HTTP or HTTPS without URL credentials');
  }
  const inspect = (ref) => JSON.parse(execute('docker', ['buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Manifest}}'])).digest;
  const assertDigest = (selected) => {
    if (inspect(`${IMAGE}:latest`) !== selected.digest) fail('DEPLOYMENT_UNKNOWN', 'staging tag artifact mismatch');
  };
  return {
    preflight: async (selected) => {
      const response = await fetch(new URL(`/api/v1/applications/${encodeURIComponent(env.COOLIFY_STUDENTHUB_GATEWAY_UUID)}`, base), {
        redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${env.COOLIFY_TOKEN}` },
      });
      if (!response.ok) fail('PRECONDITION_NOT_MET', `staging target could not be read (HTTP ${response.status})`);
      assertStagingTag(await response.json(), selected);
    },
    promote: (selected) => execute('docker', ['buildx', 'imagetools', 'create', '--prefer-index=false', '--tag', `${IMAGE}:latest`, selected.pin]),
    assertDigest,
    trigger: (selected) => triggerSelected(selected, env, fetch, {
      allowHttp: true,
      assertApplication: (app, artifact) => { assertStagingTag(app, artifact); assertDigest(artifact); },
      verifyFeatures: () => featureSmoke(),
    }),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = await switchStaging(selection(process.env.REVISION, process.env.DIGEST), liveIO(process.env));
    writeFileSync('deployment-receipt.json', JSON.stringify(result) + '\n');
    console.log(`DEPLOYMENT_SUCCEEDED: staging runs ${result.revision}`);
  } catch (error) {
    const code = error instanceof DeploymentOutcome ? error.code : 'DEPLOYMENT_UNKNOWN';
    writeFileSync('deployment-receipt.json', JSON.stringify({ outcome: code }) + '\n');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `outcome=${code}\n`);
    console.error(diagnostic(error));
    process.exitCode = 1;
  }
}
