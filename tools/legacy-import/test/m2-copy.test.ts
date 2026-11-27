import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  copyCounts, copyLegacyDocuments, M2CopyError, selectApproved, stagingKey, stagingPrefix,
  type ApprovedDocument, type CopyBounds, type DocumentStagingStore, type StagedDocument, type StagingObjects,
} from "../src/m2-copy.js";
import { documentSetDigest, type LegacyObjectReader } from "../src/m2-document-check.js";
import type { DocumentSourceRow } from "../src/m2-documents.js";

// Synthetic objects only. "Secret" marks a legacy key that must never be reported or staged.
const crc32 = (bytes: Buffer) => {
  let c = 0xffffffff;
  for (const b of bytes) { c ^= b; for (let i = 0; i < 8; i++) c = (c >>> 1) ^ ((c & 1) ? 0xedb88320 : 0); }
  return (c ^ 0xffffffff) >>> 0;
};
const chunk = (type: string, data: Buffer) => {
  const b = Buffer.alloc(data.length + 12);
  b.writeUInt32BE(data.length); b.write(type, 4); data.copy(b, 8); b.writeUInt32BE(crc32(b.subarray(4, -4)), b.length - 4);
  return b;
};
const png = (color = 0) => {
  const h = Buffer.alloc(13); h.writeUInt32BE(1, 0); h.writeUInt32BE(1, 4); h[8] = 8; h[9] = 2;
  return Buffer.concat([Buffer.from("89504e470d0a1a0a", "hex"), chunk("IHDR", h), chunk("IDAT", deflateSync(Buffer.from([0, color, 0, 0]))), chunk("IEND", Buffer.alloc(0))]);
};
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const GEN = "6f1c2b3a-4d5e-4f60-8a7b-9c0d1e2f3a4b";
const OTHER_GEN = "0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d";
const INV = { doccheck: "11111111-1111-4111-8111-111111111111", copy: "22222222-2222-4222-8222-222222222222" };

const photo1 = png(1), photo2 = png(2), front3 = png(3);
const legacyObjects: Record<string, Buffer> = { "photos/Secret-1.png": photo1, "photos/Secret-2.png": photo2, "photos/Secret-3.png": front3 };
const planned: DocumentSourceRow[] = [
  { legacyId: "1", kind: "personal-photo", keys: ["candidate-profile-photos/Secret-1.png", "photos/Secret-1.png"] },
  { legacyId: "2", kind: "personal-photo", keys: ["photos/Secret-2.png"] },
  { legacyId: "3", kind: "civil-id-front", keys: ["photos/Secret-3.png"] },
  { legacyId: "4", kind: "resume", keys: ["candidate-resume/Secret-missing.pdf"] },
];
const approvedOf = (legacyId: string, kind: ApprovedDocument["kind"], bytes: Buffer): ApprovedDocument =>
  ({ legacyId, kind, mime: "image/png", size: bytes.length, sha256: sha(bytes) });
const report = [approvedOf("1", "personal-photo", photo1), approvedOf("2", "personal-photo", photo2), approvedOf("3", "civil-id-front", front3)];

function world(opts: { legacy?: Record<string, Buffer>; objects?: Map<string, Buffer>; rows?: StagedDocument[]; failInsert?: boolean } = {}) {
  const legacyReads: string[] = [];
  const legacy: LegacyObjectReader = {
    async read(key, max) {
      legacyReads.push(key);
      const o = (opts.legacy ?? legacyObjects)[key];
      if (!o) return { kind: "missing" };
      return o.length > max ? { kind: "tooLarge" } : { kind: "found", bytes: o };
    },
  };
  const bucket = opts.objects ?? new Map<string, Buffer>();
  const puts: string[] = [];
  const objects: StagingObjects = {
    async read(key, max) {
      const o = bucket.get(key);
      if (!o) return { kind: "missing" };
      return o.length > max ? { kind: "tooLarge" } : { kind: "found", bytes: Buffer.from(o) };
    },
    async put(key, bytes) {
      puts.push(key);
      if (bucket.has(key)) return "exists";
      bucket.set(key, Buffer.from(bytes));
      return "written";
    },
    async list(prefix) { return [...bucket.keys()].filter((k) => k.startsWith(prefix)); },
  };
  const rows = new Map((opts.rows ?? []).map((r) => [`${r.legacyId}/${r.kind}/${r.generation}`, r]));
  const inserted: { row: StagedDocument; invocations: typeof INV }[] = [];
  const store: DocumentStagingStore = {
    async get(id, kind, generation) { return rows.get(`${id}/${kind}/${generation}`) ?? null; },
    async insert(row, invocations) {
      if (opts.failInsert) throw new Error("Secret connection detail");
      const k = `${row.legacyId}/${row.kind}/${row.generation}`;
      if (rows.has(k)) return "exists";
      rows.set(k, row); inserted.push({ row, invocations });
      return "inserted";
    },
  };
  return { legacy, legacyReads, objects, bucket, puts, store, rows, inserted };
}
const bounds = (over: Partial<CopyBounds> = {}): CopyBounds => ({ maxDocuments: 100, maxBytes: 1 << 30, maxMs: 60_000, now: () => 0, ...over });

test("the approved subset is the report's rows, each named by the fresh plan, refused whole on any fault", () => {
  const ok = selectApproved(report, planned)!;
  assert.deepEqual(ok.map((s) => [s.approved.legacyId, s.approved.kind, s.source.keys[0]]),
    [["1", "personal-photo", "candidate-profile-photos/Secret-1.png"], ["2", "personal-photo", "photos/Secret-2.png"], ["3", "civil-id-front", "photos/Secret-3.png"]]);
  // A planned document outside the report (4, missing in the doccheck) is simply not selected.
  assert.equal(selectApproved([], planned)!.length, 0);
  for (const bad of [
    [...report, report[0]], // duplicate
    [{ ...report[0], kind: "video" }], // unknown kind
    [{ ...report[0], legacyId: "01" }], // malformed id
    [{ ...report[0], legacyId: "9" }], // not in the plan
    [{ ...report[0], kind: "resume" }], // the plan has no CV for 1
    [{ ...report[0], sha256: "A".repeat(64) }],
    [{ ...report[0], size: 0 }],
    [{ ...report[0], size: 11 * 1024 * 1024 }],
    [{ ...report[0], mime: "image/gif" }],
    [null], "not an array",
  ]) assert.equal(selectApproved(bad, planned), null, JSON.stringify(bad).slice(0, 60));
});

test("a first copy stages each approved document under its generation key, read back, recorded once, keys never stored", async () => {
  const w = world();
  const r = await copyLegacyDocuments(selectApproved(report, planned)!, w.legacy, w.objects, w.store, GEN, INV, bounds());
  assert.deepEqual(r.outcomes.map((o) => o.rule), ["staged", "staged", "staged"]);
  assert.equal(r.complete, true);
  assert.deepEqual(r.orphans, []);
  assert.equal(documentSetDigest(r.verified), documentSetDigest(report), "the staged set is the accepted set");
  assert.deepEqual([...w.bucket.keys()].sort(), report.map((d) => stagingKey(GEN, d.legacyId, d.kind, d.sha256)).sort());
  assert.ok([...w.bucket.keys()].every((k) => k.startsWith(`legacy-import/${GEN}/`) && !k.includes("Secret")));
  assert.deepEqual(w.inserted.map((i) => i.invocations), [INV, INV, INV]);
  assert.ok(!JSON.stringify(r).includes("Secret"));
  // A retry finds every row and object verified, and reads nothing from legacy.
  const again = world({ objects: w.bucket, rows: [...w.rows.values()] });
  const r2 = await copyLegacyDocuments(selectApproved(report, planned)!, again.legacy, again.objects, again.store, GEN, INV, bounds());
  assert.deepEqual(r2.outcomes.map((o) => o.rule), ["unchanged", "unchanged", "unchanged"]);
  assert.deepEqual([again.legacyReads, again.puts], [[], []]);
  assert.equal(documentSetDigest(r2.verified), documentSetDigest(report));
});

test("changed, missing or inadmissible legacy bytes are counted and nothing is staged for them", async () => {
  const w = world({ legacy: { "photos/Secret-1.png": photo2, "photos/Secret-3.png": Buffer.from("not a png") } });
  const r = await copyLegacyDocuments(selectApproved(report, planned)!, w.legacy, w.objects, w.store, GEN, INV, bounds());
  assert.deepEqual(r.outcomes.map((o) => o.rule), ["document.changed", "document.missing", "document.admission"]);
  assert.deepEqual([w.bucket.size, w.inserted.length, r.verified.length], [0, 0, 0]);
  assert.notEqual(documentSetDigest(r.verified), documentSetDigest(report));
  assert.deepEqual(copyCounts(r)["document.changed"], 1);
});

test("an existing row is unchanged only when its object reads back; a missing or altered object is a mismatch, never rewritten", async () => {
  const first = world();
  await copyLegacyDocuments(selectApproved(report, planned)!, first.legacy, first.objects, first.store, GEN, INV, bounds());
  const k1 = stagingKey(GEN, "1", "personal-photo", sha(photo1)), k2 = stagingKey(GEN, "2", "personal-photo", sha(photo2));
  first.bucket.delete(k1);
  first.bucket.set(k2, photo1);
  const w = world({ objects: first.bucket, rows: [...first.rows.values()] });
  const r = await copyLegacyDocuments(selectApproved(report, planned)!, w.legacy, w.objects, w.store, GEN, INV, bounds());
  assert.deepEqual(r.outcomes.map((o) => o.rule), ["objectMismatch", "objectMismatch", "unchanged"]);
  assert.deepEqual([w.puts, w.inserted.length], [[], 0], "nothing is rewritten or re-recorded");
  assert.equal(w.bucket.has(k1), false);
  assert.ok(w.bucket.get(k2)!.equals(photo1), "the altered object is left as found");
  // A row of this generation with other bytes is a conflict.
  const conflicted = world({ rows: [{ ...report[0]!, sha256: sha(photo2), generation: GEN, objectKey: stagingKey(GEN, "1", "personal-photo", sha(photo2)) }] });
  const c = await copyLegacyDocuments(selectApproved([report[0]], planned)!, conflicted.legacy, conflicted.objects, conflicted.store, GEN, INV, bounds());
  assert.deepEqual(c.outcomes.map((o) => o.rule), ["conflict"]);
});

test("rows and objects of another generation count for nothing: this generation stages its own", async () => {
  const old = world();
  await copyLegacyDocuments(selectApproved(report, planned)!, old.legacy, old.objects, old.store, OTHER_GEN, INV, bounds());
  const w = world({ objects: old.bucket, rows: [...old.rows.values()] });
  const r = await copyLegacyDocuments(selectApproved(report, planned)!, w.legacy, w.objects, w.store, GEN, INV, bounds());
  assert.deepEqual(r.outcomes.map((o) => o.rule), ["staged", "staged", "staged"]);
  assert.equal(w.rows.size, 6, "the older generation's rows stay");
  assert.equal(w.bucket.size, 6);
  assert.deepEqual(r.orphans, [], "another generation's objects are not this generation's orphans");
});

test("an object written before a crash is adopted when it reads back to the approved bytes; an orphan is listed, never deleted", async () => {
  const crashed = world({ failInsert: true });
  await assert.rejects(copyLegacyDocuments(selectApproved(report, planned)!, crashed.legacy, crashed.objects, crashed.store, GEN, INV, bounds()),
    (e: unknown) => e instanceof M2CopyError && e.code === "m2.copy.staging" && !String(e).includes("Secret"));
  assert.equal(crashed.bucket.size, 1, "the object was written, its row was not");
  const stray = `${stagingPrefix(GEN)}9/resume/${"0".repeat(64)}`;
  crashed.bucket.set(stray, Buffer.from("x"));
  const w = world({ objects: crashed.bucket });
  const r = await copyLegacyDocuments(selectApproved(report, planned)!, w.legacy, w.objects, w.store, GEN, INV, bounds());
  assert.deepEqual(r.outcomes.map((o) => o.rule), ["adopted", "staged", "staged"]);
  assert.deepEqual(r.orphans, [stray]);
  assert.ok(w.bucket.has(stray));
  assert.equal(documentSetDigest(r.verified), documentSetDigest(report));
  // An interrupted object that does not read back to the approved bytes is a mismatch, and gets no row.
  const bad = new Map([[stagingKey(GEN, "1", "personal-photo", sha(photo1)), photo2]]);
  const b = world({ objects: bad });
  const rb = await copyLegacyDocuments(selectApproved([report[0]], planned)!, b.legacy, b.objects, b.store, GEN, INV, bounds());
  assert.deepEqual([rb.outcomes.map((o) => o.rule), b.inserted.length], [["objectMismatch"], 0]);
});

test("the run stops between documents at its bounds and says it is incomplete; a retry finishes it", async () => {
  const sel = selectApproved(report, planned)!;
  for (const over of [{ maxDocuments: 2 }, { maxBytes: report[0]!.size + report[1]!.size }]) {
    const w = world();
    const r = await copyLegacyDocuments(sel, w.legacy, w.objects, w.store, GEN, INV, bounds(over));
    assert.deepEqual([r.outcomes.length, r.complete, r.orphans], [2, false, []], JSON.stringify(over));
    const retry = world({ objects: w.bucket, rows: [...w.rows.values()] });
    const r2 = await copyLegacyDocuments(sel, retry.legacy, retry.objects, retry.store, GEN, INV, bounds());
    assert.deepEqual([r2.outcomes.map((o) => o.rule), r2.complete], [["unchanged", "unchanged", "staged"], true]);
  }
  let t = 0;
  const w = world();
  const r = await copyLegacyDocuments(sel, w.legacy, w.objects, w.store, GEN, INV, bounds({ maxMs: 10, now: () => (t += 6) }));
  assert.deepEqual([r.outcomes.length, r.complete], [1, false]);
});

test("staging keys are content-addressed per generation and refuse anything else", () => {
  assert.equal(stagingKey(GEN, "12", "resume", "a".repeat(64)), `legacy-import/${GEN}/12/resume/${"a".repeat(64)}`);
  for (const args of [["not-a-uuid", "1", "resume", "a".repeat(64)], [GEN, "0", "resume", "a".repeat(64)], [GEN, "1", "video", "a".repeat(64)], [GEN, "1", "resume", "../x"]] as const)
    assert.throws(() => stagingKey(args[0], args[1], args[2] as "resume", args[3]));
});
