import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createGatewayServer } from "../src/index.js";
import type { CompanyRegistrationPorts } from "../src/access/company-registration.js";
import { createCompanyRegistrationService, type CompanyRegistration } from "../../../packages/access/src/index.js";

const ORIGIN = "https://studenthub.example.invalid";
const SESSIONS: Record<string, string> = { ["s".repeat(43)]: "staff-1", ["p".repeat(43)]: "person-1", ["o".repeat(43)]: "owner-1" };
const cookie = (key: string): Record<string, string> => ({ cookie: `__Host-studenthub_session=${key.repeat(43)}` });
const FORM = { companyName: "Acme <Trading>", contactName: "Sara Ali", contactPosition: "HR manager", phoneNumber: "+965 2222 3333", companyEmail: "hr@acme.example", requestingFor: "Weekend retail staff" };

function world() {
  const grants: Record<string, { orgId: string; role: string; scope: string }[]> = { "staff-1": [{ orgId: "root", role: "staff", scope: "subtree" }], "owner-1": [{ orgId: "acme", role: "org-owner", scope: "subtree" }] };
  const rows: CompanyRegistration[] = [];
  const created: string[] = [];
  const registrations: CompanyRegistrationPorts["registrations"] = {
    async submit(principalId, request) {
      if (rows.some((row) => row.submitter.principalId === principalId && row.status === "pending")) return { kind: "refused", reason: "already_pending" };
      const id = `00000000-0000-4000-8000-${String(rows.length).padStart(12, "0")}`;
      rows.push({ ...request, id, submitter: { principalId, displayName: "Dana Person", email: "dana@example.com" }, status: "pending", submittedAt: "2026-11-17T10:00:00.000Z", reviewedAt: null, reviewReason: null, orgId: null });
      return { kind: "submitted", id };
    },
    async mine(principalId) { return rows.filter((row) => row.submitter.principalId === principalId).reverse(); },
    async queue() { return { pending: rows.filter((row) => row.status === "pending"), decided: rows.filter((row) => row.status !== "pending") }; },
  };
  const service = createCompanyRegistrationService({ operatorOrgIds: ["root"], store: { async review({ callerId, review, decide }) {
    const index = rows.findIndex((row) => row.id === review.registrationId);
    const row = rows[index];
    const decision = decide({ callerGrants: grants[callerId] ?? [], registration: row ? { submitterPrincipalId: row.submitter.principalId, status: row.status, companyName: row.companyName } : null, nameTaken: false, submitterPaused: false });
    if (decision.kind !== "apply") return decision;
    const orgId = review.action === "approve" ? `org-${created.push(row!.companyName)}` : null;
    rows[index] = { ...row!, status: review.action === "approve" ? "approved" : "rejected", reviewedAt: "2026-11-17T11:00:00.000Z", reviewReason: review.reason, orgId };
    return orgId ? { kind: "approved", orgId } : { kind: "rejected" };
  } } });
  const ports: CompanyRegistrationPorts = {
    sessions: { get: async (id) => (SESSIONS[id] ? { id, personId: SESSIONS[id]! } : undefined) },
    reads: { callerGrants: async (id) => grants[id] ?? [] }, registrations, service, operatorOrgIds: ["root"],
  };
  return { ports, rows, created };
}

async function serve(t: TestContext, login: unknown) {
  const server = createGatewayServer(undefined, undefined, undefined, login as never);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${(server.address() as import("node:net").AddressInfo).port}`;
  return (path: string, init: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    fetch(base + path, { redirect: "manual", ...init, headers: { accept: "text/html", ...init.headers } });
}
const post = (http: Awaited<ReturnType<typeof serve>>, path: string, key: string, fields: Record<string, string>, origin = ORIGIN) =>
  http(path, { method: "POST", body: new URLSearchParams(fields).toString(), headers: { ...cookie(key), origin, "content-type": "application/x-www-form-urlencoded" } });

test("A7_SIGN_UP a signed-in person registers a company once, staff approve it, and the person sees the outcome", async (t) => {
  const w = world();
  const http = await serve(t, { registrations: w.ports, web: { origin: ORIGIN } });
  const signedOut = await http("/companies/register");
  assert.equal(signedOut.status, 200);
  assert.match(await signedOut.text(), /Sign in first/);
  assert.match(await (await http("/companies/register", { headers: cookie("p") })).text(), /name="companyName"/);
  const sent = await post(http, "/companies/register", "p", FORM);
  assert.equal(sent.status, 303);
  assert.equal(sent.headers.get("location"), "/companies/register?done=submitted");
  assert.equal((await post(http, "/companies/register", "p", FORM)).status, 409, "one pending registration at a time");
  const waiting = await (await http("/companies/register?done=submitted", { headers: cookie("p") })).text();
  assert.match(waiting, /Waiting for review/);
  assert.doesNotMatch(waiting, /name="companyName"/, "no second form while one is pending");
  const queue = await (await http("/admin/access/registrations", { headers: cookie("s") })).text();
  assert.match(queue, /Acme &lt;Trading&gt;/);
  assert.doesNotMatch(queue, /Acme <Trading>/);
  const id = w.rows[0]!.id;
  const approved = await post(http, `/admin/access/registrations/${id}`, "s", { registrationId: id, action: "approve", reason: "Licence checked" });
  assert.equal(approved.status, 303);
  assert.equal(approved.headers.get("location"), "/admin/access/registrations?done=approved");
  assert.deepEqual(w.created, ["Acme <Trading>"]);
  assert.equal((await post(http, `/admin/access/registrations/${id}`, "s", { registrationId: id, action: "reject", reason: "Too late now" })).status, 409, "decided once");
  assert.match(await (await http("/companies/register", { headers: cookie("p") })).text(), /Approved · <a class="text-link" href="\/workspace">/);
});

test("A7_QUEUE the queue is the unknown-path 404 for everyone but operator staff; bad forms and other origins change nothing", async (t) => {
  const w = world();
  const http = await serve(t, { registrations: w.ports, web: { origin: ORIGIN } });
  await post(http, "/companies/register", "p", FORM);
  const id = w.rows[0]!.id;
  const unknown = await (await http("/definitely-unknown", { headers: cookie("o") })).text();
  for (const key of [undefined, "o", "p"]) {
    const page = await http("/admin/access/registrations", { headers: key ? cookie(key) : {} });
    assert.equal(page.status, 404);
    if (key) assert.equal(await page.text(), unknown);
    assert.equal((await post(http, `/admin/access/registrations/${id}`, key ?? "x", { registrationId: id, action: "approve", reason: "Licence checked" })).status, 404);
  }
  assert.equal((await post(http, `/admin/access/registrations/${id}`, "s", { registrationId: id, action: "approve", reason: "ok" })).status, 400);
  assert.equal((await post(http, `/admin/access/registrations/${id}`, "s", { registrationId: id, action: "approve", reason: "Licence checked", extra: "1" })).status, 400);
  assert.equal((await post(http, `/admin/access/registrations/${id}`, "s", { registrationId: id, action: "approve", reason: "Licence checked" }, "https://evil.invalid")).status, 400);
  assert.equal((await post(http, "/companies/register", "o", { ...FORM, phoneNumber: "call me" })).status, 400);
  assert.equal((await post(http, "/companies/register", "o", FORM, "https://evil.invalid")).status, 400);
  assert.equal(w.rows.length, 1);
  assert.equal(w.rows[0]!.status, "pending");
  const rejected = await post(http, `/admin/access/registrations/${id}`, "s", { registrationId: id, action: "reject", reason: "We could not reach you" });
  assert.equal(rejected.headers.get("location"), "/admin/access/registrations?done=rejected");
  const mine = await (await http("/companies/register", { headers: cookie("p") })).text();
  assert.match(mine, /Not approved/);
  assert.match(mine, /We could not reach you/);
  assert.match(mine, /name="companyName"/, "after a decision the person can register again");
});
