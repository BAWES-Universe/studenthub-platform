import pg from "pg";
import { databaseUrl } from "./connection.js";

export class PostgresOrganizationAccountManagerReads {
  readonly #pool: pg.Pool;
  readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool }) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close() { if (this.#owns) await this.#pool.end(); }

  async readMany(orgIds: readonly string[]): Promise<Map<string, string>> {
    if (orgIds.length === 0) return new Map();
    const rows = await this.#pool.query<{ org_id: string; principal_id: string }>(
      "SELECT org_id,principal_id FROM organization_account_managers WHERE org_id = ANY($1::text[])", [orgIds],
    );
    return new Map(rows.rows.map((row) => [row.org_id, row.principal_id]));
  }
}
