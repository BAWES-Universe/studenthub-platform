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
  upstream_session_ref: string | null;
  last_checked_at: string | null;
  last_confirmed_at: string | null;
  last_settled_at: string | null;
}

interface IdentityRow {
  issuer: string;
  subject: string;
  person_id: string;
}

export interface LockedExternalIdentity {
  readonly issuer: string;
  readonly subjectHash: string;
  readonly personId: string;
  readonly lockedAt: Date;
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
      get: (id) => this.#sessionRead(id),
      delete: (id) => this.#deleteSession(id),
      take: (id) => this.#takeSession(id),
      claimUpstreamCheck: (id, checkedAtOrBefore, now) => this.#claimUpstreamCheck(id, checkedAtOrBefore, now),
      confirmUpstream: (id, now) => this.#confirmUpstream(id, now),
      settleUpstreamCheck: (id, checkedAt) => this.#settleUpstreamCheck(id, checkedAt),
    };
    this.identities = {
      findBySubject: (issuer, subject) => this.#findIdentity(issuer, subject),
      createForSubject: (issuer, subject, claims) => this.#createIdentity(issuer, subject, claims),
      bindStableId: (issuer, subject, stableUserId) =>
        this.#bindStableId(issuer, subject, stableUserId),
      // Deliberately unavailable: mutable donor/profile fields are never an
      // authentication binding mechanism.
      findLegacyMatch: async () => undefined,
    };
  }

  #sessionRead: (id: string) => Promise<LoginSession | undefined> = (id) => this.#getSession(id);

  /**
   * SHU-457: puts a check in front of every session read made through
   * `sessions.get`, for every module that holds this store's sessions. The
   * check receives the plain store (its own reads are not checked again).
   */
  checkSessionsWith(check: (plain: SessionStore) => SessionStore): void {
    const plain: SessionStore = {
      put: (record) => this.#putSession(record),
      get: (id) => this.#getSession(id),
      delete: (id) => this.#deleteSession(id),
      take: (id) => this.#takeSession(id),
      claimUpstreamCheck: (id, checkedAtOrBefore, now) => this.#claimUpstreamCheck(id, checkedAtOrBefore, now),
      confirmUpstream: (id, now) => this.#confirmUpstream(id, now),
      settleUpstreamCheck: (id, checkedAt) => this.#settleUpstreamCheck(id, checkedAt),
    };
    const checked = check(plain);
    this.#sessionRead = (id) => checked.get(id);
    // The login application sees the mark and does not check a second time.
    Object.defineProperty(this.sessions, Symbol.for("studenthub.login.upstream-confirming"), { value: true });
  }

  async close(): Promise<void> {
    if (this.#ownsPool) await this.#pool.end();
  }

  async #putState(record: LoginState): Promise<void> {
    await this.#pool.query(
      `WITH expired AS (DELETE FROM login_states WHERE expires_at <= now())
       INSERT INTO login_states
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
      `WITH expired AS (DELETE FROM login_sessions WHERE expires_at <= now())
       INSERT INTO login_sessions (id, person_id, expires_at, upstream_session_ref, last_checked_at, last_confirmed_at)
       VALUES ($1, $2, now() + ($3 * interval '1 second'), $4::text,
               to_timestamp($5::double precision), to_timestamp($6::double precision))`,
      [
        storedToken(record.id), record.personId, this.#sessionTtlSeconds,
        record.upstreamReference ?? null,
        record.upstreamReference ? record.lastCheckedAt ?? null : null,
        record.upstreamReference ? record.lastConfirmedAt ?? null : null,
      ],
    );
  }

  async #getSession(id: string): Promise<LoginSession | undefined> {
    const { rows } = await this.#pool.query<SessionRow>(
      `WITH expired AS (
         DELETE FROM login_sessions WHERE id = $1 AND expires_at <= now()
       )
       SELECT id, person_id, upstream_session_ref,
              extract(epoch FROM last_checked_at)::text AS last_checked_at,
              extract(epoch FROM last_confirmed_at)::text AS last_confirmed_at,
              extract(epoch FROM last_settled_at)::text AS last_settled_at
         FROM login_sessions WHERE id = $1 AND expires_at > now()`,
      [storedToken(id)],
    );
    const row = rows[0];
    return row ? sessionFromRow(id, row) : undefined;
  }

  async #takeSession(id: string): Promise<LoginSession | undefined> {
    const { rows } = await this.#pool.query<SessionRow>(
      `DELETE FROM login_sessions WHERE id = $1
       RETURNING id, person_id, upstream_session_ref,
                 extract(epoch FROM last_checked_at)::text AS last_checked_at,
                 extract(epoch FROM last_confirmed_at)::text AS last_confirmed_at,
              extract(epoch FROM last_settled_at)::text AS last_settled_at`,
      [storedToken(id)],
    );
    const row = rows[0];
    return row ? sessionFromRow(id, row) : undefined;
  }

  // The once-per-T throttle: only the request whose UPDATE moves
  // last_checked_at wins the right to ask the issuer.
  async #claimUpstreamCheck(id: string, checkedAtOrBefore: number, now: number): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE login_sessions SET last_checked_at = to_timestamp($3::double precision)
        WHERE id = $1 AND expires_at > now() AND upstream_session_ref IS NOT NULL
          AND (last_checked_at IS NULL OR last_checked_at <= to_timestamp($2::double precision))`,
      [storedToken(id), checkedAtOrBefore, now],
    );
    return (result.rowCount ?? 0) === 1;
  }

  async #confirmUpstream(id: string, now: number): Promise<void> {
    await this.#pool.query(
      `UPDATE login_sessions
          SET last_confirmed_at = GREATEST(last_confirmed_at, to_timestamp($2::double precision))
        WHERE id = $1`,
      [storedToken(id), now],
    );
  }

  async #settleUpstreamCheck(id: string, checkedAt: number): Promise<void> {
    await this.#pool.query(
      `UPDATE login_sessions
          SET last_settled_at = GREATEST(last_settled_at, to_timestamp($2::double precision))
        WHERE id = $1`,
      [storedToken(id), checkedAt],
    );
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
      await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [
        storedToken(`${issuer}\u0000${subject}`),
      ]);
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

  async #bindStableId(
    issuer: string,
    subject: string,
    stableUserId: string,
  ): Promise<"bound" | "matched" | "mismatch" | "locked"> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const { rows } = await client.query<{ outcome: "bound" | "matched" | "mismatch" | "locked"; person_id: string }>(
        `WITH current_identity AS MATERIALIZED (
           SELECT issuer, subject, person_id, stable_user_id, locked_at
             FROM external_identities
            WHERE issuer = $1::text AND subject = $2::text
            FOR UPDATE
         )
         UPDATE external_identities AS identity
            SET stable_user_id = COALESCE(identity.stable_user_id, $3::text),
                locked_at = CASE
                  WHEN current_identity.locked_at IS NULL
                   AND current_identity.stable_user_id IS NOT NULL
                   AND current_identity.stable_user_id <> $3::text
                  THEN clock_timestamp()
                  ELSE identity.locked_at
                END,
                locked_reason = CASE
                  WHEN current_identity.locked_at IS NULL
                   AND current_identity.stable_user_id IS NOT NULL
                   AND current_identity.stable_user_id <> $3::text
                  THEN 'stable_id_mismatch'::text
                  ELSE identity.locked_reason
                END
           FROM current_identity
          WHERE identity.issuer = current_identity.issuer
            AND identity.subject = current_identity.subject
        RETURNING current_identity.person_id,
          CASE
            WHEN current_identity.locked_at IS NOT NULL THEN 'locked'
            WHEN current_identity.stable_user_id IS NULL THEN 'bound'
            WHEN current_identity.stable_user_id = $3::text THEN 'matched'
            ELSE 'mismatch'
          END AS outcome`,
        [issuer, subject, stableUserId],
      );
      const result = rows[0];
      if (!result) throw new Error("external identity not found");
      if (result.outcome === "mismatch") {
        await client.query("DELETE FROM login_sessions WHERE person_id = $1::text", [result.person_id]);
      }
      await client.query("COMMIT");
      return result.outcome;
    } catch (error) {
      try { await client.query("ROLLBACK"); } catch { /* preserve original */ }
      throw error;
    } finally {
      client.release();
    }
  }

  async listLockedIdentities(): Promise<readonly LockedExternalIdentity[]> {
    const { rows } = await this.#pool.query<{
      issuer: string; subject_hash: string; person_id: string; locked_at: Date;
    }>(
      `SELECT issuer, encode(sha256(convert_to(subject, 'UTF8')), 'hex') AS subject_hash,
              person_id, locked_at
         FROM external_identities
        WHERE locked_at IS NOT NULL
        ORDER BY locked_at, issuer, subject`,
    );
    return rows.map((row) => ({
      issuer: row.issuer,
      subjectHash: row.subject_hash,
      personId: row.person_id,
      lockedAt: row.locked_at,
    }));
  }

  async unlockIdentity(identity: { readonly issuer: string; readonly subject: string }): Promise<boolean> {
    const result = await this.#pool.query(
      `UPDATE external_identities
          SET locked_at = NULL, locked_reason = NULL
        WHERE issuer = $1::text AND subject = $2::text AND locked_at IS NOT NULL`,
      [identity.issuer, identity.subject],
    );
    return (result.rowCount ?? 0) > 0;
  }
}

function sessionFromRow(id: string, row: SessionRow): LoginSession {
  if (!row.upstream_session_ref) return { id, personId: row.person_id };
  return {
    id,
    personId: row.person_id,
    upstreamReference: row.upstream_session_ref,
    ...(row.last_checked_at !== null ? { lastCheckedAt: Number(row.last_checked_at) } : {}),
    ...(row.last_confirmed_at !== null ? { lastConfirmedAt: Number(row.last_confirmed_at) } : {}),
    ...(row.last_settled_at !== null ? { lastSettledAt: Number(row.last_settled_at) } : {}),
  };
}

function positiveTtl(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0) throw new RangeError(`${name} must be a positive integer`);
  return value;
}

function storedToken(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

/** Non-mutating session authorization, executed on the caller's locked transaction. */
export async function readLiveLoginSessionPerson(client: Pick<pg.PoolClient, "query">, sessionToken: string): Promise<string | undefined> {
  const { rows } = await client.query<{ person_id: string }>(
    "SELECT person_id FROM login_sessions WHERE id = $1 AND expires_at > clock_timestamp()", [storedToken(sessionToken)],
  );
  return rows[0]?.person_id;
}
