import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { OwnProfileRepository, UnconfiguredApprovedProfileAdapter } from "@studenthub/profile";
import { createLoginApplication } from "../src/login-application.js";
import { createGatewayServer } from "../src/index.js";
import type { BrowserLoginApplication } from "../src/web-ui.js";

const SESSION = "c".repeat(43);
async function route(t: TestContext) {
  const authz = new InMemoryAuthzStore({ principals: [{ id: "person-1", pbuuids: [] }], organizations: [] });
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: SESSION, personId: "person-1" });
  const repository = new OwnProfileRepository({ principals: authz, source: new UnconfiguredApprovedProfileAdapter() });
  let lists = 0, backgrounds = 0, choices = 0, civil = 0;
  const login = { ...rig.app, browserEdit: { async notice() { return {}; } }, profileEdit: { async choices() { choices++; return { countries: [], universities: [] }; } }, civilId: { async readOwn() { civil++; return null; } }, web: { origin: "https://profile.invalid", profiles: repository } } as unknown as BrowserLoginApplication;
  const documents = { async list() { lists++; return []; }, async issueDelivery() { throw new Error("not called"); } };
  const profileRecords = { service: { async background() { backgrounds++; return { education: [], experience: [], skill: [], link: [], removed: [] }; } }, sessions: rig.sessions, origin: "https://profile.invalid", async options() { return []; } };
  const server = createGatewayServer(undefined, undefined, undefined, login, null, undefined, documents as never, undefined, profileRecords as never);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const get = (accept: string) => fetch(`http://127.0.0.1:${address.port}/profile`, { headers: { accept, cookie: `__Host-studenthub_session=${SESSION}` } });
  return { get, counts: () => ({ lists, backgrounds, choices, civil }) };
}

test("Q14_4_DERIVED Q14_4_STATUS real profile route keeps 200 when completeness is unavailable", async t => {
  const f = await route(t); const response = await f.get("text/html"); const html = await response.text();
  assert.equal(response.status, 200, "completeness failure must preserve the profile status");
  assert.match(html, /Couldn't check right now/);
  assert.doesNotMatch(html, /Profile complete/);
  assert.deepEqual(f.counts(), { lists: 1, backgrounds: 1, choices: 1, civil: 1 });
});

test("Q14_4_JSON real profile route leaves repository JSON unchanged and performs no completeness reads", async t => {
  const f = await route(t); const response = await f.get("application/json"); const body = await response.json() as { fields: Record<string, { state: string }> };
  assert.equal(response.status, 200);
  assert.equal(body.fields.isProfileCompleted.state, "unavailable");
  assert.equal(body.fields.pendingFields.state, "unavailable");
  assert.deepEqual(f.counts(), { lists: 0, backgrounds: 0, choices: 0, civil: 0 });
});
