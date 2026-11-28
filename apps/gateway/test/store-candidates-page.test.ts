import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { ASSIGNMENT_LIST_LIMIT, PlacementService, type Assignment, type WorkGrant } from "../../../packages/work/src/index.js";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { renderManagedStore } from "../src/access/store-manager.js";

// M-02 a store manager's candidates. Synthetic people, companies and stores only.
const sessions = { manager: "a".repeat(43), otherManager: "b".repeat(43), owner: "c".repeat(43), staff: "d".repeat(43), revoked: "e".repeat(43), candidate: "g".repeat(43) };
const S = { a: "123e4567-e89b-42d3-a456-426614174001", second: "123e4567-e89b-42d3-a456-426614174002", b: "123e4567-e89b-42d3-a456-426614174004" };
const GRANTS: Record<string, WorkGrant[]> = {
  owner: [{ orgId: "org-a", role: "org-owner", scope: "self" }], staff: [{ orgId: "root", role: "staff", scope: "subtree" }],
  candidate: [{ orgId: "org-a", role: "candidate", scope: "self" }],
};
// Live store manager access only: a revoked grant, a removed store or a deleted company are already left out by the store.
const MANAGED: Record<string, { orgId: string; storeId: string }[]> = {
  manager: [{ orgId: "org-a", storeId: S.a }], otherManager: [{ orgId: "org-a", storeId: S.second }],
};
const CONTRACT = "c0ffee00-0000-4000-8000-000000000001";
let n = 0;
const placed = (personId: string, orgId: string, storeId: string, startDate: string, endDate: string | null): Assignment => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, personId, orgId, storeId, payContractId: CONTRACT, contractResolution: {} as never,
  startDate, endDate, warnings: [], source: "staff" as never, requestId: null, recruitCardId: null, recruitRequestId: null,
} as unknown as Assignment);
const ASSIGNMENTS = [
  placed("badr", "org-a", S.a, "2020-01-01", "2020-06-30"),
  placed("amal", "org-a", S.second, "2019-01-01", "2019-06-30"),
  placed("amal", "org-a", S.a, "2021-01-01", null),
  placed("amal", "org-a", S.a, "2020-01-01", "2020-03-31"),
  placed("zaid", "org-a", S.a, "2999-01-01", null),
  placed("carl", "org-a", S.second, "2022-01-01", null),
  placed("dina", "org-b", S.b, "2022-01-01", null),
];
const NAMES = new Map([["amal", "Amal <Synthetic>"], ["badr", "Badr"], ["carl", "Carl"], ["dina", "Dina"]]);
const STORES = new Map([[S.a, "A <Store>"], [S.second, "Second"], [S.b, "Outside store"]]);

async function fixture(t: TestContext, option: { configured?: boolean; failing?: boolean; extra?: readonly Assignment[] } = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  for (const [personId, id] of Object.entries(sessions)) await rig.sessions.put({ id, personId });
  const calls: string[] = [];
  const store = {
    organizationAncestors: async (org: string) => org === "root" ? [] : ["root"],
    listAssignments: async (f: { orgIds?: readonly string[]; includeSubtree?: boolean; personId?: string; storeId?: string }) => {
      calls.push(`list:${f.orgIds?.join(",")}:${f.storeId ?? "*"}:${f.personId ?? "*"}`);
      if (option.failing) throw new Error("database down");
      // Like the Postgres store: newest first, at most ASSIGNMENT_LIST_LIMIT.
      return [...(option.extra ?? []), ...ASSIGNMENTS].filter((a) => (f.personId === undefined || a.personId === f.personId)
        && (f.storeId === undefined || a.storeId === f.storeId) && (f.orgIds === undefined || f.orgIds.includes(a.orgId)))
        .sort((a, b) => b.startDate.localeCompare(a.startDate) || a.id.localeCompare(b.id)).slice(0, ASSIGNMENT_LIST_LIMIT);
    },
  };
  const placements = new PlacementService({ store: store as never, grants: { listGrantsForPrincipal: async (id) => GRANTS[id] ?? [] }, newId: () => "unused",
    managedStores: async (id) => MANAGED[id] ?? [] });
  const work = {
    personFor: async (s: string) => (await rig.sessions.get(s))?.personId, placements,
    personNames: async (ids: readonly string[]) => new Map(ids.flatMap((id) => NAMES.has(id) ? [[id, NAMES.get(id)!] as const] : [])),
    storeNames: async (ids: readonly string[]) => new Map(ids.map((id) => [id, STORES.get(id)!] as const)),
  };
  const login = { ...rig.app, ...(option.configured === false ? {} : { work }), web: { origin: "https://studenthub.example.invalid", returnTo: "https://studenthub.example.invalid/workspace" } } as never;
  const server = createGatewayServer(undefined, undefined, undefined, login); await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve)); t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = (path: string, who?: keyof typeof sessions, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { accept: "text/html", ...(who ? { cookie: `__Host-studenthub_session=${sessions[who]}` } : {}), ...init.headers } });
  return { request, calls };
}

const rowsOf = (html: string) => [...html.matchAll(/<tr><th scope="row">(.*?)<\/tr>/g)].map((m) => m[1]!);
const LIST = `/workspace/stores/${S.a}/candidates`;

test("STORECAND_LIST a store manager sees who is placed at their own store, working now first, and nothing else", async (t) => {
  const f = await fixture(t);
  const response = await f.request(LIST, "manager"), body = await response.text();
  assert.equal(response.status, 200); assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(rowsOf(body), [
    `<a href="${LIST}/amal">Amal &lt;Synthetic&gt;</a></th><td>Working now</td>`,
    `<a href="${LIST}/badr">Badr</a></th><td>1 January 2020 to 30 June 2020</td>`,
    `<a href="${LIST}/zaid">Unnamed person</a></th><td>From 1 January 2999</td>`], "STORECAND_LIST rows");
  assert.match(body, /<nav aria-label="Breadcrumb"><a href="\/workspace\/my-stores">My stores<\/a> › <a href="\/workspace\/stores\/[0-9a-f-]+">A &lt;Store&gt;<\/a><\/nav><h1>Candidates<\/h1>/);
  // Another store of the same company, another company, and every field beyond name, store and dates stay out.
  for (const hidden of ["Carl", "Second", "Dina", "Outside store", CONTRACT, "<Synthetic>", "<Store>"]) assert.equal(body.includes(hidden), false, hidden);
  assert.deepEqual(f.calls, [`list:org-a:${S.a}:*`], "STORECAND_LIST the store scope goes into the query, before its limit");
});

test("STORECAND_PERSON one person's placements at that store only; a person never placed there is not found", async (t) => {
  const f = await fixture(t);
  const response = await f.request(`/workspace/stores/${S.a}/candidates/amal`, "manager"), body = await response.text();
  assert.equal(response.status, 200);
  assert.match(body, /<h1>Amal &lt;Synthetic&gt;<\/h1><h2>Placements at A &lt;Store&gt;<\/h2>/);
  assert.deepEqual(rowsOf(body), ["From 1 January 2021</th><td>Working now</td>", "1 January 2020 to 31 March 2020</th><td>Ended</td>"]);
  assert.equal(body.includes("2019"), false, "STORECAND_PERSON a placement at another store is not shown");
  assert.equal(f.calls.at(-1), `list:org-a:${S.a}:amal`);
  const missing = await (await f.request(`${LIST}/nobody`, "manager")).text();
  const unknown = await (await f.request("/no/such/page", "manager")).text();
  for (const path of [`${LIST}/carl`, `${LIST}/dina`, `${LIST}/nobody`]) {
    const r = await f.request(path, "manager");
    assert.equal(r.status, 404, path); assert.equal(await r.text(), missing, path);
  }
  assert.equal(missing, unknown, "byte-identical to the unknown path");
});

test("STORECAND_HIDDEN only the store's own manager: other stores, company roles, staff, revoked and signed out callers are refused", async (t) => {
  const f = await fixture(t);
  const unknown = await (await f.request("/no/such/page", "manager")).text();
  for (const [path, who] of [[LIST, "otherManager"], [LIST, "owner"], [LIST, "staff"], [LIST, "revoked"], [LIST, "candidate"],
    [`${LIST}/amal`, "otherManager"], [`${LIST}/amal`, "owner"], [`/workspace/stores/${S.second}/candidates`, "manager"], [`/workspace/stores/${S.b}/candidates`, "manager"]] as const) {
    const r = await f.request(path, who), body = await r.text();
    assert.equal(r.status, 404, `STORECAND_HIDDEN ${who} ${path}`);
    assert.equal(body, unknown, `${who} ${path}`);
  }
  assert.equal((await f.request(LIST)).status, 401);
  assert.equal((await f.request(LIST.toUpperCase().replace("/WORKSPACE/STORES/", "/workspace/stores/").replace("/CANDIDATES", "/candidates"), "manager")).status, 404, "an upper-case store id is not this page");
  assert.equal((await f.request(`${LIST}?x=1`, "manager")).status, 400, "a query is refused");
  assert.equal((await f.request(`${LIST}/a%2Fb`, "manager")).status, 404);
  assert.equal((await f.request(`${LIST}/%E0%A4%A`, "manager")).status, 404);
  assert.equal((await f.request(LIST, "manager", { method: "POST" })).status, 404);
  assert.equal((await f.request(`/workspace/stores/not-a-store/candidates`, "manager")).status, 404);
});

test("STORECAND_LIMIT a list holding the read limit says older placements may be missing", async (t) => {
  const extra = Array.from({ length: ASSIGNMENT_LIST_LIMIT }, (_, i) => placed(`p${i}`, "org-a", S.a, "2998-01-01", null));
  const f = await fixture(t, { extra });
  const body = await (await f.request(LIST, "manager")).text();
  assert.ok(body.includes(`built from the ${ASSIGNMENT_LIST_LIMIT} most recent placements`), "the capped list says so");
  const small = await fixture(t);
  assert.equal((await (await small.request(LIST, "manager")).text()).includes("most recent placements"), false);
});

test("STORECAND_QUIET a failing read or a gateway without work answers 503 with no detail", async (t) => {
  const failing = await fixture(t, { failing: true });
  const r = await failing.request(LIST, "manager"), body = await r.text();
  assert.equal(r.status, 503, "a failing read is unavailable"); assert.match(body, /Candidates unavailable/); assert.equal(body.includes("database"), false);
  const none = await fixture(t, { configured: false });
  assert.equal((await none.request(LIST, "manager")).status, 503);
});

test("STORECAND_LINK the store page links its candidates", () => {
  const html = renderManagedStore({ principalId: "manager", storeId: S.a, name: "A <Store>", orgId: "org-a", orgName: "A", location: null, brand: null, mall: null } as never);
  assert.ok(html.includes(`<a class="button primary" href="/workspace/stores/${S.a}/candidates">Candidates at this store</a>`));
});
