import { deflateSync, inflateSync } from "node:zlib";

/**
 * A small PDF writer for StudentHub's own documents (ID cards, certificates): pages of filled
 * rectangles and circles, text in the PDF standard Helvetica fonts, and JPEG or PNG images. It
 * has no dependencies and writes PDF 1.4.
 *
 * Text is encoded in WinAnsi (Latin-1 plus a few signs), the only encoding the standard fonts
 * have without embedding a font. A character outside it is left out, and `encodable` tells a
 * caller whether a string survives whole, so it can choose another field. Arabic text needs an
 * embedded font and shaping, which this writer does not do.
 */
export type PdfFont = "regular" | "bold";
export type Rgb = readonly [number, number, number];
export interface PdfImage {
  readonly width: number; readonly height: number; readonly bits: number;
  readonly colorSpace: string; readonly filter: "DCTDecode" | "FlateDecode"; readonly decodeParms?: string; readonly data: Buffer;
}

// Advance widths (1/1000 em) of the printable ASCII characters 32 to 126 in the standard fonts' AFM files.
const HELVETICA = [278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584];
const HELVETICA_BOLD = [278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584];
// WinAnsi's 0x80 to 0x9F signs that Unicode places elsewhere.
const WIN_ANSI_EXTRA: Readonly<Record<string, number>> = { "€": 0x80, "‚": 0x82, "ƒ": 0x83, "„": 0x84, "…": 0x85, "†": 0x86, "‡": 0x87, "ˆ": 0x88, "‰": 0x89, "Š": 0x8a, "‹": 0x8b, "Œ": 0x8c, "Ž": 0x8e,
  "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97, "˜": 0x98, "™": 0x99, "š": 0x9a, "›": 0x9b, "œ": 0x9c, "ž": 0x9e, "Ÿ": 0x9f };

function winAnsi(ch: string): number | undefined {
  const code = ch.codePointAt(0)!;
  if ((code >= 0x20 && code <= 0x7e) || (code >= 0xa0 && code <= 0xff)) return code;
  return WIN_ANSI_EXTRA[ch];
}
/** Whether every character of `text` can be written in the standard fonts. */
export const encodable = (text: string): boolean => [...text.normalize("NFC")].every(ch => winAnsi(ch) !== undefined);

function encode(text: string): number[] { return [...text.normalize("NFC")].flatMap(ch => { const b = winAnsi(ch); return b === undefined ? [] : [b]; }); }

/** Width of `text` at `size` points. Characters past ASCII count as the width of "n", near enough for layout. */
export function textWidth(text: string, size: number, font: PdfFont = "regular"): number {
  const table = font === "bold" ? HELVETICA_BOLD : HELVETICA;
  return encode(text).reduce((sum, b) => sum + (b >= 32 && b <= 126 ? table[b - 32]! : table["n".charCodeAt(0) - 32]!), 0) * size / 1000;
}

/** `text` at the largest size from `size` down to `minSize` that fits `width`; cut with an ellipsis if even `minSize` is too wide. */
export function fitText(text: string, width: number, size: number, minSize: number, font: PdfFont = "regular"): { readonly text: string; readonly size: number } {
  for (let s = size; s >= minSize; s -= 0.5) if (textWidth(text, s, font) <= width) return { text, size: s };
  let cut = [...text];
  while (cut.length > 1 && textWidth(`${cut.join("").trimEnd()}…`, minSize, font) > width) cut = cut.slice(0, -1);
  return { text: `${cut.join("").trimEnd()}…`, size: minSize };
}

const num = (n: number) => { if (!Number.isFinite(n)) throw new RangeError("invalid number"); return (Math.round(n * 1000) / 1000).toString(); };
const color = ([r, g, b]: Rgb) => `${num(r / 255)} ${num(g / 255)} ${num(b / 255)}`;
function pdfString(bytes: readonly number[]): string {
  return `(${bytes.map(b => b === 0x28 || b === 0x29 || b === 0x5c ? `\\${String.fromCharCode(b)}` : b >= 0x20 && b <= 0x7e ? String.fromCharCode(b) : `\\${b.toString(8).padStart(3, "0")}`).join("")})`;
}
// Four cubic Béziers approximate a circle; this is the control point distance for a unit radius.
const KAPPA = 0.5522847498;
const circlePath = (cx: number, cy: number, r: number) => {
  const k = r * KAPPA;
  return `${num(cx + r)} ${num(cy)} m ${num(cx + r)} ${num(cy + k)} ${num(cx + k)} ${num(cy + r)} ${num(cx)} ${num(cy + r)} c ${num(cx - k)} ${num(cy + r)} ${num(cx - r)} ${num(cy + k)} ${num(cx - r)} ${num(cy)} c `
    + `${num(cx - r)} ${num(cy - k)} ${num(cx - k)} ${num(cy - r)} ${num(cx)} ${num(cy - r)} c ${num(cx + k)} ${num(cy - r)} ${num(cx + r)} ${num(cy - k)} ${num(cx + r)} ${num(cy)} c h`;
};

/** One page. Coordinates are points from the bottom left, as in PDF. */
export class PdfPage {
  readonly width: number; readonly height: number;
  readonly #ops: string[] = []; readonly images: PdfImage[] = [];
  constructor(width: number, height: number) {
    if (!(width > 0 && height > 0 && width <= 14400 && height <= 14400)) throw new RangeError("invalid page size");
    this.width = width; this.height = height;
  }
  rect(x: number, y: number, w: number, h: number, fill: Rgb): this { this.#ops.push(`${color(fill)} rg ${num(x)} ${num(y)} ${num(w)} ${num(h)} re f`); return this; }
  circle(cx: number, cy: number, r: number, fill: Rgb): this { this.#ops.push(`${color(fill)} rg ${circlePath(cx, cy, r)} f`); return this; }
  /** Text with its baseline at `y`; `align` places it left of, centred on or right of `x`. */
  text(x: number, y: number, text: string, size: number, fill: Rgb, font: PdfFont = "regular", align: "left" | "center" | "right" = "left"): this {
    const bytes = encode(text); if (!bytes.length) return this;
    const w = textWidth(text, size, font), left = align === "left" ? x : align === "center" ? x - w / 2 : x - w;
    this.#ops.push(`BT /${font === "bold" ? "F2" : "F1"} ${num(size)} Tf ${color(fill)} rg ${num(left)} ${num(y)} Td ${pdfString(bytes)} Tj ET`);
    return this;
  }
  /** An image scaled to cover the box (cropped, not stretched), optionally clipped to the circle inside it. */
  image(image: PdfImage, x: number, y: number, w: number, h: number, clip: "box" | "circle" = "box"): this {
    const index = this.images.push(image), scale = Math.max(w / image.width, h / image.height);
    const iw = image.width * scale, ih = image.height * scale, ix = x + (w - iw) / 2, iy = y + (h - ih) / 2;
    const path = clip === "circle" ? circlePath(x + w / 2, y + h / 2, Math.min(w, h) / 2) : `${num(x)} ${num(y)} ${num(w)} ${num(h)} re`;
    this.#ops.push(`q ${path} W n ${num(iw)} 0 0 ${num(ih)} ${num(ix)} ${num(iy)} cm /Im${index} Do Q`);
    return this;
  }
  /** Filled squares, for a QR code: `modules[row][col]` true is dark; row 0 is the top. */
  modules(modules: readonly (readonly boolean[])[], x: number, y: number, size: number, fill: Rgb): this {
    const n = modules.length, cell = size / n, parts: string[] = [];
    modules.forEach((row, r) => row.forEach((dark, c) => { if (dark) parts.push(`${num(x + c * cell)} ${num(y + size - (r + 1) * cell)} ${num(cell)} ${num(cell)} re`); }));
    if (parts.length) this.#ops.push(`${color(fill)} rg ${parts.join(" ")} f`);
    return this;
  }
  content(): string { return this.#ops.join("\n"); }
}

/** The whole document. `title` goes in the document information. */
export function buildPdf(pages: readonly PdfPage[], title: string): Buffer {
  if (!pages.length) throw new RangeError("no pages");
  const objects: Buffer[] = [];
  const add = (body: Buffer | string) => objects.push(typeof body === "string" ? Buffer.from(body, "latin1") : body);
  const stream = (dict: string, data: Buffer) => Buffer.concat([Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, "latin1"), data, Buffer.from("\nendstream", "latin1")]);
  // 1 catalog, 2 pages, 3 and 4 fonts, 5 info; then per page: page, content, images.
  add("<< /Type /Catalog /Pages 2 0 R >>");
  add("");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>");
  add("<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>");
  add(`<< /Title ${pdfString(encode(title))} /Producer (StudentHub) >>`);
  const kids: number[] = [];
  for (const page of pages) {
    const pageId = objects.length + 1, contentId = pageId + 1, firstImage = pageId + 2;
    const xobjects = page.images.map((_, i) => `/Im${i + 1} ${firstImage + i} 0 R`).join(" ");
    add(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(page.width)} ${num(page.height)}] /Contents ${contentId} 0 R /Resources << /Font << /F1 3 0 R /F2 4 0 R >>${xobjects ? ` /XObject << ${xobjects} >>` : ""} >> >>`);
    add(stream("", Buffer.from(page.content(), "latin1")));
    for (const image of page.images) add(stream(`/Type /XObject /Subtype /Image /Width ${image.width} /Height ${image.height} /ColorSpace ${image.colorSpace} /BitsPerComponent ${image.bits} /Filter /${image.filter}${image.decodeParms ? ` /DecodeParms ${image.decodeParms}` : ""}`, image.data));
    kids.push(pageId);
  }
  objects[1] = Buffer.from(`<< /Type /Pages /Kids [${kids.map(k => `${k} 0 R`).join(" ")}] /Count ${kids.length} >>`, "latin1");
  const parts: Buffer[] = [Buffer.from("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n", "latin1")];
  const offsets: number[] = []; let length = parts[0]!.length;
  objects.forEach((body, i) => {
    const chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n`, "latin1"), body, Buffer.from("\nendobj\n", "latin1")]);
    offsets.push(length); parts.push(chunk); length += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map(o => `${String(o).padStart(10, "0")} 00000 n \n`)].join("");
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Info 5 0 R >>\nstartxref\n${length}\n%%EOF\n`, "latin1"));
  return Buffer.concat(parts);
}

/** A baseline or progressive JPEG as a PDF image, or null when it is not one this writer can place (8-bit gray, RGB or CMYK). */
export function readJpeg(bytes: Buffer): PdfImage | null {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return null;
  let i = 2;
  while (i + 4 <= bytes.length) {
    if (bytes[i] !== 0xff) return null;
    const marker = bytes[i + 1]!;
    if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) { i += 2; continue; }
    const size = bytes.readUInt16BE(i + 2);
    if (size < 2 || i + 2 + size > bytes.length) return null;
    // A start-of-frame marker (SOF0 to SOF15, except DHT, JPG and DAC, which share the range).
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
      if (size < 8) return null;
      const bits = bytes[i + 4]!, height = bytes.readUInt16BE(i + 5), width = bytes.readUInt16BE(i + 7), components = bytes[i + 9]!;
      const space = components === 1 ? "/DeviceGray" : components === 3 ? "/DeviceRGB" : components === 4 ? "/DeviceCMYK" : undefined;
      // Baseline, extended and progressive JPEGs only: those are what DCTDecode reads.
      if (bits !== 8 || !space || !width || !height || marker > 0xc2) return null;
      // Adobe CMYK JPEGs are stored inverted.
      return { width, height, bits: 8, colorSpace: space === "/DeviceCMYK" ? "/DeviceCMYK /Decode [1 0 1 0 1 0 1 0]" : space, filter: "DCTDecode", data: bytes };
    }
    if (marker === 0xda || marker === 0xd9) return null;
    i += 2 + size;
  }
  return null;
}

/** The most pixels a PNG may declare; checked in IHDR before anything is inflated. */
export const PNG_MAX_PIXELS = 1_000_000;
/** The longest side, in pixels, a PNG photo is kept at: the card photo is 27 mm across, about 320 px at 300 dpi. */
export const PHOTO_MAX_SIDE = 320;

/**
 * A PNG as a small PDF image. Every PNG is decoded here, flattened onto white (alpha channels, and
 * palette alpha from tRNS) and box-downscaled so its longest side is at most PHOTO_MAX_SIDE; only
 * that small RGB image is kept, so a batch of cards never holds full-size photos. The decoded size
 * is bounded before inflating: at most PNG_MAX_PIXELS, and the inflate may not produce one byte
 * more than the declared rows. Interlaced PNGs, 16-bit samples and a colour-key tRNS on gray or RGB
 * are not placed (null).
 */
export function readPng(bytes: Buffer): PdfImage | null {
  const SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 33 || !bytes.subarray(0, 8).equals(SIGNATURE)) return null;
  let i = 8, width = 0, height = 0, bits = 0, type = -1, interlace = 0, palette: Buffer | null = null, alpha: Buffer | null = null;
  const idat: Buffer[] = [];
  while (i + 12 <= bytes.length) {
    const size = bytes.readUInt32BE(i), kind = bytes.toString("latin1", i + 4, i + 8), data = bytes.subarray(i + 8, i + 8 + size);
    if (i + 12 + size > bytes.length) return null;
    if (kind === "IHDR") { if (size !== 13) return null; width = data.readUInt32BE(0); height = data.readUInt32BE(4); bits = data[8]!; type = data[9]!; interlace = data[12]!; }
    else if (kind === "PLTE") palette = Buffer.from(data);
    else if (kind === "tRNS") alpha = Buffer.from(data);
    else if (kind === "IDAT") idat.push(data);
    else if (kind === "IEND") break;
    i += 12 + size;
  }
  const channels = type === 0 || type === 3 ? 1 : type === 2 ? 3 : type === 4 ? 2 : type === 6 ? 4 : 0;
  if (!channels || !width || !height || width * height > PNG_MAX_PIXELS || interlace !== 0 || bits !== 8 || !idat.length) return null;
  if (alpha && type !== 3) return null;
  let colours: Buffer | null = null;
  if (type === 3) {
    if (!palette || palette.length % 3 || palette.length > 768 || (alpha && alpha.length > palette.length / 3)) return null;
    // Palette transparency: blend each entry onto white, as the alpha path does per pixel.
    colours = palette;
    for (let e = 0; alpha && e < alpha.length; e++) for (let k = 0; k < 3; k++) colours[e * 3 + k] = Math.round(colours[e * 3 + k]! * alpha[e]! / 255 + 255 * (1 - alpha[e]! / 255));
  }
  const stride = width * channels, expected = (stride + 1) * height;
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected }); } catch { return null; }
  if (raw.length !== expected) return null;
  // Box-downscale while undoing the PNG filters row by row: only the previous row and the small output are held.
  const scale = Math.min(1, PHOTO_MAX_SIDE / Math.max(width, height));
  const outW = Math.max(1, Math.round(width * scale)), outH = Math.max(1, Math.round(height * scale));
  const sums = new Float64Array(outW * outH * 3), counts = new Uint32Array(outW * outH);
  let prev = Buffer.alloc(stride), line = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)]!, src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? line[x - channels]! : 0, b = prev[x]!, c = x >= channels ? prev[x - channels]! : 0;
      const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
      const predictor = filter === 0 ? 0 : filter === 1 ? a : filter === 2 ? b : filter === 3 ? (a + b) >> 1 : filter === 4 ? (pa <= pb && pa <= pc ? a : pb <= pc ? b : c) : -1;
      if (predictor < 0) return null;
      line[x] = (src[x]! + predictor) & 0xff;
    }
    const oy = Math.min(outH - 1, Math.floor(y * outH / height));
    for (let x = 0; x < width; x++) {
      const o = oy * outW + Math.min(outW - 1, Math.floor(x * outW / width)), at = x * channels;
      let rgb: [number, number, number];
      if (colours) { const e = line[at]!; if (e * 3 + 2 >= colours.length) return null; rgb = [colours[e * 3]!, colours[e * 3 + 1]!, colours[e * 3 + 2]!]; }
      else {
        const opacity = channels === 2 || channels === 4 ? line[at + channels - 1]! / 255 : 1;
        const flat = (v: number) => v * opacity + 255 * (1 - opacity);
        rgb = channels <= 2 ? [flat(line[at]!), flat(line[at]!), flat(line[at]!)] : [flat(line[at]!), flat(line[at + 1]!), flat(line[at + 2]!)];
      }
      sums[o * 3] += rgb[0]; sums[o * 3 + 1] += rgb[1]; sums[o * 3 + 2] += rgb[2]; counts[o]!++;
    }
    [prev, line] = [line, prev];
  }
  const out = Buffer.alloc(outW * outH * 3);
  for (let o = 0; o < outW * outH; o++) for (let k = 0; k < 3; k++) out[o * 3 + k] = Math.round(sums[o * 3 + k]! / counts[o]!);
  return { width: outW, height: outH, bits: 8, colorSpace: "/DeviceRGB", filter: "FlateDecode", data: deflateSync(out) };
}

/** A JPEG or PNG photo as a PDF image, or null. */
export const readImage = (bytes: Buffer, mime: string): PdfImage | null => mime === "image/jpeg" ? readJpeg(bytes) : mime === "image/png" ? readPng(bytes) : null;
