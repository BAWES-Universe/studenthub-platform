import assert from "node:assert/strict";
import test from "node:test";
import type { GatewayRoute, GatewayRouteContext } from "../src/routes/context.js";

const routesModule = process.env.SHU497_ROUTES_MODULE ?? new URL("../src/routes/index.js", import.meta.url).href;
const contextModule = process.env.SHU497_CONTEXT_MODULE ?? new URL("../src/routes/context.js", import.meta.url).href;

test("PREP_ORDER routes retain the exact gateway handler order", async () => {
  const { ROUTES } = await import(routesModule) as typeof import("../src/routes/index.js");
  assert.deepEqual(ROUTES.map((route) => route.name), [
    "catalogue", "candidate-documents", "organization-documents", "profile-edit-page", "profile-edit",
    "profile-browser-edit", "language-preference-page", "language-preference", "bank-details",
    "organization-profile", "organization-status", "organization-commercial-terms",
    "organization-approved-to-hire", "organization-notes", "pay-contracts", "organization-brands",
    "organization-stores", "organization-deletion", "organization-creation",
    "organization-account-manager-page", "organization-account-manager", "profile-records",
  ]);
  assert.equal(ROUTES.length, 22);
  for (const route of ROUTES) assert.equal(typeof route.handle, "function");
});

test("PREP_FIRST_WINS runRoutes short-circuits, preserves context, returns false, and propagates", async () => {
  const { runRoutes } = await import(contextModule) as typeof import("../src/routes/context.js");
  const ctx = {} as GatewayRouteContext;
  const calls: GatewayRouteContext[] = [];
  const route = (name: string, result: boolean): GatewayRoute => ({ name, handle: async (seen) => { calls.push(seen); return result; } });
  assert.equal(await runRoutes([route("one", false), route("two", true), route("three", true)], ctx), true);
  assert.equal(calls.length, 2);
  assert.ok(calls.every((seen) => seen === ctx));
  calls.length = 0;
  assert.equal(await runRoutes([route("one", false), route("two", false)], ctx), false);
  assert.equal(calls.length, 2);
  const failure = new Error("route failure");
  await assert.rejects(runRoutes([{ name: "throw", handle: async () => { throw failure; } }], ctx), (error) => error === failure);
});

test("PREP_LOOP compiled gateway delegates once before built-in routes", async () => {
  const { readFile } = await import("node:fs/promises");
  const source = await readFile(new URL("../src/index.js", import.meta.url), "utf8");
  assert.equal((source.match(/runRoutes\(ROUTES,/g) ?? []).length, 1);
  assert.ok(source.indexOf("runRoutes(ROUTES,") < source.indexOf('request.url?.split("?", 1)[0] === "/"'));
  for (const name of ["handleCatalogue", "handleCandidateDocuments", "handleOrganizationDocuments", "handleProfileEditPage", "handlePayContracts", "handleProfileRecords"]) {
    assert.doesNotMatch(source, new RegExp(`\\b${name}\\b`));
  }
});
