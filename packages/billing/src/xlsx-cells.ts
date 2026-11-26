import { inflateRawSync } from "node:zlib";
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

export type XlsxRead =
  | { readonly kind: "cells"; readonly cells: BankCell[][] }
  | { readonly kind: "refused"; readonly code: "unreadable" | "too_many_rows" | "too_large" };
const refused = (code: "unreadable" | "too_many_rows" | "too_large"): XlsxRead => ({ kind: "refused", code });

interface Entry { readonly method: number; readonly compressed: number; readonly size: number; readonly offset: number }

function entries(zip: Buffer): Map<string, Entry> | null {
  // End of central directory: the last 22 bytes, or earlier when a comment follows.
  let eocd = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return null;
  const count = zip.readUInt16LE(eocd + 10);
  let at = zip.readUInt32LE(eocd + 16);
  const found = new Map<string, Entry>();
  for (let n = 0; n < count; n++) {
    if (at + 46 > zip.length || zip.readUInt32LE(at) !== 0x02014b50) return null;
    const flags = zip.readUInt16LE(at + 8), method = zip.readUInt16LE(at + 10);
    const compressed = zip.readUInt32LE(at + 20), size = zip.readUInt32LE(at + 24);
    const nameLength = zip.readUInt16LE(at + 28), extra = zip.readUInt16LE(at + 30), comment = zip.readUInt16LE(at + 32);
    const offset = zip.readUInt32LE(at + 42);
    if (flags & 1) return null; // encrypted
    const name = zip.subarray(at + 46, at + 46 + nameLength).toString("utf8");
    found.set(name, { method, compressed, size, offset });
    at += 46 + nameLength + extra + comment;
  }
  return found;
}

function read(zip: Buffer, all: Map<string, Entry>, name: string): string | null {
  const entry = all.get(name);
  if (!entry || entry.size > MAX_ENTRY_BYTES) return null;
  const local = entry.offset;
  if (local + 30 > zip.length || zip.readUInt32LE(local) !== 0x04034b50) return null;
  const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
  const data = zip.subarray(start, start + entry.compressed);
  if (data.length !== entry.compressed) return null;
  try {
    if (entry.method === 0) return data.toString("utf8");
    if (entry.method === 8) return inflateRawSync(data, { maxOutputLength: MAX_ENTRY_BYTES }).toString("utf8");
  } catch { return null; }
  return null;
}

const ENTITY: Readonly<Record<string, string>> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };
/** A numeric reference past Unicode is not a character: it reads as U+FFFD instead of throwing. */
const codePoint = (n: number): string => (Number.isInteger(n) && n >= 0 && n <= 0x10ffff ? String.fromCodePoint(n) : "\uFFFD");
function text(xml: string): string {
  return xml.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);/gu, (_, e: string) =>
    e.startsWith("#x") ? codePoint(parseInt(e.slice(2), 16))
      : e.startsWith("#") ? codePoint(parseInt(e.slice(1), 10)) : ENTITY[e]!);
}
/** All <t> text of one string item, rich-text runs joined; phonetic runs dropped. */
function itemText(xml: string): string {
  return [...xml.replace(/<rPh\b[\s\S]*?<\/rPh>/gu, "").matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>|<t(?:\s[^>]*)?\/>/gu)]
    .map((m) => text(m[1] ?? "")).join("");
}
const attr = (tag: string, name: string): string | null => new RegExp(`\\s${name}="([^"]*)"`, "u").exec(tag)?.[1] ?? null;

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
  const sheet = /<sheet\b[^>]*>/u.exec(workbook)?.[0];
  const id = sheet ? attr(sheet, "r:id") : null;
  if (!id) return null;
  const rel = [...rels.matchAll(/<Relationship\b[^>]*>/gu)].map((m) => m[0]).find((r) => attr(r, "Id") === id);
  const target = rel ? attr(rel, "Target") : null;
  if (!target) return null;
  const path = target.startsWith("/") ? target.slice(1) : `xl/${target}`;
  return read(zip, all, path.replace(/\/\.\//gu, "/"));
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
  const sharedXml = read(zip, all, "xl/sharedStrings.xml");
  const shared = sharedXml === null ? [] : [...sharedXml.matchAll(/<si>([\s\S]*?)<\/si>|<si\/>/gu)].map((m) => itemText(m[1] ?? ""));
  const grid: BankCell[][] = [];
  let chars = 0;
  for (const row of sheet.matchAll(/<row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/row>)/gu)) {
    // `r` is optional in SpreadsheetML: a row without it follows the previous one.
    const rowRef = attr(row[1]!, "r");
    const r = rowRef === null ? grid.length + 1 : /^[1-9][0-9]{0,6}$/u.test(rowRef) ? Number(rowRef) : NaN;
    if (!Number.isInteger(r)) return refused("unreadable");
    // Rows only go forward: a repeated or earlier row number would replace data already read.
    if (r <= grid.length) return refused("unreadable");
    if (r > MAX_ROWS) return refused("too_many_rows");
    const cells: BankCell[] = [];
    for (const c of (row[2] ?? "").matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/gu)) {
      const ref = attr(c[1]!, "r"), type = attr(c[1]!, "t") ?? "n", body = c[2] ?? "";
      const at = ref === null ? { col: cells.length, row: r } : coordinate(ref);
      // A cell must sit in its own row, after the cells before it.
      if (at === null || at.row !== r || at.col < cells.length) return refused("unreadable");
      if (at.col >= MAX_COLUMNS) return refused("unreadable");
      const v = /<v>([\s\S]*?)<\/v>/u.exec(body)?.[1];
      let value: BankCell = null;
      if (type === "s") {
        const i = v === undefined ? NaN : Number(v);
        if (!Number.isInteger(i) || i < 0 || i >= shared.length) return refused("unreadable");
        value = shared[i]!;
      } else if (type === "inlineStr") value = itemText(/<is>([\s\S]*?)<\/is>/u.exec(body)?.[1] ?? "");
      else if (v !== undefined) value = text(v); // n, str, b, e: the cached text as written
      if (typeof value === "string") {
        if (value.length > XLSX_MAX_FIELD_CHARS) return refused("too_large");
        if ((chars += value.length) > MAX_GRID_CHARS) return refused("too_large");
      }
      while (cells.length < at.col) cells.push(null);
      cells[at.col] = value;
    }
    while (grid.length < r - 1) grid.push([]);
    grid[r - 1] = cells;
  }
  return { kind: "cells", cells: grid };
}
