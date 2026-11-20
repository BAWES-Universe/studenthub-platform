import assert from "node:assert/strict";
import test from "node:test";
import { addMonths, IdCardsService, IdCardVerifier, kuwaitDay, ID_CARD_BATCH_MAX } from "../src/index.js";
import type { IdCardAction, IdCardsStore, IdCardView } from "../src/index.js";

test("REPORTS_ID_CARDS three calendar months, clamped to the end of a shorter month", () => {
  assert.equal(addMonths("2026-11-19", 3), "2027-02-19");
  assert.equal(addMonths("2026-11-30", 3), "2027-02-28");
  assert.equal(addMonths("2027-11-30", 3), "2028-02-29", "leap year");
  assert.equal(addMonths("2026-10-31", 3), "2027-01-31");
  assert.equal(addMonths("2026-12-31", 2), "2027-02-28");
  assert.throws(() => addMonths("19-11-2026", 3), /invalid day/);
});

test("REPORTS_ID_CARDS today is the Asia/Kuwait day", () => {
  assert.equal(kuwaitDay(new Date("2026-11-19T20:59:59Z")), "2026-11-19");
  assert.equal(kuwaitDay(new Date("2026-11-19T21:00:00Z")), "2026-11-20");
});

class Store implements IdCardsStore {
  writes: { action: IdCardAction; people: readonly string[]; today: string; expiresOn: string; actor: string }[] = [];
  lists: { view: IdCardView; today: string; name: string | null; offset: number; limit: number }[] = [];
  refuse: { personId: string; code: "not_assigned" }[] = [];
  async list(view: IdCardView, today: string, name: string | null, offset: number, limit: number) { this.lists.push({ view, today, name, offset, limit }); return { rows: [], total: 0 }; }
  async write(action: IdCardAction, people: readonly string[], today: string, expiresOn: string, actor: string) { this.writes.push({ action, people, today, expiresOn, actor }); return this.refuse; }
  async card(personId: string) { return personId === "holder" ? { name: "Alia Badr", arabicName: null, employeeId: null, cardNumber: 7, expiresOn: "2026-11-19", issuedAt: new Date(), placement: null } : undefined; }
  async counts() { return { needs: 0, expired: 0 }; }
  verifyRows = new Map<number, { name: string | null; company: string | null; expiresOn: string; assigned: boolean }>();
  async verify(n: number) { return this.verifyRows.get(n); }
}
const rig = (at = "2026-11-19T21:30:00Z") => {
  const store = new Store();
  return { store, service: new IdCardsService(store, { async isStaff(id: string) { return id === "staff"; } }, () => new Date(at)) };
};

test("REPORTS_ID_CARDS only staff list or write; anyone else gets not found and nothing is read or written", async () => {
  const { store, service } = rig();
  assert.equal(await service.list("person", "needs", null, 1), undefined);
  assert.deepEqual(await service.write("person", "issue", ["a"]), { status: "not_found" });
  assert.equal(store.lists.length + store.writes.length, 0);
});

test("REPORTS_ID_CARDS a batch is valid three months from the Kuwait day, written by the staff member", async () => {
  const { store, service } = rig();
  assert.deepEqual(await service.write("staff", "issue", ["a", "b"]), { status: "ok", count: 2, expiresOn: "2027-02-20" });
  assert.deepEqual(store.writes, [{ action: "issue", people: ["a", "b"], today: "2026-11-20", expiresOn: "2027-02-20", actor: "staff" }]);
  store.refuse = [{ personId: "b", code: "not_assigned" }];
  assert.deepEqual(await service.write("staff", "renew", ["a", "b"]), { status: "refused", refusals: [{ personId: "b", code: "not_assigned" }] });
});

test("REPORTS_ID_CARDS a batch is between 1 and the cap, each person once, with a known action", async () => {
  const { store, service } = rig();
  for (const [action, people] of [["issue", []], ["issue", ["a", "a"]], ["issue", ["bad id"]], ["revoke", ["a"]],
    ["issue", Array.from({ length: ID_CARD_BATCH_MAX + 1 }, (_, i) => `p${i}`)]] as const)
    assert.deepEqual(await service.write("staff", action as IdCardAction, people), { status: "invalid" }, JSON.stringify([action, people.length]));
  assert.equal(store.writes.length, 0);
  assert.deepEqual(await service.write("staff", "issue", ["alia@example.com", "sso:p+1"]), { status: "ok", count: 2, expiresOn: "2027-02-20" }, "any principal id the access layer accepts");
  assert.deepEqual(await service.write("staff", "issue", Array.from({ length: ID_CARD_BATCH_MAX }, (_, i) => `p${i}`)), { status: "ok", count: ID_CARD_BATCH_MAX, expiresOn: "2027-02-20" });
});

test("REPORTS_ID_CARDS the batch is taken before authorization; changing the array afterwards changes nothing", async () => {
  const store = new Store(), people = ["a", "b"];
  const service = new IdCardsService(store, { async isStaff() { people.push("c", "c"); people[0] = "bad id"; return true; } }, () => new Date("2026-11-19T06:00:00Z"));
  assert.deepEqual(await service.write("staff", "issue", people), { status: "ok", count: 2, expiresOn: "2027-02-19" });
  assert.deepEqual(store.writes[0]!.people, ["a", "b"]);
});

test("REPORTS_ID_CARDS lists page by fifty and trim the name search", async () => {
  const { store, service } = rig();
  assert.deepEqual(await service.list("staff", "expired", "  alia  ", 3), { rows: [], total: 0, today: "2026-11-20" });
  assert.deepEqual(store.lists, [{ view: "expired", today: "2026-11-20", name: "alia", offset: 100, limit: 50 }]);
  await service.list("staff", "needs", "   ", 1);
  assert.equal(store.lists[1]?.name, null);
  await assert.rejects(service.list("staff", "all" as IdCardView, null, 1), /invalid list/);
  await assert.rejects(service.list("staff", "needs", null, 0), /invalid list/);
});

test("REPORTS_ID_CARDS a card is valid through its expiry day, in Kuwait time", async () => {
  assert.equal((await rig("2026-11-19T20:59:00Z").service.own("holder"))?.valid, true);
  assert.equal((await rig("2026-11-19T21:00:00Z").service.own("holder"))?.valid, false);
  assert.equal(await rig().service.own("nobody"), undefined);
});

test("REPORTS_ID_CARDS_PDF the person's own card and staff batches print as PDF; a missing or unreadable photo still prints", async () => {
  const store = new Store(), reads: string[] = [];
  const photos = { async read(id: string) { reads.push(id); if (id === "holder") throw new Error("storage down"); return null; } };
  const service = new IdCardsService(store, { async isStaff(id: string) { return id === "staff"; } }, () => new Date("2026-11-19T06:00:00Z"), photos);
  const own = await service.ownPdf("holder");
  assert.ok(own?.subarray(0, 5).equals(Buffer.from("%PDF-")));
  assert.ok(own!.toString("latin1").includes("(Alia Badr) Tj"));
  assert.equal(await service.ownPdf("nobody"), undefined);
  assert.deepEqual(await service.staffPdf("person", ["holder"]), { status: "not_found" });
  for (const people of [[], ["holder", "holder"], ["bad id"], Array.from({ length: ID_CARD_BATCH_MAX + 1 }, (_, i) => `p${i}`)])
    assert.deepEqual(await service.staffPdf("staff", people), { status: "invalid" });
  assert.deepEqual(await service.staffPdf("staff", ["holder", "nobody"]), { status: "refused", refusals: [{ personId: "nobody", code: "no_card" }] });
  const batch = await service.staffPdf("staff", ["holder"]);
  assert.equal(batch.status, "ok");
  assert.deepEqual(reads, ["holder", "holder"]);
});

test("REPORTS_ID_CARDS_PDF a staff print batch is taken before authorization", async () => {
  const store = new Store(), people = ["holder"];
  const service = new IdCardsService(store, { async isStaff() { people.push("nobody"); return true; } }, () => new Date("2026-11-19T06:00:00Z"));
  assert.equal((await service.staffPdf("staff", people)).status, "ok");
});

test("REPORTS_ID_CARDS_PDF a batch of 100 at-cap PNG photos is read one at a time and kept at card size", async () => {
  const { deflateSync } = await import("node:zlib");
  // A 1000 x 1000 RGBA photo (the pixel cap), a few KB on disk; the reader does not check CRCs, so they are left zero.
  const chunk = (kind: string, data: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(kind, 4, "latin1"); return Buffer.concat([head, data, Buffer.alloc(4)]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(1000, 0); ihdr.writeUInt32BE(1000, 4); ihdr[8] = 8; ihdr[9] = 6;
  const row = Buffer.alloc(1 + 4000); for (let x = 0; x < 1000; x++) row.set([x & 255, (x * 3) & 255, 90, 255], 1 + x * 4);
  const photo = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(Buffer.concat(Array(1000).fill(row)))), chunk("IEND", Buffer.alloc(0))]);
  const people = Array.from({ length: ID_CARD_BATCH_MAX }, (_, i) => `p-${i}`);
  const store = new Store(); store.card = async () => ({ name: "Alia Badr", arabicName: null, employeeId: null, cardNumber: 7, expiresOn: "2099-01-01", issuedAt: new Date(), placement: null });
  let inFlight = 0, most = 0, reads = 0;
  const photos = { async read() { most = Math.max(most, ++inFlight); reads++; await new Promise(r => setImmediate(r)); inFlight--; return { bytes: photo, mime: "image/png" }; } };
  const service = new IdCardsService(store, { async isStaff(id: string) { return id === "staff"; } }, () => new Date("2026-11-19T12:00:00Z"), photos);
  const before = process.memoryUsage();
  const result = await service.staffPdf("staff", people);
  const after = process.memoryUsage();
  assert.equal(result.status, "ok"); assert.equal(reads, 100); assert.equal(most, 1, "one photo read at a time");
  const pdf = (result as { pdf: Buffer }).pdf.toString("latin1");
  const sizes = [...pdf.matchAll(/\/Subtype \/Image \/Width (\d+) \/Height (\d+)/g)].map(m => [Number(m[1]), Number(m[2])]);
  assert.equal(sizes.length, 100); assert.ok(sizes.every(([w, h]) => w === 320 && h === 320), "every photo is kept at card size, not 1000 x 1000");
  // Each card keeps at most a 320 x 320 RGB photo (300 KB raw), so the batch's retained growth stays far under one full-size decode per card (100 x 4 MB).
  assert.ok(after.heapUsed + after.arrayBuffers - before.heapUsed - before.arrayBuffers < 64 * 1024 * 1024, `retained growth ${(after.heapUsed + after.arrayBuffers - before.heapUsed - before.arrayBuffers) >> 20} MB`);
});

test("REPORTS_ID_CARD_CHECK the public check: valid until the earlier of the printed and current expiry, and only while assigned", async () => {
  const store = new Store(), verifier = new IdCardVerifier(Buffer.alloc(32, 3));
  const service = new IdCardsService(store, { async isStaff() { return false; } }, () => new Date("2026-11-19T06:00:00Z"), undefined, verifier);
  store.verifyRows.set(7, { name: "Alia Badr", company: "Sultan Center", expiresOn: "2027-02-19", assigned: true });
  assert.deepEqual(await service.check(verifier.token(7, "2027-02-19")), { status: "checked", name: "Alia Badr", company: "Sultan Center", validUntil: "2027-02-19", valid: true, reason: null });
  assert.deepEqual(await service.check(verifier.token(7, "2026-11-18")), { status: "checked", name: "Alia Badr", company: "Sultan Center", validUntil: "2026-11-18", valid: false, reason: "expired" },
    "an old print stays expired after a renewal");
  assert.deepEqual(await service.check(verifier.token(7, "2026-11-19")), { status: "checked", name: "Alia Badr", company: "Sultan Center", validUntil: "2026-11-19", valid: true, reason: null }, "valid through the printed day");
  store.verifyRows.set(7, { name: "Alia Badr", company: null, expiresOn: "2026-12-01", assigned: false });
  assert.deepEqual(await service.check(verifier.token(7, "2027-02-19")), { status: "checked", name: "Alia Badr", company: null, validUntil: "2026-12-01", valid: false, reason: "not_assigned" },
    "a card shortened since printing shows the shorter date; a holder who left is not valid");
  assert.deepEqual(await service.check(verifier.token(8, "2027-02-19")), { status: "unknown" }, "no such card");
  assert.deepEqual(await service.check("7.20270219.AAAAAAAAAAAAAAAAAAAAAA"), { status: "unknown" }, "forged");
  assert.deepEqual(await new IdCardsService(store, { async isStaff() { return false; } }).check(verifier.token(7, "2027-02-19")), { status: "unknown" }, "no key configured");
});

test("REPORTS_ID_CARD_CHECK a printed card carries the QR code only when a key and origin are given", async () => {
  const store = new Store(), verifier = new IdCardVerifier(Buffer.alloc(32, 3));
  const service = new IdCardsService(store, { async isStaff() { return false; } }, () => new Date("2026-11-19T06:00:00Z"), undefined, verifier);
  const withQr = (await service.ownPdf("holder", "https://studenthub.co"))!.toString("latin1"), without = (await service.ownPdf("holder"))!.toString("latin1");
  assert.match(withQr, /Scan to check this card/); assert.doesNotMatch(without, /Scan to check this card/);
});
