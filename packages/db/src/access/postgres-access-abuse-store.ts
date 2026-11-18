import { randomUUID } from "node:crypto";
import pg from "pg";

/**
 * Access lane A8 (migration 0406): the person's request counters and the
 * network address block list. Structural types only; the rules live in
 * packages/access.
 */

type Cidr = { readonly address: string; readonly prefix: number };
const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();
/** Windows older than a day are pruned by whoever counts; the longest window is an hour. */
const KEEP_SECONDS = 86_400;

export class PostgresAccessAbuseStore {
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

  /** One statement: count this request in the person's window and answer the total. */
  async hit(principalId: string, kind: "write" | "upload", windowStartEpochSeconds: number): Promise<number> {
    const { rows } = await this.#pool.query<{ count: number }>(
      `INSERT INTO person_request_counts (principal_id, kind, window_start, count)
       VALUES ($1, $2, to_timestamp($3::double precision), 1)
       ON CONFLICT (principal_id, kind, window_start) DO UPDATE SET count = person_request_counts.count + 1
       RETURNING count`,
      [principalId, kind, windowStartEpochSeconds]);
    if (Math.random() < 0.01) {
      await this.#pool.query("DELETE FROM person_request_counts WHERE window_start < to_timestamp($1::double precision)",
        [windowStartEpochSeconds - KEEP_SECONDS]).catch(() => undefined);
    }
    return rows[0]!.count;
  }

  async blocks(): Promise<readonly { id: string; cidr: string; reason: string; createdAt: string; createdBy: { principalId: string; displayName: string | null } }[]> {
    const { rows } = await this.#pool.query<{ id: string; cidr: string; reason: string; created_at: Date; created_by: string; by_name: string | null }>(
      `SELECT b.id, b.cidr::text AS cidr, b.reason, b.created_at, b.created_by, p.display_name AS by_name
         FROM ip_blocks b LEFT JOIN principals p ON p.id = b.created_by
        WHERE b.removed_at IS NULL ORDER BY b.created_at DESC, b.id`);
    return rows.map((row) => ({ id: row.id, cidr: row.cidr, reason: row.reason, createdAt: iso(row.created_at), createdBy: { principalId: row.created_by, displayName: row.by_name } }));
  }

  async changeBlock(callerId: string, request: { readonly action: "block" | "unblock"; readonly cidr: Cidr; readonly reason: string }):
    Promise<{ readonly kind: "blocked" | "unblocked" } | { readonly kind: "refused"; readonly reason: "already_blocked" | "not_blocked" }> {
    const cidr = `${request.cidr.address}/${request.cidr.prefix}`;
    if (request.action === "block") {
      const { rowCount } = await this.#pool.query(
        `INSERT INTO ip_blocks (id, cidr, reason, created_by) VALUES ($1, $2::cidr, $3, $4)
         ON CONFLICT (cidr) WHERE removed_at IS NULL DO NOTHING`, [randomUUID(), cidr, request.reason, callerId]);
      return rowCount ? { kind: "blocked" } : { kind: "refused", reason: "already_blocked" };
    }
    const { rowCount } = await this.#pool.query(
      `UPDATE ip_blocks SET removed_at = clock_timestamp(), removed_by = $2, remove_reason = $3
        WHERE cidr = $1::cidr AND removed_at IS NULL`, [cidr, callerId, request.reason]);
    return rowCount ? { kind: "unblocked" } : { kind: "refused", reason: "not_blocked" };
  }
}
