import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deflateSync } from "node:zlib";

import {
  copyCounts, copyLegacyDocuments, M2CopyError, selectApproved, stagingKey, stagingPrefix,
  type ApprovedDocument, type CheckpointKey, type CopyBounds, type CopyCheckpointStore, type CopyRun, type DocumentStagingStore, type StagedDocument, type StagingObjects,
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

type Saved = Map<string, { revision: number; checkpoint: unknown }>;
function world(opts: { legacy?: Record<string, Buffer>; objects?: Map<string, Buffer>; rows?: StagedDocument[]; failInsert?: boolean; saved?: Saved } = {}) {
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
  const saved: Saved = opts.saved ?? new Map();
  const loads: string[] = [];
  const checkpoints: CopyCheckpointStore = {
    async load(key) { loads.push(JSON.stringify(key)); return saved.get(JSON.stringify(key)) ?? null; },
    async save(checkpoint, expected) {
      const k = JSON.stringify(checkpoint.key), now = saved.get(k);
      if ((now?.revision ?? null) !== expected) return "stale";
      saved.set(k, { revision: (expected ?? 0) + 1, checkpoint: JSON.parse(JSON.stringify(checkpoint)) });
      return "saved";
    },
  };
  return { legacy, legacyReads, objects, bucket, puts, lists, store, rows, inserted, checkpoints, saved, loads };
}
const bounds = (over: Partial<CopyBounds> = {}): CopyBounds =>
  ({ maxDocuments: 100, maxApprovedBytes: 1 << 30, maxObjectBytes: 10 * 1024 * 1024, maxMs: 60_000, opTimeoutMs: 1_000, settleMs: 50, maxListPages: 10, listPageSize: 100, now: () => 0, ...over });
const BUILD = "b".repeat(64);
const TARGET = { id: "33333333-3333-4333-8333-333333333333", bucket: "sh-staging-legacy-docs" };
const run = (generation = GEN, build = BUILD, target = TARGET, copy = INV.copy): CopyRun => ({ generation, build, target, invocations: { ...INV, copy } });

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

test("every bound is enforced as written; a run stops between documents and the next resumes from the saved checkpoint", async () => {
  const sel = selectApproved(report, planned)!;
  const [s0, s1, s2] = report.map((d) => d.size) as [number, number, number];
  const cap = Math.max(s0, s1, s2);
  for (const over of [{ maxDocuments: 2 }, { maxApprovedBytes: s0 + s1 + s2 - 1 }]) {
    const w = world();
    const r = await copyLegacyDocuments(sel, w, run(), bounds({ ...over, maxObjectBytes: cap }));
    assert.deepEqual([r.outcomes.length, r.complete, r.checkpoint], [2, false, { credit: "none", from: 0, next: 2 }], JSON.stringify(over));
    assert.ok(r.approvedBytes <= bounds(over).maxApprovedBytes, "the byte budget is never exceeded");
    assert.equal(r.orphans.scanned, false);
    // A new process: only what is persisted (bucket, rows, checkpoint) carries over.
    const next = world({ objects: w.bucket, rows: [...w.rows.values()], saved: w.saved });
    const r2 = await copyLegacyDocuments(sel, next, run(GEN, BUILD, TARGET, "44444444-4444-4444-8444-444444444444"), bounds({ ...over, maxObjectBytes: cap }));
    assert.deepEqual([r2.outcomes.map((o) => o.index), r2.checkpoint, r2.complete], [[2], { credit: "resumed", from: 2, next: 3 }, true]);
    assert.deepEqual(next.legacyReads, ["photos/Secret-3.png"], "the credited prefix is not read again");
    assert.equal(documentSetDigest(r2.verified), documentSetDigest(report), "the chain verified every approved document");
    assert.equal(copyCounts(r2).staged, 3);
  }
});

test("a verified prefix that uses up the time budget does not livelock once the checkpoint carries it", async () => {
  const sel = selectApproved(report, planned)!;
  const done = world();
  await copyLegacyDocuments(sel, done, run(), bounds());
  let t = 0;
  const slow = (saved?: Saved) => {
    const w = world({ objects: done.bucket, rows: [...done.rows.values()], ...(saved ? { saved } : {}) });
    const reads = w.objects.read.bind(w.objects);
    w.objects.read = async (k, m, signal) => { t += 100; return reads(k, m, signal); };
    return w;
  };
  const tight = bounds({ maxMs: 50, now: () => t });
  // Without a checkpoint every run starts again at the first document.
  const a = await copyLegacyDocuments(sel, slow(), run(), tight), b = await copyLegacyDocuments(sel, slow(), run(), tight);
  assert.deepEqual([a.outcomes.map((o) => o.index), b.outcomes.map((o) => o.index)], [[0], [0]]);
  // With the saved checkpoint the chain moves one document per run and ends after selection.length runs.
  const saved: Saved = new Map();
  let runs = 0, last;
  do { last = await copyLegacyDocuments(sel, slow(saved), run(), tight); runs++; assert.ok(runs <= sel.length); } while (!last.complete);
  assert.equal(runs, sel.length);
  assert.equal(copyCounts(last).unchanged, 3);
  assert.equal(documentSetDigest(last.verified), documentSetDigest(report));
});

test("a missing, untrusted or foreign checkpoint grants no credit; the run validates from the first document", async () => {
  const sel = selectApproved(report, planned)!;
  const first = world();
  const r = await copyLegacyDocuments(sel, first, run(), bounds({ maxDocuments: 2 }));
  assert.equal(r.checkpoint.credit, "none");
  const [[savedKey, good]] = [...first.saved.entries()] as [[string, { revision: number; checkpoint: any }]];
  const fresh = (checkpoint: unknown, target = TARGET, build = BUILD, order = sel) => {
    const w = world({ objects: first.bucket, rows: [...first.rows.values()], saved: new Map([[savedKey, { revision: good.revision, checkpoint }]]) });
    return { w, done: copyLegacyDocuments(order, w, run(GEN, build, target), bounds()) };
  };
  const clone = () => JSON.parse(JSON.stringify(good.checkpoint));
  const tamper = (edit: (c: any) => void) => { const c = clone(); edit(c); return c; };
  for (const [label, checkpoint] of [
    ["sha", tamper((c) => { c.entries[0].binding.sha256 = "0".repeat(64); })],
    ["objectKey", tamper((c) => { c.entries[0].binding.objectKey = stagingKey(OTHER_GEN, "1", "personal-photo", sha(photo1)); })],
    ["index", tamper((c) => { c.entries[1].index = 5; })],
    ["order", tamper((c) => { c.entries.reverse(); })],
    ["invocation", tamper((c) => { c.entries[0].invocation = "someone"; })],
    ["version", tamper((c) => { c.version = "v0"; })],
    ["embedded key", tamper((c) => { c.key.targetId = "55555555-5555-4555-8555-555555555555"; })],
    ["extra key field", tamper((c) => { c.key.extra = 1; })],
    ["unverified with binding", tamper((c) => { c.entries[0].rule = "conflict"; })],
    ["too many", tamper((c) => { c.entries.push(c.entries[0], c.entries[1]); })],
    ["not an object", "Secret"],
  ] as const) {
    const { w, done } = fresh(checkpoint);
    const res = await done;
    assert.deepEqual([res.checkpoint.credit, res.checkpoint.from, res.outcomes.length, res.complete], ["untrusted", 0, 3, true], label);
    assert.equal(w.saved.get(savedKey)!.revision, good.revision + 3, `${label}: replaced, never trusted`);
  }
  // Another target, bucket or build looks under another key: nothing there, no credit.
  for (const [target, build] of [[{ ...TARGET, id: "55555555-5555-4555-8555-555555555555" }, BUILD], [{ ...TARGET, bucket: "sh-other" }, BUILD], [TARGET, "c".repeat(64)]] as const) {
    const { w, done } = fresh(clone(), target, build);
    const res = await done;
    assert.deepEqual([res.checkpoint.credit, res.outcomes.length], ["none", 3]);
    assert.equal(w.loads.length, 1);
    assert.notEqual(w.loads[0], savedKey);
  }
  // The report in another order is the same canonical order and the same key: the checkpoint resumes.
  const reordered = selectApproved([...report].reverse(), planned)!;
  const { done } = fresh(clone(), TARGET, BUILD, reordered);
  const res = await done;
  assert.deepEqual([res.checkpoint, res.outcomes.map((o) => [o.index, o.legacyId])], [{ credit: "resumed", from: 2, next: 3 }, [[2, "3"]]]);
  // A concurrent writer moved the checkpoint on: the run stops rather than overwrite it.
  const racing = world({ objects: first.bucket, rows: [...first.rows.values()], saved: new Map(first.saved) });
  racing.checkpoints.load = async () => ({ revision: 0, checkpoint: good.checkpoint });
  await assert.rejects(copyLegacyDocuments(sel, racing, run(), bounds()), (e: unknown) => e instanceof M2CopyError && e.code === "m2.copy.checkpoint");
});

test("bounds, build, target and invocations are checked before anything is read", async () => {
  const sel = selectApproved(report, planned)!;
  const w = world();
  for (const bad of [{ maxObjectBytes: (1 << 30) + 1 }, { maxDocuments: 0 }, { opTimeoutMs: 0 }, { settleMs: 0 }, { listPageSize: 1.5 }])
    await assert.rejects(copyLegacyDocuments(sel, w, run(), bounds(bad)), (e: unknown) => e instanceof M2CopyError && e.code === "m2.copy.bounds");
  for (const r of [run(GEN, "not-hex"), run(GEN, BUILD, { ...TARGET, id: "x" }), run(GEN, BUILD, { ...TARGET, bucket: "" }), run(GEN, BUILD, TARGET, INV.doccheck)])
    await assert.rejects(copyLegacyDocuments(sel, w, r, bounds()), (e: unknown) => e instanceof M2CopyError && e.code === "m2.copy.bounds");
  assert.deepEqual([w.loads, w.legacyReads], [[], []]);
});

test("a document above the hard object cap is never read or written, even first in a run", async () => {
  const sel = selectApproved(report, planned)!;
  const w = world();
  const cap = Math.min(...report.map((d) => d.size)) - 1;
  const r = await copyLegacyDocuments(sel, w, run(), bounds({ maxObjectBytes: cap, maxApprovedBytes: cap }));
  assert.deepEqual(r.outcomes.map((o) => o.rule), ["overCap", "overCap", "overCap"]);
  assert.deepEqual([w.legacyReads, w.puts, w.inserted.length, r.approvedBytes, r.verified.length], [[], [], 0, 0, 0]);
  assert.equal(r.complete, true, "handled, and counted as not verified");
});

test("a port call past its timeout is aborted and awaited: settled is a timeout, still running is unsettled", async () => {
  const sel = selectApproved([report[0]], planned)!;
  const abortable = (signal: AbortSignal) => new Promise<never>((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted"))));
  const deaf = () => new Promise<never>(() => {});
  const fast = bounds({ opTimeoutMs: 5, settleMs: 5 });
  const cases: [string, (w: ReturnType<typeof world>) => void, string][] = [
    ["get honours abort", (w) => { w.store.get = (_i, _k, _g, signal) => abortable(signal); }, "m2.copy.timeout"],
    ["put ignores abort", (w) => { w.objects.put = deaf; }, "m2.copy.unsettled"],
    ["insert honours abort", (w) => { w.store.insert = (_r, _i, signal) => abortable(signal); }, "m2.copy.timeout"],
    ["checkpoint save ignores abort", (w) => { w.checkpoints.save = deaf; }, "m2.copy.unsettled"],
    ["list honours abort", (w) => { w.objects.list = (_p, _page, signal) => abortable(signal); }, "m2.copy.timeout"],
  ];
  for (const [label, edit, code] of cases) {
    const w = world();
    edit(w);
    await assert.rejects(copyLegacyDocuments(sel, w, run(), fast), (e: unknown) => e instanceof M2CopyError && e.code === code, label);
  }
  // The uncertain put above may have landed: the next run reconciles it (adopts it after read-back).
  const crashed = world();
  const put = crashed.objects.put.bind(crashed.objects);
  crashed.objects.put = async (k, b, m, signal) => { await put(k, b, m, signal); return deaf(); };
  await assert.rejects(copyLegacyDocuments(sel, crashed, run(), fast), (e: unknown) => e instanceof M2CopyError && e.code === "m2.copy.unsettled");
  const next = world({ objects: crashed.bucket, saved: crashed.saved });
  const r = await copyLegacyDocuments(sel, next, run(), fast);
  assert.deepEqual([r.checkpoint.credit, r.outcomes.map((o) => o.rule)], ["none", ["adopted"]]);
  // A legacy read changes nothing: one that runs out of time is a failed read of that document.
  const slowLegacy = world();
  slowLegacy.legacy.read = deaf;
  const rl = await copyLegacyDocuments(sel, slowLegacy, run(), fast);
  assert.deepEqual(rl.outcomes.map((o) => o.rule), ["document.readFailed"]);
});

test("the orphan scan reads page by page within its bound, says when it was truncated, and reports pairs and counts only", async () => {
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
