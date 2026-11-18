import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createGatewayServer } from "../src/index.js";
import type { StaffViewPorts } from "../src/access/staff-view.js";
import { readOnlyDocument } from "../src/access/staff-view.js";
import type { AccessPorts } from "../src/access/admin-access.js";
import type { StaffView } from "../../../packages/access/src/index.js";

const ORIGIN = "https://studenthub.example.invalid";
const SESSIONS: Record<string, string> = { ["a".repeat(43)]: "admin-1", ["s".repeat(43)]: "staff-1", ["p".repeat(43)]: "person-1", ["t".repeat(43)]: "staff-2" };
const cookie = (key: string): Record<string, string> => ({ cookie: `__Host-studenthub_session=${key.repeat(43)}` });
const PROFILE = `<!doctype html><html><head><script src="/assets/x.js"></script></head><body><header><form action="/logout" method="post"><button>Sign out</button></form></header><h1>Dana &lt;Candidate&gt;</h1><a href="/profile/edit/displayName">Edit</a><form method="post" action="/profile/edit/preview"><input name="x"><textarea></textarea><select></select></form><script>steal()</script><p>Phone ending 1234</p></body></html>`;

function world() {
  const grants: Record<string, { orgId: string; role: string; scope: string }[]> = {
    "admin-1": [{ orgId: "root", role: "admin", scope: "subtree" }], "staff-1": [{ orgId: "root", role: "staff", scope: "subtree" }],
    "staff-2": [{ orgId: "root", role: "staff", scope: "subtree" }],
  };
  const people: Record<string, string> = { "person-1": "Dana Candidate", "staff-2": "Sam Second", "admin-1": "Grace Admin", "staff-1": "Sam Staff" };
  let now = new Date("2026-11-17T10:00:00.000Z");
  const views: StaffView[] = [];
  const reads = {
    callerGrants: async (id: string) => grants[id] ?? [],
    person: async (id: string) => (people[id] ? { principalId: id, displayName: people[id]!, email: null } : null),
  };
  const staffView: StaffViewPorts = {
    sessions: { get: async (id) => (SESSIONS[id] ? { id, personId: SESSIONS[id]! } : undefined) },
    reads, operatorOrgIds: ["root"], now: () => now, render: async () => PROFILE,
    views: {
      async start(staffId, request, mayStart) {
        if (!mayStart(await reads.callerGrants(staffId), grants[request.targetPrincipalId] ?? [])) return null;
        const view = { id: String(views.length), staffPrincipalId: staffId, targetPrincipalId: request.targetPrincipalId, reason: request.reason, startedAt: now.toISOString(), expiresAt: new Date(now.getTime() + 900_000).toISOString() };
        views.push(view);
        return view;
      },
      async open(staffId, target) { return views.filter((view) => view.staffPrincipalId === staffId && view.targetPrincipalId === target && Date.parse(view.expiresAt) > now.getTime()).at(-1) ?? null; },
      async viewedOn(target) { return views.filter((view) => view.targetPrincipalId === target).map((view) => view.startedAt).reverse(); },
      async grantsOf(id) { return grants[id] ?? []; },
    },
  };
  const access = {
    sessions: staffView.sessions, operatorOrgIds: ["root"],
    reads: { ownGrants: async () => [], callerGrants: reads.callerGrants },
    views: staffView.views,
  } as unknown as AccessPorts;
  return { staffView, access, views, tick: (ms: number) => { now = new Date(now.getTime() + ms); } };
}

async function serve(t: TestContext, login: unknown) {
  const server = createGatewayServer(undefined, undefined, undefined, login as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  return (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    fetch(base + path, { redirect: "manual", ...init, headers: { accept: "text/html", ...init.headers } });
}
const start = (http: Awaited<ReturnType<typeof serve>>, key: string, target = "person-1", reason = "Support ticket 1234", origin = ORIGIN) =>
  http(`/admin/access/people/${target}/view`, { method: "POST", body: new URLSearchParams({ targetPrincipalId: target, reason }).toString(),
    headers: { ...cookie(key), origin, "content-type": "application/x-www-form-urlencoded" } });

test("A9_VIEW staff start a 15 minute read-only view with a reason, and see the person's profile with nothing that can act", async (t) => {
  const w = world();
  const http = await serve(t, { staffView: w.staffView, access: w.access, web: { origin: ORIGIN } });
  const before = await (await http("/admin/access/people/person-1/view", { headers: cookie("s") })).text();
  assert.match(before, /View as Dana Candidate for 15 minutes/);
  const started = await start(http, "s");
  assert.equal(started.status, 303);
  assert.equal(started.headers.get("location"), "/admin/access/people/person-1/view");
  assert.deepEqual(w.views.map((view) => [view.staffPrincipalId, view.targetPrincipalId, view.reason]), [["staff-1", "person-1", "Support ticket 1234"]]);
  const view = await http("/admin/access/people/person-1/view", { headers: cookie("s") });
  assert.equal(view.status, 200);
  assert.match(view.headers.get("content-security-policy") ?? "", /form-action 'none'/);
  const html = await view.text();
  assert.match(html, /Viewing as Dana Candidate, read-only, until 2026-11-17 10:15 UTC\./);
  assert.match(html, /Phone ending 1234/);
  assert.doesNotMatch(html, /<form|<script|<input|<textarea|<select|<button|steal\(\)|href="\/profile/);
  assert.equal((html.match(/<a /g) ?? []).length, 1, "only the banner's way back is a link");
  w.tick(900_000);
  assert.match(await (await http("/admin/access/people/person-1/view", { headers: cookie("s") })).text(), /View as Dana Candidate for 15 minutes/, "the view ends after 15 minutes");
  const own = await (await http("/profile/access", { headers: cookie("p") })).text();
  assert.match(own, /StudentHub staff opened a view of your account on 2026-11-17/);
  assert.doesNotMatch(own, /Sam Staff|Support ticket/, "the person sees the date, not who or why");
});

test("A9_RULES refusals: not staff or signed out is the unknown-path 404, staff cannot view staff, a bad form starts nothing", async (t) => {
  const w = world();
  const http = await serve(t, { staffView: w.staffView, access: w.access, web: { origin: ORIGIN } });
  const unknown = await (await http("/definitely-unknown", { headers: cookie("p") })).text();
  for (const key of [undefined, "p"]) {
    const response = await http("/admin/access/people/person-1/view", { headers: key ? cookie(key) : {} });
    assert.equal(response.status, 404);
    if (key) assert.equal(await response.text(), unknown);
    assert.equal((await start(http, key ?? "x")).status, 404);
  }
  assert.equal((await http("/admin/access/people/nobody/view", { headers: cookie("s") })).status, 404);
  assert.equal((await start(http, "s", "staff-2")).status, 403, "staff cannot view staff");
  assert.equal((await start(http, "a", "staff-2")).status, 303, "an admin can");
  assert.equal((await start(http, "s", "staff-1")).status, 403, "not oneself");
  assert.equal((await start(http, "s", "person-1", "no")).status, 400);
  assert.equal((await start(http, "s", "person-1", "Support ticket", "https://evil.invalid")).status, 400);
  assert.deepEqual(w.views.map((view) => [view.staffPrincipalId, view.targetPrincipalId]), [["admin-1", "staff-2"]]);
});

test("A9_VIEW the read-only document keeps text and drops every control", () => {
  const out = readOnlyDocument(PROFILE, "<section>banner</section>");
  assert.match(out, /<body><section>banner<\/section>/);
  assert.match(out, /<span>Edit<\/span>/);
  assert.doesNotMatch(out, /<form|<script|<a |<input|<button/);
});

test("A9_RULES a grant removed while the form is read starts nothing; a view that ends during the render shows nothing", async (t) => {
  const w = world();
  const http = await serve(t, { staffView: w.staffView, access: w.access, web: { origin: ORIGIN } });
  const callerGrants = w.staffView.reads.callerGrants;
  let calls = 0;
  (w.staffView.reads as { callerGrants: typeof callerGrants }).callerGrants = async (id) => (id === "staff-1" && ++calls > 1 ? [] : callerGrants(id));
  assert.equal((await start(http, "s")).status, 403);
  assert.deepEqual(w.views, [], "nothing recorded");
  (w.staffView.reads as { callerGrants: typeof callerGrants }).callerGrants = callerGrants;

  assert.equal((await start(http, "s")).status, 303);
  w.tick(899_000);
  (w.staffView as { render: StaffViewPorts["render"] }).render = async () => { w.tick(2_000); return PROFILE; };
  const html = await (await http("/admin/access/people/person-1/view", { headers: cookie("s") })).text();
  assert.match(html, /This view has ended\./);
  assert.doesNotMatch(html, /Phone ending 1234/);
});
