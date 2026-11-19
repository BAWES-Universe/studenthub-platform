import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import test, { type TestContext } from "node:test";
import { IdCardsService } from "../../../packages/reports/src/index.js";
import type { IdCardAction, IdCardsStore, IdCardView } from "../../../packages/reports/src/index.js";
import { handleIdCards } from "../src/reports/id-cards-http.js";

const ORIGIN = "https://studenthub.example", STAFF = "staff-1", PERSON = "person-1";

async function rig(t: TestContext) {
  const writes: { action: IdCardAction; people: readonly string[] }[] = [];
  let refuse: { personId: string; code: "not_assigned" }[] = [];
  const store: IdCardsStore = {
    async list(view: IdCardView) {
      return view === "needs" ? { total: 1, rows: [{ personId: "p-<1>", name: "Alia <b>Badr</b>", employeeId: "C00042", cardNumber: null, expiresOn: null, placement: { company: "Sultan Center", store: "Avenues" } }] } : { total: 0, rows: [] };
    },
    async write(action, people) { if (refuse.length) return refuse; writes.push({ action, people }); return []; },
    async card(person) { return person === PERSON ? { name: "Alia Badr", arabicName: "علياء بدر", employeeId: "C00042", cardNumber: 17, expiresOn: "2099-01-01", issuedAt: new Date("2026-11-19T00:00:00Z"), placement: { company: "Sultan Center", store: "Avenues" } } : undefined; },
    async counts() { return { needs: 0, expired: 0 }; },
  };
  const authority = { async isStaff(id: string) { return id === STAFF; } };
  const service = new IdCardsService(store, authority);
  const http = { isStaff: authority.isStaff, list: service.list.bind(service), write: service.write.bind(service), own: service.own.bind(service) };
  const server = createServer(async (req, res) => {
    if (!await handleIdCards(req, res, http, ORIGIN, async s => s === "s-staff" ? STAFF : s === "s-person" ? PERSON : s === "s-other" ? "other" : undefined)) { res.writeHead(418); res.end(); }
  });
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  t.after(() => new Promise<void>(r => server.close(() => r())));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const get = (path: string, session?: string, accept = "application/json") => fetch(base + path, { headers: { ...(session ? { cookie: `__Host-studenthub_session=${session}` } : {}), accept } });
  const post = (body: string, session = "s-staff", headers: Record<string, string> = {}, method = "POST") => fetch(base + "/workspace/id-cards", { method, redirect: "manual",
    headers: { cookie: `__Host-studenthub_session=${session}`, origin: ORIGIN, "content-type": "application/x-www-form-urlencoded", accept: "application/json", ...headers }, body });
  return { get, post, writes, base, refuseWith(r: typeof refuse) { refuse = r; } };
}

test("REPORTS_ID_CARDS_HTTP only staff reach the staff page; everyone else gets the same not found for every method", async (t) => {
  const x = await rig(t);
  const notFound = JSON.stringify({ status: "not_found" });
  for (const session of [undefined, "s-person", "s-bogus"]) {
    const res = await x.get("/workspace/id-cards", session);
    assert.equal(res.status, 404); assert.equal(await res.text(), notFound);
    for (const method of ["POST", "PUT", "DELETE", "PATCH"]) {
      const r = await x.post("action=issue&person=a", session ?? "", {}, method);
      assert.equal(r.status, 404, `${method} ${session}`); assert.equal(await r.text(), notFound);
    }
    const cross = await x.post("action=issue&person=a", session ?? "", { origin: "https://evil.example" });
    assert.equal(cross.status, 404, "cross-origin from a non-staff caller is still not found");
  }
  assert.equal(x.writes.length, 0);
  assert.equal((await x.get("/workspace/id-cards/other", "s-staff")).status, 418, "other paths are not this route's");
});

test("REPORTS_ID_CARDS_HTTP staff see who needs a card, escaped, and a form to issue", async (t) => {
  const x = await rig(t);
  const json = await (await x.get("/workspace/id-cards?view=needs&name=alia", "s-staff")).json() as { status: string; view: string; total: number; rows: { personId: string }[] };
  assert.equal(json.status, "ok"); assert.equal(json.view, "needs"); assert.equal(json.total, 1); assert.equal(json.rows[0]?.personId, "p-<1>");
  const html = await (await x.get("/workspace/id-cards", "s-staff", "text/html")).text();
  assert.match(html, /<h1>ID cards<\/h1>/);
  assert.match(html, /name="person" value="p-&lt;1&gt;"/);
  assert.match(html, /Alia &lt;b&gt;Badr&lt;\/b&gt;/);
  assert.match(html, /Sultan Center, Avenues/);
  assert.match(html, /<button type="submit" name="action" value="issue">Issue cards<\/button>/);
  assert.match(await (await x.get("/workspace/id-cards?view=expired", "s-staff", "text/html")).text(), /No assigned person has an expired card/);
  for (const bad of ["?view=all", "?page=0", "?page=x", `?name=${"a".repeat(101)}`]) assert.equal((await x.get(`/workspace/id-cards${bad}`, "s-staff")).status, 400, bad);
});

test("REPORTS_ID_CARDS_HTTP staff issue and renew in batches; refusals and bad bodies write nothing", async (t) => {
  const x = await rig(t);
  const ok = await x.post("action=issue&person=a&person=b");
  assert.equal(ok.status, 200);
  const body = await ok.json() as { status: string; action: string; count: number; expiresOn: string };
  assert.equal(body.status, "ok"); assert.equal(body.count, 2); assert.match(body.expiresOn, /^\d{4}-\d{2}-\d{2}$/);
  assert.deepEqual(x.writes, [{ action: "issue", people: ["a", "b"] }]);
  assert.equal((await x.post("action=renew&person=a")).status, 200);
  for (const bad of ["action=issue", "action=revoke&person=a", "person=a", "action=issue&action=renew&person=a", "action=issue&person=a&extra=1", "action=issue&person=a&person=a"])
    assert.equal((await x.post(bad)).status, 400, bad);
  assert.equal((await x.post("action=issue&person=a", "s-staff", { "content-type": "application/json" })).status, 400);
  assert.equal((await x.post("action=issue&person=a", "s-staff", { origin: "https://evil.example" })).status, 403);
  assert.equal((await x.post("action=issue&person=a", "s-staff", { "sec-fetch-site": "cross-site" })).status, 403);
  x.refuseWith([{ personId: "b", code: "not_assigned" }]);
  const refused = await x.post("action=issue&person=a&person=b");
  assert.equal(refused.status, 409);
  assert.deepEqual(await refused.json(), { status: "refused", refusals: [{ personId: "b", code: "not_assigned" }] });
  const html = await (await x.post("action=issue&person=a&person=b", "s-staff", { accept: "text/html" })).text();
  assert.match(html, /No card was issued, because:/); assert.match(html, /b is not assigned to a store/);
  assert.equal(x.writes.length, 2);
});

test("REPORTS_ID_CARDS_HTTP a person sees their own card, a note when they have none, and must be signed in", async (t) => {
  const x = await rig(t);
  const mine = await (await x.get("/profile/id-card", "s-person")).json() as { status: string; card: { cardNumber: number; valid: boolean; placement: unknown } };
  assert.equal(mine.status, "ok"); assert.equal(mine.card.cardNumber, 17); assert.equal(mine.card.valid, true);
  const html = await (await x.get("/profile/id-card", "s-person", "text/html")).text();
  assert.match(html, /This card is valid\./);
  assert.match(html, /<dt>Store<\/dt><dd>Avenues<\/dd>/);
  assert.match(html, /<dt>Arabic name<\/dt><dd>علياء بدر<\/dd>/);
  assert.match(html, /<dt>Employee ID<\/dt><dd>C00042<\/dd>/);
  assert.deepEqual(await (await x.get("/profile/id-card", "s-other")).json(), { status: "none" });
  assert.match(await (await x.get("/profile/id-card", "s-other", "text/html")).text(), /You do not have a StudentHub ID card yet/);
  assert.equal((await x.get("/profile/id-card")).status, 401);
  assert.equal((await fetch(x.base + "/profile/id-card", { method: "POST", headers: { cookie: "__Host-studenthub_session=s-person" } })).status, 405);
});
