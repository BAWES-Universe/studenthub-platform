import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  copyCounts, copyLegacyDocuments, M2CopyError, selectApproved, stagingKey, stagingPrefix,
  type ApprovedDocument, type CopyBounds, type CopyContinuation, type CopyRun, type DocumentStagingStore, type StagedDocument, type StagingObjects,
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
  const puts: string[] = [], lists: string[] = [];
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
    async list(prefix, page) {
      lists.push(page.after ?? "");
      const keys = [...bucket.keys()].filter((k) => k.startsWith(prefix) && (page.after === undefined || k > page.after)).sort();
      return keys.length > page.limit ? { keys: keys.slice(0, page.limit), next: keys[page.limit - 1]! } : { keys };
    },
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
  return { legacy, legacyReads, objects, bucket, puts, lists, store, rows, inserted };
}
const bounds = (over: Partial<CopyBounds> = {}): CopyBounds =>
  ({ maxDocuments: 100, maxBytes: 1 << 30, maxObjectBytes: 10 * 1024 * 1024, maxMs: 60_000, opTimeoutMs: 1_000, maxListPages: 10, listPageSize: 100, now: () => 0, ...over });
const BUILD = "b".repeat(64);
const run = (generation = GEN, build = BUILD): CopyRun => ({ generation, build, invocations: INV });

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
  const r = await copyLegacyDocuments(selectApproved(report, planned)!, w, run(GEN), bounds());
  assert.deepEqual(r.outcomes.map((o) => o.rule), ["staged", "staged", "staged"]);
  assert.equal(r.complete, true);
  assert.deepEqual([r.orphans.scanned, r.orphans.truncated, r.orphans.count], [true, false, 0]);
  assert.equal(documentSetDigest(r.verified), documentSetDigest(report), "the staged set is the accepted set");
  assert.deepEqual([...w.bucket.keys()].sort(), report.map((d) => stagingKey(GEN, d.legacyId, d.kind, d.sha256)).sort());
  assert.ok([...w.bucket.keys()].every((k) => k.startsWith(`legacy-import/${GEN}/`) && !k.includes("Secret")));
  assert.deepEqual(w.inserted.map((i) => i.invocations), [INV, INV, INV]);
  assert.ok(!JSON.stringify(r).includes("Secret"));
  // A retry finds every row and object verified, and reads nothing from legacy.
  const again = world({ objects: w.bucket, rows: [...w.rows.values()] });
  const r2 = await copyLegacyDocuments(selectApproved(report, planned)!, again, run(GEN), bounds());
  assert.deepEqual(r2.outcomes.map((o) => o.rule), ["unchanged", "unchanged", "unchanged"]);
  assert.deepEqual([again.legacyReads, again.puts], [[], []]);
  assert.equal(documentSetDigest(r2.verified), documentSetDigest(report));
});

test("changed, missing or inadmissible legacy bytes are counted and nothing is staged for them", async () => {
  const w = world({ legacy: { "photos/Secret-1.png": photo2, "photos/Secret-3.png": Buffer.from("not a png") } });
  const r = await copyLegacyDocuments(selectApproved(report, planned)!, w, run(GEN), bounds());
  assert.deepEqual(r.outcomes.map((o) => o.rule), ["document.changed", "document.missing", "document.admission"]);
  assert.deepEqual([w.bucket.size, w.inserted.length, r.verified.length], [0, 0, 0]);
  assert.notEqual(documentSetDigest(r.verified), documentSetDigest(report));
  assert.deepEqual(copyCounts(r)["document.changed"], 1);
});

test("an existing row is unchanged only when its object reads back; a missing or altered object is a mismatch, never rewritten", async () => {
  const first = world();
  await copyLegacyDocuments(selectApproved(report, planned)!, first, run(GEN), bounds());
  const k1 = stagingKey(GEN, "1", "personal-photo", sha(photo1)), k2 = stagingKey(GEN, "2", "personal-photo", sha(photo2));
  first.bucket.delete(k1);
  first.bucket.set(k2, photo1);
  const w = world({ objects: first.bucket, rows: [...first.rows.values()] });
  const r = await copyLegacyDocuments(selectApproved(report, planned)!, w, run(GEN), bounds());
  assert.deepEqual(r.outcomes.map((o) => o.rule), ["objectMismatch", "objectMismatch", "unchanged"]);
  assert.deepEqual([w.puts, w.inserted.length], [[], 0], "nothing is rewritten or re-recorded");
  assert.equal(w.bucket.has(k1), false);
  assert.ok(w.bucket.get(k2)!.equals(photo1), "the altered object is left as found");
  // A row of this generation with other bytes is a conflict.
  const conflicted = world({ rows: [{ ...report[0]!, sha256: sha(photo2), generation: GEN, objectKey: stagingKey(GEN, "1", "personal-photo", sha(photo2)) }] });
  const c = await copyLegacyDocuments(selectApproved([report[0]], planned)!, conflicted, run(GEN), bounds());
  assert.deepEqual(c.outcomes.map((o) => o.rule), ["conflict"]);
});

test("rows and objects of another generation count for nothing: this generation stages its own", async () => {
  const old = world();
  await copyLegacyDocuments(selectApproved(report, planned)!, old, run(OTHER_GEN), bounds());
  const w = world({ objects: old.bucket, rows: [...old.rows.values()] });
  const r = await copyLegacyDocuments(selectApproved(report, planned)!, w, run(GEN), bounds());
  assert.deepEqual(r.outcomes.map((o) => o.rule), ["staged", "staged", "staged"]);
  assert.equal(w.rows.size, 6, "the older generation's rows stay");
  assert.equal(w.bucket.size, 6);
  assert.equal(r.orphans.count, 0, "another generation's objects are not this generation's orphans");
});

test("an object written before a crash is adopted when it reads back to the approved bytes; an orphan is listed, never deleted", async () => {
  const crashed = world({ failInsert: true });
  await assert.rejects(copyLegacyDocuments(selectApproved(report, planned)!, crashed, run(GEN), bounds()),
    (e: unknown) => e instanceof M2CopyError && e.code === "m2.copy.staging" && !String(e).includes("Secret"));
  assert.equal(crashed.bucket.size, 1, "the object was written, its row was not");
  const stray = `${stagingPrefix(GEN)}9/resume/${"0".repeat(64)}`;
  crashed.bucket.set(stray, Buffer.from("x"));
  const w = world({ objects: crashed.bucket });
  const r = await copyLegacyDocuments(selectApproved(report, planned)!, w, run(GEN), bounds());
  assert.deepEqual(r.outcomes.map((o) => o.rule), ["adopted", "staged", "staged"]);
  assert.deepEqual(r.orphans, { scanned: true, truncated: false, count: 1, tuples: [{ legacyId: "9", kind: "resume" }], unparsed: 0 });
  assert.ok(!JSON.stringify(r).includes("0".repeat(64)) && !JSON.stringify(r).includes("legacy-import/"), "no key in the result");
  assert.ok(w.bucket.has(stray));
  assert.equal(documentSetDigest(r.verified), documentSetDigest(report));
  // An interrupted object that does not read back to the approved bytes is a mismatch, and gets no row.
  const bad = new Map([[stagingKey(GEN, "1", "personal-photo", sha(photo1)), photo2]]);
  const b = world({ objects: bad });
  const rb = await copyLegacyDocuments(selectApproved([report[0]], planned)!, b, run(GEN), bounds());
  assert.deepEqual([rb.outcomes.map((o) => o.rule), b.inserted.length], [["objectMismatch"], 0]);
});

test("every bound is enforced as written; a run stops between documents and a continuation finishes the chain", async () => {
  const sel = selectApproved(report, planned)!;
  const [s0, s1, s2] = report.map((d) => d.size) as [number, number, number];
  const cap = Math.max(s0, s1, s2);
  for (const over of [{ maxDocuments: 2 }, { maxBytes: s0 + s1 + s2 - 1 }]) {
    const w = world();
    const r = await copyLegacyDocuments(sel, w, run(), bounds({ ...over, maxObjectBytes: cap }));
    assert.deepEqual([r.outcomes.length, r.complete], [2, false], JSON.stringify(over));
    assert.ok(r.bytes <= bounds(over).maxBytes, "the byte bound is never exceeded");
    assert.deepEqual([r.orphans.scanned, r.continuation.next], [false, r.outcomes.length]);
    const r2 = await copyLegacyDocuments(sel, w, run(), bounds({ ...over, maxObjectBytes: cap }), r.continuation);
    assert.deepEqual(r2.outcomes.map((o) => o.index), [2], "the next run starts after the handled prefix");
    assert.equal(r2.complete, true);
    assert.equal(documentSetDigest(r2.verified), documentSetDigest(report), "the chain verified every approved document");
    assert.deepEqual(copyCounts(r2).staged, 3);
  }
});

test("a verified prefix that uses up the time budget does not livelock: each run handles one more and the chain ends", async () => {
  const sel = selectApproved(report, planned)!;
  const done = world();
  await copyLegacyDocuments(sel, done, run(), bounds());
  // Every validation read takes longer than the whole run's budget.
  let t = 0;
  const slow = world({ objects: done.bucket, rows: [...done.rows.values()] });
  const reads = slow.objects.read.bind(slow.objects);
  slow.objects.read = async (k, m) => { t += 100; return reads(k, m); };
  const tight = bounds({ maxMs: 50, now: () => t });
  // Without a continuation every run would start at row one again and validate the same prefix.
  const fresh = await copyLegacyDocuments(sel, slow, run(), tight);
  const again = await copyLegacyDocuments(sel, slow, run(), tight);
  assert.deepEqual([fresh.outcomes.map((o) => o.index), again.outcomes.map((o) => o.index)], [[0], [0]]);
  // With it, the chain moves one document per run and ends after selection.length runs.
  let c = fresh.continuation, runs = 1, last = fresh;
  while (!last.complete) { last = await copyLegacyDocuments(sel, slow, run(), tight, c); c = last.continuation; runs++; assert.ok(runs <= sel.length); }
  assert.equal(runs, sel.length);
  assert.deepEqual(copyCounts(last).unchanged, 3);
  assert.equal(documentSetDigest(last.verified), documentSetDigest(report));
});

test("a continuation is refused unless it belongs to the same generation, build and accepted set and adds up", async () => {
  const sel = selectApproved(report, planned)!;
  const w = world();
  const r = await copyLegacyDocuments(sel, w, run(), bounds({ maxDocuments: 1 }));
  const c = r.continuation;
  const refusals = [
    () => copyLegacyDocuments(sel, w, run(OTHER_GEN), bounds(), c),
    () => copyLegacyDocuments(sel, w, run(GEN, "c".repeat(64)), bounds(), c),
    () => copyLegacyDocuments(selectApproved(report.slice(0, 2), planned)!, w, run(), bounds(), c),
    () => copyLegacyDocuments(sel, w, run(), bounds(), { ...c, next: 2 }),
    () => copyLegacyDocuments(sel, w, run(), bounds(), { ...c, next: 4 }),
    () => copyLegacyDocuments(sel, w, run(), bounds(), { ...c, bytes: c.bytes + 1 }),
    () => copyLegacyDocuments(sel, w, run(), bounds(), { ...c, unverified: [0] }),
    () => copyLegacyDocuments(sel, w, run(), bounds(), { ...c, rules: { ...c.rules, staged: 0, conflict: 1 } }),
    () => copyLegacyDocuments(sel, w, run(), bounds(), { ...c, version: "v0" } as unknown as CopyContinuation),
  ];
  for (const [i, attempt] of refusals.entries())
    await assert.rejects(attempt(), (e: unknown) => e instanceof M2CopyError && e.code === "m2.copy.continuation", String(i));
  for (const bad of [{ maxObjectBytes: (1 << 30) + 1 }, { maxDocuments: 0 }, { opTimeoutMs: 0 }, { listPageSize: 1.5 }])
    await assert.rejects(copyLegacyDocuments(sel, w, run(), bounds(bad)), (e: unknown) => e instanceof M2CopyError && e.code === "m2.copy.bounds");
  await assert.rejects(copyLegacyDocuments(sel, w, run(GEN, "not-hex"), bounds()), (e: unknown) => e instanceof M2CopyError && e.code === "m2.copy.bounds");
});

test("a document above the hard object cap is never read or written, even first in a run", async () => {
  const sel = selectApproved(report, planned)!;
  const w = world();
  const cap = Math.min(...report.map((d) => d.size)) - 1;
  const r = await copyLegacyDocuments(sel, w, run(), bounds({ maxObjectBytes: cap, maxBytes: cap }));
  assert.deepEqual(r.outcomes.map((o) => o.rule), ["overCap", "overCap", "overCap"]);
  assert.deepEqual([w.legacyReads, w.puts, w.inserted.length, r.bytes, r.verified.length], [[], [], 0, 0, 0]);
  assert.equal(r.complete, true, "handled, and counted as not verified");
  assert.deepEqual(r.continuation.unverified, [0, 1, 2]);
});

test("a hanging port call times out with a fixed code; a hanging legacy read is a failed read of that document", async () => {
  const sel = selectApproved([report[0]], planned)!;
  const hang = () => new Promise<never>(() => {});
  const stuck = world();
  stuck.store.get = hang;
  await assert.rejects(copyLegacyDocuments(sel, stuck, run(), bounds({ opTimeoutMs: 5 })),
    (e: unknown) => e instanceof M2CopyError && e.code === "m2.copy.timeout");
  const slowLegacy = world();
  slowLegacy.legacy.read = hang;
  const r = await copyLegacyDocuments(sel, slowLegacy, run(), bounds({ opTimeoutMs: 5 }));
  assert.deepEqual(r.outcomes.map((o) => o.rule), ["document.readFailed"]);
  const stuckList = world();
  stuckList.objects.list = hang;
  await assert.rejects(copyLegacyDocuments(sel, stuckList, run(), bounds({ opTimeoutMs: 5 })),
    (e: unknown) => e instanceof M2CopyError && e.code === "m2.copy.timeout");
});

test("the orphan scan reads page by page within its bound, says when it was truncated, and reports tuples and counts only", async () => {
  const sel = selectApproved(report, planned)!;
  const objects = new Map<string, Buffer>();
  for (let i = 10; i < 15; i++) objects.set(`${stagingPrefix(GEN)}${i}/resume/${String(i % 10).repeat(64)}`, Buffer.from("x"));
  objects.set(`${stagingPrefix(GEN)}Secret-name.pdf`, Buffer.from("x"));
  const w = world({ objects });
  const r = await copyLegacyDocuments(sel, w, run(), bounds({ listPageSize: 2 }));
  assert.deepEqual([r.orphans.scanned, r.orphans.truncated, r.orphans.count, r.orphans.unparsed], [true, false, 6, 1]);
  assert.deepEqual(r.orphans.tuples.map((t) => t.legacyId), ["10", "11", "12", "13", "14"]);
  assert.equal(w.lists.length, 5, "9 keys, 2 per page");
  assert.ok(!JSON.stringify(r).includes("Secret") && !JSON.stringify(r).includes("legacy-import/"));
  const t = world({ objects: w.bucket, rows: [...w.rows.values()] });
  const truncated = await copyLegacyDocuments(sel, t, run(), bounds({ listPageSize: 2, maxListPages: 2 }));
  assert.deepEqual([truncated.complete, truncated.orphans.truncated, t.lists.length], [true, true, 2]);
  // A page that breaks the contract (too many keys, out of order or outside the prefix) is a staging fault.
  for (const page of [{ keys: ["a", "b", "c"] }, { keys: [`${stagingPrefix(OTHER_GEN)}1/resume/${"a".repeat(64)}`] }, { keys: [`${stagingPrefix(GEN)}b`, `${stagingPrefix(GEN)}a`] }]) {
    const bad = world({ objects: w.bucket, rows: [...w.rows.values()] });
    bad.objects.list = async () => page;
    await assert.rejects(copyLegacyDocuments(sel, bad, run(), bounds({ listPageSize: 2 })), (e: unknown) => e instanceof M2CopyError && e.code === "m2.copy.staging");
  }
});

test("staging keys are content-addressed per generation and refuse anything else", () => {
  assert.equal(stagingKey(GEN, "12", "resume", "a".repeat(64)), `legacy-import/${GEN}/12/resume/${"a".repeat(64)}`);
  for (const args of [["not-a-uuid", "1", "resume", "a".repeat(64)], [GEN, "0", "resume", "a".repeat(64)], [GEN, "1", "video", "a".repeat(64)], [GEN, "1", "resume", "../x"]] as const)
    assert.throws(() => stagingKey(args[0], args[1], args[2] as "resume", args[3]));
});
