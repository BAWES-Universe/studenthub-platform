declare const decimalString: unique symbol;
/** Exact decimal text. No conversion to Number and no arithmetic. */
export type DecimalString = string & { readonly [decimalString]: true };

export function parseDecimalString(value: unknown, scale: number): DecimalString {
  if (!Number.isSafeInteger(scale) || scale < 0 || scale > 18) {
    throw new TypeError("invalid decimal scale");
  }
  const pattern = scale === 0 ? /^-?(0|[1-9][0-9]*)$/
    : new RegExp(`^-?(0|[1-9][0-9]*)\\.[0-9]{${scale}}$`);
  if (typeof value !== "string" || value.trim() !== value || !pattern.test(value)) {
    throw new TypeError("invalid decimal string");
  }
  return value as DecimalString;
}
