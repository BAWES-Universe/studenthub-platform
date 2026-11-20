import assert from "node:assert/strict";
import test from "node:test";
import { CertificatesService, experienceCertificatePdf, type CertificateFacts, type CertificatesStore, type WorkHistoryRow } from "../src/index.js";

const A = "11111111-1111-4111-8111-111111111111", B = "22222222-2222-4222-8222-222222222222", C = "33333333-3333-4333-8333-333333333333", D = "44444444-4444-4444-8444-444444444444";
const ROWS: Record<string, CertificateFacts> = {
  [A]: { assignmentId: A, personId: "alia", name: "Alia Badr", company: "Sultan Center", store: "Avenues", startDate: "2026-03-01", endDate: null },
  [B]: { assignmentId: B, personId: "alia", name: "Alia Badr", company: "Alshaya", store: "Marina", startDate: "2025-01-10", endDate: "2025-06-30" },
  [C]: { assignmentId: C, personId: "alia", name: "Alia Badr", company: "Sultan Center", store: "Kuwait City", startDate: "2026-12-01", endDate: null },
  [D]: { assignmentId: D, personId: "omar", name: "Omar", company: "X", store: "Y", startDate: "2026-01-01", endDate: "2027-01-01" },
};
class Store implements CertificatesStore {
  reads: string[] = [];
  async workHistory(personId: string, today: string) {
    const rows = Object.values(ROWS).filter(r => r.personId === personId && r.startDate <= today).map(({ personId: _p, name: _n, ...r }): WorkHistoryRow => r);
    return personId === "alia" || personId === "omar" ? { name: personId === "alia" ? "Alia Badr" : "Omar", rows } : undefined;
  }
  async assignment(id: string) { this.reads.push(id); return ROWS[id]; }
}
const service = (store = new Store()) => new CertificatesService(store, { async isStaff(id: string) { return id === "staff"; } }, () => new Date("2026-11-20T06:00:00Z"));
/** The page's text operators, decoded. */
const text = (pdf: Buffer) => { const s = pdf.toString("latin1"); return [...s.matchAll(/\((.*?)\) Tj/g)].map(m => m[1]).join(" | "); };

test("REPORTS_CERTIFICATES the person sees their own started assignments; running ones are dated to today", async () => {
  const own = await service().own("alia");
  assert.deepEqual(own.rows.map(r => [r.assignmentId, r.until, r.ongoing]), [[A, "2026-11-20", true], [B, "2025-06-30", false]], "the one starting in December has no certificate yet");
  assert.deepEqual((await service().own("nobody")).rows, []);
  const omar = await service().own("omar");
  assert.deepEqual(omar.rows.map(r => [r.until, r.ongoing]), [["2026-11-20", true]], "an end date still ahead counts as running");
});

test("REPORTS_CERTIFICATES a PDF for the person's own assignment, or anyone's for staff; the same nothing otherwise", async () => {
  const s = service();
  const pdf = await s.pdf("alia", A);
  assert.ok(pdf?.subarray(0, 5).equals(Buffer.from("%PDF-")));
  const words = text(pdf!);
  for (const w of ["Certificate of Appreciation", "Awarded to", "Alia Badr", "IN RECOGNITION OF WORKING FOR", "Sultan Center", "Avenues", "From 1 March 2026 to 20 November 2026", "Khalid Almutawa", "CEO - StudentHub"])
    assert.ok(words.includes(w), w);
  assert.match(text((await s.pdf("alia", B))!), /From 10 January 2025 to 30 June 2025/);
  assert.equal(await s.pdf("omar", A), undefined, "someone else's");
  assert.equal(await s.pdf("alia", C), undefined, "not started");
  assert.equal(await s.pdf("alia", "55555555-5555-4555-8555-555555555555"), undefined, "no such assignment");
  assert.equal(await s.pdf("alia", "not-a-uuid"), undefined);
  assert.ok(await s.pdf("staff", A), "staff print anyone's");
  assert.ok(await s.pdf("staff", D));
  assert.equal(await s.pdf("staff", C), undefined, "not even staff print one that has not started");
});

test("REPORTS_CERTIFICATES only staff list someone else's assignments", async () => {
  const store = new Store(), s = service(store);
  assert.equal(await s.staffList("alia", "omar"), undefined);
  assert.equal(await s.staffList("omar", "omar"), undefined, "not even their own through the staff list");
  assert.deepEqual((await s.staffList("staff", "alia"))?.rows.map(r => r.assignmentId), [A, B]);
  assert.equal(await s.staffList("staff", "nobody"), undefined);
  assert.equal(await s.staffList("staff", "bad id!"), undefined);
});

test("REPORTS_CERTIFICATES the name prints in Latin letters; one in Arabic only leaves the name line out", () => {
  const words = text(experienceCertificatePdf({ name: "Alia علياء Badr", company: "Sultan Center", store: "Avenues", from: "2026-01-01", to: "2026-02-01" }));
  assert.ok(words.includes("Alia Badr"));
  const arabic = text(experienceCertificatePdf({ name: "علياء", company: "Sultan Center", store: "Avenues", from: "2026-01-01", to: "2026-02-01" }));
  assert.ok(arabic.includes("Awarded to") && arabic.includes("Sultan Center"));
  assert.ok(!/\| \|/.test(arabic));
});
