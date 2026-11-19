import type { ExportKind } from "./exports.js";

/**
 * The admin country and university lists (legacy `country/download-list-excel` and
 * `university/download-list-excel`): every active catalogue entry of that type with how many
 * people point at it, as nationality for a country and as university for a university.
 * StudentHub staff only. The kinds take no filters, so the audit row's filters are `{}`.
 *
 * Legacy's columns are id, English name, Arabic name and "Total Candidate". The catalogue
 * holds one name and a code, so the columns are ID, Name, Code and Total Candidate.
 */
export type CatalogueListType = "country" | "university";
export const CATALOGUE_LIST_KINDS = { country: "catalogue-country", university: "catalogue-university" } as const satisfies Record<CatalogueListType, string>;
export type CatalogueListKindId = typeof CATALOGUE_LIST_KINDS[CatalogueListType];
export interface CatalogueListRow { readonly id: string; readonly name: string; readonly code: string | null; readonly people: number }
export interface CatalogueListSource {
  isStaff(principalId: string): Promise<boolean>;
  list(type: CatalogueListType): Promise<readonly CatalogueListRow[]>;
}
export type CatalogueListFilters = Readonly<Record<string, never>>;

export function createCatalogueListExport(source: CatalogueListSource, type: CatalogueListType): ExportKind<CatalogueListFilters> {
  return {
    id: CATALOGUE_LIST_KINDS[type], filterKeys: [], columns: ["ID", "Name", "Code", "Total Candidate"],
    authorize: principalId => source.isStaff(principalId),
    async *rows(principalId) {
      if (!(await source.isStaff(principalId))) throw new Error("export authorization changed");
      for (const row of await source.list(type)) yield [row.id, row.name, row.code ?? "", row.people];
    },
  };
}

export const createCatalogueListExports = (source: CatalogueListSource): readonly ExportKind<CatalogueListFilters>[] =>
  (Object.keys(CATALOGUE_LIST_KINDS) as CatalogueListType[]).map(type => createCatalogueListExport(source, type));
