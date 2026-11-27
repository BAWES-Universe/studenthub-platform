import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createGatewayServer } from "../src/index.js";
import type { AccessPorts } from "../src/access/admin-access.js";
import {
  createStoreGrantService,
  type AccessReadStore,
  type AccessStore,
  type StoreGrantRequest,
  type StoreGrantSnapshot,
  type StoreGrantWriteStore,
} from "../../../packages/access/src/index.js";

// Access lane G-02: store manager access on the Access pages.

const ORIGIN = "https://studenthub.example.invalid";
const SESSIONS: Record<string, string> = {
  ["a".repeat(43)]: "admin-1", ["c".repeat(43)]: "candidate-1", ["o".repeat(43)]: "owner-1", ["s".repeat(43)]: "staff-self", ["r".repeat(43)]: "root-admin",
};
const session = (principalId: string) => Object.entries(SESSIONS).find(([, id]) => id === principalId)![0];
const SALMIYA = "11111111-2222-4333-8444-555555555555";
const HAWALLY = "11111111-2222-4333-8444-666666666666";

type Held = { principalId: string; orgId: string; role: string; scope: "self" | "subtree" };

function world() {
  const people: Record<string, { displayName: string | null; email: string | null }> = {
    "admin-1": { displayName: "Grace Admin", email: "grace@example.invalid" },
    "candidate-1": { displayName: "Dana Candidate", email: "dana@example.invalid" },
    "owner-1": { displayName: "Omar Owner", email: "omar@example.invalid" },
    "staff-self": { displayName: "Sam Staff", email: "sam@example.invalid" },
    "root-admin": { displayName: "Rae Root", email: "rae@example.invalid" },
  };
  const orgs: Record<string, { name: string; parent: string | null }> = { root: { name: "StudentHub", parent: null }, acme: { name: "Acme <Trading>", parent: "root" } };
  const stores: Record<string, AccessStore> = {
    [SALMIYA]: { storeId: SALMIYA, name: "Salmiya <Branch>", orgId: "acme", orgName: "Acme <Trading>" },
    [HAWALLY]: { storeId: HAWALLY, name: "Hawally", orgId: "acme", orgName: "Acme <Trading>" },
  };
  const grants: Held[] = [
    { principalId: "admin-1", orgId: "root", role: "admin", scope: "subtree" },
    // Owns Acme and could change its stores on the team page, but can't open the Access pages.
    { principalId: "owner-1", orgId: "acme", role: "org-owner", scope: "subtree" },
    { principalId: "staff-self", orgId: "root", role: "staff", scope: "self" },
    // Opens the Access pages, but covers only the operator itself, not Acme.
    { principalId: "root-admin", orgId: "root", role: "admin", scope: "self" },
  ];
  const managers = new Set<string>();
  const paused = new Set<string>();
  const events: { target: string; storeId: string; action: string; actor: string; reason: string; tokenId: string }[] = [];
  const ancestors = (orgId: string) => { const out: string[] = []; let at = orgs[orgId]?.parent ?? null; while (at) { out.push(at); at = orgs[at]?.parent ?? null; } return out; };
  const org = (orgId: string) => orgs[orgId] ? { orgId, name: orgs[orgId]!.name, ancestors: ancestors(orgId) } : null;
  const person = (principalId: string) => people[principalId] ? { principalId, ...people[principalId]! } : null;
  const reads: AccessReadStore = {
    async callerGrants(callerId) { return grants.filter((grant) => grant.principalId === callerId); },
    async findPeople() { return []; },
    async person(principalId) { return person(principalId); },
    async grants(principalId) {
      return grants.filter((grant) => grant.principalId === principalId).map((grant) => ({ orgId: grant.orgId, orgName: orgs[grant.orgId]!.name, role: grant.role, scope: grant.scope, grantedBy: null, grantedAt: null, reason: null }));
    },
    async history() { return []; },
    async findOrganizations() { return []; },
    async organization(orgId) { return org(orgId); },
    async organizations(orgIds) { return orgIds.map(org).filter((item) => item !== null); },
    async ownGrants() { return []; },
  };
  const snapshot = (callerId: string, request: StoreGrantRequest): StoreGrantSnapshot => {
    const store = stores[request.storeId];
    return {
      callerGrants: grants.filter((grant) => grant.principalId === callerId),
      targetExists: request.targetPrincipalId in people,
      store: store ? { ...store, orgAncestors: ancestors(store.orgId) } : null,
      held: managers.has(`${request.targetPrincipalId}\u0000${request.storeId}`),
      paused: paused.has(request.targetPrincipalId),
    };
  };
  const writeStore: StoreGrantWriteStore = {
    async storeSnapshot(callerId, request) { return snapshot(callerId, request); },
    async applyStore({ callerId, request, tokenId, expectedHeld, decide }) {
      if (events.some((event) => event.tokenId === tokenId)) return { kind: "refused", reason: "token_already_used" };
      const seen = snapshot(callerId, request);
      if (seen.held !== expectedHeld) return { kind: "refused", reason: "state_changed" };
      const decision = decide(seen);
      if (decision.kind !== "apply") return decision;
      const key = `${request.targetPrincipalId}\u0000${request.storeId}`;
      if (decision.after) managers.add(key); else managers.delete(key);
      events.push({ target: request.targetPrincipalId, storeId: request.storeId, action: request.action, actor: callerId, reason: request.reason, tokenId });
      return { kind: "applied", before: decision.before, after: decision.after };
    },
  };
  const ports: AccessPorts = {
    sessions: { get: async (id) => (SESSIONS[id] ? { id, personId: SESSIONS[id]! } : undefined) },
    reads,
    operatorOrgIds: ["root"],
    stores: {
      reads: {
        async findStores(query) { return Object.values(stores).filter((store) => store.name.toLowerCase().startsWith(query.toLowerCase())); },
        async storeGrants(principalId) { return Object.values(stores).filter((store) => managers.has(`${principalId}\u0000${store.storeId}`)); },
      },
      writes: createStoreGrantService({ store: writeStore, secret: Buffer.alloc(32, 5), operatorOrgIds: ["root"] }),
    },
  };
  return { ports, managers, paused, events };
}

async function serve(t: TestContext, ports: AccessPorts | undefined) {
  const server = createGatewayServer(undefined, undefined, undefined, { ...(ports ? { access: ports } : {}), web: { origin: ORIGIN } } as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const get = (path: string, principalId?: string, accept = "text/html") =>
    fetch(base + path, { headers: { accept, ...(principalId ? { cookie: `__Host-studenthub_session=${session(principalId)}` } : {}) }, redirect: "manual" });
  const post = (path: string, principalId: string | undefined, form: Record<string, string>, origin = ORIGIN) =>
    fetch(base + path, { method: "POST", redirect: "manual", body: new URLSearchParams(form).toString(),
      headers: { accept: "text/html", origin, "content-type": "application/x-www-form-urlencoded", ...(principalId ? { cookie: `__Host-studenthub_session=${session(principalId)}` } : {}) } });
  return { get, post };
}

async function sameAsUnknown(actual: Response, unknown: Response, message: string) {
  assert.equal(actual.status, unknown.status, `${message} status`);
  assert.equal(actual.headers.get("content-type"), unknown.headers.get("content-type"), `${message} content-type`);
  assert.equal(await actual.text(), await unknown.text(), `${message} body`);
}

function hiddenFields(html: string): Record<string, string> {
  const decode = (value: string) => value.replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
  return Object.fromEntries([...html.matchAll(/<input type="hidden" name="([^"]+)" value="([^"]*)">/g)].map((match) => [decode(match[1]!), decode(match[2]!)]));
}

const storeForm = { targetPrincipalId: "candidate-1", storeId: SALMIYA, action: "grant", reason: "Runs the Salmiya branch" };

test("G02_STORE_SITES everyone who can't open the Access pages gets the unknown-path 404 from the store routes", async (t) => {
  const { ports, events } = world();
  const http = await serve(t, ports);
  for (const principalId of [undefined, "candidate-1", "owner-1", "staff-self"]) {
    for (const path of ["/admin/access/store-preview", "/admin/access/store-confirm"]) {
      await sameAsUnknown(await http.post(path, principalId, storeForm), await http.get("/definitely-unknown", principalId), `${principalId ?? "signed out"} POST ${path}`);
    }
    await sameAsUnknown(await http.get(`/admin/access/people/candidate-1?store=Sal`, principalId), await http.get("/definitely-unknown", principalId), `${principalId ?? "signed out"} store search`);
  }
  // A GET of a store route, and a preview for an unknown person, are the unknown-path 404 too.
  await sameAsUnknown(await http.get("/admin/access/store-preview", "admin-1"), await http.get("/definitely-unknown", "admin-1"), "GET store-preview");
  await sameAsUnknown(await http.post("/admin/access/store-preview", "admin-1", { ...storeForm, targetPrincipalId: "nobody" }), await http.get("/definitely-unknown", "admin-1"), "preview for an unknown person");
  // Without the store ports the routes do not exist, and the person page has no store section.
  const { stores: _unused, ...withoutStores } = ports;
  const off = await serve(t, withoutStores);
  await sameAsUnknown(await off.post("/admin/access/store-preview", "admin-1", storeForm), await off.get("/definitely-unknown", "admin-1"), "unwired store-preview");
  assert.doesNotMatch(await (await off.get("/admin/access/people/candidate-1", "admin-1")).text(), /Store manager access/);
  assert.equal(events.length, 0);
});

test("G02_STORE_PAGE the person page lists their stores and offers a store only where the caller may change it", async (t) => {
  const { ports, managers } = world();
  const http = await serve(t, ports);
  const empty = await (await http.get("/admin/access/people/candidate-1", "admin-1")).text();
  assert.match(empty, /<h2>Store manager access<\/h2>/);
  assert.match(empty, /Dana Candidate manages no store\./);
  assert.match(empty, /<input type="search" name="store"/);
  const found = await (await http.get("/admin/access/people/candidate-1?store=Sal", "admin-1")).text();
  assert.match(found, /<strong>Salmiya &lt;Branch&gt;<\/strong><p>Acme &lt;Trading&gt;<\/p><form method="post" action="\/admin\/access\/store-preview">/);
  assert.match(found, /<input type="hidden" name="storeId" value="11111111-2222-4333-8444-555555555555">/);
  assert.doesNotMatch(found, /Hawally/, "only the stores whose name matches");
  // An operator admin who covers only the operator itself sees the store but can't give it.
  const narrow = await (await http.get("/admin/access/people/candidate-1?store=Sal", "root-admin")).text();
  assert.match(narrow, /<strong>Salmiya &lt;Branch&gt;<\/strong><p>Acme &lt;Trading&gt;<\/p><p>You can’t give manager access to this store\.<\/p>/);
  assert.doesNotMatch(narrow, /store-preview/);
  // A store they already manage is listed, with a take-away form for an admin who covers it only.
  managers.add(`candidate-1\u0000${SALMIYA}`);
  const held = await (await http.get("/admin/access/people/candidate-1?store=Sal", "admin-1")).text();
  assert.match(held, /<caption>Stores they manage<\/caption>.*<th scope="row">Salmiya &lt;Branch&gt;<\/th><td>Acme &lt;Trading&gt;<\/td><td><form method="post" action="\/admin\/access\/store-preview"><input type="hidden" name="action" value="revoke">/s);
  assert.match(held, /They already manage this store\./);
  const heldNarrow = await (await http.get("/admin/access/people/candidate-1", "root-admin")).text();
  assert.match(heldNarrow, /<th scope="row">Salmiya &lt;Branch&gt;<\/th><td>Acme &lt;Trading&gt;<\/td><td>—<\/td>/);
  // Your own page offers no change.
  const own = await (await http.get("/admin/access/people/admin-1?store=Sal", "admin-1")).text();
  assert.doesNotMatch(own, /store-preview/);
  // The history names the store for a store manager event; a role event keeps its scope words.
  (ports.reads as { history: AccessReadStore["history"] }).history = async () => [
    { orgId: "acme", orgName: "Acme <Trading>", role: "store-manager", scope: "store", action: "grant", actor: { principalId: "admin-1", displayName: "Grace Admin" }, reason: "Runs it", occurredAt: "2026-11-27T08:00:00.000Z", storeName: "Salmiya <Branch>" },
    { orgId: "acme", orgName: "Acme <Trading>", role: "recruiter", scope: "self", action: "grant", actor: { principalId: "admin-1", displayName: "Grace Admin" }, reason: "Hires", occurredAt: "2026-11-27T07:00:00.000Z" },
  ];
  const history = await (await http.get("/admin/access/people/candidate-1", "admin-1")).text();
  assert.match(history, /<td>Store manager<\/td><td>Store: Salmiya &lt;Branch&gt;<\/td>/);
  assert.match(history, /<td>Recruiter<\/td><td>This organization only<\/td>/);
});

test("G02_STORE_CONFIRM a preview shows the store change, the confirm applies it once, and taking it away goes the same way", async (t) => {
  const { ports, managers, events } = world();
  const http = await serve(t, ports);
  const preview = await http.post("/admin/access/store-preview", "admin-1", storeForm);
  assert.equal(preview.status, 200);
  const html = await preview.text();
  assert.match(html, /<dt>Person<\/dt><dd>Dana Candidate<\/dd>.*<dt>Store<\/dt><dd>Salmiya &lt;Branch&gt;<\/dd>.*<dt>Company<\/dt><dd>Acme &lt;Trading&gt;<\/dd>/s);
  assert.match(html, /This gives Dana Candidate store manager access to Salmiya &lt;Branch&gt;\. It covers this store only\. Their other access is not changed\./);
  assert.match(html, /<form method="post" action="\/admin\/access\/store-confirm">/);
  assert.equal(events.length, 0, "a preview writes nothing");
  const fields = hiddenFields(html);
  assert.equal(fields.storeId, SALMIYA);
  assert.equal(fields.reason, "Runs the Salmiya branch");
  // Cross-origin, altered and padded confirms are refused and change nothing.
  assert.equal((await http.post("/admin/access/store-confirm", "admin-1", fields, "https://evil.example")).status, 403);
  assert.equal((await http.post("/admin/access/store-confirm", "admin-1", { ...fields, storeId: HAWALLY })).status, 409);
  assert.equal((await http.post("/admin/access/store-confirm", "admin-1", { ...fields, extra: "1" })).status, 400);
  // The role confirm path never takes a store confirmation.
  assert.equal((await http.post("/admin/access/confirm", "admin-1", fields)).status, 400);
  assert.equal(events.length, 0);
  const confirm = await http.post("/admin/access/store-confirm", "admin-1", fields);
  assert.equal(confirm.status, 303);
  assert.equal(confirm.headers.get("location"), "/admin/access/people/candidate-1?done=store-granted");
  assert.ok(managers.has(`candidate-1\u0000${SALMIYA}`));
  const replay = await http.post("/admin/access/store-confirm", "admin-1", fields);
  assert.equal(replay.status, 409);
  assert.match(await replay.text(), /already confirmed/);
  assert.equal(events.length, 1);
  const page = await (await http.get("/admin/access/people/candidate-1?done=store-granted", "admin-1")).text();
  assert.match(page, /Store manager access was given\./);

  // Giving it again is a no-op with no token.
  const again = await (await http.post("/admin/access/store-preview", "admin-1", storeForm)).text();
  assert.match(again, /Nothing to change/);
  assert.doesNotMatch(again, /store-confirm/);

  const revoke = await (await http.post("/admin/access/store-preview", "admin-1", { ...storeForm, action: "revoke", reason: "Moved to Hawally" })).text();
  assert.match(revoke, /This takes away Dana Candidate’s store manager access to Salmiya &lt;Branch&gt;\. Access they have through a role at Acme &lt;Trading&gt; is not changed\./);
  const done = await http.post("/admin/access/store-confirm", "admin-1", hiddenFields(revoke));
  assert.equal(done.headers.get("location"), "/admin/access/people/candidate-1?done=store-revoked");
  assert.ok(!managers.has(`candidate-1\u0000${SALMIYA}`));
  assert.match(await (await http.get("/admin/access/people/candidate-1?done=store-revoked", "admin-1")).text(), /Store manager access was taken away\./);
  assert.deepEqual(events.map((event) => [event.action, event.actor, event.reason]), [["grant", "admin-1", "Runs the Salmiya branch"], ["revoke", "admin-1", "Moved to Hawally"]]);
});

test("G02_STORE_GUARDS refusals from the store form say why and change nothing", async (t) => {
  const { ports, paused, events } = world();
  const http = await serve(t, ports);
  const self = await http.post("/admin/access/store-preview", "admin-1", { ...storeForm, targetPrincipalId: "admin-1" });
  assert.equal(self.status, 403);
  assert.match(await self.text(), /can’t change your own access/);
  const narrow = await http.post("/admin/access/store-preview", "root-admin", storeForm);
  assert.equal(narrow.status, 403);
  assert.match(await narrow.text(), /right to give or take away manager access to this store/);
  const unknownStore = await http.post("/admin/access/store-preview", "admin-1", { ...storeForm, storeId: "11111111-2222-4333-8444-777777777777" });
  assert.equal(unknownStore.status, 404);
  assert.match(await unknownStore.text(), /store was removed/);
  const notHeld = await http.post("/admin/access/store-preview", "admin-1", { ...storeForm, action: "revoke" });
  assert.equal(notHeld.status, 409);
  assert.match(await notHeld.text(), /doesn’t manage this store any more/);
  assert.equal((await http.post("/admin/access/store-preview", "admin-1", { ...storeForm, reason: "ok" })).status, 400);
  assert.equal((await http.post("/admin/access/store-preview", "admin-1", { ...storeForm, storeId: "not-a-store" })).status, 400);
  assert.equal((await http.post("/admin/access/store-preview", "admin-1", { ...storeForm, extra: "1" })).status, 400);
  assert.equal((await http.post("/admin/access/store-preview", "admin-1", storeForm, "https://evil.example")).status, 403);
  paused.add("candidate-1");
  const whilePaused = await http.post("/admin/access/store-preview", "admin-1", storeForm);
  assert.equal(whilePaused.status, 409);
  assert.match(await whilePaused.text(), /access is paused/);
  assert.equal(events.length, 0);
});

test("G02_STORE_GUARDS a store confirm that fails with an unknown outcome never claims nothing changed", async (t) => {
  const { ports } = world();
  const http = await serve(t, ports);
  const fields = hiddenFields(await (await http.post("/admin/access/store-preview", "admin-1", storeForm)).text());
  const failing: AccessPorts = { ...ports, stores: { ...ports.stores!, writes: { ...ports.stores!.writes!, confirm: async () => { throw new Error("connection lost after COMMIT"); } } } };
  const broken = await serve(t, failing);
  const response = await broken.post("/admin/access/store-confirm", "admin-1", fields);
  assert.equal(response.status, 503);
  assert.match(await response.text(), /may or may not have been made/);
  // Without the signing key the store pages are read-only.
  const { writes: _unused, ...readOnly } = ports.stores!;
  const unsigned = await serve(t, { ...ports, stores: readOnly });
  assert.equal((await unsigned.post("/admin/access/store-preview", "admin-1", storeForm)).status, 503);
  assert.match(await (await unsigned.get("/admin/access/people/candidate-1?store=Sal", "admin-1")).text(), /<h2>Store manager access<\/h2>.*Changes are unavailable right now\./s);
});
