import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import { REQUIRED_DEPLOYMENT_ENV } from "./preflight.mjs";

// HOST and PLATFORM_DATABASE_HOSTS are semantic inputs to fail-closed checks,
// rather than simple non-empty requirements. They still need explicit env-store
// entries before an image may be built for the Coolify application.
export const REQUIRED_COOLIFY_ENV = Object.freeze([
  "HOST",
  ...REQUIRED_DEPLOYMENT_ENV,
  "PLATFORM_DATABASE_HOSTS",
]);

export function loadDeploymentEnvManifest(path = new URL("./deployment-env-manifest.json", import.meta.url)) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("deployment environment manifest must be readable JSON");
  }
  if (manifest?.schemaVersion !== 1 || manifest.application !== "studenthub-gateway" || !Array.isArray(manifest.required)) {
    throw new Error("deployment environment manifest has an invalid schema");
  }
  if (manifest.required.some((key) => typeof key !== "string" || !/^[A-Z][A-Z0-9_]*$/.test(key))) {
    throw new Error("deployment environment manifest contains an invalid key");
  }
  if (new Set(manifest.required).size !== manifest.required.length) {
    throw new Error("deployment environment manifest contains duplicate keys");
  }
  return Object.freeze({ ...manifest, required: Object.freeze([...manifest.required]) });
}

export const DEPLOYMENT_ENV_MANIFEST = loadDeploymentEnvManifest();

export function assertManifestMatchesRuntime(manifest = DEPLOYMENT_ENV_MANIFEST) {
  if (
    manifest.required.length !== REQUIRED_COOLIFY_ENV.length
    || REQUIRED_COOLIFY_ENV.some((key, index) => manifest.required[index] !== key)
  ) {
    throw new Error("deployment environment manifest is out of sync with runtime preflight requirements");
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  process.stdout.write(`${JSON.stringify(DEPLOYMENT_ENV_MANIFEST)}\n`);
}
