import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { IMAGE } from './select-artifact.mjs';
import { DeploymentOutcome, triggerSelected, diagnostic } from './trigger-selected.mjs';

const STAGING = 'https://staging.studenthub.co';
export const FREEZE_TITLE = '[staging-deploy] frozen: owner review required';
const fail = (code, detail) => { throw new DeploymentOutcome(code, detail); };

export function assertStagingTag(app, selected) {
  if (app?.fqdn !== STAGING || app.build_pack !== 'dockerimage'
    || app.docker_registry_image_name !== IMAGE || app.docker_registry_image_tag !== 'latest'
    || selected?.image !== IMAGE || !/^sha256:[a-f0-9]{64}$/.test(selected.digest ?? '')
    || selected.pin !== `${IMAGE}@${selected.digest}` || !/^[a-f0-9]{40}$/.test(selected.revision ?? '')) {
    fail('PRECONDITION_NOT_MET', 'existing staging Docker Image application must use the gateway latest tag');
  }
}

export async function featureSmoke(request = fetch) {
  // Public UI and the unauthenticated profile boundary are applicable to every gateway artifact.
  // Synthetic identities are deliberately confined to repository/image tests.
  for (const [path, status, content] of [['/', 200, /Continue with Universe/], ['/assets/studenthub.css', 200, /@media/], ['/profile', 401, null]]) {
    const response = await request(`${STAGING}${path}`, {
      redirect: 'manual', signal: AbortSignal.timeout(15_000), headers: { Accept: path === '/profile' ? 'application/json' : 'text/html', 'Cache-Control': 'no-cache' },
    });
    if (response.status !== status || (content && !content.test(await response.text()))) {
      fail('DEPLOYMENT_FAILED', 'staging feature smoke failed');
    }
  }
}

// The latch is durable BEFORE changing latest. A killed runner leaves staging frozen.
// All IO is injected so tests never contact Coolify, GitHub, GHCR or a host.
export async function restoreAutomatically(selected, io) {
  let previous, latch;
  try {
    await io.assertUnfrozen();
    await io.preflight(selected);
    previous = await io.previous();
    latch = await io.freeze(selected, previous);
  } catch {
    fail('PRECONDITION_NOT_MET', 'staging target, rollback readiness or durable freeze could not be established; no deployment requested');
  }
  let changed = false;
  try {
    changed = true; // A lost registry response may still have moved the tag.
    await io.promote(selected);
    await io.assertDigest(selected);
    const receipt = await io.trigger(selected);
    await io.assertDigest(selected);
    await io.unfreeze(latch);
    return { outcome: receipt.outcome, revision: selected.revision, digest: selected.digest };
  } catch (error) {
    let rollback = 'not_needed';
    if (changed) {
      try {
        await io.promote(previous);
        await io.assertDigest(previous);
        await io.trigger(previous);
        await io.assertDigest(previous);
        rollback = 'verified';
      } catch { rollback = 'unverified'; }
    }
    // Never clear the latch on failure, even after a verified rollback.
    await io.notify(latch, { outcome: error instanceof DeploymentOutcome ? error.code : 'DEPLOYMENT_UNKNOWN', rollback });
    throw error;
  }
}

function liveIO(env) {
  const execute = (command, args) => execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 60_000 });
  const repo = env.GITHUB_REPOSITORY;
  if (repo !== 'BAWES-Universe/studenthub-platform' || env.GITHUB_EVENT_NAME !== 'push' || env.GITHUB_REF !== 'refs/heads/main') {
    fail('PRECONDITION_NOT_MET', 'automatic deployment is restricted to staging main pushes');
  }
  for (const name of ['COOLIFY_BASE', 'COOLIFY_TOKEN', 'COOLIFY_STUDENTHUB_GATEWAY_UUID', 'GH_TOKEN']) {
    if (!env[name]) fail('PRECONDITION_NOT_MET', `missing ${name}`);
  }
  let base;
  try { base = new URL(env.COOLIFY_BASE); } catch { fail('PRECONDITION_NOT_MET', 'invalid Coolify base URL'); }
  if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password) {
    fail('PRECONDITION_NOT_MET', 'Coolify base must be HTTP or HTTPS without URL credentials');
  }
  const gh = (args) => JSON.parse(execute('gh', ['api', ...args]));
  const issuePath = `repos/${repo}/issues`;
  const inspect = (ref) => JSON.parse(execute('docker', ['buildx', 'imagetools', 'inspect', ref, '--format', '{{json .Manifest}}'])).digest;
  const assertDigest = (selection) => {
    if (inspect(`${IMAGE}:latest`) !== selection.digest) fail('DEPLOYMENT_UNKNOWN', 'staging tag artifact mismatch');
  };
  const trigger = (selection) => triggerSelected(selection, env, fetch, {
    allowHttp: true,
    assertApplication: (app, artifact) => { assertStagingTag(app, artifact); assertDigest(artifact); },
    verifyFeatures: () => featureSmoke(),
  });
  return {
    assertUnfrozen: () => {
      const issues = JSON.parse(execute('gh', ['api', '--paginate', '--slurp', `${issuePath}?state=open&per_page=100`]));
      if (issues.flat().some((issue) => issue.title === FREEZE_TITLE)) fail('PRECONDITION_NOT_MET', 'staging is frozen; owner review required');
    },
    preflight: async (selection) => {
      const response = await fetch(new URL(`/api/v1/applications/${encodeURIComponent(env.COOLIFY_STUDENTHUB_GATEWAY_UUID)}`, base), {
        redirect: 'error', signal: AbortSignal.timeout(15_000), headers: { Authorization: `Bearer ${env.COOLIFY_TOKEN}` },
      });
      if (!response.ok) fail('PRECONDITION_NOT_MET', 'staging target could not be verified');
      assertStagingTag(await response.json(), selection);
    },
    previous: async () => {
      const digest = inspect(`${IMAGE}:latest`);
      if (!/^sha256:[a-f0-9]{64}$/.test(digest ?? '')) fail('PRECONDITION_NOT_MET', 'rollback digest unavailable');
      const pin = `${IMAGE}@${digest}`;
      // Read the baked revision, and smoke-test the rollback artifact as well.
      execute('docker', ['pull', pin]);
      const revision = execute('docker', ['run', '--rm', '--entrypoint', 'cat', pin, '/image-source-revision']).trim();
      if (!/^[a-f0-9]{40}$/.test(revision)) fail('PRECONDITION_NOT_MET', 'rollback revision unavailable');
      const response = await fetch(`${STAGING}/health`, { redirect: 'error', signal: AbortSignal.timeout(15_000) });
      const health = await response.json();
      if (!response.ok || health.status !== 'ok' || health.component !== 'gateway' || health.revision !== revision) fail('PRECONDITION_NOT_MET', 'rollback artifact is not the healthy running revision');
      execute('bash', ['deploy/coolify/image-smoke.sh', pin]);
      return { image: IMAGE, digest, pin, revision };
    },
    freeze: (selected, previous) => gh([issuePath, '-X', 'POST', '-f', `title=${FREEZE_TITLE}`, '-f', `body=Staging deployment in progress. This issue gates further staging deployments until verification succeeds. If interrupted or failed, retain the freeze for owner review.\nRun: https://github.com/${repo}/actions/runs/${env.GITHUB_RUN_ID}\nSelected: ${selected.pin} (${selected.revision})\nRollback: ${previous.pin} (${previous.revision})`]).number,
    promote: (selection) => execute('docker', ['buildx', 'imagetools', 'create', '--prefer-index=false', '--tag', `${IMAGE}:latest`, selection.pin]),
    assertDigest,
    trigger,
    unfreeze: (number) => gh([`${issuePath}/${number}`, '-X', 'PATCH', '-f', 'state=closed']),
    notify: (number, result) => gh([`${issuePath}/${number}/comments`, '-X', 'POST', '-f', `body=Staging deployment stopped: ${result.outcome}. Rollback: ${result.rollback}. Freeze retained; explicit owner review required before closing this issue. Production was not targeted.`]),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const selected = JSON.parse(readFileSync('selected-artifact.json', 'utf8'));
    if (selected.revision !== process.env.GITHUB_SHA) fail('PRECONDITION_NOT_MET', 'selection must match this main push');
    const result = await restoreAutomatically(selected, liveIO(process.env));
    writeFileSync('deployment-receipt.json', JSON.stringify(result) + '\n');
    console.log('DEPLOYMENT_SUCCEEDED: staging health, features and running revision verified');
  } catch (error) {
    const code = error instanceof DeploymentOutcome ? error.code : 'DEPLOYMENT_UNKNOWN';
    writeFileSync('deployment-receipt.json', JSON.stringify({ outcome: code }) + '\n');
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `outcome=${code}\n`);
    console.error(diagnostic(error));
    process.exitCode = 1;
  }
}
