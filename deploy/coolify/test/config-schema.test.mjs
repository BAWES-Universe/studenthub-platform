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

test("unset and blank optional url variables are accepted but configured ones are validated", () => {
  const schema = [
    ...CONFIG_SCHEMA,
    { name: "OPTIONAL_URL", required: false, kind: "url", secret: false },
    { name: "OPTIONAL_URL_LIST", required: false, kind: "url-list", secret: false },
  ];
  assert.doesNotThrow(() => validateDeploymentEnv(validEnv(), schema));
  assert.doesNotThrow(() => validateDeploymentEnv({ ...validEnv(), OPTIONAL_URL: " ", OPTIONAL_URL_LIST: "" }, schema));
  assert.throws(
    () => validateDeploymentEnv({ ...validEnv(), OPTIONAL_URL: "ftp://example.test" }, schema),
    { message: "OPTIONAL_URL must be a valid url" },
  );
  assert.throws(
    () => validateDeploymentEnv({ ...validEnv(), OPTIONAL_URL_LIST: "https://example.test," }, schema),
    { message: "OPTIONAL_URL_LIST must be a valid url-list" },
  );
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

test("platform database hosts reject names longer than 253 characters", () => {
  const hostname = Array(5).fill("a".repeat(63)).join(".");
  assert.equal(hostname.length, 319);
  assert.throws(
    () => validateDeploymentEnv({ ...validEnv(), PLATFORM_DATABASE_HOSTS: hostname }),
    { message: "PLATFORM_DATABASE_HOSTS must be a valid host-list" },
  );
});

test("errors never disclose secret configuration values", () => {
  const databaseSecret = "database-secret-value";
  const databaseEnv = { ...validEnv(), DATABASE_URL: databaseSecret };
  assert.throws(() => validateDeploymentEnv(databaseEnv), (error) => !error.message.includes(databaseSecret));
});
