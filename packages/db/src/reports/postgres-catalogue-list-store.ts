import pg from "pg";
import { databaseUrl } from "../connection.js";

/**
 * The admin country and university lists' read (contract P-1 kinds `catalogue-country` and
 * `catalogue-university`): every active catalogue entry of the type, with how many person
 * profiles point at it. A deleted entry is left out; a person whose nationality or university
 * is unset is not counted anywhere. Sorted by name, then id, so two runs give the same file.
 */
export type CatalogueListType = "country" | "university";
export interface CatalogueListRow { readonly id: string; readonly name: string; readonly code: string | null; readonly people: number }

// The profile column is picked from this closed map, never from input.
const COLUMN: Readonly<Record<CatalogueListType, string>> = { country: "nationality_id", university: "university_id" };

export class PostgresCatalogueListStore {
  readonly #pool: pg.Pool; readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  async list(type: CatalogueListType): Promise<CatalogueListRow[]> {
    const column = COLUMN[type];
    if (!column) throw new RangeError("invalid catalogue list type");
    const result = await this.#pool.query<{ id: string; name: string; code: string | null; people: number }>(
      `SELECT c.id, c.name, c.code, (SELECT count(*)::int FROM person_profiles p WHERE p.${column} = c.id) AS people
         FROM catalogue_items c WHERE c.catalogue_type = $1 AND c.status = 'active' ORDER BY c.normalized_name, c.id`, [type]);
    return result.rows.map(r => ({ id: r.id, name: r.name, code: r.code, people: r.people }));
  }
}
