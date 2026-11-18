import { randomUUID } from "node:crypto";
import pg from "pg";

/** Access lane A9 (migration 0407): staff views of a person's account. */

const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
type Row = { id: string; staff_principal_id: string; target_principal_id: string; reason: string; started_at: Date; expires_at: Date };
const view = (row: Row) => ({
  id: row.id, staffPrincipalId: row.staff_principal_id, targetPrincipalId: row.target_principal_id,
  reason: row.reason, startedAt: iso(row.started_at), expiresAt: iso(row.expires_at),
});

export class PostgresAccessStaffViewsStore {
  readonly #pool: pg.Pool;
  readonly #ownsPool: boolean;

  constructor(options: { readonly pool: pg.Pool } | { readonly connectionString: string }) {
    if ("pool" in options) {
      this.#pool = options.pool;
      this.#ownsPool = false;
    } else {
      this.#pool = new pg.Pool({ connectionString: options.connectionString });
      this.#ownsPool = true;
    }
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }

  async start(staffPrincipalId: string, request: { readonly targetPrincipalId: string; readonly reason: string }) {
    const { rows } = await this.#pool.query<Row>(
      `INSERT INTO staff_views (id, staff_principal_id, target_principal_id, reason, started_at, expires_at)
       SELECT $1, $2, $3, $4, t, t + interval '15 minutes' FROM (SELECT clock_timestamp() AS t) now
       RETURNING id, staff_principal_id, target_principal_id, reason, started_at, expires_at`,
      [randomUUID(), staffPrincipalId, request.targetPrincipalId, request.reason]);
    return view(rows[0]!);
  }

  async open(staffPrincipalId: string, targetPrincipalId: string) {
    const { rows } = await this.#pool.query<Row>(
      `SELECT id, staff_principal_id, target_principal_id, reason, started_at, expires_at FROM staff_views
        WHERE staff_principal_id = $1 AND target_principal_id = $2 AND expires_at > clock_timestamp()
        ORDER BY expires_at DESC LIMIT 1`, [staffPrincipalId, targetPrincipalId]);
    return rows[0] ? view(rows[0]) : null;
  }

  async viewedOn(targetPrincipalId: string): Promise<readonly string[]> {
    const { rows } = await this.#pool.query<{ started_at: Date }>(
      "SELECT started_at FROM staff_views WHERE target_principal_id = $1 ORDER BY started_at DESC LIMIT 20", [targetPrincipalId]);
    return rows.map((row) => iso(row.started_at));
  }

  async grantsOf(principalId: string) {
    const { rows } = await this.#pool.query<{ org_id: string; role: string; scope: string }>(
      "SELECT org_id, role, scope FROM grants WHERE principal_id = $1 ORDER BY id", [principalId]);
    return rows.map((row) => ({ orgId: row.org_id, role: row.role, scope: row.scope }));
  }
}
