/**
 * What a journey is: the screens it verifies, how to pick people for it from legacy,
 * how to read one person's legacy sheet from the refreshed copy, and which new pages to
 * open and read for the same person.
 */

import type { FactSheet } from "./facts.js";

/** Read-only access to the refreshed legacy copy. Parameters are bound by the port. */
export interface LegacyReader {
  rows(sql: string, params: readonly LegacyParam[]): Promise<readonly Readonly<Record<string, unknown>>[]>;
}
/** Only integers and ISO dates may be bound, so a parameter can never carry free text. */
export type LegacyParam = number | { readonly date: string };

export interface JourneyContext {
  /** Kuwait calendar month walked, `YYYY-MM`; always a finished month. */
  readonly month: string;
}

export interface Journey {
  readonly id: string;
  readonly screens: readonly string[];
  /** Who walks it: a candidate, a store manager or a staff member, by legacy id. */
  readonly persona: "candidate" | "store_manager" | "staff";
  /** Up to `limit` legacy ids with something to compare, in a stable order. */
  people(legacy: LegacyReader, ctx: JourneyContext, limit: number): Promise<readonly string[]>;
  legacySheet(legacy: LegacyReader, legacyId: string, ctx: JourneyContext): Promise<FactSheet>;
  /**
   * Paths on the new app to open, in order, for this person. The legacy sheet is given so a
   * journey can open a detail page for each thing legacy showed (each day, each item).
   */
  pages(ctx: JourneyContext, legacy: FactSheet): readonly string[];
  /** Reads the sheet from the pages above: each path with its final HTML, in the same order. */
  newSheet(pages: readonly OpenedPage[], ctx: JourneyContext): FactSheet;
}

export interface OpenedPage {
  readonly path: string;
  readonly html: string;
}

/** `YYYY-MM` -> first and last ISO day. */
export function monthBounds(month: string): { readonly first: string; readonly last: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m || Number(m[2]) < 1 || Number(m[2]) > 12) throw new Error("twin.journey.badMonth");
  const days = new Date(Date.UTC(Number(m[1]), Number(m[2]), 0)).getUTCDate();
  return { first: `${month}-01`, last: `${month}-${String(days).padStart(2, "0")}` };
}
