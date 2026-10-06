import { CIVIL_ID_DECISIONS } from "./decisions.js";

export function isCivilIdDate(value: unknown): value is string {
  if (typeof value !== "string" || !/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value) || value < "0001-01-01") return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

/** Date-only expiry is inclusive in the recorded zone. Invalid inputs fail closed.
 * This is the expiry gate only: assignment must also require a reviewed, active ID.
 */
export function isCivilIdValidOn(
  expiryDate: unknown, instant: Date, timeZone: string = CIVIL_ID_DECISIONS.timeZone,
): boolean {
  if (!isCivilIdDate(expiryDate) || !(instant instanceof Date) || !Number.isFinite(instant.getTime())) return false;
  try {
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone, calendar: "gregory", numberingSystem: "latn", year: "numeric", month: "2-digit", day: "2-digit",
    }).formatToParts(instant);
    const part = (type: string) => parts.find((entry) => entry.type === type)!.value;
    const today = `${part("year").padStart(4, "0")}-${part("month")}-${part("day")}`;
    return expiryDate >= today;
  } catch {
    return false;
  }
}
