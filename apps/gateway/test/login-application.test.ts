import assert from "node:assert/strict";
import test from "node:test";

import { runLoginConformance } from "@studenthub/login-contract";

import { createLoginApplication } from "../src/login-application.js";
import { createRuntimeLoginFromEnv } from "../src/login-runtime.js";

test("the real gateway login implementation satisfies the executable OIDC contract", async () => {
  const report = await runLoginConformance(createLoginApplication);
  assert.equal(
    report.ok,
    true,
    report.results.filter((result) => !result.ok).map((result) => `${result.name}: ${result.detail}`).join("\n"),
  );
  assert.equal(report.results.length, 7);
});

test("runtime login stays disabled when unconfigured and rejects partial configuration", () => {
  assert.equal(createRuntimeLoginFromEnv({}), undefined);
  assert.throws(
    () => createRuntimeLoginFromEnv({ OIDC_ISSUER: "https://identity.test.invalid/" }),
    /incomplete login configuration/,
  );
});

test("runtime configuration rejects non-HTTPS identity endpoints before opening PostgreSQL", () => {
  assert.throws(
    () => createRuntimeLoginFromEnv({
      DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:1/synthetic",
      OIDC_ISSUER: "http://identity.test.invalid/",
      OIDC_CLIENT_ID: "synthetic-client",
      OIDC_CLIENT_SECRET: "synthetic-secret",
      OIDC_CALLBACK_URL: "https://studenthub.test.invalid/login/callback",
      OIDC_AUTHORIZATION_URL: "https://identity.test.invalid/authorize",
      OIDC_TOKEN_URL: "https://identity.test.invalid/token",
      OIDC_JWKS_URL: "https://identity.test.invalid/jwks",
      LOGIN_ALLOWED_RETURN_URLS: "https://studenthub.test.invalid/home",
    }),
    /OIDC_ISSUER must use https/,
  );
});
