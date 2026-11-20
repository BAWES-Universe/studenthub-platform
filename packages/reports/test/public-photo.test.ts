import assert from "node:assert/strict";
import test from "node:test";
import { deflateSync } from "node:zlib";
import { cleanJpeg, cleanPng, publicPhoto, readJpeg, readPng, PHOTO_MAX_SIDE } from "../src/index.js";
import { JPEG_WITH_GPS } from "./jpeg-fixtures.js";

const SECRETS = ["SECRETPLACE", "SN-SECRET", "COMMENT-SECRET", "Exif", "CameraMaker", "http://ns.adobe.com/xap"];

/** Every marker segment of a JPEG up to its first scan, as [marker, length]. */
function headers(bytes: Buffer): number[] {
  const markers: number[] = [];
  for (let i = 2; i + 4 <= bytes.length;) {
    const marker = bytes[i + 1]!; markers.push(marker);
    if (marker === 0xda) break;
    i += 2 + bytes.readUInt16BE(i + 2);
  }
  return markers;
}
/** The bytes from the first scan header to the end of image: the compressed pixels. */
const scans = (bytes: Buffer) => { const at = bytes.indexOf(Buffer.from([0xff, 0xda])); return bytes.subarray(at); };

test("REPORTS_PUBLIC_PHOTO a JPEG carrying EXIF GPS comes out without it, or any other metadata, and with the same pixels", () => {
  for (const [name, input] of Object.entries(JPEG_WITH_GPS)) {
    for (const secret of SECRETS.slice(0, 3)) assert.ok(input.includes(secret), `${name} fixture carries ${secret}`);
    const out = cleanJpeg(input)!;
    assert.ok(out, name);
    for (const secret of SECRETS) assert.ok(!out.includes(secret), `${name}: ${secret} is gone`);
    const markers = headers(out);
    assert.deepEqual(markers.filter(m => (m >= 0xe0 && m <= 0xef) || m === 0xfe), name === "cmyk" ? [0xee] : [0xe0], `${name}: only a fresh JFIF (or, for CMYK, Adobe) header`);
    assert.ok(!markers.includes(0xe1), `${name}: no APP1 (EXIF/XMP)`);
    assert.ok(scans(out).equals(scans(input)), `${name}: the compressed pixels are unchanged`);
    assert.deepEqual({ ...readJpeg(out)!, data: null }, { ...readJpeg(input)!, data: null }, `${name}: same size and colour space`);
    assert.equal(out.subarray(-2).toString("hex"), "ffd9");
  }
  const adobe = cleanJpeg(JPEG_WITH_GPS.cmyk)!;
  const at = adobe.indexOf("Adobe");
  assert.equal(adobe[at + 11], JPEG_WITH_GPS.cmyk[JPEG_WITH_GPS.cmyk.indexOf("Adobe") + 11], "the CMYK colour transform is kept");
  assert.deepEqual(publicPhoto(JPEG_WITH_GPS.rgb, "image/jpeg"), { bytes: cleanJpeg(JPEG_WITH_GPS.rgb), mime: "image/jpeg" });
});

test("REPORTS_PUBLIC_PHOTO a JPEG that cannot be rebuilt from the allow list is refused, never passed through", () => {
  const rgb = JPEG_WITH_GPS.rgb, sof = rgb.indexOf(Buffer.from([0xff, 0xc0]));
  const withSof = (marker: number, width = 24, height = 16) => { const b = Buffer.from(rgb); b[sof + 1] = marker; b.writeUInt16BE(height, sof + 5); b.writeUInt16BE(width, sof + 7); return b; };
  assert.equal(cleanJpeg(withSof(0xc3)), null, "lossless");
  assert.equal(cleanJpeg(withSof(0xc0, 6000, 4001)), null, "over PUBLIC_JPEG_MAX_PIXELS");
  assert.ok(cleanJpeg(withSof(0xc0, 6000, 4000)), "at the cap");
  assert.equal(cleanJpeg(rgb.subarray(0, rgb.length - 2)), null, "no end of image");
  assert.equal(cleanJpeg(rgb.subarray(0, rgb.length - 40)), null, "truncated scan");
  assert.equal(cleanJpeg(Buffer.from("not a jpeg at all")), null);
  const unknown = Buffer.concat([rgb.subarray(0, 2), Buffer.from([0xff, 0xf7, 0x00, 0x04, 0x00, 0x00]), rgb.subarray(2)]);
  assert.equal(cleanJpeg(unknown), null, "a marker not on the list (JPEG-LS)");
  const trailing = Buffer.concat([rgb, Buffer.from("SECRETPLACE trailing data")]);
  assert.ok(!cleanJpeg(trailing)!.includes("SECRETPLACE"), "bytes after the end of image are dropped");
  const cmykNoAdobe = Buffer.from(JPEG_WITH_GPS.cmyk); cmykNoAdobe.write("Xdobe", cmykNoAdobe.indexOf("Adobe"), "latin1");
  assert.equal(cleanJpeg(cmykNoAdobe), null, "CMYK without its Adobe header");
  assert.equal(publicPhoto(rgb, "image/gif"), null);
});

function png(width: number, height: number, extra: Buffer[] = []): Buffer {
  const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 0xff]! ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const chunk = (kind: string, data: Buffer) => { const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(kind, 4, "latin1"); const tail = Buffer.alloc(4); tail.writeUInt32BE(crc(Buffer.concat([head.subarray(4), data])), 0); return Buffer.concat([head, data, tail]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6;
  const rows = Buffer.alloc((width * 4 + 1) * height);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) rows.set([x % 256, y % 256, 90, 255], y * (width * 4 + 1) + 1 + x * 4);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...extra.map(e => chunk(e.toString("latin1", 0, 4), e.subarray(4))),
    chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

test("REPORTS_PUBLIC_PHOTO a PNG is decoded through the downscale path and written anew with only its pixels", () => {
  const input = png(640, 400, [Buffer.from("tEXtLocation\0SECRETPLACE"), Buffer.from("eXIfMM\0*SN-SECRET-12345")]);
  const out = cleanPng(input)!;
  assert.ok(out);
  for (const secret of ["SECRETPLACE", "SN-SECRET", "tEXt", "eXIf"]) assert.ok(!out.includes(secret), secret);
  const kinds: string[] = [];
  for (let i = 8; i < out.length; i += 12 + out.readUInt32BE(i)) kinds.push(out.toString("latin1", i + 4, i + 8));
  assert.deepEqual(kinds, ["IHDR", "IDAT", "IEND"]);
  const image = readPng(out)!;
  assert.deepEqual([image.width, image.height], [PHOTO_MAX_SIDE, 200], "longest side at most PHOTO_MAX_SIDE");
  assert.ok(image.data.equals(readPng(input)!.data), "the same pixels the printed card uses");
  assert.equal(cleanPng(png(1001, 1000)), null, "over PNG_MAX_PIXELS");
  assert.equal(publicPhoto(input, "image/png")?.mime, "image/png");
});
