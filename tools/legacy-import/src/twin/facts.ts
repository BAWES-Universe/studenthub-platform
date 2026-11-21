/**
 * Fact sheets: what one person sees on one journey, reduced to comparable facts.
 *
 * A sheet maps a path to a primitive. Paths name what a fact is, never what it says:
 * they are built from fixed words, ISO dates, and opaque ids, so a report can list
 * which paths differ without carrying a name, an amount or any other value. Values stay
 * in memory on the staging host and are never written anywhere.
 */

export type FactValue = string | number | boolean | null;
export type FactSheet = ReadonlyMap<string, FactValue>;

/**
 * One path segment: a lower-case word, or `[key]` where the key is an ISO date, a month,
 * or an id (digits, a UUID, or a word with digits). Free text can never form a key.
 */
const WORD = String.raw`[a-z][a-zA-Z0-9]*`;
const KEY = String.raw`\[(?:\d{4}-\d{2}(?:-\d{2})?|\d{1,20}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[a-z]+:\d{1,20})\]`;
export const FACT_PATH = new RegExp(String.raw`^${WORD}(?:${KEY})?(?:\.${WORD}(?:${KEY})?)*$`);

export class SheetBuilder {
  readonly #facts = new Map<string, FactValue>();

  set(path: string, value: FactValue): this {
    if (!FACT_PATH.test(path)) throw new Error("twin.fact.badPath");
    if (this.#facts.has(path)) throw new Error("twin.fact.duplicatePath");
    if (typeof value === "number" && !Number.isFinite(value)) throw new Error("twin.fact.badNumber");
    this.#facts.set(path, value);
    return this;
  }

  build(): FactSheet {
    return new Map([...this.#facts.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  }
}

/** Visible text as compared: Unicode NFC, whitespace collapsed and trimmed; empty is null. */
export function text(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const s = String(value).normalize("NFC").replace(/\s+/g, " ").trim();
  return s.length === 0 ? null : s;
}

/** Whole minutes as a page shows a duration (floor of seconds / 60, never negative). */
export function minutes(seconds: number): number {
  return Math.max(0, Math.floor(seconds / 60));
}

/**
 * A duration as the gateway shows it, to minutes: English `"2h 30m"`, `"45m"`, `"3h"`,
 * or Arabic `"2 س 30 د"`, `"45 د"`, `"3 س"` (apps/gateway/src/work/copy.ts).
 */
export function parseDuration(shown: string): number {
  const t = shown.trim();
  const m = /^(?:(\d+)h)?\s*(?:(\d+)m)?$/.exec(t) ?? /^(?:(\d+) س)?\s*(?:(\d+) د)?$/.exec(t);
  if (!m || (m[1] === undefined && m[2] === undefined)) throw new Error("twin.fact.badDuration");
  return Number(m[1] ?? 0) * 60 + Number(m[2] ?? 0);
}

/** A legacy `DATETIME` written in Asia/Kuwait (UTC+3, no DST) to its Kuwait `HH:MM`. */
export function kuwaitClock(legacyDateTime: string): string {
  const m = /^\d{4}-\d{2}-\d{2}[ T](\d{2}):(\d{2})/.exec(legacyDateTime);
  if (!m) throw new Error("twin.fact.badTime");
  return `${m[1]}:${m[2]}`;
}
