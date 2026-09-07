import assert from "node:assert/strict";
import test from "node:test";

import { runLoginConformance } from "@studenthub/login-contract";

import { createLoginApplication } from "../src/login-application.js";
import {
  createRuntimeLoginFromEnv,
  HttpOidcTransport,
  RefreshingJwksResolver,
} from "../src/login-runtime.js";

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

test("runtime configuration rejects an empty return URL allowlist descriptively", () => {
  assert.throws(
    () => createRuntimeLoginFromEnv({
      DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:1/synthetic",
      OIDC_ISSUER: "https://identity.test.invalid/",
      OIDC_CLIENT_ID: "synthetic-client",
      OIDC_CLIENT_SECRET: "synthetic-secret",
      OIDC_CALLBACK_URL: "https://studenthub.test.invalid/login/callback",
      OIDC_AUTHORIZATION_URL: "https://identity.test.invalid/authorize",
      OIDC_TOKEN_URL: "https://identity.test.invalid/token",
      OIDC_JWKS_URL: "https://identity.test.invalid/jwks",
      LOGIN_ALLOWED_RETURN_URLS: "   ",
    }),
    /LOGIN_ALLOWED_RETURN_URLS must not be empty/,
  );
});

test("OIDC token and JWKS requests carry bounded abort signals", async () => {
  let calls = 0;
  const successfulFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    calls += 1;
    assert.ok(init?.signal);
    assert.equal(init.signal.aborted, false);
    if (calls === 1) {
      return new Response(JSON.stringify({ access_token: "access", id_token: "header.claims.signature" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    return new Response(JSON.stringify({ keys: [{ kid: "synthetic-key", kty: "OKP" }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const transport = new HttpOidcTransport(
    "https://identity.test.invalid/",
    "https://identity.test.invalid/authorize",
    "https://identity.test.invalid/token",
    1_000,
    successfulFetch,
  );
  assert.deepEqual(await transport.exchange({
    code: "synthetic-code",
    clientId: "synthetic-client",
    clientSecret: "synthetic-secret",
    redirectUri: "https://studenthub.test.invalid/login/callback",
    codeVerifier: "synthetic-verifier",
  }), { accessToken: "access", idToken: "header.claims.signature" });

  const resolver = new RefreshingJwksResolver(
    "https://identity.test.invalid/",
    "https://identity.test.invalid/jwks",
    300,
    1_000,
    successfulFetch,
  );
  assert.deepEqual(await resolver.resolve("https://identity.test.invalid/", "synthetic-key"), {
    kid: "synthetic-key",
    kty: "OKP",
  });
});

test("stalled OIDC token and JWKS requests terminate at the configured bound", async () => {
  const stalledFetch = ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      assert.ok(init?.signal);
      const failureTimer = setTimeout(() => reject(new Error("OIDC request did not abort")), 1_000);
      init.signal.addEventListener("abort", () => {
        clearTimeout(failureTimer);
        reject(init.signal?.reason);
      }, { once: true });
    })) as typeof fetch;

  const transport = new HttpOidcTransport(
    "https://identity.test.invalid/",
    "https://identity.test.invalid/authorize",
    "https://identity.test.invalid/token",
    10,
    stalledFetch,
  );
  await assert.rejects(
    transport.exchange({
      code: "synthetic-code",
      clientId: "synthetic-client",
      clientSecret: "synthetic-secret",
      redirectUri: "https://studenthub.test.invalid/login/callback",
      codeVerifier: "synthetic-verifier",
    }),
    { name: "TimeoutError" },
  );

  const resolver = new RefreshingJwksResolver(
    "https://identity.test.invalid/",
    "https://identity.test.invalid/jwks",
    300,
    10,
    stalledFetch,
  );
  await assert.rejects(
    resolver.resolve("https://identity.test.invalid/", "synthetic-key"),
    { name: "TimeoutError" },
  );
});
