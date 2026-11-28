import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { PeopleDirectoryRow, PeopleDirectoryStore } from "@studenthub/profile";
import { createPeopleDirectory } from "../src/people-directory.js";
import { REAL_PROFILE_OTHER_SESSION, REAL_PROFILE_SESSION, startRealProfileServer } from "./helpers/real-profile-server.js";

// A-01: one person's page for operator staff and admin, reached from the People list.
const nationalityId = "11111111-1111-4111-8111-111111111111";
const complete: PeopleDirectoryRow = { principalId: "person-9", name: "Written <Name>", universeName: "Universe Name", arabicName: "اسم", workStatus: "active",
  nationality: { id: nationalityId, name: "Kuwaiti" }, detailsMissing: 0, civilState: "checked", imported: true, employeeId: "C00123", phoneLast4: "0000" };
const sparse: PeopleDirectoryRow = { principalId: "person:10", name: null, universeName: "Universe Person", arabicName: null, workStatus: null,
  nationality: null, detailsMissing: 3, civilState: "waiting", imported: false, employeeId: null, phoneLast4: null };

type Extra = { readonly withPerson?: boolean; readonly throwing?: boolean; readonly links?: boolean };

async function setup(t: TestContext, extra: Extra = {}) {
  const reads: { principalId: string; today: string }[] = [];
  // "person-mismatch" stands for a store that answers with someone else's row: the page must not show it.
  const data = new Map<string, PeopleDirectoryRow>([...[complete, sparse].map((row) => [row.principalId, row] as const), ["person-mismatch", complete]]);
  const store: PeopleDirectoryStore = {
    async page() { return { rows: [complete, sparse], total: 2 }; },
    ...(extra.withPerson === false ? {} : { async person(principalId: string, today: string) {
      reads.push({ principalId, today });
      if (extra.throwing) throw new Error("private store detail");
      return data.get(principalId) ?? null;
    } }),
  };
  const server = await startRealProfileServer(t, { now: () => new Date("2026-11-27T21:30:00.000Z"), extend: (services) => ({
    people: createPeopleDirectory({ sessions: services.sessions, authz: services.authz, store, choices: async () => ({ countries: [] }), now: services.now }),
    ...(extra.links ? { staffMessages: {} as never, access: {} as never, staffView: {} as never } : {}),
  }) });
  return { server, reads };
}
const staff = async (x: Awaited<ReturnType<typeof setup>>, role: "staff" | "admin" = "staff") =>
  x.server.authz.grantMany("person-1", [{ orgId: "root", role, scope: "subtree" }]);
const json = (x: Awaited<ReturnType<typeof setup>>, path: string, session = REAL_PROFILE_SESSION) =>
  fetch(x.server.url + path, { headers: { accept: "application/json", cookie: x.server.cookie(session) }, redirect: "manual" });

test("PERSON_PAGE staff see the list's facts for one person, masked as on the list", async (t) => {
  const x = await setup(t); await staff(x);
  const response = await x.server.get("/workspace/people/person-9");
  const html = await response.text();
  assert.equal(response.status, 200, "PERSON_PAGE staff page is 200");
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.match(html, /<h1>Written &lt;Name&gt;<\/h1><span class="badge">Imported<\/span>/, "PERSON_PAGE heading is the written name, escaped");
  for (const [label, value] of [["Universe name", "Universe Name"], ["Arabic name", "اسم"], ["Employee ID", "C00123"], ["Work status", "Actively looking"],
    ["Nationality", "Kuwaiti"], ["Details", "Details complete"], ["Civil ID", "Checked"]]) {
    assert.match(html, new RegExp(`<dt>${label}</dt><dd>${value}</dd>`), `PERSON_PAGE ${label}`);
  }
  assert.match(html, /<dt>Phone<\/dt><dd>[^<]*0000<\/dd>/, "PERSON_PAGE phone is masked to its last four");
  assert.doesNotMatch(html, /\+965|registry@example/, "PERSON_PAGE no full phone or email");
  assert.deepEqual(x.reads, [{ principalId: "person-9", today: "2026-11-28" }], "PERSON_PAGE one read, with the Kuwait date");

  const thin = await (await x.server.get("/workspace/people/person%3A10")).text();
  for (const [label, value] of [["Name", "Universe Person"], ["Employee ID", "Not imported"], ["Work status", "Not recorded"], ["Nationality", "Not recorded"],
    ["Details", "3 details missing"], ["Civil ID", "Waiting for review"], ["Phone", "Not recorded"]]) {
    assert.match(thin, new RegExp(`<dt>${label}</dt><dd>${value}</dd>`), `PERSON_PAGE sparse ${label}`);
  }
  assert.doesNotMatch(thin, /Universe name|Arabic name|badge">Imported/, "PERSON_PAGE absent facts are left out");

  const body = await (await json(x, "/workspace/people/person-9")).json();
  assert.deepEqual(body, { person: complete, active: { orgId: "root", role: "staff" } }, "PERSON_PAGE JSON is the same projection");
});

test("PERSON_LINKS the list links each person, and the page links the staff pages that exist", async (t) => {
  const x = await setup(t, { links: true }); await staff(x, "admin");
  const list = await (await x.server.get("/workspace/people")).text();
  assert.match(list, /<th scope="row"><a href="\/workspace\/people\/person-9">Written &lt;Name&gt;<\/a>/, "PERSON_LINKS list links the person");
  assert.match(list, /<th scope="row"><a href="\/workspace\/people\/person%3A10">Universe Person<\/a>/, "PERSON_LINKS list encodes the id");
  const page = await (await x.server.get("/workspace/people/person-9")).text();
  assert.match(page, /<nav class="person-actions" aria-label="Actions for this person"><a class="text-link" href="\/workspace\/people\/person-9\/message">Send a message<\/a><a class="text-link" href="\/workspace\/people\/person-9\/emails">Email log<\/a><a class="text-link" href="\/admin\/access\/people\/person-9">Access<\/a><a class="text-link" href="\/admin\/access\/people\/person-9\/view">View their profile<\/a><\/nav>/, "PERSON_LINKS every wired staff page is linked");
  assert.match(page, /href="\/workspace\/people">Back to People<\/a>/);
  const bare = await setup(t); await staff(bare);
  assert.doesNotMatch(await (await bare.server.get("/workspace/people/person-9")).text(), /person-actions/, "PERSON_LINKS unwired pages are not linked");
});

test("PERSON_ACCESS everyone but operator staff and admin gets the unknown-path 404", async (t) => {
  const x = await setup(t);
  const missing = await x.server.get("/no-such-page");
  const missingBody = await missing.text();
  const same = async (response: Response, message: string) => {
    assert.equal(response.status, 404, `${message} status`);
    assert.equal(await response.text(), missingBody, `${message} body`);
  };
  await same(await x.server.get("/workspace/people/person-9"), "PERSON_ACCESS a candidate");
  await x.server.authz.grantMany("person-1", [{ orgId: "root", role: "recruiter", scope: "subtree" }]);
  await same(await x.server.get("/workspace/people/person-9"), "PERSON_ACCESS an operator recruiter");
  await same(await x.server.get("/workspace/people/person-9", REAL_PROFILE_OTHER_SESSION), "PERSON_ACCESS another person");
  assert.equal(x.reads.length, 0, "PERSON_ACCESS refused callers read nothing");
  const anonymous = await fetch(`${x.server.url}/workspace/people/person-9`, { headers: { accept: "text/html" }, redirect: "manual" });
  assert.equal(anonymous.status, 401, "PERSON_ACCESS no session is 401");
  await staff(x);
  for (const path of ["/workspace/people/nobody", "/workspace/people/person-mismatch", "/workspace/people/%E0%A4%A", "/workspace/people/.hidden", "/workspace/people/person-9?x=1", `/workspace/people/${"a".repeat(129)}`]) {
    await same(await x.server.get(path), `PERSON_ACCESS ${path.slice(0, 40)}`);
  }
  assert.deepEqual(x.reads.map((read) => read.principalId), ["nobody", "person-mismatch"], "PERSON_ACCESS only a well-formed id is read");
});

test("PERSON_FAILURE a store without the read or a failing read is unavailable, without detail", async (t) => {
  const old = await setup(t, { withPerson: false }); await staff(old);
  assert.equal((await old.server.get("/workspace/people/person-9")).status, 503, "PERSON_FAILURE no person read is 503");
  const broken = await setup(t, { throwing: true }); await staff(broken);
  const response = await broken.server.get("/workspace/people/person-9");
  assert.equal(response.status, 503, "PERSON_FAILURE a failing read is 503");
  assert.doesNotMatch(await response.text(), /private/, "PERSON_FAILURE no internal detail");
});
