import pg from "pg";
import { databaseUrl } from "../connection.js";

/** Structurally compatible with @bawes/actor-assertion without a runtime dependency. */
export type ReplayOutcome = "consumed" | "replayed" | "expired" | "future_iat";
export interface ReplayConstraints {
  issuedAt: number;
  maxIatSkewSeconds: number;
}

/** Shared, durable replay protection. Pass a pool, never a transaction client:
 * a successful consume must commit before the caller accepts the assertion.
 */
export class PostgresReplayStore {
  readonly #pool: pg.Pool;
  readonly #ownsPool: boolean;

  constructor(options: { pool?: pg.Pool; connectionString?: string } = {}) {
    this.#ownsPool = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }

  /** Application time is deliberately ignored; PostgreSQL owns expiry and iat. */
  async consume(
    issuer: string, jti: string, expiresAt: number, _now: number,
    constraints?: ReplayConstraints,
  ): Promise<ReplayOutcome> {
    if (!issuer || !jti || !Number.isFinite(expiresAt)) throw new Error("invalid replay input");
    if (constraints !== undefined && (
      !Number.isFinite(constraints.issuedAt) ||
      !Number.isInteger(constraints.maxIatSkewSeconds) ||
      constraints.maxIatSkewSeconds < 0 || constraints.maxIatSkewSeconds > 300
    )) throw new Error("invalid replay constraints");
    const { rows } = await this.#pool.query<{ outcome: unknown }>(
      `SELECT consume_actor_assertion($1, $2, to_timestamp($3::double precision),
        to_timestamp($4::double precision), $5::integer) AS outcome`,
      [issuer, jti, expiresAt, constraints?.issuedAt ?? null, constraints?.maxIatSkewSeconds ?? null],
    );
    const outcome = rows[0]?.outcome;
    if (rows.length !== 1 || (outcome !== "consumed" && outcome !== "replayed" &&
      outcome !== "expired" && outcome !== "future_iat")) throw new Error("invalid replay database result");
    return outcome;
  }

  /** Bounded maintenance, not on the verification path. Keep expired tombstones
   * for ten minutes; expired assertions can never become consumable after prune.
   */
  async prune(limit = 1000): Promise<number> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 10000) throw new Error("invalid prune limit");
    const result = await this.#pool.query(
      `WITH cutoff AS MATERIALIZED (SELECT clock_timestamp() - interval '600 seconds' AS at),
       stale AS MATERIALIZED (
         SELECT issuer, jti FROM actor_assertion_replay, cutoff
         WHERE expires_at < cutoff.at ORDER BY expires_at LIMIT $1 FOR UPDATE OF actor_assertion_replay SKIP LOCKED
       ) DELETE FROM actor_assertion_replay r USING stale
         WHERE r.issuer = stale.issuer AND r.jti = stale.jti`, [limit],
    );
    return result.rowCount ?? 0;
  }
}
