import pg from "pg";
import type { Pool, PoolClient, PoolConfig } from "pg";
import { principalAuditRef } from "./authorization-audit.js";

export type LegacyLinkMethod = "legacy_login" | "staff";
export type LegacyApprovedProfileLink = {readonly kind:"linked";readonly candidateRef:string}|{readonly kind:"unconfigured"}|{readonly kind:"missing"}|{readonly kind:"conflict"};
/** The approved profile source. Its own resolveLink, when present, still answers for people without a legacy link row. */
export interface LegacySnapshotPort { readCandidate(candidateRef: string): Promise<unknown | undefined>; resolveLink?(principalId: string): Promise<LegacyApprovedProfileLink> }
export interface LegacyLinkStatus { readonly linked: boolean; readonly candidateId?: string }
export class LegacyCandidateAlreadyLinkedError extends Error { constructor() { super("legacy candidate is already linked"); this.name = "LegacyCandidateAlreadyLinkedError"; } }
export class PrincipalAlreadyLinkedError extends Error { constructor() { super("principal is already linked"); this.name = "PrincipalAlreadyLinkedError"; } }

function candidateId(value: string): string {
  if (!/^[1-9][0-9]*$/.test(value)) throw new TypeError("legacyCandidateId must be positive digits");
  return value;
}
function principal(value: string): string {
  if (!value.trim()) throw new TypeError("principalId must be non-empty");
  return value;
}

export class PostgresLegacyLinkStore {
  readonly #pool: Pool;
  readonly #ownsPool: boolean;
  readonly #snapshot: LegacySnapshotPort;
  constructor(poolOrConfig: Pool | PoolConfig, snapshot: LegacySnapshotPort) {
    this.#pool = poolOrConfig instanceof pg.Pool ? poolOrConfig : new pg.Pool(poolOrConfig);
    this.#ownsPool = !(poolOrConfig instanceof pg.Pool);
    this.#snapshot = snapshot;
  }
  async close(): Promise<void> { if (this.#ownsPool) await this.#pool.end(); }
  async resolveLink(principalId: string): Promise<LegacyApprovedProfileLink> {
    const { rows } = await this.#pool.query<{legacy_candidate_id:string}>(
      "SELECT legacy_candidate_id::text FROM legacy_account_links WHERE principal_id = $1::text", [principal(principalId)]);
    const ref = rows[0]?.legacy_candidate_id;
    if (!ref) return this.#snapshot.resolveLink ? this.#snapshot.resolveLink(principalId) : { kind: "unconfigured" };
    // A linked candidate whose snapshot is not imported yet reads as not imported, not as a broken profile.
    if (await this.#snapshot.readCandidate(ref) === undefined) return { kind: "unconfigured" };
    return { kind: "linked", candidateRef: ref };
  }
  // References come from the link table (already digits) or from the approved source's own resolveLink, whose shape it owns.
  readCandidate(candidateRef: string): Promise<unknown | undefined> { return this.#snapshot.readCandidate(candidateRef); }
  async status(principalId: string): Promise<LegacyLinkStatus> {
    const { rows } = await this.#pool.query<{legacy_candidate_id:string}>(
      "SELECT legacy_candidate_id::text FROM legacy_account_links WHERE principal_id = $1::text", [principal(principalId)]);
    return rows[0] ? { linked: true, candidateId: rows[0].legacy_candidate_id } : { linked: false };
  }
  async link(input: {principalId:string;legacyCandidateId:string;actor:string;method:LegacyLinkMethod}): Promise<void> {
    const p = principal(input.principalId), c = candidateId(input.legacyCandidateId), actor = principalAuditRef(input.actor);
    await this.#transaction(async client => {
      try {
        await client.query(`INSERT INTO legacy_account_links
          (principal_id, legacy_candidate_id, linked_by_ref, method)
          VALUES ($1::text, $2::text, $3::text, $4::text)`, [p, c, actor, input.method]);
      } catch (error) { this.#mapUnique(error); }
      await client.query(`INSERT INTO legacy_account_link_events
        (principal_id, legacy_candidate_id, kind, actor_ref, method)
        VALUES ($1::text, $2::text, 'linked', $3::text, $4::text)`, [p, c, actor, input.method]);
      // Attempt state clears with the link itself, so a linked person never sees a failed request.
      await client.query("DELETE FROM legacy_link_attempts WHERE principal_id = $1::text", [p]);
    });
  }
  async unlink(input: {principalId:string;actor:string}): Promise<void> {
    const p = principal(input.principalId), actor = principalAuditRef(input.actor);
    await this.#transaction(async client => {
      const { rows } = await client.query<{legacy_candidate_id:string}>(
        "DELETE FROM legacy_account_links WHERE principal_id = $1::text RETURNING legacy_candidate_id::text", [p]);
      if (rows[0]) await client.query(`INSERT INTO legacy_account_link_events
        (principal_id, legacy_candidate_id, kind, actor_ref, method)
        VALUES ($1::text, $2::text, 'unlinked', $3::text, 'staff')`, [p, rows[0].legacy_candidate_id, actor]);
    });
  }
  async checkWait(principalId: string, now = new Date()): Promise<boolean> {
    const { rows } = await this.#pool.query<{waiting:boolean}>(
      "SELECT locked_until IS NOT NULL AND locked_until > $2::timestamptz AS waiting FROM legacy_link_attempts WHERE principal_id = $1::text",
      [principal(principalId), now]);
    return rows[0]?.waiting ?? false;
  }
  async recordFailure(principalId: string, now = new Date()): Promise<void> {
    await this.#pool.query(`INSERT INTO legacy_link_attempts (principal_id, failures, locked_until)
      VALUES ($1::text, 1::integer, NULL::timestamptz)
      ON CONFLICT (principal_id) DO UPDATE SET
        failures = CASE WHEN legacy_link_attempts.locked_until IS NOT NULL AND legacy_link_attempts.locked_until <= $2::timestamptz THEN 1::integer ELSE legacy_link_attempts.failures + 1::integer END,
        locked_until = CASE WHEN (CASE WHEN legacy_link_attempts.locked_until IS NOT NULL AND legacy_link_attempts.locked_until <= $2::timestamptz THEN 1::integer ELSE legacy_link_attempts.failures + 1::integer END) >= 5::integer
          THEN $2::timestamptz + (15::integer * interval '1 minute') ELSE NULL::timestamptz END`, [principal(principalId), now]);
  }
  async recordSuccess(principalId: string): Promise<void> {
    await this.#pool.query("DELETE FROM legacy_link_attempts WHERE principal_id = $1::text", [principal(principalId)]);
  }
  async #transaction(work:(client:PoolClient)=>Promise<void>):Promise<void>{
    const client=await this.#pool.connect(); try { await client.query("BEGIN"); await work(client); await client.query("COMMIT"); }
    catch(error){await client.query("ROLLBACK");throw error;} finally{client.release();}
  }
  #mapUnique(error:unknown):never {
    if ((error as {code?:string;constraint?:string}).code === "23505") {
      if ((error as {constraint?:string}).constraint?.includes("legacy_candidate")) throw new LegacyCandidateAlreadyLinkedError();
      throw new PrincipalAlreadyLinkedError();
    }
    throw error;
  }
}
