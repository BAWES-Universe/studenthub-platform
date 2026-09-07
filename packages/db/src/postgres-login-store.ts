import { createHash, randomUUID } from "node:crypto";

import pg from "pg";
import type { Pool as PgPool, PoolConfig } from "pg";
import type {
  ClaimedProfile,
  ExternalIdentity,
  IdentityStore,
  LoginSession,
  LoginState,
  LoginStateStore,
  SessionStore,
} from "@studenthub/login-contract";

interface StateRow {
  browser_session_id: string;
  nonce: string;
  code_verifier: string;
  return_to: string;
  valid: boolean;
}

interface SessionRow {
  id: string;
  person_id: string;
}

interface IdentityRow {
  issuer: string;
  subject: string;
  person_id: string;
}

/** PostgreSQL-backed login stores sharing one bounded connection pool. */
export class PostgresLoginStore {
  readonly #pool: PgPool;
  readonly #ownsPool: boolean;
  readonly #stateTtlSeconds: number;
  readonly #sessionTtlSeconds: number;

  readonly states: LoginStateStore;
  readonly sessions: SessionStore;
  readonly identities: IdentityStore;

  constructor(
    poolOrConfig: PgPool | PoolConfig,
    options: { readonly stateTtlSeconds?: number; readonly sessionTtlSeconds?: number } = {},
  ) {
    this.#pool = poolOrConfig instanceof pg.Pool ? poolOrConfig : new pg.Pool(poolOrConfig);
    this.#ownsPool = !(poolOrConfig instanceof pg.Pool);
    this.#stateTtlSeconds = positiveTtl(options.stateTtlSeconds ?? 600, "stateTtlSeconds");
    this.#sessionTtlSeconds = positiveTtl(options.sessionTtlSeconds ?? 43_200, "sessionTtlSeconds");

    this.states = {
      put: (record) => this.#putState(record),
      consume: (state) => this.#consumeState(state),
    };
    this.sessions = {
      put: (record) => this.#putSession(record),
      get: (id) => this.#getSession(id),
      delete: (id) => this.#deleteSession(id),
    };
    this.identities = {
      findBySubject: (issuer, subject) => this.#findIdentity(issuer, subject),
      createForSubject: (issuer, subject, claims) => this.#createIdentity(issuer, subject, claims),
      // Deliberately unavailable: mutable donor/profile fields are never an
      // authentication binding mechanism.
      findLegacyMatch: async () => undefined,
    };
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }

  async #putState(record: LoginState): Promise<void> {
    await this.#pool.query(
      `INSERT INTO login_states
         (state, browser_session_id, nonce, code_verifier, return_to, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + ($6 * interval '1 second'))`,
      [storedToken(record.state), record.browserSessionId, record.nonce, record.codeVerifier, record.returnTo, this.#stateTtlSeconds],
    );
  }

  async #consumeState(state: string): Promise<LoginState | undefined> {
    // DELETE ... RETURNING is the one-use/replay boundary and stays atomic
    // across gateway processes. Expired rows are consumed too, but not used.
    const { rows } = await this.#pool.query<StateRow>(
      `DELETE FROM login_states WHERE state = $1
       RETURNING browser_session_id, nonce, code_verifier, return_to,
                 expires_at > now() AS valid`,
      [storedToken(state)],
    );
    const row = rows[0];
    if (!row?.valid) return undefined;
    return {
      state,
      browserSessionId: row.browser_session_id,
      nonce: row.nonce,
      codeVerifier: row.code_verifier,
      returnTo: row.return_to,
    };
  }

  async #putSession(record: LoginSession): Promise<void> {
    await this.#pool.query(
      `INSERT INTO login_sessions (id, person_id, expires_at)
       VALUES ($1, $2, now() + ($3 * interval '1 second'))`,
      [storedToken(record.id), record.personId, this.#sessionTtlSeconds],
    );
  }

  async #getSession(id: string): Promise<LoginSession | undefined> {
    const { rows } = await this.#pool.query<SessionRow>(
      "SELECT id, person_id FROM login_sessions WHERE id = $1 AND expires_at > now()",
      [storedToken(id)],
    );
    const row = rows[0];
    if (!row) return undefined;
    return { id, personId: row.person_id };
  }

  async #deleteSession(id: string): Promise<void> {
    await this.#pool.query("DELETE FROM login_sessions WHERE id = $1", [storedToken(id)]);
  }

  async #findIdentity(issuer: string, subject: string): Promise<ExternalIdentity | undefined> {
    const { rows } = await this.#pool.query<IdentityRow>(
      "SELECT issuer, subject, person_id FROM external_identities WHERE issuer = $1 AND subject = $2",
      [issuer, subject],
    );
    const row = rows[0];
    return row && { issuer: row.issuer, subject: row.subject, personId: row.person_id };
  }

  async #createIdentity(
    issuer: string,
    subject: string,
    claims: ClaimedProfile,
  ): Promise<ExternalIdentity> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      // Serialize only this immutable issuer/subject pair. Concurrent first
      // callbacks return one person instead of creating an orphan principal.
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`${issuer}\u0000${subject}`]);
      const existing = await client.query<IdentityRow>(
        "SELECT issuer, subject, person_id FROM external_identities WHERE issuer = $1 AND subject = $2",
        [issuer, subject],
      );
      const found = existing.rows[0];
      if (found) {
        await client.query("COMMIT");
        return { issuer: found.issuer, subject: found.subject, personId: found.person_id };
      }
      const personId = randomUUID();
      await client.query(
        "INSERT INTO principals (id, display_name, email) VALUES ($1, $2, $3)",
        [personId, claims.name ?? null, claims.email ?? null],
      );
      await client.query(
        "INSERT INTO external_identities (issuer, subject, person_id) VALUES ($1, $2, $3)",
        [issuer, subject, personId],
      );
      await client.query("COMMIT");
      return { issuer, subject, personId };
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original */ }
      throw error;
    } finally {
      client.release();
    }
  }
}

function positiveTtl(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function storedToken(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}
