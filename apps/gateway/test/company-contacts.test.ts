import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createGatewayServer } from "../src/index.js";
import { renderContextSwitcher } from "../src/web-ui.js";
import type { CompanyContactsPorts } from "../src/access/company-contacts.js";
import { createCompanyContactsService, type CompanyContact, type CompanyContactsStore } from "../../../packages/access/src/index.js";

const ORIGIN = "https://studenthub.example.invalid";
const SESSIONS: Record<string, string> = { ["o".repeat(43)]: "owner-1", ["r".repeat(43)]: "recruiter-1", ["c".repeat(43)]: "candidate-1", ["s".repeat(43)]: "staff-1" };
const session = (principalId: string) => Object.entries(SESSIONS).find(([, id]) => id === principalId)![0];
type Held = { principalId: string; orgId: string; role: string; scope: "self" | "subtree" };

function world() {
  const orgs: Record<string, { name: string; parent: string | null }> = { root: { name: "StudentHub", parent: null }, acme: { name: "Acme <Trading>", parent: "root" } };
  const grants: Held[] = [
    { principalId: "owner-1", orgId: "acme", role: "org-owner", scope: "self" },
    { principalId: "recruiter-1", orgId: "acme", role: "recruiter", scope: "self" },
    { principalId: "candidate-1", orgId: "acme", role: "candidate", scope: "self" },
    { principalId: "staff-1", orgId: "root", role: "staff", scope: "subtree" },
  ];
  const rows: (CompanyContact & { orgId: string; removed: boolean })[] = [];
  const ancestors = (orgId: string) => { const out: string[] = []; let at = orgs[orgId]?.parent ?? null; while (at) { out.push(at); at = orgs[at]?.parent ?? null; } return out; };
  const snapshot = (callerId: string, orgId: string) => ({ callerGrants: grants.filter((grant) => grant.principalId === callerId), orgLive: orgId in orgs, orgAncestors: ancestors(orgId), liveContacts: rows.filter((row) => row.orgId === orgId && !row.removed).length });
  const store: CompanyContactsStore = {
    async context(callerId, orgId) { return { callerGrants: grants.filter((grant) => grant.principalId === callerId), organization: orgs[orgId] ? { orgId, name: orgs[orgId]!.name, ancestors: ancestors(orgId) } : null }; },
    async contacts(orgId) { return rows.filter((row) => row.orgId === orgId && !row.removed).map(({ orgId: _o, removed: _r, ...row }) => row); },
    async create(input) {
      const decision = input.decide(snapshot(input.callerId, input.orgId));
      if (decision.kind === "refused") return decision;
      const id = `00000000-0000-4000-8000-${String(rows.length + 1).padStart(12, "0")}`;
      rows.push({ id, orgId: input.orgId, removed: false, updatedAt: "2026-11-17T10:00:00.000Z", ...input.contact });
      return { kind: "created", id };
    },
    async update(input) {
      const decision = input.decide(snapshot(input.callerId, input.orgId));
      if (decision.kind === "refused") return decision;
      const row = rows.find((item) => item.id === input.contactId && item.orgId === input.orgId && !item.removed);
      if (!row) return { kind: "refused", reason: "not_found" };
      Object.assign(row, input.contact);
      return { kind: "updated" };
    },
    async remove(input) {
      const decision = input.decide(snapshot(input.callerId, input.orgId));
      if (decision.kind === "refused") return decision;
      const row = rows.find((item) => item.id === input.contactId && item.orgId === input.orgId && !item.removed);
      if (!row) return { kind: "refused", reason: "not_found" };
      row.removed = true;
      return { kind: "removed" };
    },
  };
  const ports: CompanyContactsPorts = {
    sessions: { get: async (id: string) => (SESSIONS[id] ? { id, personId: SESSIONS[id]! } : undefined) } as CompanyContactsPorts["sessions"],
    contacts: createCompanyContactsService({ store }),
  };
  return { ports, rows, grants };
}

async function serve(t: TestContext, ports: CompanyContactsPorts | undefined) {
  const server = createGatewayServer(undefined, undefined, undefined, { ...(ports ? { contacts: ports } : {}), web: { origin: ORIGIN } } as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = (principalId?: string): Record<string, string> => principalId ? { cookie: `__Host-studenthub_session=${session(principalId)}` } : {};
  const get = (path: string, principalId?: string) => fetch(base + path, { headers: { accept: "text/html", ...cookie(principalId) }, redirect: "manual" });
  const post = (path: string, principalId: string | undefined, form: Record<string, string> = {}, origin = ORIGIN) =>
    fetch(base + path, { method: "POST", redirect: "manual", body: new URLSearchParams(form).toString(),
      headers: { accept: "text/html", origin, "content-type": "application/x-www-form-urlencoded", ...cookie(principalId) } });
  return { get, post };
}
async function sameAsUnknown(actual: Response, unknown: Response, message: string) {
  assert.equal(actual.status, unknown.status, `${message} status`);
  assert.equal(await actual.text(), await unknown.text(), `${message} body`);
}

test("A3_READ_SITES members and staff read contacts; only owners and staff see the forms; others get the unknown-path 404", async (t) => {
  const { ports } = world();
  const http = await serve(t, ports);
  assert.equal((await http.post("/workspace/companies/acme/contacts", "owner-1", { name: "Layla", phone0: "+965 5555 1234", email0: "Layla@Acme.example" })).status, 303);
  const owner = await (await http.get("/workspace/companies/acme/contacts", "owner-1")).text();
  assert.match(owner, /Layla/);
  assert.match(owner, /\+96555551234/);
  assert.match(owner, /Add contact/);
  const recruiter = await http.get("/workspace/companies/acme/contacts", "recruiter-1");
  assert.equal(recruiter.status, 200);
  const recruiterHtml = await recruiter.text();
  assert.match(recruiterHtml, /layla@acme\.example/);
  assert.doesNotMatch(recruiterHtml, /Add contact|Edit<\/a>|Remove Layla/);
  assert.match(await (await http.get("/workspace/companies/acme/contacts", "staff-1")).text(), /Add contact/);
  for (const principalId of [undefined, "candidate-1"]) {
    await sameAsUnknown(await http.get("/workspace/companies/acme/contacts", principalId), await http.get("/definitely-unknown", principalId), `${principalId ?? "signed out"} list`);
    await sameAsUnknown(await http.post("/workspace/companies/acme/contacts", principalId, { name: "X" }), await http.get("/definitely-unknown", principalId), `${principalId ?? "signed out"} add`);
  }
  await sameAsUnknown(await http.post("/workspace/companies/acme/contacts", "recruiter-1", { name: "X" }), await http.get("/definitely-unknown", "recruiter-1"), "recruiter add");
  await sameAsUnknown(await http.get("/workspace/companies/nowhere/contacts", "owner-1"), await http.get("/definitely-unknown", "owner-1"), "unknown company");
  const off = await serve(t, undefined);
  await sameAsUnknown(await off.get("/workspace/companies/acme/contacts", "owner-1"), await off.get("/definitely-unknown", "owner-1"), "unconfigured");
});

test("A3_CONTACT add, edit and validation through the pages; cross-origin and unknown fields are refused", async (t) => {
  const { ports, rows } = world();
  const http = await serve(t, ports);
  assert.equal((await http.post("/workspace/companies/acme/contacts", "owner-1", { name: "Layla", roleTitle: "Accountant", phone0: "22223333", phoneLabel0: "Office" })).status, 303);
  const id = rows[0]!.id;
  const edit = await http.get(`/workspace/companies/acme/contacts/${id}/edit`, "owner-1");
  assert.equal(edit.status, 200);
  assert.match(await edit.text(), /value="Office"/);
  assert.equal((await http.post(`/workspace/companies/acme/contacts/${id}`, "owner-1", { name: "Layla A.", email0: "l@acme.example" })).status, 303);
  assert.deepEqual([rows[0]!.name, rows[0]!.phones, rows[0]!.emails], ["Layla A.", [], [{ value: "l@acme.example", label: null }]]);
  const bad = await http.post("/workspace/companies/acme/contacts", "owner-1", { name: "Bad", phone0: "12" });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /6 to 20 digits/);
  assert.equal((await http.post("/workspace/companies/acme/contacts", "owner-1", { name: "Bad", phone5: "22223333" })).status, 400);
  assert.equal((await http.post("/workspace/companies/acme/contacts", "owner-1", { name: "Evil" }, "https://evil.example")).status, 400);
  assert.equal(rows.length, 1);
  await sameAsUnknown(await http.get(`/workspace/companies/acme/contacts/${id}/edit`, "recruiter-1"), await http.get("/definitely-unknown", "recruiter-1"), "recruiter edit form");
});

test("A3_REMOVE removing a contact hides it and leaves every grant alone", async (t) => {
  const { ports, rows, grants } = world();
  const http = await serve(t, ports);
  await http.post("/workspace/companies/acme/contacts", "owner-1", { name: "Layla" });
  const before = JSON.stringify(grants);
  assert.equal((await http.post(`/workspace/companies/acme/contacts/${rows[0]!.id}/remove`, "owner-1")).status, 303);
  assert.equal(rows[0]!.removed, true);
  assert.doesNotMatch(await (await http.get("/workspace/companies/acme/contacts", "owner-1")).text(), /Layla/);
  assert.equal(JSON.stringify(grants), before);
  assert.equal((await http.post(`/workspace/companies/acme/contacts/${rows[0]!.id}/remove`, "owner-1")).status, 404);
});

test("A3_SWITCHER more than one context shows the switcher with the current one and links to the others; one shows none", () => {
  const acme = { orgId: "acme", role: "recruiter" as const, organizationName: "Acme <Trading>" };
  const beta = { orgId: "beta", role: "org-owner" as const, organizationName: "Beta" };
  assert.equal(renderContextSwitcher([acme], acme), "");
  const html = renderContextSwitcher([acme, beta], acme);
  assert.match(html, /<summary aria-label="Switch company"><strong>Acme &lt;Trading&gt; · /);
  assert.match(html, /href="\/workspace\?org_id=beta&amp;role=org-owner"/);
  assert.doesNotMatch(html, /org_id=acme/, "the current context is not offered as a switch");
  assert.match(renderContextSwitcher([acme, beta], null), /Choose a workspace/);
});
