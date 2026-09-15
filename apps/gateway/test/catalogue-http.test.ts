import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryCatalogueStore, ReferenceCatalogue } from "@studenthub/reference-catalogue";
import type { Role } from "@studenthub/contracts";
import { createGatewayServer } from "../src/index.js";
import { createAuthzFixture, TEST_ORG } from "./helpers/authz.js";

async function rig(context: TestContext, role: Role = "staff") {
  const fixture = await createAuthzFixture();
  if (role !== "staff") {
    await fixture.store.revokeMany("p-1", [{ orgId: TEST_ORG, role: "staff" }]);
    await fixture.store.grantMany("p-1", [{ orgId: TEST_ORG, role }]);
  }
  const catalogue = new ReferenceCatalogue(new InMemoryCatalogueStore(), () => new Date("2026-09-14T12:00:00.000Z"));
  const server = createGatewayServer(undefined, undefined, fixture.middleware, undefined, null, undefined, undefined, catalogue);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== "string");
  return {
    fixture,
    catalogue,
    origin: `http://127.0.0.1:${address.port}`,
    headers: async () => ({ "content-type": "application/json", "x-actor-assertion": await fixture.mint({ act: { org: TEST_ORG, role } }) }),
  };
}

test("catalogue HTTP keeps candidate submissions private until an authorized approval", async (context) => {
  const candidateRig = await rig(context, "candidate");
  const submitted = await fetch(`${candidateRig.origin}/catalogue/submissions/university`, {
    method: "POST", headers: await candidateRig.headers(), body: JSON.stringify({ name: "Kuwait University", code: "KU" }),
  });
  assert.equal(submitted.status, 201);
  const submission = await submitted.json() as { id: string; status: string };
  assert.equal(submission.status, "pending");
  const before = await fetch(`${candidateRig.origin}/catalogue/university`);
  assert.deepEqual((await before.json() as { items: unknown[] }).items, []);

  // Exercise staff moderation on the same store with a separate signed identity context.
  const staffFixture = await createAuthzFixture();
  const staffServer = createGatewayServer(undefined, undefined, staffFixture.middleware, undefined, null, undefined, undefined, candidateRig.catalogue);
  await new Promise<void>((resolve) => staffServer.listen(0, "127.0.0.1", resolve));
  context.after(() => staffServer.close());
  const address = staffServer.address(); assert.ok(address && typeof address !== "string");
  const approved = await fetch(`http://127.0.0.1:${address.port}/catalogue/submissions/${submission.id}/decision`, {
    method: "POST", headers: { "content-type": "application/json", "x-actor-assertion": await staffFixture.mint() },
    body: JSON.stringify({ decision: "approved" }),
  });
  assert.equal(approved.status, 200);
  assert.deepEqual((await (await fetch(`${candidateRig.origin}/catalogue/university`)).json() as { items: { name: string }[] }).items.map((i) => i.name), ["Kuwait University"]);
});

test("catalogue HTTP authorizes before reading write bodies and recruiter grants cannot CRUD", async (context) => {
  const { origin, headers } = await rig(context, "recruiter");
  const denied = await fetch(`${origin}/catalogue/bank`, {
    method: "POST", headers: await headers(), body: JSON.stringify({ name: "Forbidden Bank" }),
  });
  assert.equal(denied.status, 403);
  assert.deepEqual(await denied.json(), { error: "catalogue_write_forbidden" });

  const fixture = await createAuthzFixture();
  const server = createGatewayServer(undefined, undefined, fixture.middleware, undefined, null, undefined, undefined, new ReferenceCatalogue(new InMemoryCatalogueStore()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const response = await fetch(`http://127.0.0.1:${address.port}/catalogue/bank`, {
    method: "POST", body: "x".repeat(64 * 1024), headers: { "content-type": "application/json" },
  });
  assert.equal(response.status, 401, "auth refusal wins over oversized or malformed body");
});

test("catalogue HTTP validates closed JSON shapes and emits stable page cursors", async (context) => {
  const { origin, headers } = await rig(context);
  for (const name of ["Alpha", "Charlie", "Bravo"]) {
    const result = await fetch(`${origin}/catalogue/major`, { method: "POST", headers: await headers(), body: JSON.stringify({ name }) });
    assert.equal(result.status, 201);
  }
  const first = await fetch(`${origin}/catalogue/major?page_size=2`);
  const page = await first.json() as { items: { name: string }[]; nextCursor: string };
  assert.deepEqual(page.items.map((item) => item.name), ["Alpha", "Bravo"]);
  const second = await fetch(`${origin}/catalogue/major?page_size=2&cursor=${encodeURIComponent(page.nextCursor)}`);
  assert.deepEqual((await second.json() as { items: { name: string }[] }).items.map((item) => item.name), ["Charlie"]);
  const invalid = await fetch(`${origin}/catalogue/major`, { method: "POST", headers: await headers(), body: JSON.stringify({ name: "X", authority: "client" }) });
  assert.equal(invalid.status, 400);
});

test("catalogue HTTP re-checks current grants so revocation takes effect before the next write", async (context) => {
  const { origin, headers, fixture } = await rig(context, "staff");
  const signedBeforeRevocation = await headers();
  await fixture.store.revokeMany("p-1", [{ orgId: TEST_ORG, role: "staff" }]);
  const response = await fetch(`${origin}/catalogue/bank`, {
    method: "POST", headers: signedBeforeRevocation, body: JSON.stringify({ name: "Revoked Bank" }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual((await fetch(`${origin}/catalogue/bank`).then((result) => result.json()) as { items: unknown[] }).items, []);
});
