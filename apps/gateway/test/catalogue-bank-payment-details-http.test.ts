import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryCatalogueStore, ReferenceCatalogue } from "@studenthub/reference-catalogue";
import { createGatewayServer } from "../src/index.js";
import { createAuthzFixture, TEST_ORG } from "./helpers/authz.js";

test("catalogue bank payment-detail routes require assertions and enforce admin writes", async (context: TestContext) => {
  const fixture = await createAuthzFixture();
  await fixture.store.revokeMany("p-1", [{ orgId: TEST_ORG, role: "staff" }]);
  await fixture.store.grantMany("p-1", [{ orgId: TEST_ORG, role: "admin" }]);
  const service = new ReferenceCatalogue(new InMemoryCatalogueStore(), () => new Date("2026-10-15T10:00:00.000Z"));
  const bank = await service.create({ principalRef: "a".repeat(64), orgId: TEST_ORG, role: "admin" }, "bank", { name: "Synthetic Bank" });
  const server = createGatewayServer(undefined, undefined, fixture.middleware, undefined, null, undefined, undefined, service);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  // Each assertion is single-use (replay protection), so every request mints its own.
  const adminHeaders = async () => ({ "content-type": "application/json", "x-actor-assertion": await fixture.mint({ act: { org: TEST_ORG, role: "admin" } }) });
  const body = { swiftCode: "DEUTDEFF", ibanBankCode: "BKME", abkCode: "7", transferType: "international" };

  const unauthenticated = await fetch(`${origin}/catalogue/bank/${bank.id}/payment-details`);
  assert.equal(unauthenticated.status, 401);
  const put = await fetch(`${origin}/catalogue/bank/${bank.id}/payment-details`, { method: "PUT", headers: await adminHeaders(), body: JSON.stringify(body) });
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { bankId: bank.id, ...body, updatedAt: "2026-10-15T10:00:00.000Z" });
  const get = await fetch(`${origin}/catalogue/bank/${bank.id}/payment-details`, { headers: await adminHeaders() });
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), { bankId: bank.id, ...body, updatedAt: "2026-10-15T10:00:00.000Z" });

  const staffFixture = await createAuthzFixture();
  const staffServer = createGatewayServer(undefined, undefined, staffFixture.middleware, undefined, null, undefined, undefined, service);
  await new Promise<void>((resolve) => staffServer.listen(0, "127.0.0.1", resolve));
  context.after(() => staffServer.close());
  const staffAddress = staffServer.address(); assert.ok(staffAddress && typeof staffAddress !== "string");
  const refused = await fetch(`http://127.0.0.1:${staffAddress.port}/catalogue/bank/${bank.id}/payment-details`, {
    method: "PUT", headers: { "content-type": "application/json", "x-actor-assertion": await staffFixture.mint() }, body: JSON.stringify(body),
  });
  assert.equal(refused.status, 403);
  assert.deepEqual(await refused.json(), { error: "catalogue_write_forbidden" });
});
