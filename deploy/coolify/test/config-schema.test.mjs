import test from "node:test";
import assert from "node:assert/strict";
import { CONFIG_SCHEMA, REQUIRED_DEPLOYMENT_ENV, validateDeploymentEnv } from "../preflight.mjs";

const requiredNames = [
  "DATABASE_URL", "OIDC_ISSUER", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET", "OIDC_CALLBACK_URL",
  "OIDC_AUTHORIZATION_URL", "OIDC_TOKEN_URL", "OIDC_JWKS_URL", "LOGIN_ALLOWED_RETURN_URLS",
];

function validEnv() {
  return {
    DATABASE_URL: "postgres://user:password@platform-postgres/studenthub",
    OIDC_ISSUER: "https://identity.example.test",
    OIDC_CLIENT_ID: "studenthub",
    OIDC_CLIENT_SECRET: "client-secret-for-testing",
    OIDC_CALLBACK_URL: "https://studenthub.example.test/login/callback",
    OIDC_AUTHORIZATION_URL: "https://identity.example.test/authorize",
    OIDC_TOKEN_URL: "https://identity.example.test/token",
    OIDC_JWKS_URL: "https://identity.example.test/keys",
    LOGIN_ALLOWED_RETURN_URLS: "https://studenthub.example.test/profile",
    HOST: "0.0.0.0",
  };
}

test("schema is frozen and derives the exact required deployment names", () => {
  assert.deepEqual(REQUIRED_DEPLOYMENT_ENV, requiredNames);
  assert.ok(Object.isFrozen(CONFIG_SCHEMA));
  assert.ok(CONFIG_SCHEMA.every(Object.isFrozen));
});

test("every required deployment variable is independently required", () => {
  for (const name of requiredNames) {
    const env = validEnv();
    delete env[name];
    assert.throws(() => validateDeploymentEnv(env), (error) => error.message.includes(name));
  }
});

test("closed schema rejects undeclared OIDC variables", () => {
  const env = { ...validEnv(), OIDC_UNDECLARED: "anything" };
  assert.throws(() => validateDeploymentEnv(env), /unknown configuration variable OIDC_UNDECLARED/);
});

test("errors never disclose secret configuration values", () => {
  const databaseSecret = "database-secret-value";
  const databaseEnv = { ...validEnv(), DATABASE_URL: databaseSecret };
  assert.throws(() => validateDeploymentEnv(databaseEnv), (error) => !error.message.includes(databaseSecret));

  const clientSecret = "client-secret-value";
  const clientEnv = { ...validEnv(), OIDC_CLIENT_SECRET: clientSecret, HOST: "wrong" };
  assert.throws(() => validateDeploymentEnv(clientEnv), (error) => !error.message.includes(clientSecret));
});
