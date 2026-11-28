import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore, createPrincipal } from "@studenthub/contracts";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { PlacementService, type Assignment, type WorkGrant } from "../../../packages/work/src/index.js";
import { CandidateDocuments } from "../../../packages/private-documents/src/candidate-lifecycle.js";
import { createGatewayServer, createLoginApplication } from "../src/index.js";

// M-05: a store manager opens the photo or CV of a person placed at their store. Synthetic people and stores only.
const ORIGIN = "https://studenthub.example.invalid";
const KEY = Buffer.alloc(32, 9);
const sessions = { manager: "a".repeat(43), coManager: "f".repeat(43), otherManager: "b".repeat(43), owner: "c".repeat(43), staff: "d".repeat(43), candidate: "g".repeat(43) };
type Who = keyof typeof sessions;
const S = { a: "123e4567-e89b-42d3-a456-426614174001", second: "123e4567-e89b-42d3-a456-426614174002" };
const GRANTS: Record<string, WorkGrant[]> = {
  owner: [{ orgId: "org-a", role: "org-owner", scope: "self" }], staff: [{ orgId: "root", role: "staff", scope: "subtree" }],
  candidate: [{ orgId: "org-a", role: "candidate", scope: "self" }],
};
let n = 0;
const placed = (personId: string, storeId: string, startDate: string, endDate: string | null): Assignment => ({
  id: `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`, personId, orgId: "org-a", storeId, payContractId: "c0ffee00-0000-4000-8000-000000000001",
  contractResolution: {} as never, startDate, endDate, warnings: [], source: "staff" as never, requestId: null, recruitCardId: null, recruitRequestId: null,
} as unknown as Assignment);
const photo = Buffer.from("photo-bytes"), resume = Buffer.from("%PDF-cv".padEnd(3000, ".")), civil = Buffer.from("civil-front");

async function fixture(t: TestContext, option: { audit?: boolean; auditFails?: boolean } = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  for (const [personId, id] of Object.entries(sessions)) await rig.sessions.put({ id, personId });
  const managed: Record<string, { orgId: string; storeId: string }[]> = { manager: [{ orgId: "org-a", storeId: S.a }], coManager: [{ orgId: "org-a", storeId: S.a }], otherManager: [{ orgId: "org-a", storeId: S.second }] };
  const assignments = [placed("amal", S.a, "2021-01-01", null), placed("zaid", S.a, "2999-01-01", null), placed("badr", S.a, "2020-01-01", "2020-06-30"), placed("amal", S.second, "2019-01-01", "2019-06-30")];
  const calls: string[] = [];
  const store = {
    organizationAncestors: async (org: string) => org === "root" ? [] : ["root"],
    listAssignments: async (f: { orgIds?: readonly string[]; personId?: string; storeId?: string }) => {
      calls.push(`list:${f.storeId ?? "*"}:${f.personId ?? "*"}`);
      return assignments.filter((a) => (f.personId === undefined || a.personId === f.personId) && (f.storeId === undefined || a.storeId === f.storeId) && (f.orgIds === undefined || f.orgIds.includes(a.orgId)));
    },
  };
  const placements = new PlacementService({ store: store as never, grants: { listGrantsForPrincipal: async (id) => GRANTS[id] ?? [] }, newId: () => "unused", managedStores: async (id) => managed[id] ?? [] });
  const work = {
    personFor: async (s: string) => (await rig.sessions.get(s))?.personId, placements,
    personNames: async (ids: readonly string[]) => new Map(ids.map((id) => [id, id === "amal" ? "Amal <Synthetic>" : id] as const)),
    storeNames: async (ids: readonly string[]) => new Map(ids.map((id) => [id, id === S.a ? "A <Store>" : "Second"] as const)),
  };
  const authz = new InMemoryAuthzStore({ organizations: [{ id: "candidate-documents", name: "Candidates" }], principals: [...Object.keys(sessions), "amal", "zaid", "badr"].map((id) => createPrincipal({ id, pbuuids: [] })) });
  const doc = (personId: string, type: string, mime: string, bytes: Buffer) => ({ id: randomUUID(), version: randomUUID(), type, mime, size: bytes.length,
    scope: { orgId: "candidate-documents", personId }, acl: "private", data: bytes.toString("base64") });
  const state = { format: 1 as const, retired: [] as never[], documents: [doc("amal", "personal-photo", "image/png", photo), doc("amal", "resume", "application/pdf", resume),
    doc("amal", "civil-id-front", "image/jpeg", civil), doc("zaid", "resume", "application/pdf", resume), doc("badr", "personal-photo", "image/png", photo)] };
  const bySession = new Map(Object.entries(sessions).map(([who, id]) => [id, who]));
  const documents = new CandidateDocuments({ store: { transaction: async (fn) => fn(state as never) }, authz, orgId: "candidate-documents", origin: ORIGIN, signingKey: KEY,
    authenticate: async (c) => typeof c === "string" && bySession.has(c) ? { kind: "principal", principalId: bySession.get(c)! } : null });
  const views: Record<string, unknown>[] = [];
  const storeDocumentViews = { recordView: async (view: Record<string, unknown>) => { if (option.auditFails) throw new Error("private audit detail"); views.push(view); } };
  const login = { ...rig.app, work, ...(option.audit === false ? {} : { storeDocumentViews }), web: { origin: ORIGIN, returnTo: `${ORIGIN}/workspace` } } as never;
  const server = createGatewayServer(undefined, undefined, undefined, login, null, undefined, documents);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const get = (path: string, who?: Who) => fetch(base + path, { redirect: "manual", headers: { accept: "text/html", ...(who ? { cookie: `__Host-studenthub_session=${sessions[who]}` } : {}) } });
  const open = (path: string, who: Who, init: { headers?: Record<string, string>; body?: string } = {}) => fetch(`${base}${path}`, { method: "POST", redirect: "manual", body: init.body ?? "",
    headers: { accept: "text/html", cookie: `__Host-studenthub_session=${sessions[who]}`, origin: ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded", ...init.headers } });
  return { get, open, views, calls, managed, state, assignments, unknownPath: async () => (await get("/no-such-page", "manager")).text() };
}
const page = (person: string, store = S.a) => `/workspace/stores/${store}/candidates/${person}/documents`;

test("STOREDOC_PAGE a store manager sees the photo and CV of a person placed at their store, with no contents", async (t) => {
  const f = await fixture(t);
  const response = await f.get(page("amal"), "manager");
  const html = await response.text();
  assert.equal(response.status, 200, "STOREDOC_PAGE manager page is 200");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(html, /<h1>Documents for Amal &lt;Synthetic&gt;<\/h1>/, "STOREDOC_PAGE heading names the person, escaped");
  const form = (type: string) => `<form method="post" action="/workspace/stores/${S.a}/candidates/amal/documents/${type}/open"><button class="text-link" type="submit">Open</button></form>`;
  assert.ok(html.includes(`<tbody><tr><th scope="row">Personal photo</th><td>On file</td><td>PNG image</td><td>11 bytes</td><td>${form("personal-photo")}</td></tr><tr><th scope="row">CV</th><td>On file</td><td>PDF</td><td>3 KB</td><td>${form("resume")}</td></tr></tbody>`), "STOREDOC_PAGE exactly the photo and CV rows");
  assert.doesNotMatch(html, /Civil ID front|civil-id|photo-bytes|PDF-cv|delivery\?t=/, "STOREDOC_PAGE no civil ID row, no contents, no link on read");
  assert.match(html, /Civil ID images are not shown to stores\./);
  const later = await (await f.get(page("zaid"), "manager")).text();
  assert.ok(later.includes('<tr><th scope="row">Personal photo</th><td>Missing</td><td>—</td><td>—</td><td></td></tr>'), "STOREDOC_PAGE a person starting later; a missing photo");
  assert.deepEqual(f.views, [], "STOREDOC_PAGE reading records nothing");

  const person = await (await f.get(`/workspace/stores/${S.a}/candidates/amal`, "manager")).text();
  assert.ok(person.includes(`<a class="text-link" href="/workspace/stores/${S.a}/candidates/amal/documents">Documents</a>`), "STOREDOC_PAGE the candidate page links the documents");
  assert.doesNotMatch(await (await f.get(`/workspace/stores/${S.a}/candidates/badr`, "manager")).text(), /\/documents"/, "STOREDOC_PAGE no link after the placement ended");
  const off = await fixture(t, { audit: false });
  assert.doesNotMatch(await (await off.get(`/workspace/stores/${S.a}/candidates/amal`, "manager")).text(), /\/documents"/, "STOREDOC_PAGE no link when documents are not wired");
});

test("STOREDOC_OPEN a photo or CV opens through a short signed link, audited on issue and on delivery", async (t) => {
  const f = await fixture(t);
  const issued = await f.open(`${page("amal")}/resume/open`, "manager");
  assert.equal(issued.status, 303, "STOREDOC_OPEN open redirects");
  const location = issued.headers.get("location") ?? "";
  assert.match(location, /^\/workspace\/stores\/documents\/delivery\?t=[\w-]+\.[\w-]+$/, "STOREDOC_OPEN the store delivery link");
  const resumeVersion = f.state.documents.find((d) => d.scope.personId === "amal" && d.type === "resume")!.version;
  assert.deepEqual(f.views, [{ viewerPrincipalId: "manager", subjectPrincipalId: "amal", storeId: S.a, operation: "issue", documentType: "resume", documentVersion: resumeVersion }], "STOREDOC_OPEN issue audited with the store");
  const delivered = await f.get(location, "manager");
  assert.equal(delivered.status, 200, "STOREDOC_OPEN delivered");
  assert.deepEqual(Buffer.from(await delivered.arrayBuffer()), resume, "STOREDOC_OPEN the bytes");
  assert.equal(delivered.headers.get("content-security-policy"), "default-src 'none'; sandbox");
  assert.deepEqual(f.views.map((v) => v.operation), ["issue", "deliver"], "STOREDOC_OPEN delivery audited");

  const missing = await f.unknownPath();
  const refused = async (response: Response, message: string) => { assert.equal(response.status, 404, `${message} status`); assert.equal(await response.text(), missing, `${message} body`); };
  await refused(await f.get(location, "otherManager"), "STOREDOC_OPEN another manager cannot use the link");
  await refused(await f.get(location, "coManager"), "STOREDOC_OPEN a link is for its viewer, even at the same store");
  await refused(await f.open(`${page("amal")}/civil-id-front/open`, "manager"), "STOREDOC_OPEN a civil ID image");
  await refused(await f.open(`${page("zaid")}/personal-photo/open`, "manager"), "STOREDOC_OPEN a missing photo");
  const again = (await f.open(`${page("amal")}/personal-photo/open`, "manager")).headers.get("location")!;
  f.managed.manager = [];
  await refused(await f.get(again, "manager"), "STOREDOC_OPEN delivery re-checks the store access");
  f.managed.manager = [{ orgId: "org-a", storeId: S.a }];
  const [payload, mac] = again.split("t=")[1]!.split(".");
  const claim = JSON.parse(Buffer.from(payload!, "base64url").toString());
  await refused(await f.get(`/workspace/stores/documents/delivery?t=${Buffer.from(JSON.stringify({ ...claim, subject: "badr" })).toString("base64url")}.${mac}`, "manager"), "STOREDOC_OPEN a tampered link");
  assert.deepEqual(f.views.map((v) => v.operation), ["issue", "deliver", "issue"], "STOREDOC_OPEN refusals record nothing more");
});

test("STOREDOC_ACCESS only the manager of the store, for a person placed there now or later; everyone else gets the unknown-path 404", async (t) => {
  const f = await fixture(t);
  const missing = await f.unknownPath();
  const same = async (response: Response, message: string) => { assert.equal(response.status, 404, `${message} status`); assert.equal(await response.text(), missing, `${message} body`); };
  for (const who of ["otherManager", "owner", "staff", "candidate"] as const) {
    await same(await f.get(page("amal"), who), `STOREDOC_ACCESS ${who} list`);
    await same(await f.open(`${page("amal")}/resume/open`, who), `STOREDOC_ACCESS ${who} open`);
  }
  await same(await f.get(page("badr"), "manager"), "STOREDOC_ACCESS an ended placement");
  await same(await f.get(page("amal", S.second), "otherManager"), "STOREDOC_ACCESS an ended placement at the other store");
  await same(await f.get(page("nobody"), "manager"), "STOREDOC_ACCESS a person never placed");
  await same(await f.get(page("bad%2Fid"), "manager"), "STOREDOC_ACCESS a malformed id");
  await same(await f.get(`${page("amal")}?x=1`, "manager"), "STOREDOC_ACCESS a query");
  assert.equal((await f.get(page("amal"))).status, 401, "STOREDOC_ACCESS no session is 401");
  assert.equal((await f.get("/workspace/stores/documents/delivery?t=x.y")).status, 401, "STOREDOC_ACCESS delivery without a session is 401");
  assert.deepEqual(f.views, [], "STOREDOC_ACCESS refusals record nothing");
});

test("STOREDOC_GUARDS open is same-origin with an empty body; unwired or failing audit is unavailable", async (t) => {
  const f = await fixture(t);
  for (const headers of [{ origin: "https://elsewhere.invalid" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
    assert.equal((await f.open(`${page("amal")}/resume/open`, "manager", { headers })).status, 403, `STOREDOC_GUARDS ${JSON.stringify(headers)}`);
  }
  assert.deepEqual(f.calls, [], "STOREDOC_GUARDS origin is checked before any read");
  const large = await f.open(`${page("amal")}/resume/open`, "manager", { body: "x=" + "y".repeat(65_536) });
  assert.equal(large.status, 404, "STOREDOC_GUARDS a body is refused");
  assert.equal(await large.text(), await f.unknownPath(), "STOREDOC_GUARDS a body is the unknown path, and it reaches the client");
  assert.equal((await f.open(`${page("amal")}/resume/open`, "manager", { body: "x=1" })).status, 404, "STOREDOC_GUARDS a small body is refused too");
  assert.deepEqual(f.views, [], "STOREDOC_GUARDS nothing issued");
  const unwired = await fixture(t, { audit: false });
  assert.equal((await unwired.get(page("amal"), "manager")).status, 503, "STOREDOC_GUARDS no audit store is 503");
  const failing = await fixture(t, { auditFails: true });
  const response = await failing.open(`${page("amal")}/resume/open`, "manager");
  assert.equal(response.status, 503, "STOREDOC_GUARDS a failing audit gives no link");
  assert.equal(response.headers.get("location"), null);
  assert.doesNotMatch(await response.text(), /private/, "STOREDOC_GUARDS no internal detail");
});
