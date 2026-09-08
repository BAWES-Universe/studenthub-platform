import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { checkReadiness } from "../healthcheck.mjs";
import { validateApplicationEnv, validateDeploymentEnv } from "../preflight.mjs";

const validEnv = {
  HOST: "0.0.0.0",
  DATABASE_URL: "postgresql://studenthub:secret@platform-postgres:5432/studenthub",
  OIDC_ISSUER: "https://auth.example.test/application/o/studenthub/",
  OIDC_CLIENT_ID: "studenthub",
  OIDC_CLIENT_SECRET: "secret",
  OIDC_CALLBACK_URL: "https://studenthub.example.test/login/callback",
  OIDC_AUTHORIZATION_URL: "https://auth.example.test/application/o/authorize/",
  OIDC_TOKEN_URL: "https://auth.example.test/application/o/token/",
  OIDC_JWKS_URL: "https://auth.example.test/application/o/studenthub/jwks/",
  LOGIN_ALLOWED_RETURN_URLS: "https://studenthub.example.test/",
  SOURCE_REVISION: "a".repeat(40),
};
const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

test("deployment preflight accepts a complete explicit configuration", () => {
  assert.doesNotThrow(() => validateDeploymentEnv(validEnv));
});

test("deployment preflight exercises the gateway's real login configuration", async () => {
  await assert.doesNotReject(() => validateApplicationEnv(validEnv));
  await assert.rejects(
    () => validateApplicationEnv({ ...validEnv, OIDC_CALLBACK_URL: "http://studenthub.example.test/login/callback" }),
    /OIDC_CALLBACK_URL must use https/,
  );
});

test("the container preflight CLI cannot bypass real gateway validation", () => {
  const result = spawnSync(process.execPath, ["deploy/coolify/preflight.mjs"], {
    cwd: repositoryRoot,
    encoding: "utf8",
    env: { ...process.env, ...validEnv, OIDC_CALLBACK_URL: "http://studenthub.example.test/login/callback" },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /OIDC_CALLBACK_URL must use https/);
});

test("deployment preflight fails closed on missing configuration", () => {
  for (const name of ["DATABASE_URL", "OIDC_CLIENT_SECRET", "SOURCE_REVISION"]) {
    const env = { ...validEnv };
    delete env[name];
    assert.throws(() => validateDeploymentEnv(env), new RegExp(name));
  }
});

test("deployment preflight rejects a loopback bind and an unpinned revision", () => {
  assert.throws(() => validateDeploymentEnv({ ...validEnv, HOST: "127.0.0.1" }), /HOST must be 0\.0\.0\.0/);
  assert.throws(() => validateDeploymentEnv({ ...validEnv, SOURCE_REVISION: "main" }), /40-character Git commit SHA/);
});

function database(overrides = {}) {
  return {
    async query() {},
    async end() {},
    ...overrides,
  };
}

test("readiness requires both PostgreSQL and the gateway", async () => {
  let queried = false;
  await checkReadiness({
    databaseUrl: validEnv.DATABASE_URL,
    connect: async () => database({ async query() { queried = true; } }),
    fetchImplementation: async () => new Response(JSON.stringify({ status: "ok", component: "gateway" })),
  });
  assert.equal(queried, true);

  await assert.rejects(() => checkReadiness({
    databaseUrl: validEnv.DATABASE_URL,
    connect: async () => { throw new Error("database unavailable"); },
    fetchImplementation: async () => new Response(JSON.stringify({ status: "ok", component: "gateway" })),
  }), /database unavailable/);

  await assert.rejects(() => checkReadiness({
    databaseUrl: validEnv.DATABASE_URL,
    connect: async () => database(),
    fetchImplementation: async () => new Response("unavailable", { status: 503 }),
  }), /gateway health returned 503/);
});
