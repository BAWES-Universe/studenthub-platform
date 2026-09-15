import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

export const REQUIRED_DEPLOYMENT_ENV = Object.freeze([
  "DATABASE_URL",
  "OIDC_ISSUER",
  "OIDC_CLIENT_ID",
  "OIDC_CLIENT_SECRET",
  "OIDC_CALLBACK_URL",
  "OIDC_AUTHORIZATION_URL",
  "OIDC_TOKEN_URL",
  "OIDC_JWKS_URL",
  "LOGIN_ALLOWED_RETURN_URLS",
]);

export function validateDeploymentEnv(env = process.env) {
  const missing = REQUIRED_DEPLOYMENT_ENV.filter((name) => !env[name]?.trim());
  if (missing.length > 0) {
    throw new Error(`missing required deployment variables: ${missing.join(", ")}`);
  }
  if (env.HOST !== "0.0.0.0") {
    throw new Error("HOST must be 0.0.0.0 in the gateway container");
  }
  let databaseUrl;
  try {
    databaseUrl = new URL(env.DATABASE_URL);
  } catch {
    throw new Error("DATABASE_URL must be a valid URL");
  }
  if (databaseUrl.protocol !== "postgres:" && databaseUrl.protocol !== "postgresql:") {
    throw new Error("DATABASE_URL must use postgres:// or postgresql://");
  }
  if (!databaseUrl.hostname || !databaseUrl.pathname.slice(1)) {
    throw new Error("DATABASE_URL must name a database host and database");
  }
  const platformDatabaseHosts = new Set([
    "platform-postgres",
    ...(env.PLATFORM_DATABASE_HOSTS ?? "").split(",").map((host) => host.trim().toLowerCase()).filter(Boolean),
  ]);
  if (!platformDatabaseHosts.has(databaseUrl.hostname.toLowerCase())) {
    throw new Error("DATABASE_URL hostname must identify the dedicated platform database");
  }

  let profileUrl;
  try {
    profileUrl = new URL("/profile", env.OIDC_CALLBACK_URL);
  } catch {
    throw new Error("OIDC_CALLBACK_URL must be a valid URL");
  }
  const requiredProfileUrl = profileUrl.href;
  const allowedReturnUrls = env.LOGIN_ALLOWED_RETURN_URLS.split(",").map((url) => url.trim());
  if (!allowedReturnUrls.includes(requiredProfileUrl)) {
    profileUrl.username = "";
    profileUrl.password = "";
    throw new Error(`LOGIN_ALLOWED_RETURN_URLS must include ${profileUrl.href}`);
  }
}

export function validateImageRevision(path = "/image-source-revision") {
  const revision = readFileSync(path, "utf8").trim();
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    throw new Error("image source revision must be the deployed 40-character Git commit SHA");
  }
  return revision;
}

export async function validateApplicationEnv(env = process.env) {
  const { createRuntimeLoginFromEnv } = await import("../../dist/apps/gateway/src/login-runtime.js");
  const runtime = createRuntimeLoginFromEnv(env);
  if (!runtime) throw new Error("login runtime must be configured for deployment");
  await runtime.close();
}

export async function runPreflight({
  env = process.env,
  revisionPath = "/image-source-revision",
  validateApplication = validateApplicationEnv,
} = {}) {
  validateDeploymentEnv(env);
  await validateApplication(env);
  validateImageRevision(revisionPath);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  try {
    await runPreflight();
  } catch (error) {
    process.stderr.write(`deployment preflight failed: ${error instanceof Error ? error.message : "unknown error"}\n`);
    process.exitCode = 1;
  }
}
