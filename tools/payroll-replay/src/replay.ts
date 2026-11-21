/** Read-only comparison of synthetic decoded cells. Not a payroll calculator or XLSX decoder. */
export const FORMAT = 'legacy-abk-workbook';
export interface CellExport {
  synthetic_only: true;
  format_id: typeof FORMAT;
  column_attributes: string[];
  header_values: null;
  rows: string[][];
}
const attributes = ['DEBIT ACCOUNT', 'Name', 'candidate.candidate_iban', 'BENEFICIARY BANK ADDRESS', 'BENEFICIARY BANK NAME', 'BENEFICIARY BANK BRANCH ID', 'BENEFICIARY CITY', 'BENEFICIARY COUNTRY', 'BENEFICIARY ADDRESS 1', 'BENEFICIARY ADDRESS 2', 'TXN CURRENCY', 'Amount', 'Type', 'BENEFICIARY BANK IDENTIFIER', 'PURPOSE OF TRANSFER', 'PAYMENT DETAILS', 'Charge'];
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('INVALID_OBJECT');
  return value as Record<string, unknown>;
}
function amount(value: string): bigint {
  // Exact comparison only; do not round serializer output or reproduce PHP math here.
  if (!/^(0|[1-9][0-9]{0,8})\.[0-9]{3}$/.test(value)) throw new Error('INVALID_AMOUNT');
  return BigInt(value.replace('.', ''));
}
export function parseCells(value: unknown): CellExport {
  const obj = object(value);
  if (obj.synthetic_only !== true || obj.format_id !== FORMAT || obj.header_values !== null) throw new Error('UNSUPPORTED_SCOPE');
  if (Object.keys(obj).sort().join('|') !== ['synthetic_only', 'format_id', 'column_attributes', 'header_values', 'rows'].sort().join('|')) throw new Error('UNEXPECTED_FIELDS');
  if (!Array.isArray(obj.column_attributes) || obj.column_attributes.length !== attributes.length || obj.column_attributes.some((v, i) => v !== attributes[i])) throw new Error('INVALID_COLUMNS');
  if (!Array.isArray(obj.rows) || obj.rows.length === 0 || obj.rows.length > 10000) throw new Error('INVALID_ROWS');
  const keys = new Set<string>();
  for (const row of obj.rows) {
    if (!Array.isArray(row) || row.length !== attributes.length || row.some(v => typeof v !== 'string' || v.length > 4096)) throw new Error('INVALID_ROW');
    if (row[10] !== 'KWD') throw new Error('UNSUPPORTED_CURRENCY');
    amount(row[11]);
    if (!/^S [0-9]+$/.test(row[15])) throw new Error('INVALID_LINE_REFERENCE');
    if (keys.has(row[15])) throw new Error('DUPLICATE_LINE_REFERENCE');
    keys.add(row[15]);
  }
  return structuredClone(obj) as unknown as CellExport;
}
/** Adapts the EXISTING source-established fixture; no new legacy serializer is invented. */
export function fromLegacyFixture(value: unknown): CellExport {
  const pack = object(value);
  if (pack.synthetic_only !== true || pack.source_data_copied !== false || pack.bank_formats_invented !== false || !Array.isArray(pack.formats)) throw new Error('INVALID_FIXTURE_PROVENANCE');
  const matches = pack.formats.filter(v => object(v).id === FORMAT);
  if (matches.length !== 1) throw new Error('INVALID_FIXTURE_FORMAT');
  const format = object(matches[0]);
  if (format.kind !== 'decoded-export-cells' || format.native_workbook_fidelity !== 'NOT_ESTABLISHED' || format.bank_acceptance !== 'UNKNOWN') throw new Error('INVALID_FIXTURE_SCOPE');
  const cells = parseCells({synthetic_only: true, format_id: FORMAT, column_attributes: format.column_attributes, header_values: format.header_values, rows: format.rows});
  if (format.record_count !== cells.rows.length || typeof format.total !== 'string' || amount(format.total) !== total(cells)) throw new Error('INVALID_FIXTURE_TOTAL');
  return cells;
}
function total(cells: CellExport): bigint { return cells.rows.reduce((sum, row) => sum + amount(row[11]), 0n); }
export function compareCells(reference: unknown, candidate: unknown) {
  const expected = parseCells(reference), actual = parseCells(candidate);
  const a = new Map(expected.rows.map(row => [row[15], row]));
  const b = new Map(actual.rows.map(row => [row[15], row]));
  let missing = 0, extra = 0, changed = 0, exact = 0;
  for (const [key, row] of a) {
    const found = b.get(key);
    if (!found) missing++;
    else if (row.some((cell, index) => cell !== found[index])) changed++;
    else exact++;
  }
  for (const key of b.keys()) if (!a.has(key)) extra++;
  const orderMatches = expected.rows.length === actual.rows.length && expected.rows.every((row, i) => row[15] === actual.rows[i][15]);
  return {
    schema: 'studenthub.payroll.synthetic-cell-replay.v1',
    status: missing + extra + changed === 0 && orderMatches ? 'PASS_SYNTHETIC_CELLS' : 'FAIL_SYNTHETIC_CELLS',
    format: FORMAT, expectedRowCount: a.size, actualRowCount: b.size, exactRowCount: exact,
    missingRowCount: missing, unexpectedRowCount: extra, changedRowCount: changed, orderMatches,
    expectedTotalFils: String(total(expected)), actualTotalFils: String(total(actual)), netDifferenceFils: String(total(actual) - total(expected)),
    currency: 'KWD', productionReplay: false, nativeWorkbookFidelity: 'NOT_ESTABLISHED', bankAcceptance: 'UNKNOWN',
  } as const;
}
