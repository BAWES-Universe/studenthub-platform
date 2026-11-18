import { createHash } from "node:crypto";
import pg from "pg";
import type { Pool, PoolClient, PoolConfig } from "pg";

/** Every bearer reference is kept only as this digest (same as login stores). */
export function universeEmbedDigest(value: string): string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError("reference must be non-empty");
  return createHash("sha256").update(value).digest("base64url");
}

export interface UniverseEmbedBindingView {
  readonly personId: string;
  readonly generation: number;
  /** Present only while the lease is unexpired by database time. */
  readonly lease?: { readonly hostSubjectDigest: string; readonly expiresAt: Date };
  /** external_identities.locked_at is set for any identity of this person. */
  readonly locked: boolean;
}

/** The persistence port used by the gateway embed service. */
export interface UniverseEmbedStore {
  ensureInstance(browserBinding: string, newRef: string, ttlSeconds: number): Promise<string>;
  findInstance(ref: string, browserBinding: string): Promise<string | undefined>;
  createHandoff(instanceId: string, browserBinding: string, ttlSeconds: number): Promise<string>;
  attachState(handoffId: string, state: string): Promise<boolean>;
  completeHandoff(state: string, sessionId: string, personId: string): Promise<boolean>;
  consumeHandoff(instanceId: string, browserBinding: string, sessionId: string): Promise<string | undefined>;
  readBinding(instanceId: string, browserBinding: string, sessionId: string): Promise<UniverseEmbedBindingView | undefined>;
  /** Without a generation: remove the binding. With one: remove it only if it is still that version. */
  invalidateBinding(instanceId: string, generation?: number): Promise<void>;
  issueChallenge(instanceId: string, browserBinding: string, sessionId: string, challenge: string, ttlSeconds: number): Promise<boolean>;
  consumeChallenge(instanceId: string, challenge: string): Promise<number | undefined>;
  writeLease(instanceId: string, generation: number, hostSubject: string, issuedAtEpochSeconds: number, leaseSeconds: number): Promise<Date | undefined>;
  identitySubjects(personId: string, issuer: string): Promise<readonly string[]>;
}

/** PostgreSQL implementation. Database time decides every expiry. */
export class PostgresUniverseEmbedStore implements UniverseEmbedStore {
  readonly #pool: Pool;
  readonly #ownsPool: boolean;

  constructor(poolOrConfig: Pool | PoolConfig) {
    this.#pool = poolOrConfig instanceof pg.Pool ? poolOrConfig : new pg.Pool(poolOrConfig);
    this.#ownsPool = !(poolOrConfig instanceof pg.Pool);
    if (this.#ownsPool) this.#pool.on("error", () => {});
  }

  async close(): Promise<void> { if (this.#ownsPool) await this.#pool.end(); }

  async #tx<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => undefined);
      throw error;
    } finally {
      client.release();
    }
  }

  async ensureInstance(browserBinding: string, newRef: string, ttlSeconds: number): Promise<string> {
    const browser = universeEmbedDigest(browserBinding);
    return this.#tx(async (client) => {
      // An expired instance is replaced; its handoffs, binding and lease go with it.
      await client.query(
        "DELETE FROM universe_embed_instances WHERE browser_binding_digest = $1 AND expires_at <= clock_timestamp()", [browser]);
      await client.query(
        `INSERT INTO universe_embed_instances (browser_binding_digest, expires_at)
         VALUES ($1, clock_timestamp() + ($2 * interval '1 second'))
         ON CONFLICT (browser_binding_digest) DO NOTHING`, [browser, positive(ttlSeconds)]);
      const { rows } = await client.query<{ id: string }>(
        "SELECT id FROM universe_embed_instances WHERE browser_binding_digest = $1", [browser]);
      const id = rows[0]?.id;
      if (!id) throw new Error("embed instance unavailable");
      await client.query(
        "INSERT INTO universe_embed_instance_refs (ref_digest, instance_id) VALUES ($1, $2)",
        [universeEmbedDigest(newRef), id]);
      return id;
    });
  }

  async findInstance(ref: string, browserBinding: string): Promise<string | undefined> {
    const { rows } = await this.#pool.query<{ id: string }>(
      `SELECT i.id FROM universe_embed_instance_refs r
         JOIN universe_embed_instances i ON i.id = r.instance_id
        WHERE r.ref_digest = $1 AND i.browser_binding_digest = $2 AND i.expires_at > clock_timestamp()`,
      [universeEmbedDigest(ref), universeEmbedDigest(browserBinding)]);
    return rows[0]?.id;
  }

  async createHandoff(instanceId: string, browserBinding: string, ttlSeconds: number): Promise<string> {
    const browser = universeEmbedDigest(browserBinding);
    return this.#tx(async (client) => {
      // Serialize connects for this instance, then supersede and create atomically.
      const locked = await client.query(
        `SELECT id FROM universe_embed_instances
          WHERE id = $1 AND browser_binding_digest = $2 AND expires_at > clock_timestamp() FOR UPDATE`,
        [instanceId, browser]);
      if (locked.rowCount !== 1) throw new Error("embed instance unavailable");
      // A completed handoff loses its session and person when superseded.
      await client.query(
        `UPDATE universe_embed_handoffs SET status = 'superseded', session_digest = NULL, person_id = NULL
          WHERE instance_id = $1 AND status IN ('pending', 'completed')`, [instanceId]);
      const { rows } = await client.query<{ id: string }>(
        `INSERT INTO universe_embed_handoffs (instance_id, browser_binding_digest, destination, status, expires_at)
         VALUES ($1, $2, '/universe/embed', 'pending', clock_timestamp() + ($3 * interval '1 second'))
         RETURNING id`, [instanceId, browser, positive(ttlSeconds)]);
      return rows[0]!.id;
    });
  }

  async attachState(handoffId: string, state: string): Promise<boolean> {
    const { rowCount } = await this.#pool.query(
      `UPDATE universe_embed_handoffs SET state_digest = $2
        WHERE id = $1 AND status = 'pending' AND state_digest IS NULL AND expires_at > clock_timestamp()`,
      [handoffId, universeEmbedDigest(state)]);
    return rowCount === 1;
  }

  async completeHandoff(state: string, sessionId: string, personId: string): Promise<boolean> {
    const { rowCount } = await this.#pool.query(
      `UPDATE universe_embed_handoffs SET status = 'completed', session_digest = $2, person_id = $3
        WHERE state_digest = $1 AND status = 'pending' AND expires_at > clock_timestamp()`,
      [universeEmbedDigest(state), universeEmbedDigest(sessionId), personId]);
    return rowCount === 1;
  }

  async consumeHandoff(instanceId: string, browserBinding: string, sessionId: string): Promise<string | undefined> {
    const browser = universeEmbedDigest(browserBinding);
    const session = universeEmbedDigest(sessionId);
    return this.#tx(async (client) => {
      // Same lock order as createHandoff (instance, then handoff), so the two never deadlock.
      const locked = await client.query(
        `SELECT id FROM universe_embed_instances
          WHERE id = $1 AND browser_binding_digest = $2 AND expires_at > clock_timestamp() FOR UPDATE`,
        [instanceId, browser]);
      if (locked.rowCount !== 1) return undefined;
      const { rows } = await client.query<{ person_id: string }>(
        `UPDATE universe_embed_handoffs SET status = 'consumed'
          WHERE instance_id = $1 AND browser_binding_digest = $2 AND session_digest = $3
            AND status = 'completed' AND expires_at > clock_timestamp()
        RETURNING person_id`, [instanceId, browser, session]);
      const personId = rows[0]?.person_id;
      if (!personId) return undefined;
      // The session must still be live by database time when the binding is recorded.
      const live = await client.query(
        "SELECT 1 FROM login_sessions WHERE id = $1 AND person_id = $2 AND expires_at > clock_timestamp()",
        [session, personId]);
      if (live.rowCount !== 1) return undefined;
      // A new binding never inherits a lease, challenge or generation-bound state.
      await client.query("DELETE FROM universe_embed_bindings WHERE instance_id = $1", [instanceId]);
      await client.query(
        `INSERT INTO universe_embed_bindings (instance_id, browser_binding_digest, session_digest, person_id)
         VALUES ($1, $2, $3, $4)`, [instanceId, browser, session, personId]);
      return personId;
    });
  }

  async readBinding(instanceId: string, browserBinding: string, sessionId: string): Promise<UniverseEmbedBindingView | undefined> {
    const { rows } = await this.#pool.query<{
      person_id: string; generation: number; lease_host_subject_digest: string | null;
      lease_expires_at: Date | null; lease_live: boolean; locked: boolean;
    }>(
      `SELECT b.person_id, b.generation, b.lease_host_subject_digest, b.lease_expires_at,
              (b.lease_expires_at IS NOT NULL AND b.lease_expires_at > clock_timestamp()) AS lease_live,
              EXISTS (SELECT 1 FROM external_identities e
                       WHERE e.person_id = b.person_id AND e.locked_at IS NOT NULL) AS locked
         FROM universe_embed_bindings b
         JOIN universe_embed_instances i ON i.id = b.instance_id AND i.expires_at > clock_timestamp()
        WHERE b.instance_id = $1 AND b.browser_binding_digest = $2 AND b.session_digest = $3`,
      [instanceId, universeEmbedDigest(browserBinding), universeEmbedDigest(sessionId)]);
    const row = rows[0];
    if (!row) return undefined;
    return {
      personId: row.person_id,
      generation: row.generation,
      locked: row.locked,
      ...(row.lease_live && row.lease_host_subject_digest && row.lease_expires_at
        ? { lease: { hostSubjectDigest: row.lease_host_subject_digest, expiresAt: row.lease_expires_at } } : {}),
    };
  }

  async invalidateBinding(instanceId: string, generation?: number): Promise<void> {
    // With a generation, only the binding version the caller checked is removed;
    // a replacement or renewed binding (a different generation) stays.
    if (generation === undefined) {
      await this.#pool.query("DELETE FROM universe_embed_bindings WHERE instance_id = $1", [instanceId]);
    } else {
      await this.#pool.query("DELETE FROM universe_embed_bindings WHERE instance_id = $1 AND generation = $2", [instanceId, generation]);
    }
  }

  async issueChallenge(instanceId: string, browserBinding: string, sessionId: string, challenge: string, ttlSeconds: number): Promise<boolean> {
    const { rowCount } = await this.#pool.query(
      `WITH expired AS (DELETE FROM universe_embed_challenges WHERE expires_at <= clock_timestamp())
       INSERT INTO universe_embed_challenges (challenge_digest, instance_id, generation, expires_at)
       SELECT $4, b.instance_id, b.generation, clock_timestamp() + ($5 * interval '1 second')
         FROM universe_embed_bindings b
        WHERE b.instance_id = $1 AND b.browser_binding_digest = $2 AND b.session_digest = $3`,
      [instanceId, universeEmbedDigest(browserBinding), universeEmbedDigest(sessionId),
        universeEmbedDigest(challenge), positive(ttlSeconds)]);
    return rowCount === 1;
  }

  async consumeChallenge(instanceId: string, challenge: string): Promise<number | undefined> {
    // One use; valid only for the binding generation it was issued in.
    const { rows } = await this.#pool.query<{ generation: number }>(
      `DELETE FROM universe_embed_challenges c
        USING universe_embed_bindings b
        WHERE c.challenge_digest = $2 AND c.instance_id = $1 AND b.instance_id = c.instance_id
          AND c.generation = b.generation AND c.expires_at > clock_timestamp()
      RETURNING c.generation`, [instanceId, universeEmbedDigest(challenge)]);
    return rows[0]?.generation;
  }

  async writeLease(instanceId: string, generation: number, hostSubject: string,
    issuedAtEpochSeconds: number, leaseSeconds: number): Promise<Date | undefined> {
    if (!Number.isFinite(issuedAtEpochSeconds)) throw new TypeError("issuedAt must be finite");
    // Expiry = min(attestation iat + lease, platform session expiry). Never
    // receipt time + lease, so a late attestation cannot add time.
    const { rows } = await this.#pool.query<{ lease_expires_at: Date }>(
      `UPDATE universe_embed_bindings b
          SET generation = nextval('universe_embed_binding_generation_seq'),
              lease_host_subject_digest = $3,
              lease_expires_at = LEAST(to_timestamp($4::double precision) + ($5 * interval '1 second'), s.expires_at)
         FROM login_sessions s
        WHERE b.instance_id = $1 AND b.generation = $2
          AND s.id = b.session_digest AND s.person_id = b.person_id AND s.expires_at > clock_timestamp()
          AND LEAST(to_timestamp($4::double precision) + ($5 * interval '1 second'), s.expires_at) > clock_timestamp()
      RETURNING b.lease_expires_at`,
      [instanceId, generation, universeEmbedDigest(hostSubject), issuedAtEpochSeconds, positive(leaseSeconds)]);
    return rows[0]?.lease_expires_at;
  }

  async identitySubjects(personId: string, issuer: string): Promise<readonly string[]> {
    const { rows } = await this.#pool.query<{ subject: string }>(
      "SELECT subject FROM external_identities WHERE person_id = $1 AND issuer = $2 ORDER BY subject",
      [personId, issuer]);
    return rows.map((row) => row.subject);
  }
}

function positive(seconds: number): number {
  if (!Number.isSafeInteger(seconds) || seconds <= 0) throw new RangeError("ttl must be a positive integer");
  return seconds;
}
