import { readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { IMAGE } from './select-artifact.mjs';

export class DeploymentOutcome extends Error {
  constructor(code, detail) {
    super(`${code}: ${detail}`);
    this.name = 'DeploymentOutcome';
    this.code = code;
  }
}
const outcome = (code, detail) => new DeploymentOutcome(code, detail);

export function assertSelectedApplication(application, selection) {
  if (selection?.image !== IMAGE || !/^sha256:[a-f0-9]{64}$/.test(selection?.digest ?? '')
    || !/^[a-f0-9]{40}$/.test(selection?.revision ?? '')
    || selection.pin !== `${IMAGE}@${selection.digest}`
    || application?.build_pack !== 'dockerimage'
    || application.docker_registry_image_name !== IMAGE
    || application.docker_registry_image_tag !== selection.digest.replace(':', '-')
    || application.fqdn !== 'https://staging.studenthub.co') {
    throw outcome('PRECONDITION_NOT_MET', 'staging application must already pin the selected digest; verify Docker Image mode, repository, sha256-<digest> tag and staging domain before triggering');
  }
}

export async function triggerSelected(selection, env = process.env, request = fetch, {
  timeoutMs = 300_000, intervalMs = 5_000, now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  for (const key of ['COOLIFY_BASE', 'COOLIFY_TOKEN', 'COOLIFY_STUDENTHUB_GATEWAY_UUID']) {
    if (!env[key]) throw outcome('PRECONDITION_NOT_MET', `missing ${key}`);
  }
  let base;
  try { base = new URL(env.COOLIFY_BASE); } catch {
    throw outcome('PRECONDITION_NOT_MET', 'invalid Coolify base URL');
  }
  if (base.protocol !== 'https:' || base.username || base.password) {
    throw outcome('PRECONDITION_NOT_MET', 'Coolify requires an HTTPS base URL without credentials');
  }
  const uuid = encodeURIComponent(env.COOLIFY_STUDENTHUB_GATEWAY_UUID);
  const deadline = now() + timeoutMs;
  const call = async (path, method, authenticated = true) => {
    try {
      const response = await request(new URL(path, base), {
        method, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(15_000, deadline - now()))),
        headers: { ...(authenticated ? { Authorization: `Bearer ${env.COOLIFY_TOKEN}` } : {}),
          Accept: 'application/json', 'Cache-Control': 'no-cache' },
      });
      // A server error or lost response may occur after acceptance. Never retry POST.
      if (!response.ok) throw outcome(method === 'POST' && [400, 401, 403, 404, 405, 422, 429].includes(response.status)
        ? 'TRIGGER_REJECTED' : 'DEPLOYMENT_UNKNOWN', `Coolify ${method} failed (HTTP ${response.status}); inspect history before retrying`);
      return await response.json();
    } catch (error) {
      if (error instanceof DeploymentOutcome) throw error;
      throw outcome('DEPLOYMENT_UNKNOWN', 'request timed out, response lost or unreadable; inspect history before retrying');
    }
  };
  assertSelectedApplication(await call(`/api/v1/applications/${uuid}`, 'GET'), selection);
  const result = await call(`/api/v1/deploy?uuid=${uuid}`, 'POST');
  if (!Array.isArray(result?.deployments) || !result.deployments.length
    || result.deployments.some((item) => typeof item?.deployment_uuid !== 'string'
      || !/^[a-zA-Z0-9_-]+$/.test(item.deployment_uuid)
      || (item.resource_uuid !== undefined && item.resource_uuid !== env.COOLIFY_STUDENTHUB_GATEWAY_UUID))) {
    throw outcome('DEPLOYMENT_UNKNOWN', 'Coolify returned no deployment UUID or an unverifiable receipt; inspect history before retrying');
  }
  const receipt = { ...selection, applicationUuid: env.COOLIFY_STUDENTHUB_GATEWAY_UUID,
    deploymentUuids: [...new Set(result.deployments.map((item) => item.deployment_uuid))] };
  try {
    while (now() < deadline) {
      let finished = true;
      for (const id of receipt.deploymentUuids) {
        const deployment = await call(`/api/v1/deployments/${encodeURIComponent(id)}`, 'GET');
        if (deployment?.deployment_uuid !== id) {
          throw outcome('DEPLOYMENT_UNKNOWN', 'deployment lookup did not return the requested UUID');
        }
        if (['failed', 'cancelled', 'cancelled-by-user'].includes(deployment.status)) {
          throw outcome('DEPLOYMENT_FAILED', 'recorded deployment reached a failed or cancelled terminal status');
        }
        if (!['queued', 'in_progress', 'finished'].includes(deployment.status)) {
          throw outcome('DEPLOYMENT_UNKNOWN', 'deployment status is unrecognized');
        }
        finished &&= deployment.status === 'finished';
      }
      if (finished) {
        const application = await call(`/api/v1/applications/${uuid}`, 'GET');
        try { assertSelectedApplication(application, selection); } catch {
          throw outcome('DEPLOYMENT_UNKNOWN', 'application pin changed after triggering');
        }
        if (application.status === 'running:healthy') {
          const health = await call('https://staging.studenthub.co/health', 'GET', false);
          if (health?.status === 'ok' && health.component === 'gateway' && health.revision === selection.revision
            && now() < deadline) return { ...receipt, outcome: 'DEPLOYMENT_SUCCEEDED' };
        }
      }
      await sleep(Math.max(0, Math.min(intervalMs, deadline - now())));
    }
    throw outcome('DEPLOYMENT_UNKNOWN', 'verification timed out without a verified healthy selected deployment');
  } catch (error) {
    error.receipt = receipt;
    throw error;
  }
}

// Only our fixed diagnostics are printable; remote bodies, tokens and arbitrary errors are not.
export function diagnostic(error) {
  return error instanceof DeploymentOutcome ? error.message
    : 'DEPLOYMENT_UNKNOWN: selection could not be read or receipt could not be recorded';
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const receipt = await triggerSelected(JSON.parse(readFileSync(process.argv[2], 'utf8')));
    writeFileSync('deployment-receipt.json', `${JSON.stringify(receipt)}\n`, { mode: 0o600 });
    console.log('DEPLOYMENT_SUCCEEDED: selected deployment finished and healthy revision verified');
  } catch (error) {
    if (error.receipt) {
      try { writeFileSync('deployment-receipt.json', `${JSON.stringify({ ...error.receipt, outcome: error.code })}\n`, { mode: 0o600 }); } catch { /* retain original safe diagnostic */ }
    }
    console.error(diagnostic(error));
    process.exitCode = 1;
  }
}
