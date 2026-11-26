import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { deflateSync } from "node:zlib";

import { checkLegacyDocuments, documentCheckCounts, type LegacyObjectRead, type LegacyObjectReader } from "../src/m2-document-check.js";
import type { DocumentSourceRow } from "../src/m2-documents.js";

// Synthetic objects only. "Secret" marks a key or content that must never be reported.
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
const pdf = () => {
  let s = "%PDF-1.4\n";
  const offsets: number[] = [];
  for (const [i, obj] of ["<< /Type /Catalog /Pages 2 0 R >>", "<< /Type /Pages /Kids [3 0 R] /Count 1 >>", "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 100 100] >>"].entries()) {
    offsets.push(s.length); s += `${i + 1} 0 obj\n${obj}\nendobj\n`;
  }
  const x = s.length;
  s += `xref\n0 4\n0000000000 65535 f \n${offsets.map((n) => `${String(n).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
  return Buffer.from(s);
};
const sha = (b: Buffer) => createHash("sha256").update(b).digest("hex");

/** A bucket in memory that records every read and honours the size bound. */
const bucket = (objects: Record<string, Buffer | Error>) => {
  const reads: string[] = [];
  const reader: LegacyObjectReader = {
    async read(key, maxBytes): Promise<LegacyObjectRead> {
      reads.push(key);
      const o = objects[key];
      if (o instanceof Error) throw o;
      if (o === undefined) return { kind: "missing" };
      return o.length > maxBytes ? { kind: "tooLarge" } : { kind: "found", bytes: o };
    },
  };
  return { reader, reads };
};
const row = (legacyId: string, kind: DocumentSourceRow["kind"], ...keys: string[]): DocumentSourceRow => ({ legacyId, kind, keys });

test("an admitted object is recorded with the key that held it, its type, size and sha256", async () => {
  const photo = png(1), cv = pdf(), front = png(2);
  const { reader } = bucket({ "photos/p1.png": photo, "candidate-resume/c1.pdf": cv, "photos/f1.png": front });
  const result = await checkLegacyDocuments([
    row("1", "personal-photo", "candidate-profile-photos/p1.png", "photos/p1.png"),
    row("1", "resume", "candidate-resume/c1.pdf"),
    row("1", "civil-id-front", "photos/f1.png"),
  ], reader);
  assert.deepEqual(result.issues, []);
  assert.deepEqual(result.checked, [
    { legacyId: "1", kind: "personal-photo", key: "photos/p1.png", mime: "image/png", size: photo.length, sha256: sha(photo) },
    { legacyId: "1", kind: "resume", key: "candidate-resume/c1.pdf", mime: "application/pdf", size: cv.length, sha256: sha(cv) },
    { legacyId: "1", kind: "civil-id-front", key: "photos/f1.png", mime: "image/png", size: front.length, sha256: sha(front) },
  ]);
});

test("legacy's probe order wins: a later key is never read once one is found", async () => {
  const first = png(3);
  const { reader, reads } = bucket({ "candidate-profile-photos/a.png": first, "photos/a.png": png(4) });
  const result = await checkLegacyDocuments([row("2", "personal-photo", "candidate-profile-photos/a.png", "photos/a.png")], reader);
  assert.equal(result.checked[0]!.sha256, sha(first));
  assert.deepEqual(reads, ["candidate-profile-photos/a.png"]);
});

test("missing, oversized, refused and unreadable objects are issues by rule and column, never by key or content", async () => {
  const big = Buffer.concat([png(5), Buffer.alloc(10 * 1024 * 1024)]);
  const { reader } = bucket({
    "photos/Secret-big.png": big,
    "candidate-resume/Secret-photo.pdf": png(6), // an image where a PDF must be
    "photos/Secret-text.png": Buffer.from("Secret text, not an image"),
    "photos/Secret-jpeg.png": Buffer.from([0xff, 0xd8, 0xff, 0xd9]), // a JPEG signature with no frame
    "candidate-resume/Secret-active.pdf": Buffer.from(pdf().toString("latin1").replace("/Type /Catalog", "/Type /Catalog /OpenAction 3 0 R")),
    "photos/Secret-fail.png": new Error("Secret detail from the store"),
  });
  const result = await checkLegacyDocuments([
    row("10", "personal-photo", "candidate-profile-photos/Secret-gone.png", "photos/Secret-gone.png"),
    row("11", "civil-id-back", "photos/Secret-big.png"),
    row("12", "resume", "candidate-resume/Secret-photo.pdf"),
    row("13", "civil-id-front", "photos/Secret-text.png"),
    row("14", "personal-photo", "photos/Secret-jpeg.png"),
    row("15", "resume", "candidate-resume/Secret-active.pdf"),
    row("16", "civil-id-back", "photos/Secret-fail.png"),
  ], reader);
  assert.deepEqual(result.checked, []);
  assert.deepEqual(result.issues, [
    { rule: "document.missing", legacyId: "10", field: "candidate_personal_photo" },
    { rule: "document.tooLarge", legacyId: "11", field: "candidate_civil_photo_back" },
    { rule: "document.admission", legacyId: "12", field: "candidate_resume" },
    { rule: "document.admission", legacyId: "13", field: "candidate_civil_photo_front" },
    { rule: "document.admission", legacyId: "14", field: "candidate_personal_photo" },
    { rule: "document.admission", legacyId: "15", field: "candidate_resume" },
    { rule: "document.readFailed", legacyId: "16", field: "candidate_civil_photo_back" },
  ]);
  assert.ok(!JSON.stringify(result.issues).includes("Secret"));
  assert.deepEqual(documentCheckCounts(result), {
    checked: 0, bytes: 0,
    rules: { "document.missing": 1, "document.tooLarge": 1, "document.admission": 4, "document.readFailed": 1 },
  });
});

test("a reader that ignores the size bound or answers nonsense cannot get an object admitted", async () => {
  const over = Buffer.concat([png(7), Buffer.alloc(10 * 1024 * 1024)]);
  const lying: LegacyObjectReader = { async read(key) { return key.endsWith("over.png") ? { kind: "found", bytes: over } : ({ kind: "found", bytes: "x" } as unknown as LegacyObjectRead); } };
  const result = await checkLegacyDocuments([row("20", "personal-photo", "photos/over.png"), row("21", "personal-photo", "photos/odd.png")], lying);
  assert.deepEqual(result.issues, [
    { rule: "document.tooLarge", legacyId: "20", field: "candidate_personal_photo" },
    { rule: "document.readFailed", legacyId: "21", field: "candidate_personal_photo" },
  ]);
});

test("reads run one at a time, in input order", async () => {
  let active = 0, peak = 0;
  const order: string[] = [];
  const reader: LegacyObjectReader = {
    async read(key) {
      active++; peak = Math.max(peak, active); order.push(key);
      await new Promise((resolve) => setImmediate(resolve));
      active--;
      return { kind: "found", bytes: png(8) };
    },
  };
  const rows = ["3", "1", "2"].map((id) => row(id, "civil-id-front", `photos/${id}.png`));
  const result = await checkLegacyDocuments(rows, reader);
  assert.equal(peak, 1);
  assert.deepEqual(order, ["photos/3.png", "photos/1.png", "photos/2.png"]);
  assert.deepEqual(result.checked.map((d) => d.legacyId), ["3", "1", "2"]);
  assert.equal(documentCheckCounts(result).bytes, png(8).length * 3);
});
