import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createGatewayServer } from "../src/index.js";
import type { AccessPorts } from "../src/access/admin-access.js";
import {
  createAccessGrantService,
  type AccessGrantWriteStore,
  type AccessReadStore,
  type GrantChangeRequest,
  type GrantSnapshot,
} from "../../../packages/access/src/index.js";

const ORIGIN = "https://studenthub.example.invalid";
const SESSIONS: Record<string, string> = { ["a".repeat(43)]: "admin-1", ["c".repeat(43)]: "candidate-1", ["o".repeat(43)]: "owner-1", ["s".repeat(43)]: "staff-self" };
const session = (principalId: string) => Object.entries(SESSIONS).find(([, id]) => id === principalId)![0];

type Held = { principalId: string; orgId: string; role: string; scope: "self" | "subtree" };
type Event = { target: string; orgId: string; role: string; scope: "self" | "subtree"; action: "grant" | "revoke"; actor: string; reason: string; at: string; tokenId: string };

function world() {
  const people: Record<string, { displayName: string | null; email: string | null }> = {
    "admin-1": { displayName: "Grace Admin", email: "grace@example.invalid" },
    "candidate-1": { displayName: "Dana Candidate", email: "dana@example.invalid" },
    "owner-1": { displayName: "Omar Owner", email: "omar@example.invalid" },
    "staff-self": { displayName: "Sam Staff", email: "sam@example.invalid" },
  };
  const orgs: Record<string, { name: string; parent: string | null }> = { root: { name: "StudentHub", parent: null }, acme: { name: "Acme <Trading>", parent: "root" } };
  const grants: Held[] = [
    { principalId: "admin-1", orgId: "root", role: "admin", scope: "subtree" },
    { principalId: "owner-1", orgId: "acme", role: "org-owner", scope: "subtree" },
    { principalId: "staff-self", orgId: "root", role: "staff", scope: "self" },
    { principalId: "candidate-1", orgId: "acme", role: "finance", scope: "self" },
  ];
  const events: Event[] = [];
  const ancestors = (orgId: string) => { const out: string[] = []; let at = orgs[orgId]?.parent ?? null; while (at) { out.push(at); at = orgs[at]?.parent ?? null; } return out; };
  const org = (orgId: string) => orgs[orgId] ? { orgId, name: orgs[orgId]!.name, ancestors: ancestors(orgId) } : null;
  const person = (principalId: string) => people[principalId] ? { principalId, ...people[principalId]! } : null;
  const reads: AccessReadStore = {
    async callerGrants(callerId) { return grants.filter((grant) => grant.principalId === callerId); },
    async findPeople(query) {
      return Object.keys(people).map(person).filter((row) => row && (query.kind === "email" ? row.email === query.value : row.displayName?.toLowerCase().startsWith(query.value.toLowerCase()))) as never;
    },
    async person(principalId) { return person(principalId); },
    async grants(principalId) {
      return grants.filter((grant) => grant.principalId === principalId).map((grant) => {
        const event = events.filter((item) => item.target === principalId && item.orgId === grant.orgId && item.role === grant.role).at(-1);
        const known = event?.action === "grant";
        return { orgId: grant.orgId, orgName: orgs[grant.orgId]!.name, role: grant.role, scope: grant.scope,
          grantedBy: known ? { principalId: event.actor, displayName: people[event.actor]?.displayName ?? null } : null,
          grantedAt: known ? event.at : null, reason: known ? event.reason : null };
      });
    },
    async history(principalId) {
      return events.filter((event) => event.target === principalId).reverse().map((event) => ({ orgId: event.orgId, orgName: orgs[event.orgId]!.name, role: event.role, scope: event.scope, action: event.action, actor: { principalId: event.actor, displayName: people[event.actor]?.displayName ?? null }, reason: event.reason, occurredAt: event.at }));
    },
    async findOrganizations(query) { return Object.keys(orgs).filter((id) => orgs[id]!.name.toLowerCase().startsWith(query.toLowerCase())).map((id) => org(id)!); },
    async organization(orgId) { return org(orgId); },
    async organizations(orgIds) { return orgIds.map(org).filter((item) => item !== null); },
    async ownGrants(principalId) { return grants.filter((grant) => grant.principalId === principalId).map((grant) => ({ orgId: grant.orgId, orgName: orgs[grant.orgId]!.name, role: grant.role, scope: grant.scope })); },
  };
  const snapshot = (callerId: string, request: GrantChangeRequest): GrantSnapshot => ({
    callerGrants: grants.filter((grant) => grant.principalId === callerId),
    targetExists: request.targetPrincipalId in people,
    orgLive: request.orgId in orgs,
    orgAncestors: ancestors(request.orgId),
    current: grants.find((grant) => grant.principalId === request.targetPrincipalId && grant.orgId === request.orgId && grant.role === request.role)?.scope ?? null,
    adminCount: grants.filter((grant) => grant.orgId === request.orgId && grant.role === "admin").length,
    targetGrants: grants.filter((grant) => grant.principalId === request.targetPrincipalId).map(({ orgId, role, scope }) => ({ orgId, role, scope })),
  });
  const store: AccessGrantWriteStore = {
    async snapshot(callerId, request) { return snapshot(callerId, request); },
    async apply({ callerId, request, tokenId, expectedBefore, decide }) {
      if (events.some((event) => event.tokenId === tokenId)) return { kind: "refused", reason: "token_already_used" };
      const seen = snapshot(callerId, request);
      if (seen.current !== expectedBefore) return { kind: "refused", reason: "state_changed" };
      const decision = decide(seen);
      if (decision.kind !== "apply") return decision;
      const at = grants.findIndex((grant) => grant.principalId === request.targetPrincipalId && grant.orgId === request.orgId && grant.role === request.role);
      if (decision.after === null) grants.splice(at, 1);
      else if (at >= 0) grants[at] = { ...grants[at]!, scope: decision.after };
      else grants.push({ principalId: request.targetPrincipalId, orgId: request.orgId, role: request.role, scope: decision.after });
      events.push({ target: request.targetPrincipalId, orgId: request.orgId, role: request.role, scope: decision.after ?? decision.before!, action: decision.after === null ? "revoke" : "grant", actor: callerId, reason: request.reason, at: "2026-11-17T10:00:00.000Z", tokenId });
      return { kind: "applied", before: decision.before, after: decision.after };
    },
  };
  const ports: AccessPorts = {
    sessions: { get: async (id) => (SESSIONS[id] ? { id, personId: SESSIONS[id]! } : undefined) },
    reads,
    writes: createAccessGrantService({ store, secret: Buffer.alloc(32, 3), operatorOrgIds: ["root"] }),
    operatorOrgIds: ["root"],
  };
  return { ports, grants, events };
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

const grantForm = { targetPrincipalId: "candidate-1", orgId: "acme", role: "recruiter", scope: "self", action: "grant", reason: "Joined the hiring team" };

test("A1_READ_SITES a signed-out visitor, a non-admin and an unknown person all get the unknown-path 404", async (t) => {
  const { ports, events } = world();
  const http = await serve(t, ports);
  for (const accept of ["text/html", "application/json"]) {
    for (const principalId of [undefined, "candidate-1", "owner-1", "staff-self"]) {
      for (const path of ["/admin/access", "/admin/access?q=dana%40example.invalid", "/admin/access/people/candidate-1", "/admin/access/people/candidate-1/audit"]) {
        await sameAsUnknown(await http.get(path, principalId, accept), await http.get("/definitely-unknown", principalId, accept), `${principalId ?? "signed out"} ${path} ${accept}`);
      }
    }
    await sameAsUnknown(await http.get("/admin/access/people/nobody", "admin-1", accept), await http.get("/definitely-unknown", "admin-1", accept), `unknown person ${accept}`);
    await sameAsUnknown(await http.get("/admin/access/people/nobody/audit", "admin-1", accept), await http.get("/definitely-unknown", "admin-1", accept), `unknown person audit ${accept}`);
    await sameAsUnknown(await http.get("/admin/access/people/nobody%00x", "admin-1", accept), await http.get("/definitely-unknown", "admin-1", accept), `NUL in a person id ${accept}`);
    await sameAsUnknown(await http.get("/profile/access", undefined, accept), await http.get("/definitely-unknown", undefined, accept), `own list signed out ${accept}`);
  }
  for (const principalId of [undefined, "candidate-1", "owner-1"]) {
    for (const path of ["/admin/access/preview", "/admin/access/confirm"]) {
      await sameAsUnknown(await http.post(path, principalId, grantForm), await http.get("/definitely-unknown", principalId), `${principalId ?? "signed out"} POST ${path}`);
    }
  }
  // A preview for an unknown person is the unknown-path 404 too.
  await sameAsUnknown(await http.post("/admin/access/preview", "admin-1", { ...grantForm, targetPrincipalId: "nobody" }), await http.get("/definitely-unknown", "admin-1"), "preview for an unknown person");
  // Unconfigured: the paths do not exist.
  const off = await serve(t, undefined);
  await sameAsUnknown(await off.get("/admin/access", "admin-1"), await off.get("/definitely-unknown", "admin-1"), "unconfigured");
  await sameAsUnknown(await off.get("/admin/access/people/candidate-1/audit", "admin-1"), await off.get("/definitely-unknown", "admin-1"), "unconfigured audit");
  assert.equal(events.length, 0);
});

test("G01_CATALOGUE_PAGE operator admins and subtree staff read the grant catalogue; everyone else gets the unknown-path 404", async (t) => {
  const { ports, grants } = world();
  const http = await serve(t, ports);
  for (const principalId of [undefined, "candidate-1", "owner-1", "staff-self"]) {
    await sameAsUnknown(await http.get("/admin/access/catalogue", principalId), await http.get("/definitely-unknown", principalId), `${principalId ?? "signed out"} catalogue`);
  }
  // The same staff member, now at subtree scope, may open the Access pages.
  grants.find((grant) => grant.principalId === "staff-self")!.scope = "subtree";
  for (const principalId of ["admin-1", "staff-self"]) {
    const page = await http.get("/admin/access/catalogue", principalId);
    assert.equal(page.status, 200, principalId);
    const html = await page.text();
    assert.match(html, /CATALOGUE VERSION 1/);
    assert.match(html, /<caption>Roles on StudentHub itself<\/caption>/);
    assert.match(html, /<caption>Roles on a company<\/caption>/);
    assert.match(html, /<th scope="row">Finance<\/th><td>This organization and its sub-companies<\/td><td>StudentHub administrators<\/td><td><ul><li>Finance reports<\/li><li>See company contacts<\/li><\/ul><\/td>/);
    assert.match(html, /<th scope="row">Recruiter<\/th><td>This organization only<\/td><td>StudentHub staff and administrators<\/td><td><ul><li>See company contacts<\/li><\/ul><\/td>/);
  }
  assert.match(await (await http.get("/admin/access", "admin-1")).text(), /href="\/admin\/access\/catalogue"/);
  const post = await http.post("/admin/access/catalogue", "admin-1", {});
  await sameAsUnknown(post, await http.get("/definitely-unknown", "admin-1"), "POST catalogue");
});

test("A1_READ_SITES each person reads their own roles on Your access, with no granter or reason", async (t) => {
  const { ports } = world();
  const http = await serve(t, ports);
  const response = await http.get("/profile/access", "candidate-1");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'/);
  const html = await response.text();
  assert.match(html, /Your access/);
  assert.match(html, /Acme &lt;Trading&gt;/, "organization names are escaped");
  assert.match(html, /<td>Finance<\/td><td>This organization only<\/td>/);
  assert.doesNotMatch(html, /Given by|Reason/);
  assert.match(await (await http.get("/profile/access", "admin-1")).text(), /<td>Administrator<\/td><td>This organization and its sub-companies<\/td>/);
});

test("A1_LIST an admin finds a person by email or name and sees every grant, unknown granters included", async (t) => {
  const { ports } = world();
  const http = await serve(t, ports);
  const byEmail = await (await http.get("/admin/access?q=DANA%40example.invalid", "admin-1")).text();
  assert.match(byEmail, /href="\/admin\/access\/people\/candidate-1">Dana Candidate<\/a>/);
  assert.match(byEmail, /dana@example\.invalid/);
  assert.match(await (await http.get("/admin/access?q=dan", "admin-1")).text(), /Dana Candidate/);
  assert.match(await (await http.get("/admin/access?q=da", "admin-1")).text(), /at least 3 letters/);
  const page = await (await http.get("/admin/access/people/candidate-1", "admin-1")).text();
  assert.match(page, /<th scope="row">Acme &lt;Trading&gt;<\/th><td>Finance<\/td><td>This organization only<\/td><td>Unknown<\/td><td>Unknown<\/td><td>Not recorded<\/td>/);
  assert.match(page, /Review taking it away/);
  const search = await (await http.get("/admin/access/people/candidate-1?org=acme", "admin-1")).text();
  assert.match(search, /<option value="org-owner">Organization owner<\/option><option value="recruiter">Recruiter<\/option><option value="finance">Finance<\/option>/);
  assert.match(search, /<option value="subtree">This organization and its sub-companies<\/option>/);
  assert.doesNotMatch(search, /value="candidate"/);
  // Own page: no change forms.
  const own = await (await http.get("/admin/access/people/admin-1", "admin-1")).text();
  assert.match(own, /can’t change your own access/);
  assert.doesNotMatch(own, /Review taking it away/);
});

test("A1_PREVIEW_CONFIRM a form preview shows the change, the confirm applies it once, and the page shows who and why", async (t) => {
  const { ports, grants, events } = world();
  const http = await serve(t, ports);
  const preview = await http.post("/admin/access/preview", "admin-1", grantForm);
  assert.equal(preview.status, 200);
  const html = await preview.text();
  assert.match(html, /Dana Candidate/);
  assert.match(html, /Acme &lt;Trading&gt;/);
  assert.match(html, /Joined the hiring team/);
  assert.equal(events.length, 0, "a preview writes nothing");
  const fields = hiddenFields(html);
  assert.equal(fields.reason, "Joined the hiring team");
  // Cross-origin confirm is refused.
  assert.equal((await http.post("/admin/access/confirm", "admin-1", fields, "https://evil.example")).status, 403);
  // An altered field is refused.
  assert.equal((await http.post("/admin/access/confirm", "admin-1", { ...fields, role: "finance" })).status, 409);
  // A valid confirmation posted anywhere but /admin/access/confirm is the unknown-path 404 and changes nothing.
  for (const path of ["/admin/access", "/admin/access/people/candidate-1", "/admin/access/elsewhere"]) {
    assert.equal((await http.post(path, "admin-1", fields)).status, 404, path);
  }
  assert.equal(events.length, 0, "no other path applies a grant");
  assert.ok(!grants.some((grant) => grant.principalId === "candidate-1" && grant.role === "recruiter"));
  const confirm = await http.post("/admin/access/confirm", "admin-1", fields);
  assert.equal(confirm.status, 303);
  assert.equal(confirm.headers.get("location"), "/admin/access/people/candidate-1?done=granted");
  assert.ok(grants.some((grant) => grant.principalId === "candidate-1" && grant.role === "recruiter"));
  const replay = await http.post("/admin/access/confirm", "admin-1", fields);
  assert.equal(replay.status, 409);
  assert.match(await replay.text(), /already confirmed/);
  assert.equal(events.length, 1);
  const page = await (await http.get("/admin/access/people/candidate-1?done=granted", "admin-1")).text();
  assert.match(page, /The role was given\./);
  assert.match(page, /<td>Recruiter<\/td><td>This organization only<\/td><td>Grace Admin<\/td><td>17 Nov 2026<\/td><td>Joined the hiring team<\/td>/);
  assert.match(page, /<td>Given<\/td><td>Acme &lt;Trading&gt;<\/td><td>Recruiter<\/td>/);
  // The person's own list shows the role, never the reason.
  const own = await (await http.get("/profile/access", "candidate-1")).text();
  assert.match(own, /<td>Recruiter<\/td>/);
  assert.doesNotMatch(own, /Joined the hiring team/);
});

test("A1_GUARDS refusals from the form say why and change nothing", async (t) => {
  const { ports, events } = world();
  const http = await serve(t, ports);
  const self = await http.post("/admin/access/preview", "admin-1", { ...grantForm, targetPrincipalId: "admin-1", orgId: "root", role: "finance" });
  assert.equal(self.status, 403);
  assert.match(await self.text(), /can’t change your own access/);
  const candidate = await http.post("/admin/access/preview", "admin-1", { ...grantForm, role: "candidate" });
  assert.equal(candidate.status, 403);
  const lastAdmin = await http.post("/admin/access/preview", "admin-1", { ...grantForm, targetPrincipalId: "admin-1", orgId: "root", role: "admin", action: "revoke" });
  assert.equal(lastAdmin.status, 403, "self comes first");
  const shortReason = await http.post("/admin/access/preview", "admin-1", { ...grantForm, reason: "ok" });
  assert.equal(shortReason.status, 400);
  assert.match(await shortReason.text(), /3 to 500 characters/);
  const extra = await http.post("/admin/access/preview", "admin-1", { ...grantForm, extra: "1" });
  assert.equal(extra.status, 400);
  const held = await http.post("/admin/access/preview", "admin-1", { ...grantForm, role: "finance" });
  assert.equal(held.status, 200);
  assert.match(await held.text(), /Nothing to change/);
  assert.equal(events.length, 0);
});

test("A1_READ_SITES the workspace shows the Access link to operator admins and staff only", async () => {
  const { renderWorkspace } = await import("../src/web-ui.js");
  const { ports } = world();
  const render = (active: { orgId: string; role: string; organizationName: string }, withAccess = true) =>
    renderWorkspace({ status: 200, body: { contexts: [active], active } } as never, (withAccess ? { access: ports } : {}) as never);
  assert.match(render({ orgId: "root", role: "admin", organizationName: "StudentHub" }), /href="\/admin\/access">Access<\/a>/);
  assert.match(render({ orgId: "root", role: "staff", organizationName: "StudentHub" }), /href="\/admin\/access"/);
  assert.doesNotMatch(render({ orgId: "acme", role: "org-owner", organizationName: "Acme" }), /\/admin\/access/);
  assert.doesNotMatch(render({ orgId: "acme", role: "admin", organizationName: "Acme" }), /\/admin\/access/);
  assert.doesNotMatch(render({ orgId: "root", role: "admin", organizationName: "StudentHub" }, false), /\/admin\/access/);
});

test("U03_ACCOUNT_LINK the workspace and the profile menu link to Account wherever the sessions store is wired, for every role", async () => {
  const { renderWorkspace } = await import("../src/web-ui.js");
  const { CONTRIBUTIONS } = await import("../src/contributions/index.js");
  const { ports } = world();
  const account = {} as never;
  const render = (active: { orgId: string; role: string; organizationName: string } | null, login: unknown) =>
    renderWorkspace({ status: 200, body: { contexts: active ? [active] : [], active } } as never, login as never);
  for (const active of [null, { orgId: "acme", role: "candidate", organizationName: "Acme" }, { orgId: "root", role: "admin", organizationName: "StudentHub" }]) {
    assert.match(render(active, { access: { ...ports, account } }), /<a class="nav-item" href="\/account">Account<\/a>/, JSON.stringify(active));
    assert.doesNotMatch(render(active, { access: ports }), /href="\/account"/, "no link where the sessions store is not wired");
    assert.doesNotMatch(render(active, {}), /href="\/account"/);
  }
  const entry = CONTRIBUTIONS.navigation.find((item) => item.key === "account")!;
  assert.equal(entry.href, "/account");
  assert.equal(entry.visible({ access: { ...ports, account } } as never), true);
  assert.equal(entry.visible({ access: ports } as never), false);
});

test("A1_GUARDS a confirm that fails with an unknown outcome never claims nothing changed", async (t) => {
  const { ports } = world();
  const failing: AccessPorts = { ...ports, writes: { ...ports.writes!, confirm: async () => { throw new Error("connection lost after COMMIT"); } } };
  const http = await serve(t, failing);
  const preview = await http.post("/admin/access/preview", "admin-1", grantForm);
  const response = await http.post("/admin/access/confirm", "admin-1", hiddenFields(await preview.text()));
  assert.equal(response.status, 503);
  const html = await response.text();
  assert.match(html, /The change may or may not have been made/);
  assert.doesNotMatch(html, /Nothing was changed/);
});

test("G02_PREVIEW_EFFECT the review page says what the change opens or closes for the person, their other roles counted", async (t) => {
  const { ports, events } = world();
  const http = await serve(t, ports);
  // Staff on StudentHub itself opens nothing here; widening to the sub-companies opens the staff abilities.
  const widen = await (await http.post("/admin/access/preview", "admin-1", { ...grantForm, targetPrincipalId: "staff-self", orgId: "root", role: "staff", scope: "subtree" })).text();
  assert.match(widen, /<h2>What changes for them<\/h2><p>Sam Staff will be able to:<\/p><ul><li>Open the Access pages<\/li><li>Review company sign-ups<\/li><li>Pause a person and view as them<\/li><li>Operations reports<\/li><li>Give company roles<\/li><li>Give company roles in sub-companies<\/li><li>See company contacts<\/li><li>Change company contacts<\/li><li>Manage store managers<\/li><\/ul><\/section>/);
  // Taking an owner's role away closes what it opened.
  const revoke = await (await http.post("/admin/access/preview", "admin-1", { ...grantForm, targetPrincipalId: "owner-1", role: "org-owner", scope: "subtree", action: "revoke" })).text();
  assert.match(revoke, /Omar Owner will no longer be able to:<\/p><ul><li>See company contacts<\/li><li>Change company contacts<\/li><li>Manage store managers<\/li><\/ul>/);
  assert.doesNotMatch(revoke, /will be able to:/);
  assert.match(revoke, /<p>In the companies below Acme &lt;Trading&gt;, Omar Owner will no longer be able to:<\/p><ul><li>See company contacts<\/li><li>Change company contacts<\/li><li>Manage store managers<\/li><\/ul>/);
  // Widening a company role reaches the companies below it; at the company itself nothing changes.
  const below = await (await http.post("/admin/access/preview", "admin-1", { ...grantForm, role: "finance", scope: "subtree" })).text();
  assert.match(below, /<h2>What changes for them<\/h2><p>In the companies below Acme &lt;Trading&gt;, Dana Candidate will be able to:<\/p><ul><li>See company contacts<\/li><\/ul><p class="sidebar-note">“Companies below” shows what this role’s scope reaches\. In a particular sub-company, another role Dana Candidate holds there may still give the same\.<\/p><\/section>/);
  // A role whose abilities the person already has opens nothing new.
  const covered = await (await http.post("/admin/access/preview", "admin-1", grantForm)).text();
  assert.match(covered, /Nothing in the <a class="text-link" href="\/admin\/access\/catalogue">grant catalogue<\/a> changes for Dana Candidate: their other roles already decide it\./);
  assert.doesNotMatch(covered, /will (no longer )?be able to:/);
  // The effect comes from the preview's own snapshot, never from a second read of the person's grants.
  // A second read that disagrees (grants refused, ancestry emptied) cannot skew it.
  const stale = { ...ports, reads: { ...ports.reads,
    async grants() { throw new Error("the preview must not re-read grants"); },
    async organization(orgId: string) { const org = await ports.reads.organization(orgId); return org && { ...org, ancestors: ["skewed"] }; } } };
  const fromSnapshot = await (await (await serve(t, stale)).post("/admin/access/preview", "admin-1", grantForm)).text();
  assert.match(fromSnapshot, /Nothing in the <a class="text-link" href="\/admin\/access\/catalogue">grant catalogue<\/a> changes for Dana Candidate/);
  // The same with coverage that only the ancestry gives: finance on StudentHub and below,
  // nothing held on Acme itself. A skewed ancestry would show contacts as newly opened.
  const inherited = world();
  inherited.grants.splice(inherited.grants.findIndex((grant) => grant.principalId === "candidate-1"), 1,
    { principalId: "candidate-1", orgId: "root", role: "finance", scope: "subtree" });
  const skewed = { ...inherited.ports, reads: { ...inherited.ports.reads,
    async grants() { throw new Error("the preview must not re-read grants"); },
    async organization(orgId: string) { const org = await inherited.ports.reads.organization(orgId); return org && { ...org, ancestors: ["skewed"] }; } } };
  const fromAncestry = await (await (await serve(t, skewed)).post("/admin/access/preview", "admin-1", grantForm)).text();
  assert.match(fromAncestry, /Nothing in the <a class="text-link" href="\/admin\/access\/catalogue">grant catalogue<\/a> changes for Dana Candidate/);
  assert.doesNotMatch(fromAncestry, /See company contacts/);
  // Nothing to change: no effect section.
  assert.doesNotMatch(await (await http.post("/admin/access/preview", "admin-1", { ...grantForm, role: "finance" })).text(), /What changes for them/);
  assert.equal(events.length, 0, "previews write nothing");
});

test("G03_AUDIT_PAGE an administrator sees what a person's access does now and why; everyone else gets the unknown-path 404", async (t) => {
  const { ports } = world();
  const http = await serve(t, ports);
  for (const principalId of [undefined, "candidate-1", "owner-1", "staff-self"]) {
    await sameAsUnknown(await http.get("/admin/access/people/owner-1/audit", principalId), await http.get("/definitely-unknown", principalId), `${principalId ?? "signed out"} audit`);
  }
  await sameAsUnknown(await http.get("/admin/access/people/nobody/audit", "admin-1"), await http.get("/definitely-unknown", "admin-1"), "unknown person audit");
  assert.equal((await http.post("/admin/access/people/owner-1/audit", "admin-1", {})).status, 404, "the audit page is read-only");
  const page = await http.get("/admin/access/people/owner-1/audit", "admin-1");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /What Omar Owner’s access does now/);
  assert.match(html, /<h2>On StudentHub, and every company below it<\/h2><p class="empty-contexts">Nothing in the <a class="text-link" href="\/admin\/access\/catalogue">grant catalogue<\/a>\.<\/p>/);
  assert.match(html, /<h2>On Acme &lt;Trading&gt;<\/h2>.*<tr><th scope="row">Change company contacts<\/th><td><ul><li>Organization owner on Acme &lt;Trading&gt;, this organization and its sub-companies<\/li><\/ul><\/td><\/tr>/);
  // A subtree company grant reaches the companies below; a self one does not.
  assert.match(html, /<h3>In the companies below Acme &lt;Trading&gt;<\/h3>.*<tr><th scope="row">Manage store managers<\/th><td><ul><li>Organization owner on Acme &lt;Trading&gt;, this organization and its sub-companies<\/li><\/ul><\/td><\/tr>/);
  assert.doesNotMatch(await (await http.get("/admin/access/people/candidate-1/audit", "admin-1")).text(), /In the companies below/);
  // An operator administrator: StudentHub-wide abilities, each with its grant.
  assert.match(await (await http.get("/admin/access/people/admin-1/audit", "admin-1")).text(), /<tr><th scope="row">Manage blocked addresses<\/th><td><ul><li>Administrator on StudentHub, this organization and its sub-companies<\/li><\/ul><\/td><\/tr>/);
  // The person page links to it.
  assert.match(await (await http.get("/admin/access/people/owner-1", "admin-1")).text(), /href="\/admin\/access\/people\/owner-1\/audit">What their access does now →<\/a>/);
});
