// M-2 documents: the input a document check runs on, read from the refreshed legacy copy.
//
// Who owns an object is decided over every candidate row (m2-documents: archived, duplicate-id
// and unimported rows also claim objects), so the check must never run on a partial or mixed
// candidate table. This module proves the ownership input before any object is read:
//
// - one statement reads every candidate row with M-1's columns and the four document columns,
//   so the people M-1 would import and the object claims come from the same rows;
// - the table is counted before and after that read, and the three numbers must agree, so a
//   truncated read or a copy that changed underneath is refused (`m2.ownershipIncomplete`);
// - the caller holds the refresh lock and binds the refresh identity, as `m4 plan` does, so the
//   copy is one known generation for the whole run.
//
// Columns are fixed lists; nothing here reads a password, token, contact value or civil ID.

import type { LegacyReader } from "./twin/journey.js";
import { M1_SOURCES, mapLegacyCandidates } from "./m1-people.js";
import { M2_DOCUMENT_SOURCES, mapLegacyDocuments, type M2Documents } from "./m2-documents.js";

type Row = Readonly<Record<string, unknown>>;

export const M2_RUN_SOURCES = {
  candidate: [...new Set<string>([...M1_SOURCES.candidate, ...M2_DOCUMENT_SOURCES.candidate])],
  country: M1_SOURCES.country,
  university: M1_SOURCES.university,
  area: M1_SOURCES.area,
} as const satisfies Record<string, readonly string[]>;
export type M2Table = keyof typeof M2_RUN_SOURCES;
export type M2Sources = Readonly<Record<M2Table, readonly Row[]>>;

const NAME = /^[a-z][a-z0-9_]{0,63}$/;

export function m2SourceSql(table: M2Table): string {
  const columns = M2_RUN_SOURCES[table];
  if (!NAME.test(table) || !columns.every((c) => NAME.test(c))) throw new Error("m2.badSourceName");
  return `SELECT JSON_OBJECT(${columns.map((c) => `'${c}', \`${c}\``).join(", ")}) FROM \`${table}\``;
}
export const M2_CANDIDATE_COUNT_SQL = "SELECT JSON_OBJECT('n', COUNT(*)) FROM `candidate`";

/** Thrown with a fixed code only: a reader error could carry values. */
export class M2InputError extends Error {
  constructor(readonly code: "m2.read.candidate" | "m2.read.country" | "m2.read.university" | "m2.read.area" | "m2.ownershipIncomplete") {
    super(code); this.name = "M2InputError";
  }
}

async function count(reader: LegacyReader): Promise<number> {
  let rows: readonly Row[];
  try { rows = await reader.rows(M2_CANDIDATE_COUNT_SQL, []); } catch { throw new M2InputError("m2.ownershipIncomplete"); }
  const n = rows.length === 1 ? Number(rows[0]!.n) : NaN;
  if (!Number.isSafeInteger(n) || n < 0) throw new M2InputError("m2.ownershipIncomplete");
  return n;
}

/** Reads the four tables; refuses unless the candidate rows are the whole table, unchanged during the read. */
export async function readM2Sources(reader: LegacyReader): Promise<M2Sources> {
  const before = await count(reader);
  const out = {} as Record<M2Table, readonly Row[]>;
  for (const table of Object.keys(M2_RUN_SOURCES) as M2Table[]) {
    try { out[table] = await reader.rows(m2SourceSql(table), []); } catch { throw new M2InputError(`m2.read.${table}`); }
  }
  const after = await count(reader);
  if (before !== after || out.candidate.length !== before) throw new M2InputError("m2.ownershipIncomplete");
  return out;
}

/** The documents to check: M-1's imported people, their four kinds, ownership over every candidate row. */
export function planM2(sources: M2Sources, today: string): M2Documents & { readonly candidates: number } {
  const { people } = mapLegacyCandidates({ candidate: sources.candidate, country: sources.country, university: sources.university, area: sources.area }, today);
  return { ...mapLegacyDocuments(sources.candidate, people), candidates: sources.candidate.length };
}
