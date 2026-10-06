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
    const databaseSecret = env.DATABASE_URL;
    const clientSecret = env.OIDC_CLIENT_SECRET;
    delete env[name];
    assert.throws(
      () => validateDeploymentEnv(env),
      (error) => error.message.includes(name)
        && !error.message.includes(databaseSecret)
        && !error.message.includes(clientSecret),
    );
  }
});

test("an empty optional platform database host list is accepted", () => {
  assert.doesNotThrow(() => validateDeploymentEnv({ ...validEnv(), PLATFORM_DATABASE_HOSTS: "" }));
});

test("closed schema rejects undeclared OIDC variables", () => {
  const env = { ...validEnv(), OIDC_UNDECLARED: "anything" };
  assert.throws(() => validateDeploymentEnv(env), /unknown configuration variable OIDC_UNDECLARED/);
});

test("closed schema rejects undeclared LOGIN variables", () => {
  assert.throws(
    () => validateDeploymentEnv({ ...validEnv(), LOGIN_UNDECLARED: "anything" }),
    { message: "unknown configuration variable LOGIN_UNDECLARED" },
  );
});

test("url variables reject invalid URLs and non-http schemes", () => {
  for (const value of ["not a url", "javascript:alert(1)", "ftp://identity.example.test", "file:///issuer", "data:text/plain,test"]) {
    assert.throws(
      () => validateDeploymentEnv({ ...validEnv(), OIDC_ISSUER: value }),
      { message: "OIDC_ISSUER must be a valid url" },
    );
  }
});

test("url-list variables reject invalid URLs, non-http schemes, and empty parts", () => {
  for (const value of [
    "not a url",
    "ftp://studenthub.example.test/profile",
    "https://studenthub.example.test/profile,",
    "https://studenthub.example.test/profile,,https://other.example.test/profile",
  ]) {
    assert.throws(
      () => validateDeploymentEnv({ ...validEnv(), LOGIN_ALLOWED_RETURN_URLS: value }),
      { message: "LOGIN_ALLOWED_RETURN_URLS must be a valid url-list" },
    );
  }
});

test("platform database hosts must be hostnames and reject empty parts", () => {
  const invalidHosts = [
    "-reporting-db", "reporting-db-", "reporting_db", ".reporting-db", "reporting-db.",
    `${"a".repeat(64)}.example`, `${"a".repeat(250)}.com`, "reporting-db,", "reporting-db,,isolated-platform-db",
  ];
  for (const value of invalidHosts) {
    assert.throws(
      () => validateDeploymentEnv({ ...validEnv(), PLATFORM_DATABASE_HOSTS: value }),
      { message: "PLATFORM_DATABASE_HOSTS must be a valid host-list" },
    );
  }
  assert.doesNotThrow(() => validateDeploymentEnv({
    ...validEnv(),
    PLATFORM_DATABASE_HOSTS: "reporting-db, isolated-platform-db",
  }));
});

test("errors never disclose secret configuration values", () => {
  const databaseSecret = "database-secret-value";
  const databaseEnv = { ...validEnv(), DATABASE_URL: databaseSecret };
  assert.throws(() => validateDeploymentEnv(databaseEnv), (error) => !error.message.includes(databaseSecret));
});
