import { deflateSync, inflateSync } from "node:zlib";
import { readPng } from "./pdf.js";

/**
 * The card holder's photo as the public check page serves it. An upload is never sent as it was
 * stored: phone photos carry EXIF (GPS position, camera serial, time taken) and other metadata, and
 * the public page is anonymous. So every photo is rebuilt from its image data alone.
 *
 * - A PNG is decoded through the card's downscale path (readPng: bounded, flattened onto white, at
 *   most PHOTO_MAX_SIDE a side) and written out as a new PNG holding only IHDR, IDAT and IEND, so no
 *   text, eXIf, iCCP or other chunk survives.
 * - A JPEG is rebuilt segment by segment from an allow list: the quantization and Huffman tables,
 *   the frame header, restart interval, and each scan with its entropy-coded data. Every APPn
 *   segment (EXIF and XMP in APP1, ICC, Photoshop IPTC in APP13, maker notes), every comment and
 *   anything after the end of image is dropped; a fresh JFIF header is written, and for Adobe CMYK
 *   files a fresh Adobe header carrying only the colour transform. A marker that is not on the list
 *   refuses the photo. The pixels are unchanged, so EXIF orientation is lost (the printed card
 *   ignores it too).
 */

/** The most pixels a served JPEG may declare, so a viewer's browser is never handed a decompression bomb. */
export const PUBLIC_JPEG_MAX_PIXELS = 24_000_000;

export interface PublicPhoto { readonly bytes: Buffer; readonly mime: "image/jpeg" | "image/png" }

const segment = (marker: number, body: Buffer) => { const head = Buffer.alloc(4); head[0] = 0xff; head[1] = marker; head.writeUInt16BE(body.length + 2, 2); return Buffer.concat([head, body]); };
// JFIF 1.01, no density (aspect ratio 1:1), no thumbnail.
const JFIF = segment(0xe0, Buffer.from([0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]));
const adobe = (transform: number) => segment(0xee, Buffer.from([0x41, 0x64, 0x6f, 0x62, 0x65, 0x00, 0x64, 0x00, 0x00, 0x00, 0x00, transform]));

/** The JPEG rebuilt from its image segments only, or null when it is not a baseline, extended or progressive 8-bit JPEG this can rebuild. */
export function cleanJpeg(bytes: Buffer): Buffer | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  const out: Buffer[] = [];
  let i = 2, frame = false, scans = 0, components = 0, transform: number | null = null, ended = false;
  while (i + 2 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    if (marker === 0xff) { i += 1; continue; } // fill bytes before a marker
    if (marker === 0xd9) { ended = true; break; }
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) return null; // only valid inside a scan
    if (i + 4 > bytes.length) return null;
    const size = bytes.readUInt16BE(i + 2);
    if (size < 2 || i + 2 + size > bytes.length) return null;
    const body = bytes.subarray(i + 4, i + 2 + size);
    if (marker === 0xc0 || marker === 0xc1 || marker === 0xc2) {
      if (frame || body.length < 6) return null;
      const bits = body[0]!, height = body.readUInt16BE(1), width = body.readUInt16BE(3);
      components = body[5]!;
      if (bits !== 8 || !width || !height || width * height > PUBLIC_JPEG_MAX_PIXELS || ![1, 3, 4].includes(components) || body.length !== 6 + components * 3) return null;
      frame = true; out.push(segment(marker, body));
    } else if (marker === 0xdb || marker === 0xc4 || marker === 0xdd) out.push(segment(marker, body));
    else if (marker === 0xee) { if (body.length >= 12 && body.toString("latin1", 0, 5) === "Adobe") transform = body[11]!; }
    else if ((marker >= 0xe0 && marker <= 0xef) || marker === 0xfe) { /* APPn and comments: dropped */ }
    else if (marker === 0xda) {
      if (!frame) return null;
      // The scan's entropy-coded data runs to the next marker that is not a stuffed 0xFF00 or a restart marker.
      let end = i + 2 + size;
      for (;;) {
        if (end + 1 >= bytes.length) return null;
        if (bytes[end] === 0xff && bytes[end + 1] !== 0x00 && !(bytes[end + 1]! >= 0xd0 && bytes[end + 1]! <= 0xd7)) break;
        end++;
      }
      out.push(bytes.subarray(i, end)); scans++; i = end; continue;
    } else return null;
    i += 2 + size;
  }
  if (!ended || !frame || !scans) return null;
  const header = components === 4 ? (transform === null ? null : adobe(transform)) : JFIF;
  if (!header) return null; // CMYK without the Adobe header is read differently by every viewer
  return Buffer.concat([Buffer.from([0xff, 0xd8]), header, ...(components === 3 && transform !== null ? [adobe(transform)] : []), ...out, Buffer.from([0xff, 0xd9])]);
}

const CRC = new Int32Array(256).map((_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c; });
function chunk(kind: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8); head.writeUInt32BE(data.length, 0); head.write(kind, 4, "latin1");
  let c = -1; for (const b of [...head.subarray(4), ...data]) c = CRC[(c ^ b) & 0xff]! ^ (c >>> 8);
  const tail = Buffer.alloc(4); tail.writeUInt32BE((c ^ -1) >>> 0, 0);
  return Buffer.concat([head, data, tail]);
}

/** The PNG decoded through the card's downscale path and written out as a new 8-bit RGB PNG, or null. */
export function cleanPng(bytes: Buffer): Buffer | null {
  const image = readPng(bytes);
  if (!image) return null;
  const stride = image.width * 3, rgb = inflateSync(image.data, { maxOutputLength: stride * image.height });
  if (rgb.length !== stride * image.height) return null;
  const rows = Buffer.alloc((stride + 1) * image.height);
  for (let y = 0; y < image.height; y++) rgb.copy(rows, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(image.width, 0); ihdr.writeUInt32BE(image.height, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(rows)), chunk("IEND", Buffer.alloc(0))]);
}

/** The photo as the public page may serve it, rebuilt without metadata, or null. */
export function publicPhoto(bytes: Buffer, mime: string): PublicPhoto | null {
  const clean = mime === "image/jpeg" ? cleanJpeg(bytes) : mime === "image/png" ? cleanPng(bytes) : null;
  return clean && { bytes: clean, mime: mime as PublicPhoto["mime"] };
}
