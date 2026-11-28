import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import test, { type TestContext } from "node:test";
import { InMemoryAuthzStore, createPrincipal } from "@studenthub/contracts";
import type { PeopleDirectoryRow, PeopleDirectoryStore } from "@studenthub/profile";
import { CandidateDocuments } from "../../../packages/private-documents/src/candidate-lifecycle.js";
import { createPeopleDirectory } from "../src/people-directory.js";
import { REAL_PROFILE_CIVIL_KEY, REAL_PROFILE_ORIGIN, REAL_PROFILE_OTHER_PERSON, REAL_PROFILE_OTHER_SESSION, REAL_PROFILE_PERSON, REAL_PROFILE_SESSION, startRealProfileServer } from "./helpers/real-profile-server.js";

// A-03: one person's documents for operator staff and admin, reached from the person page.
const photo = Buffer.from("photo-bytes"), resume = Buffer.from("%PDF-resume".padEnd(2048, ".")), front = Buffer.from("civil-front");
const person: PeopleDirectoryRow = { principalId: REAL_PROFILE_OTHER_PERSON, name: "Other <Person>", universeName: null, arabicName: null, workStatus: null,
  nationality: null, detailsMissing: 0, civilState: "recorded", imported: false, employeeId: null, phoneLast4: null };
const path = `/workspace/people/${REAL_PROFILE_OTHER_PERSON}/documents`;

type Grant = { readonly orgId: "root" | "candidate-documents"; readonly role: "staff" | "admin" | "org-owner"; readonly scope: "self" | "subtree" };
type Extra = { readonly staffGrant?: Grant; readonly noDocuments?: boolean; readonly throwingPeople?: boolean };

async function setup(t: TestContext, extra: Extra = {}) {
  const authz = new InMemoryAuthzStore({ organizations: [{ id: "candidate-documents", name: "Candidates" }, { id: "root", name: "StudentHub" }],
    principals: [createPrincipal({ id: REAL_PROFILE_PERSON, pbuuids: [] }), createPrincipal({ id: REAL_PROFILE_OTHER_PERSON, pbuuids: [] })] });
  await authz.grantMany(REAL_PROFILE_PERSON, [{ orgId: "root", role: "staff", scope: "subtree" }]);
  const doc = (type: string, mime: string, bytes: Buffer) => ({ id: randomUUID(), version: randomUUID(), type, mime, size: bytes.length,
    scope: { orgId: "candidate-documents", personId: REAL_PROFILE_OTHER_PERSON }, acl: "private", data: bytes.toString("base64") });
  const state = { format: 1 as const, documents: [doc("personal-photo", "image/png", photo), doc("resume", "application/pdf", resume), doc("civil-id-front", "image/jpeg", front)], retired: [] as never[] };
  const documents = new CandidateDocuments({ store: { transaction: async (fn) => fn(state as never) }, authz, orgId: "candidate-documents", origin: REAL_PROFILE_ORIGIN,
    signingKey: Buffer.from(REAL_PROFILE_CIVIL_KEY, "base64"), now: () => new Date("2026-11-12T09:00:00Z").getTime(),
    authenticate: async (c) => c === REAL_PROFILE_SESSION ? { kind: "principal", principalId: REAL_PROFILE_PERSON } : null });
  const reads: string[] = [];
  const store: PeopleDirectoryStore = {
    async page() { return { rows: [person], total: 1 }; },
    async person(principalId: string) { reads.push(principalId); if (extra.throwingPeople) throw new Error("private store detail"); return principalId === person.principalId ? person : null; },
  };
  const server = await startRealProfileServer(t, {
    civilIdReview: { ...(extra.noDocuments ? {} : { documents }), ...(extra.staffGrant ? { staffGrant: extra.staffGrant } : {}) },
    extend: (services) => ({ people: createPeopleDirectory({ sessions: services.sessions, authz: services.authz, store, choices: async () => ({ countries: [] }), now: services.now }) }),
  });
  return { server, reads, state, views: server.reviewStore!.views };
}
type Rig = Awaited<ReturnType<typeof setup>>;
const open = (x: Rig, type: string, init: { session?: string; headers?: Record<string, string>; body?: string } = {}) =>
  fetch(`${x.server.url}${path}/${type}/open`, { method: "POST", redirect: "manual", body: init.body ?? "",
    headers: { accept: "text/html", cookie: x.server.cookie(init.session), origin: REAL_PROFILE_ORIGIN, "sec-fetch-site": "same-origin", "content-type": "application/x-www-form-urlencoded", ...init.headers } });
/** A delivery link signed with the test key, as StaffDocuments.issue would sign it. */
const signedLink = (claim: Record<string, unknown>) => {
  const payload = Buffer.from(JSON.stringify(claim)).toString("base64url");
  return `/workspace/civil-ids/delivery?t=${payload}.${createHmac("sha256", Buffer.from(REAL_PROFILE_CIVIL_KEY, "base64")).update("staff-delivery-v1\u0000" + payload).digest("base64url")}`;
};
const unknownPath = async (x: Rig) => (await x.server.get("/no-such-page")).text();

test("DOCS_PAGE staff see each document's type, state, format and size, with no contents", async (t) => {
  const x = await setup(t);
  const response = await x.server.get(path);
  const html = await response.text();
  assert.equal(response.status, 200, "DOCS_PAGE staff page is 200");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(html, /<h1>Documents for Other &lt;Person&gt;<\/h1>/, "DOCS_PAGE heading names the person, escaped");
  assert.match(html, /<dt>Civil ID<\/dt><dd>Recorded, not yet checked<\/dd>/, "DOCS_PAGE Civil ID state as on the person page");
  const form = (type: string) => `<form method="post" action="/workspace/people/${REAL_PROFILE_OTHER_PERSON}/documents/${type}/open"><button class="text-link" type="submit">Open</button></form>`;
  assert.ok(html.includes(`<tr><th scope="row">Personal photo</th><td>On file</td><td>PNG image</td><td>11 bytes</td><td>${form("personal-photo")}</td></tr>`), "DOCS_PAGE photo row");
  assert.ok(html.includes(`<tr><th scope="row">CV</th><td>On file</td><td>PDF</td><td>2 KB</td><td>${form("resume")}</td></tr>`), "DOCS_PAGE CV row");
  assert.ok(html.includes('<tr><th scope="row">Civil ID front</th><td>On file</td><td>JPEG image</td><td>11 bytes</td><td></td></tr>'), "DOCS_PAGE Civil ID front has no open action");
  assert.ok(html.includes('<tr><th scope="row">Civil ID back</th><td>Missing</td><td>—</td><td>—</td><td></td></tr>'), "DOCS_PAGE missing document");
  assert.match(html, /Upload dates are not recorded\./, "DOCS_PAGE says dates are not recorded");
  assert.doesNotMatch(html, /photo-bytes|PDF-resume|civil-front|cGhvdG8|delivery\?t=/, "DOCS_PAGE no contents and no link issued on read");
  assert.deepEqual(x.views, [], "DOCS_PAGE listing records no document view");
  assert.deepEqual(x.reads, [REAL_PROFILE_OTHER_PERSON], "DOCS_PAGE one person read, for this id");

  const body = await (await fetch(x.server.url + path, { headers: { accept: "application/json", cookie: x.server.cookie() } })).json();
  assert.deepEqual(body, { person: { principalId: REAL_PROFILE_OTHER_PERSON, name: "Other <Person>", civilState: "recorded" }, documents: [
    { type: "personal-photo", state: "on_file", mime: "image/png", size: 11, openable: true },
    { type: "resume", state: "on_file", mime: "application/pdf", size: 2048, openable: true },
    { type: "civil-id-front", state: "on_file", mime: "image/jpeg", size: 11, openable: false },
    { type: "civil-id-back", state: "missing", openable: false },
  ], active: { orgId: "root", role: "staff" } }, "DOCS_PAGE JSON is the same projection");

  const page = await (await x.server.get(`/workspace/people/${REAL_PROFILE_OTHER_PERSON}`)).text();
  assert.match(page, new RegExp(`<a class="text-link" href="/workspace/people/${REAL_PROFILE_OTHER_PERSON}/documents">Documents</a>`), "DOCS_PAGE the person page links the documents");
  assert.match(html, new RegExp(`href="/workspace/people/${REAL_PROFILE_OTHER_PERSON}">Back to Other &lt;Person&gt;</a>`), "DOCS_PAGE links back to the person");
});

test("DOCS_OPEN a photo or CV opens through the existing signed delivery, audited; Civil ID photos do not", async (t) => {
  const x = await setup(t);
  const issued = await open(x, "resume");
  assert.equal(issued.status, 303, "DOCS_OPEN open redirects");
  const location = issued.headers.get("location") ?? "";
  assert.match(location, /^\/workspace\/civil-ids\/delivery\?t=[\w-]+\.[\w-]+$/, "DOCS_OPEN the link is the existing staff delivery");
  assert.deepEqual(x.views.map((v) => [v.kind, v.documentType, v.subjectPrincipalId]), [["person_document_issue", "resume", REAL_PROFILE_OTHER_PERSON]], "DOCS_OPEN issue is audited");
  const delivered = await x.server.get(location);
  assert.equal(delivered.status, 200, "DOCS_OPEN delivery serves a person who is not waiting for review");
  assert.deepEqual(Buffer.from(await delivered.arrayBuffer()), resume, "DOCS_OPEN delivered bytes");
  assert.equal(delivered.headers.get("content-type"), "application/pdf");
  assert.deepEqual(x.views.map((v) => v.kind), ["person_document_issue", "person_document_deliver"], "DOCS_OPEN delivery is audited");

  const missing = await unknownPath(x);
  for (const type of ["civil-id-front", "civil-id-back", "nothing"]) {
    const refused = await open(x, type);
    assert.equal(refused.status, 404, `DOCS_OPEN ${type} is 404`);
    assert.equal(await refused.text(), missing, `DOCS_OPEN ${type} is the unknown path`);
  }
  x.state.documents.splice(0, 1);
  const gone = await open(x, "personal-photo");
  assert.equal(gone.status, 404, "DOCS_OPEN a missing photo is 404");
  assert.equal(await gone.text(), missing, "DOCS_OPEN a missing photo is the unknown path");
  assert.equal(x.views.length, 2, "DOCS_OPEN refusals issue nothing");

  // The document service itself refuses a person page link for a Civil ID photo, and a forged one is not delivered.
  await assert.rejects(x.server.login.civilIdReview!.staffDocuments!.issue(REAL_PROFILE_SESSION, REAL_PROFILE_OTHER_PERSON, "civil-id-front", "person_page"),
    (error: { code?: string }) => error.code === "denied", "DOCS_OPEN Civil ID person page link is refused at issue");
  const forged = signedLink({ viewer: REAL_PROFILE_PERSON, subject: REAL_PROFILE_OTHER_PERSON, type: "civil-id-front", version: x.state.documents.find((d) => d.type === "civil-id-front")!.version,
    purpose: "person_page", issuedAt: Date.parse("2026-11-12T09:00:00Z"), expiresAt: Date.parse("2026-11-12T09:00:00Z") + 60_000 });
  const refused = await x.server.get(forged);
  assert.equal(refused.status, 404, "DOCS_OPEN a signed Civil ID person page link is not delivered");
  assert.equal(x.views.length, 2, "DOCS_OPEN the refused delivery records nothing");
});

test("DOCS_ACCESS everyone but operator staff and admin gets the unknown-path 404", async (t) => {
  for (const staffGrant of [{ orgId: "root", role: "org-owner", scope: "subtree" }, { orgId: "root", role: "staff", scope: "self" }, { orgId: "candidate-documents", role: "admin", scope: "subtree" }] as const) {
    const x = await setup(t, { staffGrant });
    const missing = await unknownPath(x);
    for (const response of [await x.server.get(path), await open(x, "resume")]) {
      assert.equal(response.status, 404, `DOCS_ACCESS ${staffGrant.role}/${staffGrant.scope}/${staffGrant.orgId} status`);
      assert.equal(await response.text(), missing, `DOCS_ACCESS ${staffGrant.role}/${staffGrant.scope}/${staffGrant.orgId} body`);
    }
    assert.deepEqual([x.reads, x.views], [[], []], "DOCS_ACCESS refused callers read and issue nothing");
  }
  const x = await setup(t);
  const missing = await unknownPath(x);
  const same = async (response: Response, message: string) => {
    assert.equal(response.status, 404, `${message} status`);
    assert.equal(await response.text(), missing, `${message} body`);
  };
  await same(await x.server.get(path, REAL_PROFILE_OTHER_SESSION), "DOCS_ACCESS the person themselves");
  await same(await open(x, "resume", { session: REAL_PROFILE_OTHER_SESSION }), "DOCS_ACCESS the person themselves opening");
  for (const bad of ["/workspace/people/nobody/documents", "/workspace/people/%E0%A4%A/documents", "/workspace/people/.hidden/documents", `${path}?x=1`, `${path}/`]) {
    await same(await x.server.get(bad), `DOCS_ACCESS ${bad}`);
  }
  assert.deepEqual(x.reads, ["nobody"], "DOCS_ACCESS only a well-formed id is read");
  const anonymous = await fetch(x.server.url + path, { headers: { accept: "text/html" } });
  assert.equal(anonymous.status, 401, "DOCS_ACCESS no session is 401");
  assert.equal(x.views.length, 0, "DOCS_ACCESS nothing issued");
});

test("DOCS_GUARDS open is same-origin with an empty body; failures are unavailable without detail", async (t) => {
  const x = await setup(t);
  for (const headers of [{ origin: "https://elsewhere.invalid" }, { "sec-fetch-site": "cross-site" }] as Record<string, string>[]) {
    const refused = await open(x, "resume", { headers });
    assert.equal(refused.status, 403, `DOCS_GUARDS ${JSON.stringify(headers)} refused`);
  }
  assert.deepEqual([x.reads, x.views], [[], []], "DOCS_GUARDS origin is checked before any read");
  const extra = await open(x, "resume", { body: "x=1" });
  assert.equal(extra.status, 404, "DOCS_GUARDS a body is refused");
  assert.equal(await extra.text(), await unknownPath(x), "DOCS_GUARDS a body is the unknown path");
  const large = await open(x, "resume", { body: "x=" + "y".repeat(65_536) });
  assert.equal(large.status, 404, "DOCS_GUARDS a large body is refused, and the refusal reaches the client");
  assert.equal(await large.text(), await unknownPath(x), "DOCS_GUARDS a large body is the unknown path");
  assert.equal((await open(x, "resume", { body: "" })).status, 303, "DOCS_GUARDS the empty form opens");
  const query = await fetch(`${x.server.url}${path}/resume/open?x=1`, { method: "POST", redirect: "manual", headers: { cookie: x.server.cookie(), origin: REAL_PROFILE_ORIGIN } });
  assert.equal(query.status, 404, "DOCS_GUARDS a query is refused");

  const unwired = await setup(t, { noDocuments: true });
  assert.equal((await unwired.server.get(path)).status, 503, "DOCS_GUARDS no document service is 503");
  assert.equal((await open(unwired, "resume")).status, 503, "DOCS_GUARDS no document service cannot open");
  const broken = await setup(t, { throwingPeople: true });
  const response = await broken.server.get(path);
  assert.equal(response.status, 503, "DOCS_GUARDS a failing person read is 503");
  assert.doesNotMatch(await response.text(), /private/, "DOCS_GUARDS no internal detail");
  const failing = await setup(t);
  failing.server.login.civilIdReview!.staffDocuments!.documents = async () => { throw new Error("private document detail"); };
  const down = await failing.server.get(path);
  assert.equal(down.status, 503, "DOCS_GUARDS a failing documents read is 503");
  assert.doesNotMatch(await down.text(), /private/, "DOCS_GUARDS no document detail");
});
