import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore, createPrincipal } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { InMemoryApprovedProfileAdapter, OwnProfileRepository, SYNTHETIC_PROFILE_FIXTURES } from "@studenthub/profile";
import { createGatewayServer } from "../src/index.js";
import { createLoginApplication } from "../src/login-application.js";
import type { BrowserLoginApplication } from "../src/web-ui.js";

const SESSION = "s".repeat(43);

async function fixture(t: TestContext, failure?: "background" | "choices" | "civil" | "documents") {
  const rig = createSyntheticLoginRig(createLoginApplication);
  await rig.sessions.put({ id: SESSION, personId: "person-1" });
  const principals = new InMemoryAuthzStore({ principals: [createPrincipal({ id: "person-1", pbuuids: [], email: "person@example.invalid" })] });
  const repository = new OwnProfileRepository({
    principals,
    source: new InMemoryApprovedProfileAdapter({ links: [{ principalId: "person-1", candidateRef: "candidate-1" }], rows: new Map([["candidate-1", SYNTHETIC_PROFILE_FIXTURES.populated]]) }),
    today: () => "2026-11-11",
  });
  const counts = { profile: 0, background: 0, choices: 0, civil: 0, documents: 0, writes: 0 };
  const login: BrowserLoginApplication = {
    ...rig.app,
    browserEdit: { async notice() { return {}; } } as never,
    profileEdit: {
      async choices() { counts.choices++; if (failure === "choices") throw new Error("choices"); return { countries: [], universities: [] }; },
      async preview() { counts.writes++; throw new Error("write"); }, async confirm() { counts.writes++; throw new Error("write"); }, async receipt() { counts.writes++; throw new Error("write"); },
    },
    civilId: { async readOwn() { counts.civil++; if (failure === "civil") throw new Error("civil"); return { maskedNumber: "***", expiry: "2030-01-01" }; } } as never,
    web: { origin: "https://profile.test.invalid", returnTo: "https://profile.test.invalid/profile", profiles: { async readOwn(request) { counts.profile++; return repository.readOwn(request); } } },
  };
  const documents = { async list() { counts.documents++; if (failure === "documents") throw new Error("documents"); return []; }, async issueDelivery() { throw new Error("delivery"); } };
  const profileRecords = { service: { async background() { counts.background++; if (failure === "background") throw new Error("background"); return { education: [], skill: [], experience: [], link: [] }; } }, sessions: rig.sessions, origin: "https://profile.test.invalid", async options() { return []; } };
  const server = createGatewayServer(undefined, undefined, undefined, login, null, undefined, documents as never, undefined, profileRecords as never);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const get = (accept: string) => fetch(`http://127.0.0.1:${address.port}/profile`, { headers: { accept, cookie: `__Host-studenthub_session=${SESSION}` } });
  return { get, counts };
}

test("Q14_4_STATUS real GET keeps 200 when each gatherer source throws synchronously", async t => {
  for (const source of ["background", "choices", "civil", "documents"] as const) {
    const f = await fixture(t, source);
    const response = await f.get("text/html"); const html = await response.text();
    assert.equal(response.status, 200, `${source} failure must preserve profile status`);
    assert.match(html, /Couldn&#39;t check right now/);
    assert.doesNotMatch(html, /Profile complete/);
    assert.equal(f.counts.profile, 1);
  }
});

test("Q14_4_CHECKLIST real GET renders linked missing items in fixed order", async t => {
  const f = await fixture(t);
  const response = await f.get("text/html"); const html = await response.text();
  assert.equal(response.status, 200);
  const expected = [
    ['Personal photo', '/profile/documents'], ['Civil ID front', '/profile/documents'],
    ['Civil ID back', '/profile/documents'], ['Education', '/profile/background'], ['Skill', '/profile/background'],
  ] as const;
  let cursor = -1;
  for (const [words, href] of expected) {
    const item = new RegExp(`<li><a href="${href}">${words}</a></li>`).exec(html);
    assert.ok(item, `${words} must carry its own target ${href}`);
    assert.ok(item.index > cursor, `${words} must follow the fixed requirement order`); cursor = item.index;
  }
  const checklist = html.match(/<section class="p-card p-checklist">[^]*?<\/section>/)?.[0] ?? "";
  assert.doesNotMatch(checklist, /<dt>|data-state="unavailable"/);
});

test("Q14_4_DERIVED source failure derives unavailable fields without changing route status", async t => {
  const f = await fixture(t, "background");
  const response = await f.get("text/html"); const html = await response.text();
  assert.equal(response.status, 200); assert.match(html, /Couldn&#39;t check right now/);
  assert.match(html, /Profile completeness[^]*?data-state="unavailable"/);
  assert.equal(f.counts.writes, 0);
});

test("Q14_4_JSON real GET performs no completeness or document reads", async t => {
  const f = await fixture(t);
  const response = await f.get("application/json");
  assert.equal(response.status, 200); assert.ok(await response.json());
  assert.deepEqual({ background: f.counts.background, choices: f.counts.choices, civil: f.counts.civil, documents: f.counts.documents }, { background: 0, choices: 0, civil: 0, documents: 0 });
});

test("Q14_4_NOWRITE real GET gathers each source once and never invokes a write", async t => {
  const f = await fixture(t);
  const response = await f.get("text/html"); assert.equal(response.status, 200); await response.text();
  assert.deepEqual(f.counts, { profile: 1, background: 1, choices: 1, civil: 1, documents: 1, writes: 0 });
});
