import { createHash } from "node:crypto";
import pg from "pg";

/**
 * Access lane U-03 (migration 0409): the signed-in person's own sessions.
 *
 * Structural types only, matching AccountSessionsStore in packages/access.
 * Reads and deletes go by person id, never by a session id the caller names,
 * so a person can only ever see or end their own sessions. Session ids are
 * stored hashed; the current one is recognised by hashing the caller's cookie.
 */

export const ACCOUNT_SESSIONS_LIMIT = 50;
const storedToken = (value: string): string => createHash("sha256").update(value).digest("base64url");
const iso = (value: Date | string): string => (value instanceof Date ? value : new Date(value)).toISOString();

export class PostgresAccessSessionsStore {
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

  /** The person's live sessions, newest first (unknown start times last), at most ACCOUNT_SESSIONS_LIMIT. One query. */
  async list(personId: string, currentSessionToken: string) {
    const { rows } = await this.#pool.query<{ current: boolean; created_at: Date | null; expires_at: Date }>(
      `SELECT id = $2 AS current, created_at, expires_at
         FROM login_sessions
        WHERE person_id = $1 AND expires_at > now()
        ORDER BY id = $2 DESC, created_at DESC NULLS LAST, expires_at DESC
        LIMIT $3`,
      [personId, storedToken(currentSessionToken), ACCOUNT_SESSIONS_LIMIT]);
    return rows.map((row) => ({ current: row.current, signedInAt: row.created_at ? iso(row.created_at) : null, expiresAt: iso(row.expires_at) }));
  }

  /** Ends every session of the person, this one included. Answers how many were ended. One statement. */
  async endAll(personId: string): Promise<number> {
    const result = await this.#pool.query("DELETE FROM login_sessions WHERE person_id = $1", [personId]);
    return result.rowCount ?? 0;
  }
}
