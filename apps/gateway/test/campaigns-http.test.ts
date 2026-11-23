import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { CampaignsService, type CampaignsStore, type CampaignRecord } from "../../../packages/reports/src/index.js";
import { handleIdCards, type IdCardsHttpService } from "../src/reports/id-cards-http.js";

// A tiny in-memory store so the whole route, service and store line up as production wires them.
function memory() {
  const rows = new Map<string, CampaignRecord>();
  let n = 0;
  const key = (r: Pick<CampaignRecord, "utmSource" | "utmMedium" | "utmCampaign" | "utmContent" | "utmTerm">) => JSON.stringify([r.utmSource, r.utmMedium, r.utmCampaign, r.utmContent, r.utmTerm]);
  const live = () => [...rows.values()].filter(r => !r.retired);
  const store: CampaignsStore = {
    async list() { return [...rows.values()].sort((a, b) => Number(a.retired) - Number(b.retired)); },
    async create(v) {
      if (live().some(r => key(r) === key(v))) return { refused: "duplicate" };
      const id = `c${++n}`; rows.set(id, { id, ...v, retired: false, clicks: { recent: 0, total: 0 } }); return { id };
    },
    async update(id, v) {
      const r = rows.get(id); if (!r) return { refused: "unknown" }; if (r.retired) return { refused: "retired" };
      if (live().some(o => o.id !== id && key(o) === key(v))) return { refused: "duplicate" };
      rows.set(id, { ...r, ...v }); return true;
    },
    async retire(id) { const r = rows.get(id); if (!r) return { refused: "unknown" }; if (r.retired) return { refused: "retired" }; rows.set(id, { ...r, retired: true }); return true; },
  };
  return { store, rows };
}

async function rig(t: TestContext) {
  const { store, rows } = memory();
  // Seed one campaign with clicks so the list shows real figures.
  rows.set("seed", { id: "seed", utmSource: "newsletter", utmMedium: "email", utmCampaign: "launch", utmContent: null, utmTerm: "kuwait", investment: "12.500", retired: false, clicks: { recent: 2, total: 9 } });
  const isStaff = async (id: string) => id === "staff";
  const campaigns = new CampaignsService(store, { isStaff }, () => new Date("2026-11-23T09:00:00Z"));
  const service = { isStaff, campaigns: { campaignsPage: (v: string) => campaigns.page(v), campaignCreate: (v: string, i: never) => campaigns.create(v, i),
    campaignUpdate: (v: string, id: string, i: never) => campaigns.update(v, id, i), campaignRetire: (v: string, id: string) => campaigns.retire(v, id) } } as unknown as IdCardsHttpService;
  const server = createServer(async (req, res) => {
    if (!await handleIdCards(req, res, service, "https://studenthub.example", async s => ({ "s-alia": "alia", "s-staff": "staff" } as Record<string, string>)[s])) { res.writeHead(418); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/communications/campaigns`;
  const get = (session?: string, accept = "application/json") => fetch(base, { headers: { ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), accept } });
  const post = (session: string | undefined, body: string, headers: Record<string, string> = {}) => fetch(base, { method: "POST", redirect: "manual", body,
    headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://studenthub.example", ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), ...headers } });
  const call = (session: string | undefined, method: string) => fetch(base, { method, headers: { ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}),
    accept: "application/json", "content-type": "application/x-www-form-urlencoded", origin: "https://studenthub.example" } });
  return { get, post, call, rows };
}

test("CAMPAIGNS_HTTP staff see the campaigns, their clicks, the not-available figures and the new-campaign form", async (t) => {
  const x = await rig(t);
  const body = await (await x.get("s-staff")).json() as { day: string; clickDays: number; campaigns: CampaignRecord[]; missing: { label: string }[] };
  assert.equal(body.day, "2026-11-23");
  assert.deepEqual(body.campaigns.find(c => c.id === "seed")!.clicks, { recent: 2, total: 9 });
  assert.deepEqual(body.missing.map(m => m.label), ["Signups", "Revenue"]);
  const html = await (await x.get("s-staff", "text/html")).text();
  assert.match(html, /<h1>Marketing campaigns<\/h1>/);
  assert.match(html, /Recent clicks are the last 30 days/);
  assert.match(html, /Signups: Not available <small>\(waits on attribution at signup/);
  assert.match(html, /<td>newsletter<\/td>/);
  assert.match(html, /<input type="hidden" name="action" value="create">/);
});

test("CAMPAIGNS_HTTP everyone who is not staff gets the same not found for every method, and the path is this route's", async (t) => {
  const x = await rig(t);
  for (const session of [undefined, "s-alia"]) for (const method of ["GET", "POST", "DELETE"]) {
    const r = await x.call(session, method);
    assert.equal(r.status, 404, `${method} ${session}`);
  }
});

test("CAMPAIGNS_HTTP staff create a campaign, same origin only, and a duplicate is refused", async (t) => {
  const x = await rig(t);
  const created = await x.post("s-staff", "action=create&utmSource=google&utmMedium=cpc&utmCampaign=spring", { accept: "application/json" });
  assert.equal(created.status, 201);
  assert.equal((await created.json() as { status: string }).status, "ok");
  assert.ok([...x.rows.values()].some(r => r.utmCampaign === "spring"));
  // Same values again: duplicate, reported as a 400 with the field, and nothing new stored.
  const before = x.rows.size;
  const dup = await x.post("s-staff", "action=create&utmSource=google&utmMedium=cpc&utmCampaign=spring", { accept: "application/json" });
  assert.equal(dup.status, 400); assert.deepEqual(await dup.json(), { status: "invalid", field: "duplicate" });
  assert.equal(x.rows.size, before);
  // Cross origin is refused before anything is read.
  assert.equal((await x.post("s-staff", "action=create&utmSource=x&utmMedium=y&utmCampaign=z", { origin: "https://evil.example" })).status, 403);
  // An HTML create redirects back to the page.
  const html = await x.post("s-staff", "action=create&utmSource=twitter&utmMedium=social&utmCampaign=xmas", { accept: "text/html" });
  assert.deepEqual([html.status, html.headers.get("location")], [303, "/communications/campaigns"]);
});

test("CAMPAIGNS_HTTP a refused create re-renders the page with the reason for HTML; a bad form or action is a 400", async (t) => {
  const x = await rig(t);
  const refused = await x.post("s-staff", "action=create&utmSource=&utmMedium=email&utmCampaign=c", { accept: "text/html" });
  assert.equal(refused.status, 400);
  assert.match(await refused.text(), /role="alert">The source is required/);
  assert.equal((await x.post("s-staff", "action=create&utmSource=s&utmMedium=m&utmCampaign=c&bogus=1")).status, 400, "an unknown field");
  assert.equal((await x.post("s-staff", "action=delete&id=seed")).status, 400, "an unknown action");
  assert.equal((await x.post("s-staff", "action=create&utmSource=s&utmSource=t&utmMedium=m&utmCampaign=c")).status, 400, "a repeated field");
});

test("CAMPAIGNS_HTTP staff update and retire a campaign; unknown and retired are refused", async (t) => {
  const x = await rig(t);
  const ok = await x.post("s-staff", "action=update&id=seed&utmSource=newsletter&utmMedium=email&utmCampaign=relaunch&investment=5.000", { accept: "application/json" });
  assert.equal(ok.status, 200);
  assert.equal(x.rows.get("seed")!.utmCampaign, "relaunch");
  assert.equal(x.rows.get("seed")!.investment, "5.000");
  assert.deepEqual(await (await x.post("s-staff", "action=update&id=ghost&utmSource=s&utmMedium=m&utmCampaign=c", { accept: "application/json" })).json(), { status: "invalid", field: "unknown" });
  const retired = await x.post("s-staff", "action=retire&id=seed", { accept: "application/json" });
  assert.equal(retired.status, 200); assert.equal(x.rows.get("seed")!.retired, true);
  assert.deepEqual(await (await x.post("s-staff", "action=retire&id=seed", { accept: "application/json" })).json(), { status: "invalid", field: "retired" });
});

test("CAMPAIGNS_HTTP a full multilingual form of 100-character fields round-trips", async (t) => {
  const x = await rig(t);
  // 3-byte characters percent-encode to 9 bytes each, so five full fields pass 4,096 bytes.
  const cjk = (c: string) => c.repeat(100), ar = "ح".repeat(100);
  const fields = { utmSource: cjk("広"), utmMedium: cjk("告"), utmCampaign: ar, utmContent: cjk("内"), utmTerm: cjk("語") };
  const body = new URLSearchParams({ action: "create", ...fields, investment: "123456789.999" }).toString();
  assert.ok(Buffer.byteLength(body) > 4096, `the form is ${Buffer.byteLength(body)} bytes`);
  const created = await x.post("s-staff", body, { accept: "application/json" });
  assert.equal(created.status, 201);
  const row = [...x.rows.values()].find(r => r.utmCampaign === ar)!;
  assert.deepEqual({ utmSource: row.utmSource, utmMedium: row.utmMedium, utmCampaign: row.utmCampaign, utmContent: row.utmContent, utmTerm: row.utmTerm, investment: row.investment }, { ...fields, investment: "123456789.999" });
});
