import pg from "pg";
import { databaseUrl } from "./connection.js";

const COLUMNS = ["name_en", "name_ar", "description_en", "description_ar", "website"] as const;

export class PostgresOrganizationProfileReads {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool }) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close() { if (this.#owns) await this.#pool.end(); }
  async read(orgId: string): Promise<Record<string, string>> {
    const row = (await this.#pool.query<Record<(typeof COLUMNS)[number], string | null>>(
      "SELECT name_en,name_ar,description_en,description_ar,website FROM organization_profiles WHERE org_id=$1", [orgId],
    )).rows[0];
    if (!row) return {};
    return Object.fromEntries(COLUMNS.flatMap((name) => typeof row[name] === "string" ? [[name, row[name]]] : []));
  }
}
