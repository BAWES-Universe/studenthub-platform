import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createGatewayServer } from "../src/index.js";
import { INVITE_COOKIE, type CompanyTeamPorts } from "../src/access/company-team.js";
import {
  createCompanyTeamService,
  recordingInvitationMailer,
  type InvitationStore,
} from "../../../packages/access/src/index.js";

const ORIGIN = "https://studenthub.example.invalid";
const RETURN_TO = `${ORIGIN}/profile`;
const SESSIONS: Record<string, string> = {
  ["o".repeat(43)]: "owner-1", ["p".repeat(43)]: "owner-2", ["s".repeat(43)]: "staff-1", ["r".repeat(43)]: "recruiter-1", ["i".repeat(43)]: "invitee-1", ["x".repeat(43)]: "other-1",
};
const session = (principalId: string) => Object.entries(SESSIONS).find(([, id]) => id === principalId)![0];
type Held = { principalId: string; orgId: string; role: string; scope: "self" | "subtree" };
type Invitation = { id: string; orgId: string; role: string; scope: "self" | "subtree"; email: string; tokenHash: string; invitedBy: string; expiresAt: Date; usedAt: Date | null; revokedAt: Date | null };

/** An in-memory store with the Postgres store's order: read inside, decide, then write. */
function world() {
  const people: Record<string, { displayName: string; email: string }> = {
    "owner-1": { displayName: "Omar Owner", email: "omar@example.invalid" },
    "owner-2": { displayName: "Olga Owner", email: "olga@example.invalid" },
    "staff-1": { displayName: "Sam Staff", email: "sam@example.invalid" },
    "recruiter-1": { displayName: "Rita Recruiter", email: "rita@example.invalid" },
    "invitee-1": { displayName: "Ines Invitee", email: "Ines@Example.invalid" },
    "other-1": { displayName: "Otto Other", email: "otto@example.invalid" },
  };
  const orgs: Record<string, { name: string; parent: string | null }> = { root: { name: "StudentHub", parent: null }, acme: { name: "Acme <Trading>", parent: "root" } };
  const grants: Held[] = [
    { principalId: "owner-1", orgId: "acme", role: "org-owner", scope: "self" },
    { principalId: "staff-1", orgId: "root", role: "staff", scope: "subtree" },
    { principalId: "recruiter-1", orgId: "acme", role: "recruiter", scope: "self" },
  ];
  const invitations: Invitation[] = [];
  const ancestors = (orgId: string) => { const out: string[] = []; let at = orgs[orgId]?.parent ?? null; while (at) { out.push(at); at = orgs[at]?.parent ?? null; } return out; };
  const held = (principalId: string) => grants.filter((grant) => grant.principalId === principalId);
  const pending = (orgId: string, now: Date) => invitations.filter((item) => item.orgId === orgId && !item.usedAt && !item.revokedAt && item.expiresAt > now);
  const store: InvitationStore = {
    async context(callerId, orgId) {
      return { callerGrants: held(callerId), organization: orgs[orgId] ? { orgId, name: orgs[orgId]!.name, ancestors: ancestors(orgId) } : null };
    },
    async team(orgId, now) {
      return {
        members: grants.filter((grant) => grant.orgId === orgId).map((grant) => ({ principalId: grant.principalId, displayName: people[grant.principalId]!.displayName, email: people[grant.principalId]!.email, role: grant.role, scope: grant.scope })),
        invitations: pending(orgId, now).map((item) => ({ id: item.id, email: item.email, role: item.role, scope: item.scope, invitedBy: { principalId: item.invitedBy, displayName: people[item.invitedBy]!.displayName }, expiresAt: item.expiresAt.toISOString() })),
      };
    },
    async invitation(tokenHash, now) {
      const item = invitations.find((row) => row.tokenHash === tokenHash && !row.usedAt && !row.revokedAt && row.expiresAt > now);
      return item ? { orgId: item.orgId, orgName: orgs[item.orgId]!.name, role: item.role, scope: item.scope } : null;
    },
    async invite(input) {
      const open = pending(input.orgId, input.now);
      const decision = input.decide({ callerGrants: held(input.callerId), orgLive: input.orgId in orgs, orgAncestors: ancestors(input.orgId), pendingCount: open.length,
        duplicatePending: open.some((item) => item.role === input.role && item.email === input.email) });
      if (decision.kind === "refused") return decision;
      const id = `00000000-0000-4000-8000-${String(invitations.length + 1).padStart(12, "0")}`;
      const expiresAt = new Date(input.now.getTime() + input.ttlMs);
      invitations.push({ id, orgId: input.orgId, role: input.role, scope: input.scope, email: input.email, tokenHash: input.tokenHash, invitedBy: input.callerId, expiresAt, usedAt: null, revokedAt: null });
      return { kind: "invited", id, expiresAt: expiresAt.toISOString() };
    },
    async revokeInvitation(input) {
      const decision = input.decide({ callerGrants: held(input.callerId), orgAncestors: ancestors(input.orgId) });
      if (decision.kind === "refused") return decision;
      const item = invitations.find((row) => row.id === input.invitationId && row.orgId === input.orgId && !row.usedAt && !row.revokedAt);
      if (!item) return { kind: "refused", reason: "not_found" };
      item.revokedAt = input.now;
      return { kind: "revoked" };
    },
    async accept(input) {
      const item = invitations.find((row) => row.tokenHash === input.tokenHash);
      if (!item) return { kind: "invalid" };
      const decision = input.decide({ invitation: item, now: input.now, orgLive: item.orgId in orgs, orgAncestors: ancestors(item.orgId), principalEmail: people[input.principalId]?.email ?? null, inviterGrants: held(item.invitedBy) });
      if (decision.kind !== "accept") return decision;
      item.usedAt = input.now;
      grants.push({ principalId: input.principalId, orgId: item.orgId, role: item.role, scope: item.scope });
      return { kind: "accepted", orgId: item.orgId, role: item.role, scope: item.scope };
    },
    async removeMember(input) {
      const target = grants.filter((grant) => grant.principalId === input.targetId && grant.orgId === input.orgId);
      const decision = input.decide({ callerGrants: held(input.callerId), orgLive: input.orgId in orgs, orgAncestors: ancestors(input.orgId), targetGrants: target,
        ownerCount: grants.filter((grant) => grant.orgId === input.orgId && grant.role === "org-owner").length });
      if (decision.kind === "refused") return decision;
      for (const grant of target) grants.splice(grants.indexOf(grant), 1);
      return { kind: "removed", roles: decision.roles };
    },
  };
  const mailer = recordingInvitationMailer();
  const ports: CompanyTeamPorts = {
    sessions: { get: async (id) => (SESSIONS[id] ? { id, personId: SESSIONS[id]! } : undefined) } as CompanyTeamPorts["sessions"],
    team: createCompanyTeamService({ store, mailer, now: () => new Date("2026-11-17T10:00:00Z") }),
  };
  return { ports, grants, invitations, mailer, people };
}

async function serve(t: TestContext, ports: CompanyTeamPorts | undefined) {
  const server = createGatewayServer(undefined, undefined, undefined, { ...(ports ? { team: ports } : {}), web: { origin: ORIGIN, returnTo: RETURN_TO } } as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const cookies = (principalId?: string, extra?: string) => [principalId ? `__Host-studenthub_session=${session(principalId)}` : "", extra ?? ""].filter(Boolean).join("; ");
  const get = (path: string, principalId?: string, extra?: string) =>
    fetch(base + path, { headers: { accept: "text/html", cookie: cookies(principalId, extra) }, redirect: "manual" });
  const post = (path: string, principalId: string | undefined, form: Record<string, string> = {}, origin = ORIGIN) =>
    fetch(base + path, { method: "POST", redirect: "manual", body: new URLSearchParams(form).toString(),
      headers: { accept: "text/html", origin, "content-type": "application/x-www-form-urlencoded", cookie: cookies(principalId) } });
  return { get, post };
}

async function sameAsUnknown(actual: Response, unknown: Response, message: string) {
  assert.equal(actual.status, unknown.status, `${message} status`);
  assert.equal(await actual.text(), await unknown.text(), `${message} body`);
}
const linkIn = (html: string) => /value="(https:[^"]+\/invitations\/([A-Za-z0-9_-]{43}))"/.exec(html);

test("A2_TEAM_PAGE owners write, operator staff read, anyone else gets the unknown-path 404", async (t) => {
  const { ports } = world();
  const http = await serve(t, ports);
  const owner = await http.get("/workspace/companies/acme/team", "owner-1");
  assert.equal(owner.status, 200);
  const page = await owner.text();
  assert.match(page, /Acme &lt;Trading&gt; team/);
  assert.match(page, /Rita Recruiter/);
  assert.match(page, /Create invitation/);
  assert.match(page, /\/workspace\/companies\/acme\/team\/members\/recruiter-1\/remove/);
  const staff = await (await http.get("/workspace/companies/acme/team", "staff-1")).text();
  assert.match(staff, /Rita Recruiter/);
  assert.doesNotMatch(staff, /Create invitation|Remove from team/);
  for (const principalId of [undefined, "recruiter-1", "invitee-1"]) {
    await sameAsUnknown(await http.get("/workspace/companies/acme/team", principalId), await http.get("/definitely-unknown", principalId), `${principalId ?? "signed out"} team`);
    await sameAsUnknown(await http.post("/workspace/companies/acme/team/invite", principalId, { email: "a@example.com", role: "recruiter", scope: "self" }), await http.get("/definitely-unknown", principalId), `${principalId ?? "signed out"} invite`);
  }
  await sameAsUnknown(await http.post("/workspace/companies/acme/team/invite", "staff-1", { email: "a@example.com", role: "recruiter", scope: "self" }), await http.get("/definitely-unknown", "staff-1"), "read-only staff invite");
  await sameAsUnknown(await http.get("/workspace/companies/nowhere/team", "owner-1"), await http.get("/definitely-unknown", "owner-1"), "unknown company");
  const off = await serve(t, undefined);
  await sameAsUnknown(await off.get("/workspace/companies/acme/team", "owner-1"), await off.get("/definitely-unknown", "owner-1"), "unconfigured");
});

test("A2_INVITE the link is shown once and handed to the mailer; refusals are typed; cross-origin is refused", async (t) => {
  const { ports, mailer, invitations } = world();
  const http = await serve(t, ports);
  const created = await http.post("/workspace/companies/acme/team/invite", "owner-1", { email: " New@Example.com ", role: "finance", scope: "self" });
  assert.equal(created.status, 201);
  assert.equal(created.headers.get("cache-control"), "no-store");
  const html = await created.text();
  const link = linkIn(html);
  assert.ok(link, html);
  assert.equal(mailer.sent.length, 1);
  assert.equal(mailer.sent[0]!.link, link[1]);
  assert.equal(mailer.sent[0]!.to, "new@example.com");
  assert.equal(invitations.length, 1);
  const team = await (await http.get("/workspace/companies/acme/team", "owner-1")).text();
  assert.match(team, /new@example\.com/);
  assert.equal(team.includes(link[2]!), false, "the link is never shown again");
  assert.equal((await http.post("/workspace/companies/acme/team/invite", "owner-1", { email: "new@example.com", role: "finance", scope: "self" })).status, 409);
  assert.equal((await http.post("/workspace/companies/acme/team/invite", "owner-1", { email: "nope", role: "finance", scope: "self" })).status, 400);
  assert.equal((await http.post("/workspace/companies/acme/team/invite", "owner-1", { email: "a@example.com", role: "finance", scope: "subtree" })).status, 403);
  assert.equal((await http.post("/workspace/companies/acme/team/invite", "owner-1", { email: "a@example.com", role: "admin", scope: "self" })).status, 403);
  assert.equal((await http.post("/workspace/companies/acme/team/invite", "owner-1", { email: "a@example.com", role: "finance", scope: "self", extra: "1" })).status, 400);
  assert.equal((await http.post("/workspace/companies/acme/team/invite", "owner-1", { email: "a@example.com", role: "finance", scope: "self" }, "https://evil.example")).status, 403);
  assert.equal(invitations.length, 1);
  const revoke = await http.post(`/workspace/companies/acme/team/invitations/${invitations[0]!.id}/revoke`, "owner-1");
  assert.equal(revoke.status, 303);
  assert.ok(invitations[0]!.revokedAt);
});

test("A2_MATCH sign-in returns to the link; the page names company and role, never the address; wrong address and dead links", async (t) => {
  const { ports, grants } = world();
  const http = await serve(t, ports);
  const created = await (await http.post("/workspace/companies/acme/team/invite", "owner-1", { email: "ines@example.invalid", role: "recruiter", scope: "self" })).text();
  const token = linkIn(created)![2]!;

  const signedOut = await http.get(`/invitations/${token}`);
  assert.equal(signedOut.status, 303);
  assert.equal(signedOut.headers.get("location"), `/login/universe?return_to=${encodeURIComponent(RETURN_TO)}`);
  const cookie = signedOut.headers.get("set-cookie") ?? "";
  assert.match(cookie, new RegExp(`^${INVITE_COOKIE}=${token}; Path=/; Max-Age=3600; HttpOnly; Secure; SameSite=Lax$`));
  const back = await http.get("/profile", "invitee-1", `${INVITE_COOKIE}=${token}`);
  assert.equal(back.status, 303);
  assert.equal(back.headers.get("location"), `/invitations/${token}`);
  assert.match(back.headers.get("set-cookie") ?? "", new RegExp(`^${INVITE_COOKIE}=; Path=/; Max-Age=0`));

  const page = await http.get(`/invitations/${token}`, "other-1");
  assert.equal(page.status, 200);
  const html = await page.text();
  assert.match(html, /Acme &lt;Trading&gt;/);
  assert.match(html, /Recruiter/);
  assert.doesNotMatch(html, /ines@example/i);
  const wrong = await http.post(`/invitations/${token}/accept`, "other-1");
  assert.equal(wrong.status, 403);
  const wrongHtml = await wrong.text();
  assert.match(wrongHtml, /This invitation is for a different address/);
  assert.doesNotMatch(wrongHtml, /ines@example|otto@example/i);
  assert.equal(grants.some((grant) => grant.principalId === "other-1"), false);

  const dead = await http.get(`/invitations/${"z".repeat(43)}`, "invitee-1");
  const garbage = await http.get("/invitations/not-a-token", "invitee-1");
  assert.equal(dead.status, 404);
  const deadHtml = await dead.text();
  assert.match(deadHtml, /This invitation is no longer valid/);
  assert.equal(garbage.status, dead.status);
  assert.equal(await garbage.text(), deadHtml);
  assert.equal((await http.post(`/invitations/${token}/accept`, "invitee-1", {}, "https://evil.example")).status, 403);
});

test("A2_ACCEPT accepting creates the grant for the signed-in person and goes to their access list; a replay is dead", async (t) => {
  const { ports, grants } = world();
  const http = await serve(t, ports);
  const token = linkIn(await (await http.post("/workspace/companies/acme/team/invite", "owner-1", { email: "ines@example.invalid", role: "recruiter", scope: "self" })).text())![2]!;
  assert.equal(grants.some((grant) => grant.principalId === "invitee-1"), false);
  const accepted = await http.post(`/invitations/${token}/accept`, "invitee-1");
  assert.equal(accepted.status, 303);
  assert.equal(accepted.headers.get("location"), "/profile/access");
  assert.deepEqual(grants.filter((grant) => grant.principalId === "invitee-1"), [{ principalId: "invitee-1", orgId: "acme", role: "recruiter", scope: "self" }]);
  const replay = await http.post(`/invitations/${token}/accept`, "invitee-1");
  assert.equal(replay.status, 404);
  assert.match(await replay.text(), /This invitation is no longer valid/);
  const signedOut = await http.post(`/invitations/${token}/accept`, undefined);
  assert.equal(signedOut.status, 303);
  assert.match(signedOut.headers.get("location") ?? "", /^\/login\/universe\?return_to=/);
});

test("A2_REMOVE the confirm step names the person; the last owner stays", async (t) => {
  const { ports, grants } = world();
  const http = await serve(t, ports);
  const confirm = await http.get("/workspace/companies/acme/team/members/recruiter-1/remove", "owner-1");
  assert.equal(confirm.status, 200);
  assert.match(await confirm.text(), /Remove Rita Recruiter\?/);
  await sameAsUnknown(await http.get("/workspace/companies/acme/team/members/recruiter-1/remove", "staff-1"), await http.get("/definitely-unknown", "staff-1"), "read-only confirm");
  assert.equal((await http.get("/workspace/companies/acme/team/members/nobody/remove", "owner-1")).status, 404);
  const removed = await http.post("/workspace/companies/acme/team/members/recruiter-1/remove", "owner-1");
  assert.equal(removed.status, 303);
  assert.equal(grants.some((grant) => grant.principalId === "recruiter-1"), false);
  const last = await http.post("/workspace/companies/acme/team/members/owner-1/remove", "owner-1");
  assert.equal(last.status, 409);
  assert.match(await last.text(), /last owner/);
  assert.equal(grants.some((grant) => grant.principalId === "owner-1"), true);
});
