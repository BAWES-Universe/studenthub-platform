import assert from "node:assert/strict";
import { crc32, deflateRawSync } from "node:zlib";
import { test } from "node:test";
import { AUB_RESULT_COLUMNS, readBankResultSheet } from "../src/bank-results.js";
import { readFileSync } from "node:fs";
import { XLSX_MAX_BYTES, XLSX_MAX_FIELD_CHARS, readXlsxCells } from "../src/xlsx-cells.js";

// Synthetic workbooks only: statuses, references and line ids are made up.
type Cell = { value: string | number | null; type?: StringConstructor | NumberConstructor } | null;
async function workbook(rows: (string | number | null)[][]): Promise<Uint8Array> {
  const { default: writeExcelFile } = await import("write-excel-file/node");
  const data: Cell[][] = rows.map((row) => row.map((value) => (value === null ? null : { value, type: typeof value === "number" ? Number : String })));
  return new Uint8Array(await writeExcelFile(data as never, { sheet: "Result" }).toBuffer());
}

/** The grid, or the refusal code. */
const cellsOf = (bytes: Uint8Array) => { const read = readXlsxCells(bytes); return read.kind === "cells" ? read.cells : read.code; };

/** A minimal zip of named text entries, deflated or stored. `tamper` edits one entry's headers or bytes after they are built. */
type Tamper = (entry: { name: string; local: Buffer; central: Buffer; body: Buffer }) => void;
function zip(files: Record<string, string> | readonly (readonly [string, string])[], stored = false, tamper?: Tamper): Uint8Array {
  const locals: Buffer[] = [], centrals: Buffer[] = [];
  const list = Array.isArray(files) ? files : Object.entries(files);
  let offset = 0;
  for (const [name, content] of list) {
    const raw = Buffer.from(content, "utf8"), body = stored ? Buffer.from(raw) : deflateRawSync(raw), nameBytes = Buffer.from(name, "utf8");
    const crc = crc32(raw) >>> 0;
    const local = Buffer.alloc(30); local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(stored ? 0 : 8, 8); local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(nameBytes.length, 26);
    const central = Buffer.alloc(46); central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(stored ? 0 : 8, 10); central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(nameBytes.length, 28); central.writeUInt32LE(offset, 42);
    tamper?.({ name, local, central, body });
    locals.push(local, Buffer.from(nameBytes), body); centrals.push(central, nameBytes);
    offset += 30 + nameBytes.length + body.length;
  }
  const dir = Buffer.concat(centrals), end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(list.length, 8); end.writeUInt16LE(list.length, 10);
  end.writeUInt32LE(dir.length, 12); end.writeUInt32LE(offset, 16);
  return new Uint8Array(Buffer.concat([...locals, dir, end]));
}
const book = (sheet: string, shared?: string, sheetPath = "worksheets/sheet1.xml") => ({
  "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name="A" sheetId="1" r:id="rId7"/></sheets></workbook>`,
  "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId1" Target="styles.xml"/><Relationship Id="rId7" Target="${sheetPath}"/></Relationships>`,
  [`xl/${sheetPath}`]: `<worksheet><sheetData>${sheet}</sheetData></worksheet>`,
  ...(shared === undefined ? {} : { "xl/sharedStrings.xml": `<sst>${shared}</sst>` }),
});

test("XLSX_ROUNDTRIP a workbook a spreadsheet program writes reads back as the AUB layout the bank result reader expects", async () => {
  const first = ["Status", "Status Description", "Debit Narrative", "Credit Narrative"];
  const head = [...first, ...AUB_RESULT_COLUMNS.filter((c) => !first.includes(c))];
  const bytes = await workbook([
    [null, null, null, null],
    head,
    ["SUCCESS", "REF-1", "Salary", "L-1"],
    ["FAIL", "Account closed", "Salary", "L-2"],
  ]);
  const cells = cellsOf(bytes);
  assert.ok(Array.isArray(cells));
  assert.deepEqual(cells.slice(1), [head, ["SUCCESS", "REF-1", "Salary", "L-1"], ["FAIL", "Account closed", "Salary", "L-2"]]);
  const sheet = readBankResultSheet("aub", cells);
  assert.equal(sheet.kind, "read");
  assert.deepEqual(sheet.kind === "read" && sheet.rows.map((r) => [r.rowNumber, r.outcome, r.reference, r.lineRef]),
    [[3, "success", "REF-1", "L-1"], [4, "fail", "Account closed", "L-2"]]);
});

test("XLSX_CELLS shared, inline and rich strings, numbers, gaps and entities keep their place and their text", () => {
  const cells = cellsOf(zip(book(
    `<row r="2"><c r="A2" t="s"><v>0</v></c><c r="C2" t="inlineStr"><is><t>in &amp; out</t></is></c></row>`
    + `<row r="4"><c r="B4"><v>120.5</v></c><c r="D4" t="s"><v>1</v></c><c r="E4" t="b"><v>1</v></c><c r="F4"/></row>`,
    `<si><t>Status</t></si><si><r><t>RE</t></r><r><t xml:space="preserve">F-&#x31;</t></r><rPh><t>x</t></rPh></si>`)));
  assert.deepEqual(cells, [[], ["Status", null, "in & out"], [], [null, "120.5", null, "REF-1", "1", null]]);
  assert.deepEqual(cellsOf(zip(book(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`, "<si><t>stored</t></si>"), true)), [["stored"]]);
  assert.deepEqual(cellsOf(zip(book(`<row r="1"><c r="A1"><v>7</v></c></row>`, undefined, "worksheets/other.xml"))), [["7"]]);
  assert.deepEqual(cellsOf(zip(book(`<row><c><v>1</v></c></row><row r="3"><c><v>3</v></c></row><row><c><v>4</v></c></row>`))), [["1"], [], ["3"], ["4"]],
    "a row without r follows the previous row");
  assert.deepEqual(cellsOf(zip(book(`<row r="1"><c r="A1" t="inlineStr"><is><t>a&#x110000;b&#99999999999;c&#x41;</t></is></c></row>`))), [["a\uFFFDb\uFFFDcA"]],
    "a numeric reference past Unicode reads as U+FFFD, not an exception");
});

test("XLSX_REFUSED anything that is not a readable, bounded workbook is refused, not guessed", () => {
  assert.equal(cellsOf(new Uint8Array()), "unreadable");
  assert.equal(cellsOf(new TextEncoder().encode("Status,Reference\nSUCCESS,REF-1\n")), "unreadable");
  assert.equal(cellsOf(new Uint8Array(XLSX_MAX_BYTES + 1)), "too_large");
  const files = book(`<row r="1"><c r="A1" t="s"><v>0</v></c></row>`, "<si><t>x</t></si>");
  const { ["xl/_rels/workbook.xml.rels"]: _rels, ...noRels } = files;
  assert.equal(cellsOf(zip(noRels)), "unreadable", "no relationships");
  assert.equal(cellsOf(zip(book(`<row r="1"><c r="A1" t="s"><v>3</v></c></row>`, "<si><t>x</t></si>"))), "unreadable", "shared index out of range");
  assert.equal(cellsOf(zip(book(`<row r="1"><c r="ZZ1"><v>1</v></c></row>`))), "unreadable", "too many columns");
  assert.equal(cellsOf(zip(book(`<row r="20000"><c r="A20000"><v>1</v></c></row>`))), "too_many_rows", "too many rows");
  const bomb = Buffer.from(zip({ ...files, "xl/sharedStrings.xml": `<sst><si><t>${"a".repeat(21 * 1024 * 1024)}</t></si></sst>` }));
  assert.ok(bomb.length < XLSX_MAX_BYTES);
  assert.equal(cellsOf(bomb), "unreadable", "an entry that inflates past its cap");
});

test("XLSX_STRICT rows and cells out of order, repeated or in the wrong row, and oversized text, are refused, never replaced", () => {
  const one = (sheet: string, shared?: string) => cellsOf(zip(book(sheet, shared)));
  assert.equal(one(`<row r="2"><c r="A2"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>`), "unreadable", "a repeated row");
  assert.equal(one(`<row r="3"><c r="A3"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row>`), "unreadable", "a row going back");
  assert.equal(one(`<row r="1"><c r="B1"><v>1</v></c><c r="B1"><v>2</v></c></row>`), "unreadable", "a repeated cell");
  assert.equal(one(`<row r="1"><c r="C1"><v>1</v></c><c r="B1"><v>2</v></c></row>`), "unreadable", "a cell going back");
  assert.equal(one(`<row r="1"><c r="B1"><v>1</v></c><c><v>2</v></c><c r="C1"><v>3</v></c></row>`), "unreadable", "an implicit cell then the same coordinate");
  assert.equal(one(`<row r="1"><c r="A2"><v>1</v></c></row>`), "unreadable", "a cell in another row");
  assert.equal(one(`<row r="0"><c><v>1</v></c></row>`), "unreadable", "row zero");
  assert.equal(one(`<row r="1x"><c><v>1</v></c></row>`), "unreadable", "a malformed row number");
  assert.equal(one(`<row r="10011"><c><v>1</v></c></row>`), "too_many_rows");
  assert.deepEqual(one(`<row r="10010"><c><v>1</v></c></row>`)?.length, 10010);
  assert.equal(one(`<row r="1"><c t="inlineStr"><is><t>${"x".repeat(XLSX_MAX_FIELD_CHARS + 1)}</t></is></c></row>`), "too_large", "one field too long");
  assert.deepEqual(one(`<row r="1"><c t="inlineStr"><is><t>${"x".repeat(XLSX_MAX_FIELD_CHARS)}</t></is></c></row>`), [["x".repeat(XLSX_MAX_FIELD_CHARS)]]);
  const repeated = Array.from({ length: 2100 }, (_, i) => `<row r="${i + 1}"><c t="s"><v>0</v></c></row>`).join("");
  assert.equal(one(repeated, `<si><t>${"y".repeat(1000)}</t></si>`), "too_large", "one shared string repeated past the grid cap");
});

/** Decoded cell matrices from the bank-file contract (docs/parity/bank-file-contract/fixtures.json), synthetic values only.
 * These workbooks are GENERATED from the contract's matrices by write-excel-file: they prove the layouts and the reader
 * agree, not that a bank's native export reads the same. Native AUB/KFH producer files are separate evidence and a
 * gate before real-file use (see the bank result page's module note); this suite claims nothing about them. */
type Fixture = { readonly id: string; readonly format?: string; readonly header_row?: number; readonly rows: (string | null)[][] };
const contract = JSON.parse(readFileSync(new URL("../../../../docs/parity/bank-file-contract/fixtures.json", import.meta.url), "utf8")) as { formats: Fixture[]; malformed_cases: Fixture[] };
const fixture = (list: readonly Fixture[], id: string) => list.find((f) => f.id === id)!.rows;

test("XLSX_CONTRACT_FIXTURES the AUB and KFH result layouts from the bank-file contract, written as generated workbooks, read back into the expected rows", async () => {
  const aubCells = cellsOf(await workbook(fixture(contract.formats, "aub-results")));
  assert.ok(Array.isArray(aubCells));
  const aub = readBankResultSheet("aub", aubCells);
  assert.equal(aub.kind, "read");
  assert.deepEqual(aub.kind === "read" && aub.rows.map((r) => [r.rowNumber, r.outcome, r.lineRef, r.reference]),
    [[3, "success", "910001", "SYNTHETIC-REF-1"], [4, "fail", "910002", "SYNTHETIC-REF-2"]]);
  const kfhCells = cellsOf(await workbook(fixture(contract.formats, "kfh-results")));
  assert.ok(Array.isArray(kfhCells));
  const kfh = readBankResultSheet("kfh", kfhCells);
  assert.equal(kfh.kind, "read");
  assert.deepEqual(kfh.kind === "read" && kfh.rows.map((r) => [r.rowNumber, r.outcome, r.lineRef, r.reference, r.account, r.amount, r.currency]),
    [[10, "success", null, "SYNTHETIC-REF-1", "XX00ABKK0000000000000000000001", "10.125", "KWD"],
      [11, "success", null, "SYNTHETIC-REF-2", "XX00TEST0000000000000000000002", "20.005", "KWD"]]);
  for (const [id, format] of [["aub-results-missing-header", "aub"], ["kfh-results-missing-header", "kfh"]] as const) {
    const cells = cellsOf(await workbook(fixture(contract.malformed_cases, id)));
    assert.ok(Array.isArray(cells));
    assert.equal(readBankResultSheet(format, cells).kind, "refused", id);
  }
});

test("XLSX_WELL_FORMED a truncated or malformed sheet is refused, shared strings are bounded as they are read, and scanning stays linear", () => {
  const sheet = (xml: string, shared?: string) => cellsOf(zip({ ...book("", shared), "xl/worksheets/sheet1.xml": xml }));
  const full = `<worksheet><sheetData><row r="1"><c><v>1</v></c></row><row r="3"/><row r="4"><c r="B4"><v>4</v></c></row></sheetData></worksheet>`;
  assert.deepEqual(sheet(full), [["1"], [], [], [null, "4"]], "empty rows and gaps are kept");
  for (const cut of [full.indexOf("<row r=\"4\">") + 12, full.indexOf("</row></sheetData>"), full.length - 13, full.length - 1])
    assert.equal(sheet(full.slice(0, cut)), "unreadable", `cut at ${cut}`);
  assert.equal(sheet(`<worksheet><sheetData><row r="1"><c><v>1</c></v></row></sheetData></worksheet>`), "unreadable", "crossed tags");
  for (const bad of [`<row r="4" <c r="A4"/>`, `<row r="4"><c r="A4" <v>1</v></c></row>`, `<row r="4" r2=x/>`, `<row r="4"></ row>`])
    assert.equal(sheet(`<worksheet><sheetData><row r="1"><c><v>1</v></c></row>${bad}</sheetData></worksheet>`), "unreadable", bad);
  assert.equal(sheet(`<worksheet><sheetData><row r="1"><c><v><![CDATA[1]]></v></c></row></sheetData></worksheet>`), "unreadable", "CDATA");
  assert.equal(sheet(`<worksheet><sheetData></sheetData></worksheet><worksheet/>`), "unreadable", "a second root");
  assert.equal(sheet(`<worksheet/>`), "unreadable", "no sheetData");
  assert.equal(sheet(`<worksheet><sheetData><row r="1"><row r="2"/></row></sheetData></worksheet>`), "unreadable", "a row inside a row");
  assert.deepEqual(sheet(`<?xml version="1.0"?><x:worksheet xmlns:x="ns"><!-- <row r="1"> --><x:sheetData><x:row r="2"><x:c r="A2" t="inlineStr"><x:is><x:t>a &gt; b</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>`),
    [[], ["a > b"]], "comments and prefixes are read as XML, not as rows");
  const empties = `<sst>${"<si/>".repeat(10_010 * 64 + 1)}</sst>`;
  assert.equal(sheet(full, empties.slice(5, -6)), "too_large", "more shared strings than cells a sheet may hold");
  const started = Date.now();
  assert.deepEqual(sheet(`<worksheet><!--${"<row>".repeat(100_000)}--><sheetData><row r="1"><c><v>1</v></c></row></sheetData>${"<!-- <row> -->".repeat(50_000)}</worksheet>`), [["1"]]);
  assert.ok(Date.now() - started < 2000, `linear scan, took ${Date.now() - started} ms`);
});

test("XLSX_CUT_TAG a start tag cut short after valid result rows refuses the whole file, so earlier rows are never applied alone", async () => {
  const first = ["Status", "Status Description", "Debit Narrative", "Credit Narrative"];
  const head = [...first, ...AUB_RESULT_COLUMNS.filter((c) => !first.includes(c))];
  const headXml = head.map((h) => `<c t="inlineStr"><is><t>${h}</t></is></c>`).join("");
  const row = (r: number, cells: string[]) => `<row r="${r}">${cells.map((v) => `<c t="inlineStr"><is><t>${v}</t></is></c>`).join("")}</row>`;
  const body = `<row r="2">${headXml}</row>${row(3, ["SUCCESS", "REF-1", "x", "L-1"])}`;
  const read = (tail: string) => cellsOf(zip({ ...book(""), "xl/worksheets/sheet1.xml": `<worksheet><sheetData>${body}${tail}</sheetData></worksheet>` }));
  const whole = read(row(4, ["SUCCESS", "REF-2", "x", "L-2"]));
  assert.ok(Array.isArray(whole));
  const sheetRead = readBankResultSheet("aub", whole);
  assert.deepEqual(sheetRead.kind === "read" && sheetRead.rows.map((r) => r.lineRef), ["L-1", "L-2"]);
  assert.equal(read(`<row r="4" <c r="A4"/>`), "unreadable");
});

test("XLSX_CELL_CONTENT a cell whose markup carries a value must read as that value: duplicate attributes, a type its markup contradicts, or content that decodes to nothing refuse the sheet", () => {
  const sheet = (cell: string, shared = "<si><t>x</t></si><si><t></t></si><si><t> </t></si>") =>
    cellsOf(zip(book(`<row r="2"><c r="A2" t="inlineStr"><is><t>SUCCESS</t></is></c></row><row r="3">${cell}</row>`, shared)));
  assert.deepEqual(sheet(`<c r="A3" s="1"/><c r="B3" t="s"><v>0</v></c>`), [[], ["SUCCESS"], [null, "x"]], "a styled empty cell stays empty");
  for (const bad of [
    `<c r="A3" t="n" t="inlineStr"><is><t>SUCCESS</t></is></c>`,
    `<c r="A3" r="B3"><v>1</v></c>`,
    `<c r="A3" t="n"><is><t>SUCCESS</t></is></c>`,
    `<c r="A3" t="inlineStr"><v>1</v></c>`,
    `<c r="A3" t="inlineStr"><is><t>a</t></is><v>1</v></c>`,
    `<c r="A3" t="inlineStr"/>`,
    `<c r="A3" t="zz"><v>1</v></c>`,
    `<c r="A3"><v></v></c>`,
    `<c r="A3"><v> </v></c>`,
    `<c r="A3" t="inlineStr"><is><t></t></is></c>`,
    `<c r="A3" t="inlineStr"><is><rPh><t>x</t></rPh></is></c>`,
    `<c r="A3" t="s"><v>1</v></c>`,
    `<c r="A3" t="s"><v>2</v></c>`,
  ]) assert.equal(sheet(bad), "unreadable", bad);
});

test("XLSX_ATTRIBUTES every attribute is read by one grammar: either quote style and spaces around = mean the same, anything else refuses", () => {
  const sheet = (rows: string) => cellsOf(zip(book(rows, "<si><t>shared</t></si>")));
  const same = [["shared", "7"], [null, "x y"]];
  assert.deepEqual(sheet(`<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>7</v></c></row><row r="2"><c r="B2" t="inlineStr"><is><t>x y</t></is></c></row>`), same);
  assert.deepEqual(sheet(`<row r='1'><c r='A1' t='s'><v>0</v></c><c r = "B1" ><v>7</v></c></row><row  r =  '2' ><c r='B2' t = 'inlineStr'><is><t>x y</t></is></c></row>`), same, "single quotes and spaced =");
  assert.deepEqual(sheet(`<row r="1"><c r="A1" t='s'><v>0</v></c><c r="B1"><v>7</v></c></row><row r="2"><c r='B2' t="inlineStr"><is><t>x y</t></is></c></row>`), same, "mixed");
  for (const bad of [`<row r=1><c><v>1</v></c></row>`, `<row r="1" r='1'><c><v>1</v></c></row>`, `<row r="1"><c t='s' t="s"><v>0</v></c></row>`, `<row r="1"x="2"><c><v>1</v></c></row>`])
    assert.equal(sheet(bad), "unreadable", bad);
  const files = book(`<row r="1"><c><v>1</v></c></row>`);
  const quoted = { ...files,
    "xl/workbook.xml": `<workbook xmlns:r="r"><sheets><sheet name='A' sheetId = '1' r:id = 'rId7'/></sheets></workbook>`,
    "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id='rId1' Target='styles.xml'/><Relationship Target = 'worksheets/sheet1.xml' Id = "rId7"/></Relationships>` };
  assert.deepEqual(cellsOf(zip(quoted)), [["1"]], "the workbook and its relationships use the same grammar");
  assert.equal(cellsOf(zip({ ...quoted, "xl/_rels/workbook.xml.rels": `<Relationships><Relationship Id="rId7" Target="worksheets/sheet1.xml"/><Relationship Id="rId7" Target="worksheets/other.xml"/></Relationships>` })),
    "unreadable", "one relationship id twice");
});

test("XLSX_ARCHIVE duplicate or colliding part names and parts that disagree with their declared CRC-32 or sizes refuse the workbook", async () => {
  const files = book(`<row r="1"><c><v>1</v></c></row>`);
  assert.deepEqual(cellsOf(zip(files)), [["1"]]);
  assert.deepEqual(cellsOf(zip(files, true)), [["1"]]);
  const sheetPath = "xl/worksheets/sheet1.xml", other = `<worksheet><sheetData><row r="1"><c><v>2</v></c></row></sheetData></worksheet>`;
  for (const twin of [sheetPath, "XL/Worksheets/Sheet1.xml", "/xl/worksheets/sheet1.xml", "xl\\worksheets\\sheet1.xml", "xl/./worksheets/sheet1.xml"])
    assert.equal(cellsOf(zip([...Object.entries(files), [twin, other]])), "unreadable", `a second ${twin}`);
  assert.equal(cellsOf(zip([...Object.entries(files), ["xl/../evil.xml", "<x/>"]])), "unreadable", "a part outside the package");
  const only = (name: string, edit: Tamper): Tamper => (e) => { if (e.name === name) edit(e); };
  const cases: [string, Tamper, boolean?][] = [
    ["central CRC", only(sheetPath, (e) => e.central.writeUInt32LE((e.central.readUInt32LE(16) ^ 1) >>> 0, 16))],
    ["local CRC", only(sheetPath, (e) => e.local.writeUInt32LE((e.local.readUInt32LE(14) ^ 1) >>> 0, 14))],
    ["content changed under both CRCs", only(sheetPath, (e) => { e.body[e.body.indexOf("1")] = "7".charCodeAt(0); }), true],
    ["central size", only(sheetPath, (e) => e.central.writeUInt32LE(e.central.readUInt32LE(24) + 1, 24))],
    ["local size", only(sheetPath, (e) => e.local.writeUInt32LE(e.local.readUInt32LE(22) - 1, 22))],
    ["local method", only(sheetPath, (e) => e.local.writeUInt16LE(0, 8))],
    ["workbook part CRC", only("xl/workbook.xml", (e) => e.central.writeUInt32LE((e.central.readUInt32LE(16) ^ 1) >>> 0, 16))],
  ];
  for (const [label, edit, stored] of cases)
    assert.equal(cellsOf(zip(files, stored ?? false, edit)), "unreadable", label);
  const renamed = Buffer.from(zip(files));
  renamed.write("xl/worksheets/sheet2.xml", renamed.indexOf("xl/worksheets/sheet1.xml"), "utf8");
  assert.equal(cellsOf(renamed), "unreadable", "the local header names another part");
  const trailing = Buffer.concat([Buffer.from(zip(files)), Buffer.from("junk")]);
  assert.equal(cellsOf(trailing), "unreadable", "bytes after the directory end");
  const real = await workbook([["a", "b"], ["1", "2"]]);
  assert.deepEqual(cellsOf(real), [["a", "b"], ["1", "2"]], "a writer's data descriptors carry the same CRC and sizes");
});
