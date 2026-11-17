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

const always = ["adminJobs", "adminOutbox", "area", "callback", "companies", "exports", "logout", "navigation", "organizationAccountManager", "organizationBrands", "organizationCreation", "organizationStores", "payContracts", "people", "profile", "start", "web"].sort();
const signed = [...always, "bankDetails", "browserEdit", "organizationApprovedToHire", "organizationCommercialTerms", "organizationDeletion", "organizationNotes", "organizationProfile", "organizationStatus", "preferences", "profileEdit"].sort();
const KEY = Buffer.alloc(32, 7).toString("base64");

test("PREP_WIRING_SHAPE preserves application and web keys with and without signing", async () => {
  // The work lane needs its own cutover switch as well as the signing key.
  for (const [environment, expected] of [[env, always], [{ ...env, SAFE_WRITE_SIGNING_KEY: KEY }, signed], [{ ...env, WORK_LANE_ENABLED: "true" }, always],
    [{ ...env, SAFE_WRITE_SIGNING_KEY: KEY, WORK_LANE_ENABLED: "false" }, signed], [{ ...env, SAFE_WRITE_SIGNING_KEY: KEY, WORK_LANE_ENABLED: "true" }, [...signed, "work"].sort()]] as const) {
    const runtime = createRuntimeLoginFromEnv(environment)!;
    assert.deepEqual(Object.keys(runtime.application).sort(), expected);
    assert.deepEqual(Object.keys(runtime.application.web!).sort(), ["origin", "profiles", "returnTo"]);
    await runtime.close();
  }
});

test("PREP_WIRING_WORK_SWITCH a work lane switch other than true or false stops startup", () => {
  assert.throws(() => createRuntimeLoginFromEnv({ ...env, SAFE_WRITE_SIGNING_KEY: KEY, WORK_LANE_ENABLED: "yes" }), /WORK_LANE_ENABLED must be true or false/);
});

test("PREP_WIRING_SOURCE keeps construction out of the login runtime", async () => {
  const source = await readFile(new URL("../src/login-runtime.js", import.meta.url), "utf8");
  for (const forbidden of ["new Postgres", "new pg.Pool", "new OrganizationRepository", "new ExportService"]) assert.doesNotMatch(source, new RegExp(forbidden.replace(".", "\\.")));
  for (const module of ["access", "profile", "organizations", "pay-contracts", "ops", "work"]) assert.equal(source.split(`./wiring/${module}.js`).length - 1, 1);
  for (const module of ["access", "profile", "organizations", "pay-contracts", "ops", "work"]) {
    const wired = await readFile(new URL(`../src/wiring/${module}.js`, import.meta.url), "utf8");
    assert.equal([...wired.matchAll(/export function wire[A-Za-z]+/g)].length, 1);
  }
});

test("PREP_WIRING_COUNT closes every independently constructed pool exactly once", async (t) => {
  const ended = new Map<pg.Pool, number>();
  t.mock.method(pg.Pool.prototype, "end", async function(this: pg.Pool) { ended.set(this, (ended.get(this) ?? 0) + 1); });
  for (const [environment, expected] of [[env, 20], [{ ...env, SAFE_WRITE_SIGNING_KEY: KEY }, 26], [{ ...env, SAFE_WRITE_SIGNING_KEY: KEY, WORK_LANE_ENABLED: "true" }, 27]] as const) {
    ended.clear();
    const runtime = createRuntimeLoginFromEnv(environment)!;
    await runtime.close();
    assert.equal(ended.size, expected);
    assert.ok([...ended.values()].every(count => count === 1));
  }
});
