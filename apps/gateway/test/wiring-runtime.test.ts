import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import pg from "pg";
import { createRuntimeLoginFromEnv } from "../src/login-runtime.js";
import { recruitPlacementPort, wireWork } from "../src/wiring/work.js";

const env = {
  DATABASE_URL: "postgres://synthetic:synthetic@127.0.0.1:1/synthetic",
  OIDC_ISSUER: "https://identity.test.invalid/", OIDC_CLIENT_ID: "synthetic", OIDC_CLIENT_SECRET: "synthetic",
  OIDC_CALLBACK_URL: "https://studenthub.test.invalid/login/callback",
  OIDC_AUTHORIZATION_URL: "https://identity.test.invalid/authorize", OIDC_TOKEN_URL: "https://identity.test.invalid/token",
  OIDC_JWKS_URL: "https://identity.test.invalid/jwks", LOGIN_ALLOWED_RETURN_URLS: "https://studenthub.test.invalid/profile",
};

const always = ["abuse", "access", "adminJobs", "adminOutbox", "area", "bankResults", "callback", "companies", "contacts", "exports", "financeContracts", "financeSettled", "financeTransfers", "invoices", "logout", "navigation", "organizationAccountManager", "organizationBrands", "organizationCreation", "organizationStores", "payContracts", "payHistory", "people", "platformIntegrations", "platformOperations", "profile", "recruitChecklist", "recruitEmployerView", "recruitFulltimers", "recruitInterviews", "recruitInvitations", "recruitJobs", "recruitPeopleSearch", "recruitPipeline", "recruitRequestApplications", "recruitRequests", "registrations", "staffView", "start", "storeManager", "team", "web"].sort();
const signed = [...always, "bankDetails", "browserEdit", "organizationApprovedToHire", "organizationCommercialTerms", "organizationDeletion", "organizationNotes", "organizationProfile", "organizationStatus", "preferences", "profileEdit"].sort();
const KEY = Buffer.alloc(32, 7).toString("base64");

test("PREP_WIRING_SHAPE preserves application and web keys with and without signing", async () => {
  // The work lane needs its own cutover switch as well as the signing key.
  for (const [environment, expected] of [[env, always], [{ ...env, SAFE_WRITE_SIGNING_KEY: KEY }, signed], [{ ...env, WORK_LANE_ENABLED: "true" }, always],
    [{ ...env, SAFE_WRITE_SIGNING_KEY: KEY, WORK_LANE_ENABLED: "false" }, signed]] as const) {
    const runtime = createRuntimeLoginFromEnv(environment)!;
    assert.deepEqual(Object.keys(runtime.application).sort(), expected);
    assert.deepEqual(Object.keys(runtime.application.web!).sort(), ["origin", "profiles", "returnTo"]);
    await runtime.close();
  }
});

test("PREP_WIRING_WORK_SWITCH a work lane switch other than true or false stops startup", () => {
  assert.throws(() => createRuntimeLoginFromEnv({ ...env, SAFE_WRITE_SIGNING_KEY: KEY, WORK_LANE_ENABLED: "yes" }), /WORK_LANE_ENABLED must be true or false/);
});

test("PREP_WIRING_WORK_PORTS store managers come from the access lane and notices from the comms lane; a partial notice port stops startup", async (t) => {
  t.mock.method(pg.Pool.prototype, "end", async () => {});
  const settings = { databaseUrl: env.DATABASE_URL, safeWriteKey: Buffer.from(KEY, "base64") } as unknown as Parameters<typeof wireWork>[0];
  const access = { authzStore: {} } as unknown as Parameters<typeof wireWork>[1];
  const managedStores = { async managedStores() { return []; } };
  // With no ports at all, the access lane's store managers and the comms lane's feed producers are used.
  const defaults = wireWork(settings, access, { enabled: true });
  assert.ok(defaults.services.work);
  await defaults.close();
  const notices = { async onDecided() {}, async onUndone() {} };
  // Without an explicit port the access lane's store-manager store is used.
  const withAccessStores = wireWork(settings, access, { enabled: true, notices });
  assert.ok(withAccessStores.services.work);
  await withAccessStores.close();
  // An empty or partial notice port would skip notices or their withdrawal, so it counts as missing.
  for (const partial of [{}, { onDecided: notices.onDecided }, { onUndone: notices.onUndone }]) {
    assert.throws(() => wireWork(settings, access, { enabled: true, managedStores, notices: partial }), /needs decision notice hooks with both onDecided and onUndone/, JSON.stringify(Object.keys(partial)));
  }
  const wired = wireWork(settings, access, { enabled: true, managedStores, notices });
  assert.ok(wired.services.work);
  await wired.close();
});

test("PREP_WIRING_SOURCE keeps construction out of the login runtime", async () => {
  const source = await readFile(new URL("../src/login-runtime.js", import.meta.url), "utf8");
  for (const forbidden of ["new Postgres", "new pg.Pool", "new OrganizationRepository", "new ExportService"]) assert.doesNotMatch(source, new RegExp(forbidden.replace(".", "\\.")));
  for (const module of ["access", "access-lane", "profile", "organizations", "pay-contracts", "ops", "work"]) assert.equal(source.split(`./wiring/${module}.js`).length - 1, 1);
  for (const module of ["access", "access-lane", "profile", "organizations", "pay-contracts", "ops", "work"]) {
    const wired = await readFile(new URL(`../src/wiring/${module}.js`, import.meta.url), "utf8");
    assert.equal([...wired.matchAll(/export function wire[A-Za-z]+/g)].length, 1);
  }
});

test("PREP_WIRING_COUNT closes every independently constructed pool exactly once", async (t) => {
  const ended = new Map<pg.Pool, number>();
  t.mock.method(pg.Pool.prototype, "end", async function(this: pg.Pool) { ended.set(this, (ended.get(this) ?? 0) + 1); });
  for (const [environment, expected] of [[env, 33], [{ ...env, SAFE_WRITE_SIGNING_KEY: KEY }, 39]] as const) {
    ended.clear();
    const runtime = createRuntimeLoginFromEnv(environment)!;
    await runtime.close();
    assert.equal(ended.size, expected);
    assert.ok([...ended.values()].every(count => count === 1));
  }
});

test("PREP_WIRING_RECRUIT_PLACEMENT the recruit stage's \"placed\" reaches the work lane's placeFromRecruit when the lane is on; off, recruit keeps its stub", async () => {
  assert.equal(recruitPlacementPort(undefined), undefined);
  const calls: unknown[][] = [];
  const placements = { placeFromRecruit: async (...args: unknown[]) => { calls.push(args); return { kind: "placed", assignmentId: "a-1", created: calls.length === 1 }; } };
  const port = recruitPlacementPort({ placements } as never)!;
  assert.equal(port.available, true);
  const request = { recruitCardId: "11111111-2222-4333-8444-555555555555", requestId: "66666666-7777-4888-8999-000000000000", personId: "person", storeId: "aaaaaaaa-0000-4000-8000-000000000001", startDate: null, endDate: null };
  assert.deepEqual(await port.placeFromRecruit("staff", request), { kind: "placed", assignmentId: "a-1", created: true });
  // A retry of the same card is passed through as is; PlacementService replays it (W1_RECRUIT, W1_PG).
  assert.deepEqual(await port.placeFromRecruit("staff", request), { kind: "placed", assignmentId: "a-1", created: false });
  assert.deepEqual(calls, [["staff", request], ["staff", request]]);
  // The runtime hands the port to wireRecruit.
  const source = await readFile(new URL("../src/login-runtime.js", import.meta.url), "utf8");
  assert.match(source, /wireRecruit\(settings, access\.services, recruitPlacementPort\(workArea\.services\.work\)\)/);
});
