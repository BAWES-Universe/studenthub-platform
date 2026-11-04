const dangerous = /^[=+\-@\t\r]/;

export function csvCell(value: unknown): string {
  let text = value === null || value === undefined ? "" : String(value);
  if (dangerous.test(text)) text = `'${text}`;
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function writeCsv(columns: readonly string[], rows: readonly (readonly unknown[])[]): Buffer {
  const lines = [columns, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  return Buffer.from(`\uFEFF${lines}\r\n`, "utf8");
}
