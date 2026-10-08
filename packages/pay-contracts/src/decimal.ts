/**
 * Exact money values as strings. Legacy computed money in PHP floats (FI-F1);
 * here a value is only ever parsed into integer thousandths for comparison.
 */
const DECIMAL = /^(0|[1-9][0-9]{0,8})(?:\.([0-9]{1,3}))?$/;

/** Canonical three-place form, or undefined when the input is not an exact decimal within `decimal(12,3)`. */
export function canonicalDecimal(value: unknown): string | undefined {
  const raw = typeof value === "number" ? numberText(value) : value;
  if (typeof raw !== "string") return undefined;
  const match = DECIMAL.exec(raw.trim());
  if (!match) return undefined;
  return `${match[1]}.${(match[2] ?? "").padEnd(3, "0")}`;
}

/** Numbers are accepted only when their shortest text form is already exact. */
function numberText(value: number): string | undefined {
  if (!Number.isFinite(value) || value < 0) return undefined;
  const text = String(value);
  return /e/i.test(text) ? undefined : text;
}

export function thousandths(value: string): bigint {
  const canonical = canonicalDecimal(value);
  if (canonical === undefined) throw new RangeError("not an exact decimal");
  return BigInt(canonical.replace(".", ""));
}

export function compareDecimal(a: string, b: string): -1 | 0 | 1 {
  const left = thousandths(a);
  const right = thousandths(b);
  return left < right ? -1 : left > right ? 1 : 0;
}

export function isPositiveDecimal(value: string): boolean {
  return thousandths(value) > 0n;
}
