import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import type { PayContract, PayContractView } from "@studenthub/pay-contracts";
import { createGatewayServer, createLoginApplication } from "../src/index.js";
import { createPayContracts, type PayContractsCreate } from "../src/pay-contracts-http.js";

const ORIGIN = "https://studenthub.example.invalid", ORG = "org-a";
const sessions = { owner: "a".repeat(43), finance: "b".repeat(43), staff: "c".repeat(43), admin: "d".repeat(43), candidate: "e".repeat(43), recruiter: "f".repeat(43), outsider: "g".repeat(43) };
const people: Record<keyof typeof sessions, string> = { owner: "owner", finance: "finance", staff: "staff", admin: "admin", candidate: "candidate", recruiter: "recruiter", outsider: "outsider" };
const base = { id: "10000000-0000-4000-8000-000000000001", candidateId: "candidate-secret", companyId: ORG, storeId: "store-secret", startDate: "2026-01-01", currencyId: "kwd", transferCost: "77.777", autoGenerate: false, status: "active", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-01T00:00:00.000Z" } as const;
const contracts: PayContract[] = [
  { ...base, startDate: "2026-03-01", terms: { payModel: "hourly", candidateHourlyRate: "candidate-hourly-secret", companyHourlyRate: "20.000" } },
  { ...base, id: "20000000-0000-4000-8000-000000000002", startDate: "2026-02-01", endDate: "2026-12-31", status: "inactive", terms: { payModel: "fixed_price", candidateTotal: "candidate-fixed-secret", companyTotal: "900.000", completionPercentage: 40 } },
  { ...base, id: "30000000-0000-4000-8000-000000000003", startDate: "2026-01-01", terms: { payModel: "monthly_salary", candidateTotal: "candidate-salary-secret", companyTotal: "500.000", salaryDay: 25 } },
];
type Options = { configured?: boolean; web?: boolean; contracts?: readonly PayContract[]; thrown?: boolean; result503?: boolean };

async function fixture(t: TestContext, options: Options = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  for (const who of Object.keys(sessions) as Array<keyof typeof sessions>) await rig.sessions.put({ id: sessions[who], personId: people[who] });
  const calls = { access: [] as string[], company: [] as string[], methods: [] as string[] };
  const store = {
    forCompany() { calls.methods.push("forCompany"); throw new Error("write forbidden"); }, readReceipt: async () => { calls.methods.push("receipt"); return null; },
    readAccess: async (person: string, orgId: string): Promise<PayContractView | null> => { calls.access.push(`${person}:${orgId}`); if (options.thrown) throw new Error("private contract stack"); if (options.result503) throw new Error("503 result supplied below"); if (orgId !== ORG || ["candidate", "recruiter", "outsider"].includes(person)) return null; return ["staff", "admin"].includes(person) ? "full" : "company"; },
    isCandidate: async () => { calls.methods.push("listMine"); return false; },
  };
  const ports = { listForCompany: async (orgId: string) => { calls.company.push(orgId); return options.contracts ?? contracts; }, listForCandidate: async () => { calls.methods.push("listMine"); return []; } };
  const created = createPayContracts({ sessions: rig.sessions, store, contracts: ports });
  const service: PayContractsCreate = options.result503 ? { ...created, listCompany: async () => ({ status: 503, body: { error: "down" } }) } : created;
  const tracked = Object.fromEntries(Object.entries(service).map(([name, fn]) => [name, async (...args: unknown[]) => { calls.methods.push(name); return (fn as (...values: unknown[]) => unknown)(...args); }])) as unknown as PayContractsCreate;
  const login = { ...rig.app, ...(options.configured === false ? {} : { payContracts: tracked }), ...(options.web === false ? {} : { web: { origin: ORIGIN, returnTo: `${ORIGIN}/workspace` } }) } as never;
  const server = createGatewayServer(undefined, undefined, undefined, login);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const request = (path: string, who?: keyof typeof sessions, init: RequestInit = {}) => fetch(`http://127.0.0.1:${address.port}${path}`, { ...init, headers: { accept: "text/html", ...(who ? { cookie: `__Host-studenthub_session=${sessions[who]}` } : {}), ...init.headers } });
  return { request, calls };
}

test("ORGCON_SHOW authorized readers see the company contract list and negotiated API", async (t) => {
  const f = await fixture(t);
  for (const who of ["owner", "finance", "staff", "admin"] as const) {
    const response = await f.request(`/organization/${ORG}/contracts`, who), html = await response.text();
    assert.equal(response.status, 200); assert.match(response.headers.get("content-type")!, /^text\/html/); assert.equal(response.headers.get("cache-control"), "no-store");
    for (const value of ["2026-03-01", "Open-ended", "Active", "Hourly", "20.000 per hour", "2026-12-31", "Inactive", "Fixed price", "900.000 (40% complete)", "Monthly salary", "500.000 (salary day 25)", `href="/organization/${ORG}"`]) assert.ok(html.includes(value), `ORGCON_SHOW renders ${value}`);
    assert.ok(html.indexOf("2026-03-01") < html.indexOf("2026-02-01") && html.indexOf("2026-02-01") < html.indexOf("2026-01-01"), "ORGCON_SHOW rows preserve listCompany order");
  }
  const json = await f.request(`/organization/${ORG}/contracts`, "owner", { headers: { accept: "application/json" } }), api = await f.request(`/pay-contracts/company/${ORG}`, "owner", { headers: { accept: "application/json" } });
  assert.equal(json.headers.get("content-type"), "application/json"); assert.equal(await json.text(), await api.text(), "ORGCON_SHOW page JSON equals the existing company API");
  const head = await f.request(`/organization/${ORG}/contracts`, "owner", { method: "HEAD" }); assert.equal(head.status, 200); assert.match(head.headers.get("content-type")!, /^text\/html/); assert.equal(head.headers.get("cache-control"), "no-store"); assert.equal(await head.text(), "");
  const empty = await fixture(t, { contracts: [] }); assert.match(await (await empty.request(`/organization/${ORG}/contracts`, "owner")).text(), /No contracts yet\./);
  const unsafe = "<img src=x onerror=alert(1)>";
  const escaped = await fixture(t, { contracts: [{ ...contracts[0]!, startDate: unsafe as PayContract["startDate"] }] }); const escapedHtml = await (await escaped.request(`/organization/${ORG}/contracts`, "owner")).text();
  assert.match(escapedHtml, /&lt;img src=x onerror=alert\(1\)&gt;/, "ORGCON_SHOW rendered values are escaped"); assert.doesNotMatch(escapedHtml, /<img src=x onerror=alert\(1\)>/);
});

test("ORGCON_COMPANY_TERMS full views still render only company terms through listCompany", async (t) => {
  const f = await fixture(t); const html = await (await f.request(`/organization/${ORG}/contracts`, "staff")).text();
  for (const secret of ["candidate-hourly-secret", "candidate-fixed-secret", "candidate-salary-secret", "77.777", "candidate-secret", "store-secret"]) assert.doesNotMatch(html, new RegExp(secret), "ORGCON_COMPANY_TERMS candidate and transfer values stay hidden");
  assert.deepEqual(f.calls.company, [ORG], "ORGCON_COMPANY_TERMS contracts are listed exactly once"); assert.deepEqual(f.calls.methods, ["listCompany"], "ORGCON_COMPANY_TERMS only listCompany is called");
});

test("ORGCON_DENY refusals, malformed ids, queries, and methods preserve their boundaries", async (t) => {
  const f = await fixture(t); const signedOut = await f.request(`/organization/${ORG}/contracts`); assert.equal(signedOut.status, 401); assert.match(await signedOut.text(), /Sign in/); assert.equal(f.calls.access.length, 0, "ORGCON_DENY no session reads no access port");
  let html404: string | undefined;
  for (const [path, who] of [[`/organization/${ORG}/contracts`, "candidate"], [`/organization/${ORG}/contracts`, "recruiter"], [`/organization/${ORG}/contracts`, "outsider"], ["/organization/missing/contracts", "staff"], ["/organization/operator/contracts", "staff"]] as const) { const response = await f.request(path, who), body = await response.text(); assert.equal(response.status, 404); html404 ??= body; assert.equal(body, html404, "ORGCON_DENY HTML refusals are byte-identical"); }
  const reads = f.calls.access.length; for (const path of ["/organization/%E0%A4%A/contracts", "/organization/%20/contracts"]) assert.equal((await f.request(path, "staff")).status, 404); assert.equal(f.calls.access.length, reads, "ORGCON_DENY malformed ids do not call listCompany");
  const jsonBodies: string[] = []; for (const who of ["candidate", "recruiter"] as const) { const response = await f.request(`/organization/${ORG}/contracts`, who, { headers: { accept: "application/json" } }); jsonBodies.push(await response.text()); } assert.equal(jsonBodies[0], jsonBodies[1], "ORGCON_DENY JSON refusals are byte-identical");
  const beforeQuery = f.calls.access.length, query = await f.request(`/organization/${ORG}/contracts?x=1`, "owner"); assert.equal(query.status, 400, "ORGCON_DENY query strings are 400"); assert.equal(f.calls.access.length, beforeQuery);
  for (const method of ["POST", "PUT", "DELETE"]) { const page = await f.request(`/organization/${ORG}/contracts`, "owner", { method }), unknown = await f.request("/not-a-route", "owner", { method }); assert.equal(page.status, unknown.status); assert.equal(await page.text(), await unknown.text(), "ORGCON_DENY non-read methods fall through"); }
});

test("ORGCON_PASSTHROUGH existing pay-contract and organization paths retain their handlers", async (t) => {
  const f = await fixture(t); const api = await f.request(`/pay-contracts/company/${ORG}`, "owner", { headers: { accept: "application/json" } }); assert.equal(api.status, 200); assert.equal((await api.json() as { view: string }).view, "company");
  for (const path of [`/organization/${ORG}`, `/organization/${ORG}/stores`, `/organization/${ORG}/notes`, `/organization/${ORG}/transfers`, `/organization/${ORG}/contracts/x`]) { const response = await f.request(path, "owner"); assert.notEqual(response.headers.get("content-type"), null, `ORGCON_PASSTHROUGH ${path} reaches a later handler`); }
});

test("ORGCON_UNAVAILABLE unavailable and failed reads produce only the safe 503", async (t) => {
  for (const options of [{ configured: false }, { web: false }, { thrown: true }, { result503: true }]) { const f = await fixture(t, options), response = await f.request(`/organization/${ORG}/contracts`, "owner"), html = await response.text(); assert.equal(response.status, 503, "ORGCON_UNAVAILABLE failures are 503"); assert.match(html, /Contracts are unavailable right now\./); assert.doesNotMatch(html, /private contract stack|20\.000|No contracts yet/); }
  const f = await fixture(t, { thrown: true }), json = await f.request(`/organization/${ORG}/contracts`, "owner", { headers: { accept: "application/json" } }); assert.equal(json.status, 503); assert.deepEqual(await json.json(), { error: "safe_write_unavailable" });
});
