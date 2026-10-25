import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryCatalogueStore, ReferenceCatalogue } from "@studenthub/reference-catalogue";
import { createGatewayServer } from "../src/index.js";
import { createAuthzFixture, TEST_ORG } from "./helpers/authz.js";

test("SHU344_HTTP currency detail routes authenticate and validate admin writes", async (context: TestContext) => {
  const fixture = await createAuthzFixture(); await fixture.store.revokeMany("p-1", [{ orgId: TEST_ORG, role: "staff" }]); await fixture.store.grantMany("p-1", [{ orgId: TEST_ORG, role: "admin" }]);
  const service = new ReferenceCatalogue(new InMemoryCatalogueStore(), () => new Date("2026-10-15T10:00:00.000Z"));
  const actor = { principalRef: "a".repeat(64), orgId: TEST_ORG, role: "admin" as const };
  const currency = await service.create(actor, "currency", { name: "Kuwaiti Dinar", code: "KWD" }); const empty = await service.create(actor, "currency", { name: "Dollar", code: "USD" });
  const server = createGatewayServer(undefined, undefined, fixture.middleware, undefined, null, undefined, undefined, service); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); context.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== "string"); const origin = `http://127.0.0.1:${address.port}`;
  const adminHeaders = async () => ({ "content-type": "application/json", "x-actor-assertion": await fixture.mint({ act: { org: TEST_ORG, role: "admin" } }) });
  assert.equal((await fetch(`${origin}/catalogue/currency/${currency.id}/details`)).status, 401);
  const put = await fetch(`${origin}/catalogue/currency/${currency.id}/details`, { method: "PUT", headers: await adminHeaders(), body: JSON.stringify({ symbol: "KD", decimalPlaces: 3 }) }); assert.equal(put.status, 200);
  const expected = { currencyId: currency.id, symbol: "KD", decimalPlaces: 3, updatedAt: "2026-10-15T10:00:00.000Z" }; assert.deepEqual(await put.json(), expected);
  const get = await fetch(`${origin}/catalogue/currency/${currency.id}/details`, { headers: await adminHeaders() }); assert.equal(get.status, 200); assert.deepEqual(await get.json(), expected);
  const malformed = await fetch(`${origin}/catalogue/currency/${currency.id}/details`, { method: "PUT", headers: await adminHeaders(), body: JSON.stringify({ symbol: "KD" }) }); assert.equal(malformed.status, 400); assert.deepEqual(await malformed.json(), { error: "invalid_currency_details" });
  const absent = await fetch(`${origin}/catalogue/currency/${empty.id}/details`, { headers: await adminHeaders() }); assert.equal(absent.status, 404); assert.deepEqual(await absent.json(), { error: "currency_details_not_found" });
  const staffFixture = await createAuthzFixture(); const staffServer = createGatewayServer(undefined, undefined, staffFixture.middleware, undefined, null, undefined, undefined, service); await new Promise<void>((resolve) => staffServer.listen(0, "127.0.0.1", resolve)); context.after(() => staffServer.close()); const staffAddress = staffServer.address(); assert.ok(staffAddress && typeof staffAddress !== "string");
  const refused = await fetch(`http://127.0.0.1:${staffAddress.port}/catalogue/currency/${currency.id}/details`, { method: "PUT", headers: { "content-type": "application/json", "x-actor-assertion": await staffFixture.mint() }, body: JSON.stringify({ symbol: "$", decimalPlaces: 2 }) }); assert.equal(refused.status, 403); assert.deepEqual(await refused.json(), { error: "catalogue_write_forbidden" });
});
