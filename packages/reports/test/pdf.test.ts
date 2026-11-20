import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { buildPdf, encodable, fitText, PdfPage, PHOTO_MAX_SIDE, PNG_MAX_PIXELS, readImage, readJpeg, readPng, textWidth } from "../src/pdf.js";
import { cardNumberText, idCardsPdf, longDate } from "../src/id-card-pdf.js";

const latin = (b: Buffer) => b.toString("latin1");

/** Checks the cross-reference table: every entry points at its object's header, and startxref at the table. */
function assertWellFormed(pdf: Buffer): void {
  const text = latin(pdf);
  assert.match(text, /^%PDF-1\.4\n/); assert.match(text, /%%EOF\n$/);
  const start = Number(/startxref\n(\d+)\n%%EOF\n$/.exec(text)![1]);
  assert.equal(text.slice(start, start + 4), "xref");
  const [, count] = /^xref\n0 (\d+)\n/.exec(text.slice(start))!;
  const entries = text.slice(start).split("\n").slice(2, 2 + Number(count));
  assert.equal(entries[0], "0000000000 65535 f ");
  entries.slice(1).forEach((entry, i) => {
    const offset = Number(entry.slice(0, 10));
    assert.equal(text.slice(offset, offset + `${i + 1} 0 obj`.length), `${i + 1} 0 obj`, `object ${i + 1}`);
  });
  for (const m of text.matchAll(/<< ([^\n]*?)\/Length (\d+) >>\nstream\n/g)) {
    const at = m.index! + m[0].length;
    assert.equal(text.slice(at + Number(m[2]), at + Number(m[2]) + 10), "\nendstream", "stream length");
  }
}

test("REPORTS_PDF a document has a valid cross-reference table, one page per page, and escaped text", () => {
  const page = new PdfPage(200, 100).rect(0, 0, 200, 100, [255, 255, 255]).text(10, 50, "Café (open) \\ 100%", 12, [0, 0, 0]);
  const pdf = buildPdf([page, new PdfPage(200, 100)], "Test (one)");
  assertWellFormed(pdf);
  const text = latin(pdf);
  assert.match(text, /\/Count 2 /);
  assert.ok(text.includes("(Caf\\351 \\(open\\) \\\\ 100%) Tj"), "parentheses and backslash escaped, é as WinAnsi octal");
  assert.ok(text.includes("/Title (Test \\(one\\))"));
  assert.throws(() => buildPdf([], "x"), /no pages/);
  assert.throws(() => new PdfPage(0, 10), /invalid page size/);
  assert.throws(() => new PdfPage(10, 10).rect(Number.NaN, 0, 1, 1, [0, 0, 0]), /invalid number/);
});

test("REPORTS_PDF only WinAnsi text is written; anything else is left out", () => {
  assert.equal(encodable("Alia Badr-Al'Mutawa"), true);
  assert.equal(encodable("Zoë – “quoted” €5"), true);
  assert.equal(encodable("علي"), false);
  const text = latin(buildPdf([new PdfPage(100, 100).text(0, 0, "A علي B", 10, [0, 0, 0]).text(0, 20, "علي", 10, [0, 0, 0])], "t"));
  assert.ok(text.includes("(A  B) Tj")); assert.equal(text.match(/Tj/g)?.length, 1, "a string with nothing left writes nothing");
});

test("REPORTS_PDF widths follow the font metrics; long text shrinks, then is cut with an ellipsis", () => {
  assert.equal(textWidth("Hi", 10), (722 + 222) / 100);
  assert.equal(textWidth("Hi", 10, "bold"), (722 + 278) / 100);
  assert.deepEqual(fitText("Short", 100, 12, 6), { text: "Short", size: 12 });
  const shrunk = fitText("A rather long company name", 100, 12, 6);
  assert.ok(shrunk.size < 12 && shrunk.size >= 6 && textWidth(shrunk.text, shrunk.size) <= 100); assert.equal(shrunk.text, "A rather long company name");
  const cut = fitText("The Sultan Center Food Products Company of Kuwait", 60, 10, 8);
  assert.equal(cut.size, 8); assert.match(cut.text, /…$/); assert.ok(textWidth(cut.text, 8) <= 60);
});

const jpeg = (sof: number, bits: number, components: number) => Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x4a, 0x46, 0xff, sof, 0x00, 8 + 3 * components, bits, 0x00, 0x20, 0x00, 0x30, components,
  ...Array.from({ length: components * 3 }, () => 0x11), 0xff, 0xda, 0x00, 0x02, 0xff, 0xd9]);

test("REPORTS_PDF JPEG photos pass through with their size and colour space", () => {
  assert.deepEqual({ ...readJpeg(jpeg(0xc0, 8, 3))!, data: null }, { width: 48, height: 32, bits: 8, colorSpace: "/DeviceRGB", filter: "DCTDecode", data: null });
  assert.equal(readJpeg(jpeg(0xc2, 8, 1))?.colorSpace, "/DeviceGray", "progressive gray");
  assert.match(readJpeg(jpeg(0xc0, 8, 4))!.colorSpace, /DeviceCMYK \/Decode/);
  assert.equal(readJpeg(jpeg(0xc3, 8, 3)), null, "lossless");
  assert.equal(readJpeg(jpeg(0xc0, 12, 3)), null, "12-bit");
  assert.equal(readJpeg(Buffer.from("not a jpeg")), null);
  assert.equal(readJpeg(jpeg(0xc0, 8, 3).subarray(0, 12)), null, "truncated");
});

function png(width: number, height: number, type: number, rows: number[][], extra: { bits?: number; interlace?: number; palette?: number[]; trns?: number[]; ihdrSize?: number } = {}): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (kind: string, data: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(kind, 4, "latin1"); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0); return Buffer.concat([head, data, tail]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = extra.bits ?? 8; ihdr[9] = type; ihdr[12] = extra.interlace ?? 0;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr.subarray(0, extra.ihdrSize ?? 13)), ...(extra.palette ? [chunk("PLTE", Buffer.from(extra.palette))] : []), ...(extra.trns ? [chunk("tRNS", Buffer.from(extra.trns))] : []),
    chunk("IDAT", deflateSync(Buffer.from(rows.flat()))), chunk("IEND", Buffer.alloc(0))]);
}

test("REPORTS_PDF PNG photos are decoded, flattened onto white and kept as small RGB", async () => {
  const { inflateSync } = await import("node:zlib");
  const pixels = (bytes: Buffer) => { const image = readPng(bytes)!; assert.equal(image.colorSpace, "/DeviceRGB"); assert.equal(image.decodeParms, undefined); return [...inflateSync(image.data)]; };
  assert.deepEqual(pixels(png(2, 1, 2, [[0, 10, 20, 30, 40, 50, 60]])), [10, 20, 30, 40, 50, 60], "RGB");
  assert.deepEqual(pixels(png(1, 1, 0, [[0, 7]])), [7, 7, 7], "gray");
  assert.deepEqual(pixels(png(2, 1, 3, [[0, 0, 1]], { palette: [255, 0, 0, 0, 255, 0] })), [255, 0, 0, 0, 255, 0], "palette");
  // RGBA, Sub filter on the second pixel: (100,150,200,255) then (+0,+0,+0,-255) = (100,150,200,0): opaque colour, then fully transparent.
  assert.deepEqual(pixels(png(2, 1, 6, [[1, 100, 150, 200, 255, 0, 0, 0, 1]])), [100, 150, 200, 255, 255, 255]);
  // Gray with half alpha, Up filter on row 2 adds the row above.
  assert.deepEqual(pixels(png(1, 2, 4, [[0, 0, 128], [2, 0, 0]])), [127, 127, 127, 127, 127, 127]);
  // Palette transparency from tRNS is flattened onto white: transparent black prints white, half-alpha red prints pink.
  assert.deepEqual(pixels(png(2, 1, 3, [[0, 0, 1]], { palette: [0, 0, 0, 255, 0, 0], trns: [0, 128] })), [255, 255, 255, 255, 127, 127]);
  assert.equal(readPng(png(1, 1, 3, [[0, 0]], { palette: [0, 0, 0], trns: [0, 0] })), null, "more tRNS entries than palette entries");
  assert.equal(readPng(png(1, 1, 3, [[0, 1]], { palette: [0, 0, 0] })), null, "an index past the palette");
  assert.equal(readPng(png(1, 1, 2, [[0, 1, 2, 3]], { trns: [0, 1, 0, 2, 0, 3] })), null, "colour-key transparency is not placed");
  assert.equal(readPng(png(1, 1, 2, [[0, 1, 2, 3]], { interlace: 1 })), null, "interlaced");
  assert.equal(readPng(png(1, 1, 2, [[0, 1, 2, 3]], { bits: 16 })), null, "16-bit");
  assert.equal(readPng(png(1, 1, 6, [[9, 1, 2, 3, 4]])), null, "unknown filter");
  assert.equal(readPng(png(1, 1, 3, [[0, 0]])), null, "palette PNG without a palette");
  assert.equal(readImage(png(1, 1, 0, [[0, 7]]), "image/gif"), null);
  // A short IHDR is refused, not read past its end, even when the buffer is long enough overall.
  assert.equal(readPng(png(1, 1, 2, [[0, 1, 2, 3]], { ihdrSize: 0 })), null, "zero-length IHDR");
  assert.equal(readPng(png(1, 1, 2, [[0, 1, 2, 3]], { ihdrSize: 12 })), null, "short IHDR");
  // Rows beyond the declared size are not inflated: the inflate may produce exactly the declared bytes.
  assert.equal(readPng(png(1, 1, 2, [[0, 1, 2, 3], [0, 4, 5, 6]])), null, "more data than the header declares");
});

test("REPORTS_PDF a PNG's decoded size is bounded before inflating, and photos are kept at card size", async () => {
  const { inflateSync } = await import("node:zlib");
  assert.equal(PNG_MAX_PIXELS, 1_000_000); assert.equal(PHOTO_MAX_SIDE, 320);
  // High-compression alpha PNGs: a few KB on disk, megabytes decoded.
  const flat = (w: number, h: number) => png(w, h, 6, Array.from({ length: h }, () => [0, ...Array.from({ length: w }, () => [10, 20, 30, 255]).flat()]));
  const over = flat(1001, 1000);
  assert.ok(over.length < 64 * 1024, "the over-budget PNG is small on disk");
  assert.equal(readPng(over), null, "one pixel row past the budget is refused, though its data is valid");
  // A huge declared size with little data is refused from the header alone; nothing is inflated.
  assert.equal(readPng(png(10000, 10000, 6, [[0]])), null);
  const atCap = readPng(flat(1000, 1000))!;
  assert.equal(atCap.width, 320); assert.equal(atCap.height, 320);
  const kept = inflateSync(atCap.data);
  assert.equal(kept.length, 320 * 320 * 3); assert.deepEqual([...kept.subarray(0, 6)], [10, 20, 30, 10, 20, 30]);
  // Downscaling averages the pixels it folds together: alternating black and white columns become mid gray.
  const stripes = readPng(png(640, 1, 0, [[0, ...Array.from({ length: 640 }, (_, x) => (x % 2) * 255)]]))!;
  assert.equal(stripes.width, 320); assert.equal(stripes.height, 1);
  assert.ok([...inflateSync(stripes.data)].every(v => v === 128));
  const tall = readPng(png(1, 960, 0, Array.from({ length: 960 }, () => [0, 9])))!;
  assert.equal(tall.width, 1); assert.equal(tall.height, 320, "the longest side sets the scale");
});

test("REPORTS_ID_CARD_PDF two pages per card with the card's details, no civil ID, and the photo when there is one", () => {
  assert.equal(longDate("2027-02-19"), "19 February 2027"); assert.throws(() => longDate("2027-13-01"), /invalid day/);
  assert.equal(cardNumberText(17), "000017"); assert.equal(cardNumberText(1234567), "1234567");
  const photo = readPng(png(1, 1, 2, [[0, 200, 100, 50]]))!;
  const pdf = idCardsPdf([
    { name: "Alia Badr", employeeId: "C00042", cardNumber: 17, expiresOn: "2027-02-19", placement: { company: "Sultan Center", store: "Avenues" }, photo },
    { name: "علي محمد", employeeId: null, cardNumber: 18, expiresOn: "2027-02-28", placement: null },
  ]);
  assertWellFormed(pdf);
  const text = latin(pdf);
  assert.match(text, /\/Count 4 /);
  for (const s of ["(No. 000017)", "(Alia Badr)", "(Employee ID C00042)", "(Sultan Center)", "(Avenues)", "(19 February 2027)", "(No. 000018)", "(28 February 2027)", "(contact@bawes.net)"])
    assert.ok(text.includes(`${s} Tj`), s);
  assert.equal(text.match(/\/Subtype \/Image/g)?.length, 1, "only the first card has a photo");
  assert.doesNotMatch(text, /Civil|civil/);
  assert.throws(() => idCardsPdf([]), /no cards/);
});
