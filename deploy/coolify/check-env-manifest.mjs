import { pathToFileURL } from "node:url";

import {
  assertManifestMatchesRuntime,
  DEPLOYMENT_ENV_MANIFEST,
} from "./deployment-env-manifest.mjs";

function requiredSetting(env, name) {
  const value = env[name];
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`deployment environment check configuration is missing ${name}`);
  }
  return value.trim();
}

export function missingRequiredEnv(entries, required = DEPLOYMENT_ENV_MANIFEST.required) {
  if (!Array.isArray(entries)) {
    throw new Error("Coolify returned an invalid environment-variable list");
  }

  const deployed = new Set();
  for (const entry of entries) {
    if (
      !entry
      || typeof entry !== "object"
      || entry.is_preview === true
      || entry.is_runtime === false
      || typeof entry.key !== "string"
    ) continue;
    deployed.add(entry.key.trim());
  }

  return required.filter((key) => !deployed.has(key));
}

export function failureMessage({ application, applicationUuid, missing }) {
  const keys = missing.join(", ");
  return `Coolify deployment environment check failed for ${application} application ${applicationUuid}: missing required variables: ${keys}. Set ${keys} on Coolify application ${applicationUuid} before retrying this workflow.`;
}

export async function checkCoolifyEnv({
  baseUrl,
  token,
  applicationUuid,
  fetchImplementation = fetch,
  manifest = DEPLOYMENT_ENV_MANIFEST,
}) {
  const endpoint = `${baseUrl.replace(/\/+$/, "")}/api/v1/applications/${encodeURIComponent(applicationUuid)}/envs`;
  let response;
  try {
    response = await fetchImplementation(endpoint, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${token}`,
      },
    });
  } catch {
    throw new Error(`Coolify deployment environment check could not read application ${applicationUuid}`);
  }

  if (!response?.ok) {
    const status = Number.isInteger(response?.status) ? ` (HTTP ${response.status})` : "";
    throw new Error(`Coolify deployment environment check could not read application ${applicationUuid}${status}`);
  }

  let entries;
  try {
    entries = await response.json();
  } catch {
    throw new Error(`Coolify deployment environment check received invalid JSON for application ${applicationUuid}`);
  }
  const missing = missingRequiredEnv(entries, manifest.required);
  if (missing.length > 0) {
    throw new Error(failureMessage({
      application: manifest.application,
      applicationUuid,
      missing,
    }));
  }
  return { application: manifest.application, applicationUuid, checked: manifest.required.length };
}

export async function runFromEnv({
  env = process.env,
  fetchImplementation = fetch,
  stdout = process.stdout,
} = {}) {
  assertManifestMatchesRuntime(DEPLOYMENT_ENV_MANIFEST);
  const result = await checkCoolifyEnv({
    baseUrl: requiredSetting(env, "COOLIFY_BASE"),
    token: requiredSetting(env, "COOLIFY_READ_TOKEN"),
    applicationUuid: requiredSetting(env, "COOLIFY_STUDENTHUB_GATEWAY_UUID"),
    fetchImplementation,
    manifest: DEPLOYMENT_ENV_MANIFEST,
  });
  stdout.write(`Coolify deployment environment verified for ${result.application} application ${result.applicationUuid}: ${result.checked} required runtime keys are present.\n`);
  return result;
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  try {
    await runFromEnv();
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : "Coolify deployment environment check failed"}\n`);
    process.exitCode = 1;
  }
}
