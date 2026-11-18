import assert from "node:assert/strict";
import { Readable } from "node:stream";
import { test } from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { createRecruitEmployerView, handleRecruitEmployerView, type EmployerDocumentsPort, type RecruitEmployerViewStore } from "../src/recruit/employer-view-http.js";

const SESSION = "h".repeat(43), REQ = "223e4567-e89b-42d3-a456-426614174000";
const base = { principal_id: "p1", name: "Noor <b>", arabic_name: null, objective: "Retail", introduction: "Hi <script>", preferred_time: null, gender: "female", birth_date: "2000-06-15", driving_licence: true, nationality_name: "Kuwait", area_name: null, job_search_status: "active" };
const store: RecruitEmployerViewStore = {
  person: async (viewer, r, who) => {
    if (r !== REQ || viewer === "stranger") return null;
    if (who === "gone") return { person: { ...base, principal_id: who }, records: [], link: { stage: "withdrawn", invitation_status: null }, staff: false };
    if (who === "gone-staff") return { person: { ...base, principal_id: who }, records: [], link: { stage: "withdrawn", invitation_status: null }, staff: true };
    return who === "p1" ? { person: base, records: [{ kind: "skill", fields: { name: "Arabic" }, university: null, degree: null, major: null }], link: { stage: "contacted", invitation_status: null }, staff: false } : null;
  },
  recordEmployerDocumentView: async () => {},
};
const sessions = { get: async (id: string) => (id === SESSION ? { id, personId: "owner" } : id === "s".repeat(43) ? { id, personId: "stranger" } : undefined) };
const now = () => new Date("2026-06-14T22:30:00Z");
const issued: string[] = [];
const documents: EmployerDocumentsPort = { links: async (viewer, who, r) => { issued.push(`${viewer}:${who}:${r}`); return [{ type: "resume", url: "/documents/delivery?t=abc&x=1", expiresAt: "2026-06-15T00:00:00Z" }]; },
  deliver: async (session, url) => { if (session !== SESSION || url !== "/recruit/documents/delivery?t=ok") throw Error("denied"); return { bytes: Buffer.from("%PDF"), headers: { "Content-Type": "application/pdf" } }; } };

async function call(service: ReturnType<typeof createRecruitEmployerView>, path: string, o: { cookie?: string; html?: boolean; method?: string } = {}) {
  const req = Readable.from([]) as IncomingMessage;
  req.url = path; req.method = o.method ?? "GET"; req.headers = { cookie: `__Host-studenthub_session=${o.cookie ?? SESSION}` };
  let status = 0, payload: string | Buffer = "", page: { status: number; body: string } | undefined;
  const fake = { headersSent: false, writeHead(code: number) { status = code; fake.headersSent = true; return fake; }, end(chunk?: string | Buffer) { payload = chunk ?? ""; return fake; }, destroy() { return fake; } };
  const handled = await handleRecruitEmployerView(req, fake as unknown as ServerResponse, service, (s, _t, body) => { page = { status: s, body }; }, o.html ?? false);
  return { handled, status: page?.status ?? status, json: payload && !Buffer.isBuffer(payload) ? JSON.parse(payload) as Record<string, unknown> : undefined, bytes: Buffer.isBuffer(payload) ? payload.toString() : undefined, page };
}

test("REC5_HTTP the company reads a linked person in Kuwait time; withdrawn links hide them except from staff; documents come from the port", async () => {
  const plain = createRecruitEmployerView({ sessions, store, now });
  const r = await call(plain, `/recruit/requests/${REQ}/people/p1`);
  assert.equal(r.status, 200);
  const person = r.json!.person as { age: number; skills: string[]; stage: string };
  assert.deepEqual([person.age, person.skills, person.stage, r.json!.documents], [26, ["Arabic"], "contacted", null], "15 June has begun in Kuwait");
  assert.deepEqual((await call(plain, `/recruit/requests/${REQ}/people/gone`)).json, { error: "not_found" });
  assert.equal((await call(plain, `/recruit/requests/${REQ}/people/gone-staff`)).status, 200);
  assert.deepEqual((await call(plain, `/recruit/requests/${REQ}/people/p1`, { cookie: "s".repeat(43) })).json, { error: "not_found" });
  assert.deepEqual((await call(plain, `/recruit/requests/nope/people/p1`)).json, { error: "not_found" });
  assert.equal((await call(plain, `/recruit/requests/${REQ}/people/p1`, { cookie: "x" })).status, 401);
  assert.equal((await call(plain, `/recruit/requests/${REQ}/people/p1`, { method: "POST" })).status, 404);
  assert.equal((await call(plain, `/recruit/requests/${REQ}`)).handled, false);
  const withDocs = createRecruitEmployerView({ sessions, store, now, documents });
  assert.deepEqual((await call(withDocs, `/recruit/requests/${REQ}/people/p1`)).json!.documents, [{ type: "resume", url: "/documents/delivery?t=abc&x=1", expiresAt: "2026-06-15T00:00:00Z" }]);
  assert.deepEqual(issued, [`${SESSION}:p1:${REQ}`], "links are issued for the caller's own session");
  const failing = createRecruitEmployerView({ sessions, store, now, documents: { links: async () => { throw Error("down"); }, deliver: async () => { throw Error("down"); } } });
  assert.equal((await call(failing, `/recruit/requests/${REQ}/people/p1`)).json!.documents, null, "a documents failure shows the page without documents");
});

test("REC5_HTTP_PAGE the page escapes the person and shows documents only as issued links", async () => {
  const page = (await call(createRecruitEmployerView({ sessions, store, now, documents }), `/recruit/requests/${REQ}/people/p1`, { html: true })).page!;
  for (const text of ["Noor &lt;b&gt;", "Hi &lt;script&gt;", "<dt>Age</dt><dd>26</dd>", "Contacted", 'href="/documents/delivery?t=abc&amp;x=1"', ">CV<"]) assert.ok(page.body.includes(text), text);
  assert.equal(page.body.includes("2000-06-15"), false, "the birth date itself is not shown");
  const none = (await call(createRecruitEmployerView({ sessions, store, now }), `/recruit/requests/${REQ}/people/p1`, { html: true })).page!;
  assert.ok(none.body.includes("once secure document links are available"));
});

test("REC5_HTTP_DELIVERY the delivery path answers bytes only for a valid link and the caller's session", async () => {
  const withDocs = createRecruitEmployerView({ sessions, store, now, documents });
  const ok = await call(withDocs, "/recruit/documents/delivery?t=ok");
  assert.deepEqual([ok.handled, ok.status, ok.bytes], [true, 200, "%PDF"]);
  for (const [path, o] of [["/recruit/documents/delivery?t=bad", {}], ["/recruit/documents/delivery?t=ok", { cookie: "s".repeat(43) }], ["/recruit/documents/delivery?t=ok", { method: "POST" }]] as const) {
    const r = await call(withDocs, path, o);
    assert.deepEqual([r.handled, r.status, r.json], [true, 404, { error: "not_found" }], path);
  }
  assert.equal((await call(createRecruitEmployerView({ sessions, store, now }), "/recruit/documents/delivery?t=ok")).status, 404, "no documents store, no bytes");
});
