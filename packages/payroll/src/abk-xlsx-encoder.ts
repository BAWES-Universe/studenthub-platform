import type { SheetData } from "write-excel-file/node";
import type { AbkWorkbookSpec, AbkXlsxEncoder } from "./abk-workbook.js";

const MAX_CELL_TEXT_UNITS = 32_767;
const MAX_WORKBOOK_TEXT_UNITS = 8_000_000;

// Upstream sanitizes several code points instead of rejecting them. XML normalizes CR
// and Excel readers can interpret OOXML escape-shaped literals. Reject these rather than
// letting a report silently change a value. Keep ordinary Unicode, LF and tab.
const UNENCODABLE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\ufdd0-\ufdef\ufffd-\uffff\uD800-\uDFFF]|_[xX][0-9a-fA-F]{4}_/u;
function checkText(value: string): void {
  if (value.length > MAX_CELL_TEXT_UNITS || UNENCODABLE.test(value) ||
      Array.from(value).some((char) => (char.codePointAt(0)! & 0xffff) >= 0xfffe)) {
    throw new Error("ABK XLSX cell text cannot be preserved exactly");
  }
}

/** Materialize only ABK primitives with explicit string/number types; never infer formulas. */
export function toAbkXlsxSheetData(spec: AbkWorkbookSpec): SheetData {
  if (typeof spec.sheetName !== "string" || !spec.sheetName.trim() || spec.sheetName.length > 31 ||
      /[\\/?*\[\]:\t\n]/u.test(spec.sheetName) ||
      spec.sheetName.startsWith("'") || spec.sheetName.endsWith("'")) {
    throw new Error("Invalid XLSX sheet name");
  }
  checkText(spec.sheetName);
  if (!Array.isArray(spec.rows) || spec.rows.length < 2 || spec.rows.length > 10_001) {
    throw new Error("ABK XLSX requires a header and 1..10000 lines");
  }
  let textUnits = 0;
  const data: SheetData = [];
  for (let r = 0; r < spec.rows.length; r++) {
    const row: readonly unknown[] = spec.rows[r]!;
    if (!Array.isArray(row) || row.length !== 17) throw new Error("ABK XLSX requires 17 columns");
    const output: SheetData[number] = [];
    for (let c = 0; c < row.length; c++) {
      const value: unknown = row[c];
      if (r > 0 && c === 11) {
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0 ||
            value >= 1_000_000_000_000 || Number(value.toFixed(3)) !== value) {
          throw new Error("ABK XLSX requires a finalized numeric amount");
        }
        output.push({ value, type: Number });
      } else if (r > 0 && c === 4 && value === null) {
        output.push(null);
      } else {
        if (typeof value !== "string" || !value.trim()) throw new Error("ABK XLSX requires nonempty text");
        checkText(value);
        textUnits += value.length;
        if (textUnits > MAX_WORKBOOK_TEXT_UNITS) throw new Error("ABK XLSX text budget exceeded");
        output.push({ value, type: String });
      }
    }
    data.push(output);
  }
  return data;
}

/** Pure bytes boundary; no file paths, formulas, styles, transport, or export/eligibility decisions. */
export const nativeAbkXlsxEncoder: AbkXlsxEncoder = Object.freeze({
  async encode(spec: AbkWorkbookSpec): Promise<Uint8Array> {
    const sheet = spec.sheetName;
    const rows = toAbkXlsxSheetData(spec);
    const { default: writeExcelFile } = await import("write-excel-file/node");
    return new Uint8Array(await writeExcelFile(rows, { sheet }).toBuffer());
  },
});
