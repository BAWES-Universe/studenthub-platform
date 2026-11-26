import { crc32, inflateRawSync } from "node:zlib";
import type { BankCell } from "./bank-results.js";

/**
 * The first worksheet of an .xlsx workbook as a grid of cells, for the bank
 * result reader. Only what a bank export needs: shared strings, inline strings,
 * numbers and booleans as their text. No formulas are evaluated (a cached value
 * is read as written), no styles, no dates. Bounded: the archive, every entry
 * it inflates, and the grid are capped, so a hostile file is refused, not read.
 * Strict: rows and cells must be in ascending order with coordinates that agree,
 * so nothing is ever silently replaced. Each field and the whole materialized grid
 * are capped. Anything else is a refusal with a reason, never an exception.
 */
export const XLSX_MAX_BYTES = 5 * 1024 * 1024;
const MAX_ENTRY_BYTES = 20 * 1024 * 1024;
const MAX_COLUMNS = 64;
const MAX_ROWS = 10_010;
/** No bank field is anywhere near this long; a longer one is refused, not cut. */
export const XLSX_MAX_FIELD_CHARS = 1024;
/** Characters of cell text across the whole grid (shared strings can repeat one long text many times). */
const MAX_GRID_CHARS = 2_000_000;
/** Distinct shared strings: no more than the cells a sheet may hold. */
const MAX_SHARED_STRINGS = MAX_ROWS * MAX_COLUMNS;

export type XlsxRead =
  | { readonly kind: "cells"; readonly cells: BankCell[][] }
  | { readonly kind: "refused"; readonly code: "unreadable" | "too_many_rows" | "too_large" };
const refused = (code: "unreadable" | "too_many_rows" | "too_large"): XlsxRead => ({ kind: "refused", code });

interface Entry { readonly name: string; readonly flags: number; readonly method: number; readonly crc: number; readonly compressed: number; readonly size: number; readonly offset: number }

/** The key a part name is found by: case, `\` and leading `/` folded, so two spellings of one part collide. */
function partKey(name: string): string | null {
  const parts = name.replace(/\\/gu, "/").replace(/^\/+/u, "").toLowerCase().split("/").filter((p) => p !== "" && p !== ".");
  return parts.length === 0 || parts.includes("..") ? null : parts.join("/");
}

/** The central directory, keyed by part. Refused: a second directory end, multi-disk or zip64 archives,
 * encryption, and any part name that is malformed or collides with another once normalized. */
function entries(zip: Buffer): Map<string, Entry> | null {
  // End of central directory: the last 22 bytes, or earlier when a comment follows.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0 || eocd + 22 + zip.readUInt16LE(eocd + 20) !== zip.length) return null;
  const disk = zip.readUInt16LE(eocd + 4), dirDisk = zip.readUInt16LE(eocd + 6);
  const onDisk = zip.readUInt16LE(eocd + 8), count = zip.readUInt16LE(eocd + 10);
  const dirSize = zip.readUInt32LE(eocd + 12), dirStart = zip.readUInt32LE(eocd + 16);
  if (disk !== 0 || dirDisk !== 0 || onDisk !== count || count === 0xffff || dirStart === 0xffffffff || dirStart + dirSize !== eocd) return null;
  let at = dirStart;
  const found = new Map<string, Entry>();
  for (let n = 0; n < count; n++) {
    if (at + 46 > eocd || zip.readUInt32LE(at) !== 0x02014b50) return null;
    const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10), crc = zip.readUInt32LE(at + 16);
    const compressed = zip.readUInt32LE(at + 20), size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32);
    const offset = zip.readUInt32LE(at + 42);
    if (flags & 1 || compressed === 0xffffffff || size === 0xffffffff || offset === 0xffffffff) return null; // encrypted or zip64
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    const key = partKey(name);
    if (key === null || found.has(key)) return null;
    found.set(key, { name, flags, method, crc, compressed, size, offset });
    at += 46 + nameLength + extra + comment;
  }
  return at === eocd ? found : null;
}

/** One part, inflated and checked against its declared integrity: the local header names the same part with
 * the same method, and the CRC-32 and both sizes (local header, or data descriptor when bit 3 is set) agree
 * with the central directory and with the bytes inflated. Anything else is null. */
function read(zip: Buffer, all: Map<string, Entry>, name: string): string | null {
  const key = partKey(name);
  const entry = key === null ? undefined : all.get(key);
  if (!entry || entry.size > MAX_ENTRY_BYTES || (entry.method !== 0 && entry.method !== 8)) return null;
  const local = entry.offset;
  if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) return null;
  const localFlags = zip.readUInt16LE(local + 6), localMethod = zip.readUInt16LE(local + 8);
  const nameLength = zip.readUInt16LE(local + 26), extra = zip.readUInt16LE(local + 28);
  if (localMethod !== entry.method || (localFlags & 8) !== (entry.flags & 8) || localFlags & 1) return null;
  if (zip.subarray(local + 30, local + 30 + nameLength).toString("utf8") !== entry.name) return null;
  const start = local + 30 + nameLength + extra;
  const data = zip.subarray(start, start + entry.compressed);
  if (data.length !== entry.compressed) return null;
  let declared: { crc: number; compressed: number; size: number };
  if (entry.flags & 8) {
    // Data descriptor after the data, with or without its signature.
    let d = start + entry.compressed;
    if (d + 4 <= zip.length && zip.readUInt32LE(d) === 0x08074b50) d += 4;
    if (d + 12 > zip.length) return null;
    declared = { crc: zip.readUInt32LE(d), compressed: zip.readUInt32LE(d + 4), size: zip.readUInt32LE(d + 8) };
  } else declared = { crc: zip.readUInt32LE(local + 14), compressed: zip.readUInt32LE(local + 18), size: zip.readUInt32LE(local + 22) };
  if (declared.crc !== entry.crc || declared.compressed !== entry.compressed || declared.size !== entry.size) return null;
  let bytes: Buffer;
  try { bytes = entry.method === 0 ? data : inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }); } catch { return null; }
  if (bytes.length !== entry.size || (crc32(bytes) >>> 0) !== entry.crc) return null;
  return bytes.toString("utf8");
}

const ENTITY: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
/** A numeric reference past Unicode is not a character: it reads as U+FFFD instead of throwing. */
const codePoint = (n: number): string => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "\uFFFD");
function text(xml: string): string {
  return xml.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/gu, (_, e: string) =>
    e.startsWith("#x") ? codePoint(parseInt(e.slice(2), 16))
      : e.startsWith("#") ? codePoint(parseInt(e.slice(1), 10)) : ENTITY[e]!);
}

/** `B12` as column 1 of row 12; null for anything else. */
function coordinate(ref: string): { readonly col: number; readonly row: number } | null {
  const match = /^([A-Z]{1,3})([1-9][0-9]{0,6})$/u.exec(ref);
  if (!match) return null;
  let n = 0;
  for (const c of match[1]!) n = n * 26 + (c.charCodeAt(0) - 64);
  return { col: n - 1, row: Number(match[2]) };
}

/** The first sheet in workbook order, through the workbook's relationships. */
function firstSheet(zip: Buffer, all: Map<string, Entry>): string | null {
  const workbook = read(zip, all, "xl/workbook.xml");
  const rels = read(zip, all, "xl/_rels/workbook.xml.rels");
  if (!workbook || !rels) return null;
  let id: string | null = null;
  if (!scanXml(workbook, { open(name, attrs) { if (name === "sheet" && id === null) id = attrs.get("r:id") ?? ""; return true; }, close: () => true, text: () => true }) || !id) return null;
  const targets = new Map<string, string>();
  const relsOk = scanXml(rels, { open(name, attrs) {
    if (name !== "Relationship") return true;
    const key = attrs.get("Id"), target = attrs.get("Target");
    if (key === undefined || target === undefined || targets.has(key)) return false;
    targets.set(key, target); return true;
  }, close: () => true, text: () => true });
  const target = relsOk ? targets.get(id) : undefined;
  if (!target) return null;
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  return read(zip, all, path.replace(/\/\.\//gu, "/"));
}

/**
 * One linear pass over an XML part. Calls `open` for each start tag (and `close` right after a
 * self-closing one), `close` for each end tag, and `text` for character data inside the root.
 * Comments and processing instructions are skipped; DOCTYPE, CDATA, mismatched or unclosed tags,
 * a second root or text outside the root are malformed. False when malformed or a handler refuses,
 * so a truncated part is never read as a shorter one.
 */
interface XmlHandler { open(name: string, attrs: ReadonlyMap<string, string>): boolean; close(name: string): boolean; text(raw: string): boolean }
const TAG_NAME = /^[A-Za-z_][\w.:-]*/u;
const ATTRIBUTE = /\s+([A-Za-z_][\w.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/uy;
/** The one attribute grammar: either quote style, spaces around `=`, values decoded; null when anything else is in the
 * tag (a stray `<`, an unquoted value) or an attribute is named twice (which one did the writer mean?). */
function attributes(rest: string): Map<string, string> | null {
  const map = new Map<string, string>();
  let at = 0;
  for (;;) {
    ATTRIBUTE.lastIndex = at;
    const match = ATTRIBUTE.exec(rest);
    if (!match) break;
    if (map.has(match[1]!)) return null;
    map.set(match[1]!, text(match[2] ?? match[3] ?? ""));
    at = ATTRIBUTE.lastIndex;
  }
  return /^\s*$/u.test(rest.slice(at)) ? map : null;
}
/** SpreadsheetML cell types; anything else is not a cell this reader understands. */
const CELL_TYPES: ReadonlySet<string> = new Set(["n", "s", "str", "inlineStr", "b", "e", "d"]);
const localName = (qualified: string) => qualified.slice(qualified.indexOf(":") + 1);
function scanXml(xml: string, handler: XmlHandler): boolean {
  const stack: string[] = [];
  let at = 0, rooted = false;
  while (at < xml.length) {
    const lt = xml.indexOf("<", at);
    const stop = lt < 0 ? xml.length : lt;
    if (stop > at) {
      const raw = xml.slice(at, stop);
      if (stack.length === 0) { if (raw.trim() !== "") return false; }
      else if (!handler.text(raw)) return false;
    }
    if (lt < 0) break;
    if (xml.startsWith("<!--", lt)) { const end = xml.indexOf("-->", lt + 4); if (end < 0) return false; at = end + 3; continue; }
    if (xml.startsWith("<?", lt)) { const end = xml.indexOf("?>", lt + 2); if (end < 0) return false; at = end + 2; continue; }
    if (xml.startsWith("<!", lt)) return false;
    let gt = lt + 1, quote = "";
    for (; gt < xml.length; gt++) {
      const ch = xml[gt];
      if (quote) { if (ch === quote) quote = ""; } else if (ch === "\"" || ch === "'") quote = ch; else if (ch === ">") break;
    }
    if (gt >= xml.length) return false;
    const inner = xml.slice(lt + 1, gt);
    at = gt + 1;
    if (inner.startsWith("/")) {
      const name = /^\/([A-Za-z_][\w.:-]*)\s*$/u.exec(inner)?.[1];
      if (!name) return false;
      if (stack.pop() !== name || !handler.close(localName(name))) return false;
      continue;
    }
    // A start tag is a name and well-formed attributes only: a stray `<` (a tag cut short) is malformed.
    const selfClosing = inner.endsWith("/");
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const name = TAG_NAME.exec(body)?.[0];
    const attrs = name === undefined ? null : attributes(body.slice(name.length));
    if (name === undefined || attrs === null) return false;
    if (stack.length === 0 && rooted) return false;
    rooted = true;
    if (!handler.open(localName(name), attrs)) return false;
    if (selfClosing) { if (!handler.close(localName(name))) return false; } else stack.push(name);
  }
  return rooted && stack.length === 0;
}

/** Text of a string item (<si> or <is>): every <t>, rich runs joined, phonetic runs dropped. */
class StringItem {
  private parts: string[] = []; private size = 0; private collecting = false; private phonetic = 0;
  open(name: string): void { if (name === "rPh") this.phonetic++; else if (name === "t" && this.phonetic === 0) this.collecting = true; }
  close(name: string): void { if (name === "rPh") this.phonetic--; else if (name === "t") this.collecting = false; }
  /** False once the raw text could not fit a field (decoded text is never longer than raw). */
  text(raw: string): boolean {
    if (!this.collecting) return true;
    this.parts.push(raw); this.size += raw.length;
    return this.size <= XLSX_MAX_FIELD_CHARS * 8;
  }
  value(): string { return text(this.parts.join("")); }
}

/** Shared strings, read incrementally: each item is checked against the field cap, the item count
 * and the total text before it is kept. */
function sharedStrings(xml: string): string[] | "unreadable" | "too_large" {
  const items: string[] = [];
  let item: StringItem | null = null, total = 0, verdict: "unreadable" | "too_large" = "unreadable";
  const ok = scanXml(xml, {
    open(name) {
      if (name === "si") { if (item) return false; item = new StringItem(); return true; }
      item?.open(name); return true;
    },
    close(name) {
      if (name !== "si") { item?.close(name); return true; }
      const value = item!.value(); item = null;
      if (value.length > XLSX_MAX_FIELD_CHARS || items.length >= MAX_SHARED_STRINGS || (total += value.length) > MAX_GRID_CHARS) { verdict = "too_large"; return false; }
      items.push(value); return true;
    },
    text(raw) { if (item && !item.text(raw)) { verdict = "too_large"; return false; } return true; },
  });
  return ok ? items : verdict;
}

export function readXlsxCells(bytes: Uint8Array): XlsxRead {
  if (bytes.length > XLSX_MAX_BYTES) return refused("too_large");
  if (bytes.length === 0) return refused("unreadable");
  const zip = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length);
  let all: Map<string, Entry> | null;
  try { all = entries(zip); } catch { return refused("unreadable"); }
  if (!all) return refused("unreadable");
  const sheet = firstSheet(zip, all);
  if (sheet === null) return refused("unreadable");
  // The shared-strings part is optional; present but unreadable is a broken file, never "no shared strings".
  const sharedPresent = all.has(partKey("xl/sharedStrings.xml")!);
  const sharedXml = sharedPresent ? read(zip, all, "xl/sharedStrings.xml") : null;
  if (sharedPresent && sharedXml === null) return refused("unreadable");
  const shared = sharedXml === null ? [] : sharedStrings(sharedXml);
  if (!Array.isArray(shared)) return refused(shared);

  const grid: BankCell[][] = [];
  const path: string[] = [];
  let verdict: "unreadable" | "too_many_rows" | "too_large" = "unreadable";
  let sheetData = false, chars = 0, r = 0;
  let cells: BankCell[] | null = null;
  let cell: { col: number; type: string; v: string[] | null; vSize: number; inline: StringItem | null } | null = null;
  const fail = (code: "unreadable" | "too_many_rows" | "too_large") => { verdict = code; return false; };
  const parent = () => path[path.length - 1];
  const ok = scanXml(sheet, {
    open(name, attrs) {
      const within = parent();
      path.push(name);
      if (name === "sheetData" && within === "worksheet") { if (sheetData) return false; sheetData = true; return true; }
      if (name === "row" && within === "sheetData") {
        // `r` is optional in SpreadsheetML: a row without it follows the previous one.
        const rowRef = attrs.get("r") ?? null;
        const next = rowRef === null ? grid.length + 1 : /^[1-9][0-9]{0,6}$/u.test(rowRef) ? Number(rowRef) : NaN;
        // Rows only go forward: a repeated or earlier row number would replace data already read.
        if (!Number.isInteger(next) || next <= grid.length) return fail("unreadable");
        if (next > MAX_ROWS) return fail("too_many_rows");
        r = next; cells = [];
        return true;
      }
      if (name === "row" || name === "c" ? cell !== null || (name === "row" && cells !== null) : false) return false; // no nesting
      if (name === "c" && within !== "row") return false;
      if (name === "c" && within === "row" && cells) {
        const ref = attrs.get("r") ?? null;
        const at = ref === null ? { col: cells.length, row: r } : coordinate(ref);
        // A cell must sit in its own row, after the cells before it.
        if (at === null || at.row !== r || at.col < cells.length || at.col >= MAX_COLUMNS) return fail("unreadable");
        cell = { col: at.col, type: attrs.get("t") ?? "n", v: null, vSize: 0, inline: null };
        return true;
      }
      if (cell && name === "v" && within === "c") { if (cell.v) return false; cell.v = []; return true; }
      if (cell && name === "is" && within === "c") { if (cell.inline) return false; cell.inline = new StringItem(); return true; }
      cell?.inline?.open(name);
      return true;
    },
    close(name) {
      path.pop();
      if (cell && name !== "c") { cell.inline?.close(name); return true; }
      if (cell && name === "c" && cells) {
        const { col, type, v, inline } = cell; cell = null;
        // The markup must agree with the declared type: an inline string only in `<is>`, every other value only in `<v>`.
        if (!CELL_TYPES.has(type) || (type === "inlineStr") !== (inline !== null) || (type === "inlineStr" && v !== null)) return fail("unreadable");
        const raw = v === null ? undefined : v.join("");
        let value: BankCell = null;
        if (type === "s") {
          const i = raw === undefined ? NaN : Number(raw);
          if (!Number.isInteger(i) || i < 0 || i >= shared.length) return fail("unreadable");
          value = shared[i]!;
        } else if (type === "inlineStr") value = inline ? inline.value() : "";
        else if (raw !== undefined) value = text(raw); // n, str, b, e: the cached text as written
        // A cell that carries a value never reads as empty: content that decodes to nothing is refused, not skipped.
        if ((v !== null || inline !== null) && (typeof value !== "string" || value.trim() === "")) return fail("unreadable");
        if (typeof value === "string" && (value.length > XLSX_MAX_FIELD_CHARS || (chars += value.length) > MAX_GRID_CHARS)) return fail("too_large");
        while (cells.length < col) cells.push(null);
        cells[col] = value;
        return true;
      }
      if (name === "row" && cells) {
        while (grid.length < r - 1) grid.push([]);
        grid[r - 1] = cells; cells = null;
      }
      return true;
    },
    text(raw) {
      if (!cell) return true;
      if (cell.inline) { if (!cell.inline.text(raw)) return fail("too_large"); return true; }
      if (cell.v && parent() === "v") {
        cell.v.push(raw);
        if ((cell.vSize += raw.length) > XLSX_MAX_FIELD_CHARS * 8) return fail("too_large");
      }
      return true;
    },
  });
  if (!ok) return refused(verdict);
  // A worksheet without sheetData is not a bank sheet.
  return sheetData ? { kind: "cells", cells: grid } : refused("unreadable");
}
