import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { createGatewayServer } from "../src/index.js";
import { createLoginApplication } from "../src/login-application.js";
import type { AccessPorts } from "../src/access/admin-access.js";
import { createAccountPauseService, type AccessReadStore, type AccountPause } from "../../../packages/access/src/index.js";

const ORIGIN = "https://studenthub.example.invalid";
const SESSIONS: Record<string, string> = { ["a".repeat(43)]: "admin-1", ["s".repeat(43)]: "staff-1", ["c".repeat(43)]: "candidate-1" };
const session = (principalId: string) => Object.entries(SESSIONS).find(([, id]) => id === principalId)![0];

function world(writable = true) {
  const grants = [
    { principalId: "admin-1", orgId: "root", role: "admin", scope: "subtree" as const },
    { principalId: "staff-1", orgId: "root", role: "staff", scope: "subtree" as const },
    { principalId: "candidate-1", orgId: "acme", role: "recruiter", scope: "self" as const },
  ];
  const people: Record<string, string> = { "admin-1": "Grace Admin", "staff-1": "Sam Staff", "candidate-1": "Dana <Candidate>" };
  let live: AccountPause | null = null;
  const changes: string[] = [];
  const reads = {
    async callerGrants(id: string) { return grants.filter((grant) => grant.principalId === id); },
    async person(id: string) { return people[id] ? { principalId: id, displayName: people[id]!, email: `${id}@example.invalid` } : null; },
    async grants() { return []; }, async history() { return []; }, async organizations() { return []; },
  } as unknown as AccessReadStore;
  const store = {
    async apply(input: Parameters<Parameters<typeof createAccountPauseService>[0]["store"]["apply"]>[0]) {
      const target = input.request.targetPrincipalId;
      const decision = input.decide({
        callerGrants: grants.filter((grant) => grant.principalId === input.callerId), targetExists: target in people,
        targetGrants: grants.filter((grant) => grant.principalId === target), paused: live !== null,
      });
      if (decision.kind === "refused") return decision;
      changes.push(`${input.request.action}:${target}:${input.request.reason}`);
      if (input.request.action === "pause") {
        live = { pausedAt: "2026-11-17T10:00:00.000Z", pausedBy: { principalId: input.callerId, displayName: people[input.callerId]! }, reason: input.request.reason, grants: [], storeGrants: [] };
        return { kind: "paused" as const, grants: 1, storeGrants: 0 };
      }
      live = null;
      return { kind: "resumed" as const, restored: 1, leftOut: 0 };
    },
  };
  const ports: AccessPorts = {
    sessions: { get: async (id) => (SESSIONS[id] ? { id, personId: SESSIONS[id]! } : undefined) },
    reads, operatorOrgIds: ["root"],
    pauses: { reads: { pause: async () => live }, ...(writable ? { writes: createAccountPauseService({ store, operatorOrgIds: ["root"] }) } : {}) },
  };
  return { ports, changes, live: () => live };
}

async function serve(t: TestContext, ports: AccessPorts) {
  const server = createGatewayServer(undefined, undefined, undefined, { access: ports, web: { origin: ORIGIN } } as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = (principalId?: string): Record<string, string> => (principalId ? { cookie: `__Host-studenthub_session=${session(principalId)}` } : {});
  return {
    get: (path: string, principalId?: string) => fetch(base + path, { headers: { accept: "text/html", ...cookie(principalId) }, redirect: "manual" }),
    post: (path: string, principalId: string | undefined, form: Record<string, string>, origin = ORIGIN) => fetch(base + path, {
      method: "POST", redirect: "manual", body: new URLSearchParams(form).toString(),
      headers: { accept: "text/html", origin, "content-type": "application/x-www-form-urlencoded", ...cookie(principalId) } }),
  };
}
const form = (action: "pause" | "resume", reason = "Reported for misuse") => ({ targetPrincipalId: "candidate-1", action, reason });

test("A6_PAGE staff pause and resume a person from the Access page, and the page shows who, when and why", async (t) => {
  const w = world();
  const http = await serve(t, w.ports);
  const page = await (await http.get("/admin/access/people/candidate-1", "staff-1")).text();
  assert.match(page, /<h2>Account<\/h2>/);
  assert.match(page, /action="\/admin\/access\/people\/candidate-1\/pause"/);
  const paused = await http.post("/admin/access/people/candidate-1/pause", "staff-1", form("pause"));
  assert.equal(paused.status, 303);
  assert.equal(paused.headers.get("location"), "/admin/access/people/candidate-1?done=paused");
  const after = await (await http.get("/admin/access/people/candidate-1?done=paused", "staff-1")).text();
  assert.match(after, /Access was paused\./);
  assert.match(after, /Access paused<\/strong> on .* by Sam Staff: Reported for misuse/);
  assert.match(after, /action="\/admin\/access\/people\/candidate-1\/resume"/);
  const again = await http.post("/admin/access/people/candidate-1/pause", "staff-1", form("pause"));
  assert.equal(again.status, 409, "a second pause is refused");
  assert.match(await again.text(), /already paused/);
  assert.equal((await http.post("/admin/access/people/candidate-1/resume", "staff-1", form("resume", "Cleared after review"))).status, 303);
  assert.deepEqual(w.changes, ["pause:candidate-1:Reported for misuse", "resume:candidate-1:Cleared after review"]);
  assert.equal(w.live(), null);
});

test("A6_PAGE refusals: not staff or signed out is the unknown-path 404, cross-site 403, bad form 400, self 403, no key 503", async (t) => {
  const w = world();
  const http = await serve(t, w.ports);
  for (const principalId of [undefined, "candidate-1"]) {
    const response = await http.post("/admin/access/people/candidate-1/pause", principalId, form("pause"));
    const unknown = await http.get("/definitely-unknown", principalId);
    assert.equal(response.status, unknown.status);
    assert.equal(await response.text(), await unknown.text());
  }
  assert.equal((await http.get("/admin/access/people/candidate-1/pause", "staff-1")).status, 404, "GET is not a pause");
  assert.equal((await http.post("/admin/access/people/candidate-1/pause", "staff-1", form("pause"), "https://evil.invalid")).status, 403);
  assert.equal((await http.post("/admin/access/people/candidate-1/pause", "staff-1", form("pause", "no"))).status, 400);
  assert.equal((await http.post("/admin/access/people/candidate-1/pause", "staff-1", form("resume"))).status, 400, "the path and the action agree");
  assert.equal((await http.post("/admin/access/people/candidate-1/pause", "staff-1", { ...form("pause"), extra: "x" })).status, 400);
  assert.equal((await http.post("/admin/access/people/staff-1/pause", "staff-1", { ...form("pause"), targetPrincipalId: "staff-1" })).status, 403);
  assert.deepEqual(w.changes, []);
  const readOnly = world(false);
  const ro = await serve(t, readOnly.ports);
  assert.doesNotMatch(await (await ro.get("/admin/access/people/candidate-1", "staff-1")).text(), /Pause access<\/button>/);
  assert.equal((await ro.post("/admin/access/people/candidate-1/pause", "staff-1", form("pause"))).status, 503);
});

test("A6_SIGN_IN a paused person gets no session and the sign-in page says access is paused", async () => {
  const rig = createSyntheticLoginRig((dependencies, config) => createLoginApplication({ ...dependencies, accessPause: { isPaused: async () => true } }, config));
  await rig.app.start({ browserSessionId: "browser-a", returnTo: "https://studenthub.test.invalid/home" });
  const authorization = rig.provider.authorizationRequests.at(-1)!;
  const response = await rig.app.callback({ browserSessionId: "browser-a", state: authorization.state, code: rig.provider.authorize() });
  assert.deepEqual(response, { status: 403, body: { error: "access_paused" } });
  assert.equal(rig.sessions.records.size, 0);
  const open = createSyntheticLoginRig((dependencies, config) => createLoginApplication({ ...dependencies, accessPause: { isPaused: async () => false } }, config));
  await open.app.start({ browserSessionId: "browser-a", returnTo: "https://studenthub.test.invalid/home" });
  const next = open.provider.authorizationRequests.at(-1)!;
  assert.equal((await open.app.callback({ browserSessionId: "browser-a", state: next.state, code: open.provider.authorize() })).status, 302);
});

test("A6_SIGN_IN the browser callback renders the paused page", async (t) => {
  const login = {
    callback: async () => ({ status: 403, body: { error: "access_paused" } }),
    web: { origin: ORIGIN },
  };
  const server = createGatewayServer(undefined, undefined, undefined, login as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const port = (server.address() as import("node:net").AddressInfo).port;
  const response = await fetch(`http://127.0.0.1:${port}/login/callback?state=s&code=c`, { headers: { accept: "text/html", cookie: `__Host-studenthub_browser=${"b".repeat(43)}` } });
  assert.equal(response.status, 403);
  const html = await response.text();
  assert.match(html, /Your StudentHub access is paused\./);
  assert.doesNotMatch(html, /Continue with Universe/);
});
