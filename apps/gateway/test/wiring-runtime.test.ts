import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { createRuntimeLoginFromEnv } from "../src/login-runtime.js";

const env = {
  DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:1/synthetic",
  OIDC_ISSUER: "https://identity.test.invalid/", OIDC_CLIENT_ID: "synthetic", OIDC_CLIENT_SECRET: "synthetic",
  OIDC_CALLBACK_URL: "https://studenthub.test.invalid/login/callback",
  OIDC_AUTHORIZATION_URL: "https://identity.test.invalid/authorize", OIDC_TOKEN_URL: "https://identity.test.invalid/token",
  OIDC_JWKS_URL: "https://identity.test.invalid/jwks", LOGIN_ALLOWED_RETURN_URLS: "https://studenthub.test.invalid/profile",
};

const always = ["adminJobs", "adminOutbox", "callback", "companies", "exports", "logout", "navigation", "organizationAccountManager", "organizationBrands", "organizationCreation", "organizationStores", "payContracts", "profile", "start", "web"].sort();
const signed = [...always, "bankDetails", "browserEdit", "organizationApprovedToHire", "organizationCommercialTerms", "organizationDeletion", "organizationNotes", "organizationProfile", "organizationStatus", "preferences", "profileEdit"].sort();

test("PREP_WIRING_SHAPE preserves application and web keys with and without signing", async () => {
  for (const [environment, expected] of [[env, always], [{ ...env, SAFE_WRITE_SIGNING_KEY: Buffer.alloc(32, 7).toString("base64") }, signed]] as const) {
    const runtime = createRuntimeLoginFromEnv(environment)!;
    assert.deepEqual(Object.keys(runtime.application).sort(), expected);
    assert.deepEqual(Object.keys(runtime.application.web!).sort(), ["origin", "profiles", "returnTo"]);
    await runtime.close();
  }
});

test("PREP_WIRING_SOURCE keeps construction out of the login runtime", async () => {
  const source = await readFile(new URL("../src/login-runtime.js", import.meta.url), "utf8");
  for (const forbidden of ["new Postgres", "new pg.Pool", "new OrganizationRepository", "new ExportService"]) assert.doesNotMatch(source, new RegExp(forbidden.replace(".", "\\.")));
  for (const module of ["access", "profile", "organizations", "pay-contracts", "ops"]) assert.equal(source.split(`./wiring/${module}.js`).length - 1, 1);
  for (const module of ["access", "profile", "organizations", "pay-contracts", "ops"]) {
    const wired = await readFile(new URL(`../src/wiring/${module}.js`, import.meta.url), "utf8");
    assert.equal([...wired.matchAll(/export function wire[A-Za-z]+/g)].length, 1);
  }
});

test("PREP_WIRING_COUNT closes every independently constructed pool exactly once", async (t) => {
  const ended = new Map<pg.Pool, number>();
  t.mock.method(pg.Pool.prototype, "end", async function(this: pg.Pool) { ended.set(this, (ended.get(this) ?? 0) + 1); });
  for (const [environment, expected] of [[env, 19], [{ ...env, SAFE_WRITE_SIGNING_KEY: Buffer.alloc(32, 7).toString("base64") }, 25]] as const) {
    ended.clear();
    const runtime = createRuntimeLoginFromEnv(environment)!;
    await runtime.close();
    assert.equal(ended.size, expected);
    assert.ok([...ended.values()].every(count => count === 1));
  }
});
