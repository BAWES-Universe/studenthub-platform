// Work lane stores (W-1 placements, W-3 sessions, W-7 day totals).
//
// The domain rules live in packages/work; this file only reads and writes
// rows. Its shapes mirror packages/work's ports structurally (the db package
// compiles on its own, like the notifications store). Errors that carry a
// meaning for the domain (23P01 overlap, 23505 on work_sessions_one_open) are
// raised inside a savepoint and passed through unchanged, so the caller can map
// them and the transaction stays usable.

import pg from "pg";
import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";
import type { PayContract } from "@studenthub/pay-contracts";
import { PostgresPayContractStore } from "./postgres-pay-contract-store.js";

type IsoDate = string;
type Json = Readonly<Record<string, string | number | boolean | null>>;

export interface WorkAssignmentRecord {
  readonly id: string; readonly personId: string; readonly orgId: string; readonly storeId: string;
  readonly payContractId: string | null;
  readonly contractResolution: { readonly version: "studenthub.pay-rate-resolution.v1"; readonly steps: readonly string[]; readonly matchedContractIds: readonly string[]; readonly contractId: string | null };
  readonly startDate: IsoDate; readonly endDate: IsoDate | null;
  readonly warnings: readonly ("civil_id_missing" | "civil_id_expires_before_start" | "no_pay_contract")[];
  readonly source: "staff" | "request" | "recruit" | "import"; readonly requestId: string | null;
  readonly recruitCardId: string | null; readonly recruitRequestId: string | null;
  readonly createdBy: string | null; readonly createdAt: string;
}
export interface WorkAssignmentRequestRecord {
  readonly id: string; readonly personId: string; readonly orgId: string; readonly storeId: string;
  readonly status: "pending" | "accepted" | "rejected" | "cancelled"; readonly note: string | null;
  readonly requestedBy: string; readonly requestedAt: string;
  readonly decidedBy: string | null; readonly decidedAt: string | null; readonly decisionReason: string | null;
}
export interface WorkEventRecord {
  readonly kind: string; readonly orgId: string; readonly personId: string; readonly subjectId: string;
  readonly actorId: string | null; readonly detail: Json;
}
export interface WorkLocation { readonly latitude: number; readonly longitude: number }
export interface WorkSessionRecord {
  readonly id: string; readonly assignmentId: string; readonly personId: string; readonly orgId: string; readonly storeId: string;
  readonly workDate: IsoDate; readonly startedAt: string; readonly endedAt: string | null; readonly durationSeconds: number | null;
  readonly startLocation: WorkLocation | null; readonly endLocation: WorkLocation | null;
  readonly source: "timer" | "manual" | "correction" | "import"; readonly status: "pending" | "approved" | "rejected";
  readonly flags: readonly ("late_entry" | "location_missing")[]; readonly note: string | null;
  readonly correctsSessionId: string | null; readonly decisionId: string | null; readonly deletedAt: string | null;
  readonly createdBy: string | null; readonly createdAt: string; readonly appealId: string | null;
}
export interface NewWorkSessionRecord {
  readonly id: string; readonly assignmentId: string; readonly personId: string; readonly orgId: string; readonly storeId: string;
  readonly workDate: IsoDate; readonly startedAt: Date; readonly endedAt: Date | null;
  readonly startLocation: WorkLocation | null; readonly endLocation: WorkLocation | null;
  readonly source: "timer" | "manual" | "correction"; readonly status: "pending" | "approved" | "rejected";
  readonly flags: readonly ("late_entry" | "location_missing")[]; readonly note: string | null;
  readonly correctsSessionId: string | null; readonly createdBy: string; readonly appealId?: string | null;
}
export interface WorkDayTotal {
  readonly personId: string; readonly assignmentId: string; readonly orgId: string; readonly storeId: string; readonly workDate: IsoDate;
  readonly firstStartedAt: string | null; readonly lastEndedAt: string | null;
  readonly approvedSeconds: number; readonly pendingSeconds: number; readonly rejectedSeconds: number;
  readonly approvedCount: number; readonly pendingCount: number; readonly rejectedCount: number; readonly openCount: number;
}

export type Queryable = Pick<PoolClient, "query">;

export const ASSIGNMENT_COLUMNS = `a.id, a.person_principal_id, a.org_id, a.store_id, a.pay_contract_id, a.contract_resolution,
 to_char(a.start_date,'YYYY-MM-DD') AS start_date, to_char(a.end_date,'YYYY-MM-DD') AS end_date, a.warnings, a.source,
 a.request_id, a.recruit_card_id, a.recruit_request_id, a.created_by, a.created_at`;
export interface AssignmentRow {
  id: string; person_principal_id: string; org_id: string; store_id: string; pay_contract_id: string | null;
  contract_resolution: WorkAssignmentRecord["contractResolution"]; start_date: string; end_date: string | null;
  warnings: WorkAssignmentRecord["warnings"]; source: WorkAssignmentRecord["source"]; request_id: string | null;
  recruit_card_id: string | null; recruit_request_id: string | null; created_by: string | null; created_at: Date;
}
export function assignmentFromRow(r: AssignmentRow): WorkAssignmentRecord {
  return Object.freeze({
    id: r.id, personId: r.person_principal_id, orgId: r.org_id, storeId: r.store_id, payContractId: r.pay_contract_id,
    contractResolution: r.contract_resolution, startDate: r.start_date, endDate: r.end_date, warnings: Object.freeze([...r.warnings]),
    source: r.source, requestId: r.request_id, recruitCardId: r.recruit_card_id, recruitRequestId: r.recruit_request_id, createdBy: r.created_by, createdAt: r.created_at.toISOString(),
  });
}

const REQUEST_COLUMNS = `id, person_principal_id, org_id, store_id, status, note, requested_by, requested_at, decided_by, decided_at, decision_reason`;
interface RequestRow {
  id: string; person_principal_id: string; org_id: string; store_id: string; status: WorkAssignmentRequestRecord["status"]; note: string | null;
  requested_by: string; requested_at: Date; decided_by: string | null; decided_at: Date | null; decision_reason: string | null;
}
function requestFromRow(r: RequestRow): WorkAssignmentRequestRecord {
  return Object.freeze({
    id: r.id, personId: r.person_principal_id, orgId: r.org_id, storeId: r.store_id, status: r.status, note: r.note,
    requestedBy: r.requested_by, requestedAt: r.requested_at.toISOString(), decidedBy: r.decided_by,
    decidedAt: r.decided_at ? r.decided_at.toISOString() : null, decisionReason: r.decision_reason,
  });
}

export const SESSION_COLUMNS = `s.id, s.assignment_id, s.person_principal_id, s.org_id, s.store_id, to_char(s.work_date,'YYYY-MM-DD') AS work_date,
 s.started_at, s.ended_at, s.duration_seconds, s.start_latitude::float8 AS start_latitude, s.start_longitude::float8 AS start_longitude,
 s.end_latitude::float8 AS end_latitude, s.end_longitude::float8 AS end_longitude, s.source, s.status, s.flags, s.note,
 s.corrects_session_id, s.decision_id, s.deleted_at, s.created_by, s.created_at, s.appeal_id`;
export interface SessionRow {
  id: string; assignment_id: string; person_principal_id: string; org_id: string; store_id: string; work_date: string;
  started_at: Date; ended_at: Date | null; duration_seconds: number | null;
  start_latitude: number | null; start_longitude: number | null; end_latitude: number | null; end_longitude: number | null;
  source: WorkSessionRecord["source"]; status: WorkSessionRecord["status"]; flags: WorkSessionRecord["flags"]; note: string | null;
  corrects_session_id: string | null; decision_id: string | null; deleted_at: Date | null; created_by: string | null; created_at: Date;
  appeal_id: string | null;
}
const location = (lat: number | null, long: number | null): WorkLocation | null => lat === null || long === null ? null : Object.freeze({ latitude: lat, longitude: long });
export function workSessionFromRow(r: SessionRow): WorkSessionRecord {
  return Object.freeze({
    id: r.id, assignmentId: r.assignment_id, personId: r.person_principal_id, orgId: r.org_id, storeId: r.store_id, workDate: r.work_date,
    startedAt: r.started_at.toISOString(), endedAt: r.ended_at ? r.ended_at.toISOString() : null, durationSeconds: r.duration_seconds,
    startLocation: location(r.start_latitude, r.start_longitude), endLocation: location(r.end_latitude, r.end_longitude),
    source: r.source, status: r.status, flags: Object.freeze([...r.flags]), note: r.note, correctsSessionId: r.corrects_session_id, decisionId: r.decision_id,
    deletedAt: r.deleted_at ? r.deleted_at.toISOString() : null, createdBy: r.created_by, createdAt: r.created_at.toISOString(), appealId: r.appeal_id,
  });
}

/** Runs `sql` inside a savepoint so a refused write (overlap, duplicate) leaves the transaction usable. */
export async function guarded<T>(client: Queryable, work: () => Promise<T>): Promise<T> {
  await client.query("SAVEPOINT work_write");
  try {
    const result = await work();
    await client.query("RELEASE SAVEPOINT work_write");
    return result;
  } catch (error) {
    await client.query("ROLLBACK TO SAVEPOINT work_write");
    await client.query("RELEASE SAVEPOINT work_write");
    throw error;
  }
}

export async function insertEvent(client: Queryable, e: WorkEventRecord): Promise<void> {
  await client.query("INSERT INTO work_events(kind,org_id,person_principal_id,subject_id,actor_principal_id,detail) VALUES($1,$2,$3,$4,$5,$6::jsonb)",
    [e.kind, e.orgId, e.personId, e.subjectId, e.actorId, JSON.stringify(e.detail)]);
}

export class PoolOwner {
  readonly pool: PgPool;
  readonly #owns: boolean;
  constructor(poolOrConfig: PgPool | PoolConfig) {
    this.pool = poolOrConfig instanceof pg.Pool ? poolOrConfig : new pg.Pool(poolOrConfig);
    this.#owns = !(poolOrConfig instanceof pg.Pool);
  }
  async close(): Promise<void> { if (this.#owns) await this.pool.end(); }
  async transaction<T>(work: (client: PoolClient) => Promise<T>): Promise<T> {
    const client = await this.pool.connect();
    let broken = false;
    try {
      await client.query("BEGIN");
      const result = await work(client);
      await client.query("COMMIT");
      return result;
    } catch (error) {
      await client.query("ROLLBACK").catch(() => { broken = true; });
      throw error;
    } finally {
      client.release(broken);
    }
  }
}

/** Assignment in force on a date at an active store. */
async function assignmentOn(q: Queryable, personId: string, date: IsoDate): Promise<WorkAssignmentRecord | undefined> {
  const { rows } = await q.query<AssignmentRow>(`SELECT ${ASSIGNMENT_COLUMNS} FROM work_assignments a JOIN organization_stores st ON st.id = a.store_id
   WHERE a.person_principal_id = $1 AND a.start_date <= $2::date AND (a.end_date IS NULL OR a.end_date >= $2::date) AND st.status = 'active'
   ORDER BY a.start_date DESC LIMIT 1`, [personId, date]);
  return rows[0] ? assignmentFromRow(rows[0]) : undefined;
}

/** W-1 placements and assignment requests. */
export class PostgresWorkPlacementStore {
  readonly #db: PoolOwner;
  readonly #contracts: PostgresPayContractStore;

  constructor(poolOrConfig: PgPool | PoolConfig) {
    this.#db = new PoolOwner(poolOrConfig);
    this.#contracts = new PostgresPayContractStore(this.#db.pool);
  }
  async close(): Promise<void> { await this.#db.close(); }

  async store(storeId: string): Promise<{ id: string; orgId: string; status: "active" | "deleted"; ancestors: readonly string[] } | undefined> {
    const { rows } = await this.#db.pool.query<{ id: string; org_id: string; status: "active" | "deleted" }>("SELECT id, org_id, status FROM organization_stores WHERE id = $1", [storeId]);
    const row = rows[0];
    if (!row) return undefined;
    return { id: row.id, orgId: row.org_id, status: row.status, ancestors: (await this.organizationAncestors(row.org_id)) ?? [] };
  }

  async organizationAncestors(orgId: string): Promise<readonly string[] | undefined> {
    const { rows } = await this.#db.pool.query<{ id: string; depth: number }>(`WITH RECURSIVE up(id, parent, depth) AS (
      SELECT id, parent_org_id, 0 FROM organizations WHERE id = $1
      UNION ALL SELECT o.id, o.parent_org_id, up.depth + 1 FROM organizations o JOIN up ON o.id = up.parent WHERE up.depth < 32)
     SELECT id, depth FROM up ORDER BY depth`, [orgId]);
    if (rows.length === 0) return undefined;
    return Object.freeze(rows.slice(1).map((r) => r.id));
  }

  async personExists(personId: string): Promise<boolean> {
    return (await this.#db.pool.query("SELECT 1 FROM principals WHERE id = $1", [personId])).rowCount === 1;
  }

  async civilId(personId: string): Promise<{ present: boolean; expiry: IsoDate | null }> {
    const { rows } = await this.#db.pool.query<{ number_hash: Buffer | null; expiry: string | null }>(
      "SELECT number_hash, to_char(expiry_date,'YYYY-MM-DD') AS expiry FROM person_civil_ids WHERE principal_id = $1 AND released_at IS NULL", [personId]);
    const row = rows[0];
    return { present: row !== undefined && row.number_hash !== null, expiry: row?.expiry ?? null };
  }

  async contracts(personId: string): Promise<readonly PayContract[]> {
    return this.#contracts.listForCandidate(personId);
  }

  async assignment(id: string): Promise<WorkAssignmentRecord | undefined> {
    const { rows } = await this.#db.pool.query<AssignmentRow>(`SELECT ${ASSIGNMENT_COLUMNS} FROM work_assignments a WHERE a.id = $1`, [id]);
    return rows[0] ? assignmentFromRow(rows[0]) : undefined;
  }

  async assignmentForRecruitCard(recruitCardId: string): Promise<WorkAssignmentRecord | undefined> {
    const { rows } = await this.#db.pool.query<AssignmentRow>(`SELECT ${ASSIGNMENT_COLUMNS} FROM work_assignments a WHERE a.recruit_card_id = $1`, [recruitCardId]);
    return rows[0] ? assignmentFromRow(rows[0]) : undefined;
  }

  async request(id: string): Promise<WorkAssignmentRequestRecord | undefined> {
    const { rows } = await this.#db.pool.query<RequestRow>(`SELECT ${REQUEST_COLUMNS} FROM work_assignment_requests WHERE id = $1`, [id]);
    return rows[0] ? requestFromRow(rows[0]) : undefined;
  }

  /** Newest first. `orgIds` covers each organization, and its sub-companies only with `includeSubtree`. */
  async listAssignments(filter: { personId?: string; orgIds?: readonly string[]; includeSubtree?: boolean; storeId?: string }): Promise<readonly WorkAssignmentRecord[]> {
    const { rows } = await this.#db.pool.query<AssignmentRow>(`WITH RECURSIVE tree(id) AS (
       SELECT id FROM organizations WHERE $2::text[] IS NOT NULL AND id = ANY($2::text[])
       UNION SELECT o.id FROM organizations o JOIN tree t ON o.parent_org_id = t.id WHERE $4::boolean)
     SELECT ${ASSIGNMENT_COLUMNS} FROM work_assignments a
     WHERE ($1::text IS NULL OR a.person_principal_id = $1) AND ($2::text[] IS NULL OR a.org_id IN (SELECT id FROM tree))
       AND ($3::uuid IS NULL OR a.store_id = $3::uuid)
     ORDER BY a.start_date DESC, a.id LIMIT 500`, [filter.personId ?? null, filter.orgIds ?? null, filter.storeId ?? null, filter.includeSubtree === true]);
    return Object.freeze(rows.map(assignmentFromRow));
  }

  async listRequests(filter: { orgIds?: readonly string[]; includeSubtree?: boolean; status?: WorkAssignmentRequestRecord["status"] }): Promise<readonly WorkAssignmentRequestRecord[]> {
    const { rows } = await this.#db.pool.query<RequestRow>(`WITH RECURSIVE tree(id) AS (
       SELECT id FROM organizations WHERE $1::text[] IS NOT NULL AND id = ANY($1::text[])
       UNION SELECT o.id FROM organizations o JOIN tree t ON o.parent_org_id = t.id WHERE $3::boolean)
     SELECT ${REQUEST_COLUMNS} FROM work_assignment_requests
     WHERE ($1::text[] IS NULL OR org_id IN (SELECT id FROM tree)) AND ($2::text IS NULL OR status = $2)
     ORDER BY requested_at DESC, id LIMIT 500`, [filter.orgIds ?? null, filter.status ?? null, filter.includeSubtree === true]);
    return Object.freeze(rows.map(requestFromRow));
  }

  async transaction<T>(work: (tx: WorkPlacementTransaction) => Promise<T>): Promise<T> {
    return this.#db.transaction((client) => work(placementTransaction(client)));
  }
}

export interface WorkPlacementTransaction {
  insertAssignment(a: WorkAssignmentRecord): Promise<void>;
  lockAssignment(id: string): Promise<WorkAssignmentRecord | undefined>;
  setEndDate(id: string, endDate: IsoDate | null): Promise<void>;
  insertRequest(r: WorkAssignmentRequestRecord): Promise<"inserted" | "duplicate_pending">;
  lockRequest(id: string): Promise<WorkAssignmentRequestRecord | undefined>;
  decideRequest(id: string, status: "accepted" | "rejected" | "cancelled", actorId: string, reason: string | null): Promise<void>;
  openSessionCount(assignmentId: string): Promise<number>;
  event(e: WorkEventRecord): Promise<void>;
}

function placementTransaction(client: PoolClient): WorkPlacementTransaction {
  return {
    async insertAssignment(a) {
      await guarded(client, () => client.query(`INSERT INTO work_assignments(id, person_principal_id, org_id, store_id, pay_contract_id, contract_resolution,
        start_date, end_date, warnings, source, request_id, recruit_card_id, recruit_request_id, created_by, created_at)
        VALUES($1,$2,$3,$4,$5,$6::jsonb,$7::date,$8::date,$9::text[],$10,$11,$12,$13,$14,$15)`,
        [a.id, a.personId, a.orgId, a.storeId, a.payContractId, JSON.stringify(a.contractResolution), a.startDate, a.endDate, [...a.warnings], a.source, a.requestId,
          a.recruitCardId, a.recruitRequestId, a.createdBy, a.createdAt]));
    },
    async lockAssignment(id) {
      const { rows } = await client.query<AssignmentRow>(`SELECT ${ASSIGNMENT_COLUMNS} FROM work_assignments a WHERE a.id = $1 FOR UPDATE`, [id]);
      return rows[0] ? assignmentFromRow(rows[0]) : undefined;
    },
    async setEndDate(id, endDate) {
      await guarded(client, () => client.query("UPDATE work_assignments SET end_date = $2::date WHERE id = $1", [id, endDate]));
    },
    async insertRequest(r) {
      try {
        await guarded(client, () => client.query(`INSERT INTO work_assignment_requests(id, person_principal_id, org_id, store_id, status, note, requested_by, requested_at)
          VALUES($1,$2,$3,$4,'pending',$5,$6,$7)`, [r.id, r.personId, r.orgId, r.storeId, r.note, r.requestedBy, r.requestedAt]));
        return "inserted";
      } catch (error) {
        if ((error as { code?: string; constraint?: string }).code === "23505" && (error as { constraint?: string }).constraint === "work_assignment_requests_one_pending") return "duplicate_pending";
        throw error;
      }
    },
    async lockRequest(id) {
      const { rows } = await client.query<RequestRow>(`SELECT ${REQUEST_COLUMNS} FROM work_assignment_requests WHERE id = $1 FOR UPDATE`, [id]);
      return rows[0] ? requestFromRow(rows[0]) : undefined;
    },
    async decideRequest(id, status, actorId, reason) {
      await client.query("UPDATE work_assignment_requests SET status = $2, decided_by = $3, decided_at = clock_timestamp(), decision_reason = $4 WHERE id = $1 AND status = 'pending'", [id, status, actorId, reason]);
    },
    async openSessionCount(assignmentId) {
      const { rows } = await client.query<{ n: number }>("SELECT count(*)::int AS n FROM work_sessions WHERE assignment_id = $1 AND ended_at IS NULL AND deleted_at IS NULL", [assignmentId]);
      return rows[0]?.n ?? 0;
    },
    event: (e) => insertEvent(client, e),
  };
}

export interface WorkSessionTransaction {
  insert(s: NewWorkSessionRecord): Promise<WorkSessionRecord>;
  lockOpen(personId: string): Promise<WorkSessionRecord | undefined>;
  lock(id: string): Promise<WorkSessionRecord | undefined>;
  close(id: string, endedAt: Date, endLocation: WorkLocation): Promise<WorkSessionRecord>;
  softDelete(id: string, actorId: string, reason: string): Promise<void>;
  restore(id: string): Promise<void>;
  event(e: WorkEventRecord): Promise<void>;
}

export async function insertSession(client: PoolClient, s: NewWorkSessionRecord): Promise<WorkSessionRecord> {
  return guarded(client, async () => {
    const { rows } = await client.query<SessionRow>(`WITH s AS (INSERT INTO work_sessions(id, assignment_id, person_principal_id, org_id, store_id, work_date, started_at, ended_at,
      start_latitude, start_longitude, end_latitude, end_longitude, source, status, flags, note, corrects_session_id, created_by, appeal_id)
      VALUES($1,$2,$3,$4,$5,$6::date,$7,$8,$9,$10,$11,$12,$13,$14,$15::text[],$16,$17,$18,$19) RETURNING *) SELECT ${SESSION_COLUMNS} FROM s`,
    [s.id, s.assignmentId, s.personId, s.orgId, s.storeId, s.workDate, s.startedAt, s.endedAt,
      s.startLocation?.latitude ?? null, s.startLocation?.longitude ?? null, s.endLocation?.latitude ?? null, s.endLocation?.longitude ?? null,
      s.source, s.status, [...s.flags], s.note, s.correctsSessionId, s.createdBy, s.appealId ?? null]);
    if (!rows[0]) throw new Error("work session insert returned no row");
    return workSessionFromRow(rows[0]);
  });
}

function sessionTransaction(client: PoolClient): WorkSessionTransaction {
  const one = async (sql: string, values: unknown[]) => {
    const { rows } = await client.query<SessionRow>(sql, values);
    return rows[0] ? workSessionFromRow(rows[0]) : undefined;
  };
  return {
    insert: (s) => insertSession(client, s),
    lockOpen: (personId) => one(`SELECT ${SESSION_COLUMNS} FROM work_sessions s WHERE s.person_principal_id = $1 AND s.ended_at IS NULL AND s.deleted_at IS NULL FOR UPDATE`, [personId]),
    lock: (id) => one(`SELECT ${SESSION_COLUMNS} FROM work_sessions s WHERE s.id = $1 FOR UPDATE`, [id]),
    async close(id, endedAt, endLocation) {
      const row = await guarded(client, () => one(`WITH s AS (UPDATE work_sessions SET ended_at = $2, end_latitude = $3, end_longitude = $4
        WHERE id = $1 AND ended_at IS NULL RETURNING *) SELECT ${SESSION_COLUMNS} FROM s`, [id, endedAt, endLocation.latitude, endLocation.longitude]));
      if (!row) throw new Error("work session was not open");
      return row;
    },
    async softDelete(id, actorId, reason) {
      await client.query("UPDATE work_sessions SET deleted_at = clock_timestamp(), deleted_by = $2, delete_reason = $3 WHERE id = $1 AND deleted_at IS NULL", [id, actorId, reason]);
    },
    async restore(id) {
      await guarded(client, () => client.query("UPDATE work_sessions SET deleted_at = NULL, deleted_by = NULL, delete_reason = NULL WHERE id = $1 AND deleted_at IS NOT NULL", [id]));
    },
    event: (e) => insertEvent(client, e),
  };
}

/** W-3 sessions and W-7 day totals. */
export class PostgresWorkSessionStore {
  readonly #db: PoolOwner;
  constructor(poolOrConfig: PgPool | PoolConfig) { this.#db = new PoolOwner(poolOrConfig); }
  async close(): Promise<void> { await this.#db.close(); }

  assignmentOn(personId: string, date: IsoDate): Promise<WorkAssignmentRecord | undefined> { return assignmentOn(this.#db.pool, personId, date); }

  async assignment(id: string): Promise<WorkAssignmentRecord | undefined> {
    const { rows } = await this.#db.pool.query<AssignmentRow>(`SELECT ${ASSIGNMENT_COLUMNS} FROM work_assignments a WHERE a.id = $1`, [id]);
    return rows[0] ? assignmentFromRow(rows[0]) : undefined;
  }

  async open(personId: string): Promise<WorkSessionRecord | undefined> {
    const { rows } = await this.#db.pool.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM work_sessions s WHERE s.person_principal_id = $1 AND s.ended_at IS NULL AND s.deleted_at IS NULL`, [personId]);
    return rows[0] ? workSessionFromRow(rows[0]) : undefined;
  }

  async session(id: string): Promise<WorkSessionRecord | undefined> {
    const { rows } = await this.#db.pool.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM work_sessions s WHERE s.id = $1`, [id]);
    return rows[0] ? workSessionFromRow(rows[0]) : undefined;
  }

  /** Day totals for one person over an inclusive date range, oldest first. */
  async dayTotals(filter: { personId?: string; storeId?: string; orgIds?: readonly string[]; from: IsoDate; to: IsoDate }): Promise<readonly WorkDayTotal[]> {
    const { rows } = await this.#db.pool.query<{
      person_principal_id: string; assignment_id: string; org_id: string; store_id: string; work_date: string;
      first_started_at: Date | null; last_ended_at: Date | null; approved_seconds: string; pending_seconds: string; rejected_seconds: string;
      approved_count: number; pending_count: number; rejected_count: number; open_count: number;
    }>(`WITH RECURSIVE tree(id) AS (
       SELECT id FROM organizations WHERE $3::text[] IS NOT NULL AND id = ANY($3::text[])
       UNION SELECT o.id FROM organizations o JOIN tree t ON o.parent_org_id = t.id)
     SELECT person_principal_id, assignment_id, org_id, store_id, to_char(work_date,'YYYY-MM-DD') AS work_date, first_started_at, last_ended_at,
      approved_seconds::text, pending_seconds::text, rejected_seconds::text, approved_count, pending_count, rejected_count, open_count
     FROM work_day_totals WHERE ($1::text IS NULL OR person_principal_id = $1) AND ($2::uuid IS NULL OR store_id = $2::uuid)
      AND ($3::text[] IS NULL OR org_id IN (SELECT id FROM tree)) AND work_date BETWEEN $4::date AND $5::date
     ORDER BY work_date, person_principal_id, assignment_id`, [filter.personId ?? null, filter.storeId ?? null, filter.orgIds ?? null, filter.from, filter.to]);
    return Object.freeze(rows.map((r) => Object.freeze({
      personId: r.person_principal_id, assignmentId: r.assignment_id, orgId: r.org_id, storeId: r.store_id, workDate: r.work_date,
      firstStartedAt: r.first_started_at?.toISOString() ?? null, lastEndedAt: r.last_ended_at?.toISOString() ?? null,
      approvedSeconds: Number(r.approved_seconds), pendingSeconds: Number(r.pending_seconds), rejectedSeconds: Number(r.rejected_seconds),
      approvedCount: r.approved_count, pendingCount: r.pending_count, rejectedCount: r.rejected_count, openCount: r.open_count,
    })));
  }

  async transaction<T>(work: (tx: WorkSessionTransaction) => Promise<T>): Promise<T> {
    return this.#db.transaction((client) => work(sessionTransaction(client)));
  }
}

export interface WorkDecisionRecord {
  readonly id: string; readonly orgId: string; readonly storeId: string; readonly personId: string; readonly workDate: IsoDate;
  readonly scope: "session" | "day"; readonly outcome: "approved" | "rejected" | "undone"; readonly sessionIds: readonly string[];
  readonly reason: string | null; readonly note: string | null; readonly rating: number | null; readonly notePublic: boolean;
  readonly batchId: string | null; readonly decidedBy: string | null; readonly decidedAt: string;
}
interface DecisionRow {
  id: string; org_id: string; store_id: string; person_principal_id: string; work_date: string; scope: "session" | "day";
  outcome: "approved" | "rejected" | "undone"; session_ids: string[]; reason: string | null; note: string | null; rating: number | null;
  note_public: boolean; batch_id: string | null; decided_by: string | null; decided_at: Date;
}
const DECISION_COLUMNS = `id, org_id, store_id, person_principal_id, to_char(work_date,'YYYY-MM-DD') AS work_date, scope, outcome, session_ids,
 reason, note, rating, note_public, batch_id, decided_by, decided_at`;
function decisionFromRow(r: DecisionRow): WorkDecisionRecord {
  return Object.freeze({
    id: r.id, orgId: r.org_id, storeId: r.store_id, personId: r.person_principal_id, workDate: r.work_date, scope: r.scope, outcome: r.outcome,
    sessionIds: Object.freeze([...r.session_ids]), reason: r.reason, note: r.note, rating: r.rating, notePublic: r.note_public,
    batchId: r.batch_id, decidedBy: r.decided_by, decidedAt: r.decided_at.toISOString(),
  });
}

export async function ancestorsOf(q: Queryable, orgId: string): Promise<readonly string[] | undefined> {
  const { rows } = await q.query<{ id: string; depth: number }>(`WITH RECURSIVE up(id, parent, depth) AS (
    SELECT id, parent_org_id, 0 FROM organizations WHERE id = $1
    UNION ALL SELECT o.id, o.parent_org_id, up.depth + 1 FROM organizations o JOIN up ON o.id = up.parent WHERE up.depth < 32)
   SELECT id, depth FROM up ORDER BY depth`, [orgId]);
  return rows.length === 0 ? undefined : Object.freeze(rows.slice(1).map((r) => r.id));
}

export interface WorkDecisionTransaction {
  lockSessions(ids: readonly string[]): Promise<readonly WorkSessionRecord[]>;
  lockDay(day: { personId: string; storeId: string; workDate: IsoDate }): Promise<readonly WorkSessionRecord[]>;
  isReplaced(sessionId: string): Promise<boolean>;
  insertDecision(d: WorkDecisionRecord): Promise<void>;
  setStatus(sessionIds: readonly string[], status: "pending" | "approved" | "rejected", decisionId: string): Promise<void>;
  event(e: WorkEventRecord): Promise<void>;
  notify(n: WorkDecisionNotice): Promise<void>;
}

export type WorkDecisionNotice =
  | { readonly kind: "decided"; readonly personId: string; readonly sessionId: string; readonly decisionId: string; readonly outcome: "approved" | "rejected"; readonly workDate: IsoDate }
  | { readonly kind: "undone"; readonly personId: string; readonly sessionId: string; readonly withdrawnDecisionId: string };

/**
 * Notification producers, run on the decision's own client so the notice
 * commits or rolls back with it. Shapes match `@studenthub/db/comms`
 * recordWorkSessionDecision / retractWorkSessionDecision.
 */
export interface WorkDecisionHooks {
  onDecided?(client: PoolClient, input: { personPrincipalId: string; sessionId: string; decisionId: string; decision: "approved" | "rejected"; workDate: string }): Promise<unknown>;
  onUndone?(client: PoolClient, input: { personPrincipalId: string; decisionId: string }): Promise<unknown>;
}

export async function insertDecision(client: Queryable, d: WorkDecisionRecord): Promise<void> {
  await client.query(`INSERT INTO work_decisions(id, org_id, store_id, person_principal_id, work_date, scope, outcome, session_ids, reason, note, rating, note_public, batch_id, decided_by, decided_at)
    VALUES($1,$2,$3,$4,$5::date,$6,$7,$8::uuid[],$9,$10,$11,$12,$13,$14,$15)`,
  [d.id, d.orgId, d.storeId, d.personId, d.workDate, d.scope, d.outcome, [...d.sessionIds], d.reason, d.note, d.rating, d.notePublic, d.batchId, d.decidedBy, d.decidedAt]);
}
export async function setSessionStatus(client: Queryable, sessionIds: readonly string[], status: string, decisionId: string): Promise<void> {
  await client.query("UPDATE work_sessions SET status = $2, decision_id = $3 WHERE id = ANY($1::uuid[])", [[...sessionIds], status, decisionId]);
}
export async function notifyHooks(client: PoolClient, hooks: WorkDecisionHooks, n: WorkDecisionNotice): Promise<void> {
  if (n.kind === "decided") await hooks.onDecided?.(client, { personPrincipalId: n.personId, sessionId: n.sessionId, decisionId: n.decisionId, decision: n.outcome, workDate: n.workDate });
  else await hooks.onUndone?.(client, { personPrincipalId: n.personId, decisionId: n.withdrawnDecisionId });
}
export async function sessionInForce(client: Queryable, sessionId: string): Promise<boolean> {
  const { rows } = await client.query<{ forced: boolean }>("SELECT work_session_in_force($1::uuid) AS forced", [sessionId]);
  return rows[0]?.forced === true;
}

/** W-4 decisions. */
export class PostgresWorkDecisionStore {
  readonly #db: PoolOwner;
  readonly #hooks: WorkDecisionHooks;
  constructor(poolOrConfig: PgPool | PoolConfig, hooks: WorkDecisionHooks = {}) { this.#db = new PoolOwner(poolOrConfig); this.#hooks = hooks; }
  async close(): Promise<void> { await this.#db.close(); }
  organizationAncestors(orgId: string): Promise<readonly string[] | undefined> { return ancestorsOf(this.#db.pool, orgId); }
  async transaction<T>(work: (tx: WorkDecisionTransaction) => Promise<T>): Promise<T> {
    const hooks = this.#hooks;
    return this.#db.transaction((client) => work({
      async lockSessions(ids) {
        const { rows } = await client.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM work_sessions s WHERE s.id = ANY($1::uuid[]) ORDER BY s.id FOR UPDATE`, [[...ids]]);
        return rows.map(workSessionFromRow);
      },
      async lockDay(day) {
        const { rows } = await client.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM work_sessions s
          WHERE s.person_principal_id = $1 AND s.store_id = $2 AND s.work_date = $3::date AND s.ended_at IS NOT NULL AND s.deleted_at IS NULL
            AND work_session_in_force(s.id) ORDER BY s.id FOR UPDATE`, [day.personId, day.storeId, day.workDate]);
        return rows.map(workSessionFromRow);
      },
      async isReplaced(sessionId) {
        const { rows } = await client.query<{ forced: boolean }>("SELECT work_session_in_force($1::uuid) AS forced", [sessionId]);
        return rows[0]?.forced === false;
      },
      insertDecision: (d) => insertDecision(client, d),
      setStatus: (sessionIds, status, decisionId) => setSessionStatus(client, sessionIds, status, decisionId),
      event: (e) => insertEvent(client, e),
      notify: (n) => notifyHooks(client, hooks, n),
    }));
  }
}

export interface WorkSessionFilter {
  readonly personId?: string; readonly orgIds?: readonly string[]; readonly includeSubtree?: boolean; readonly storeIds?: readonly string[];
  readonly sessionIds?: readonly string[];
  readonly status?: "pending" | "approved" | "rejected"; readonly range: { readonly from: IsoDate; readonly to: IsoDate };
  readonly after?: { readonly workDate: IsoDate; readonly id: string }; readonly limit?: number;
}

/** Shared WHERE for W-5 lists and totals; every value is bound. */
function sessionWhere(f: WorkSessionFilter): { readonly sql: string; readonly values: unknown[] } {
  const values: unknown[] = [f.personId ?? null, f.orgIds ? [...f.orgIds] : null, f.storeIds ? [...f.storeIds] : null, f.status ?? null, f.range.from, f.range.to,
    f.includeSubtree === true, f.sessionIds ? [...f.sessionIds] : null];
  const sql = `WITH RECURSIVE tree(id) AS (
     SELECT id FROM organizations WHERE $2::text[] IS NOT NULL AND id = ANY($2::text[])
     UNION SELECT o.id FROM organizations o JOIN tree t ON o.parent_org_id = t.id WHERE $7::boolean)
   SELECT %COLUMNS% FROM work_sessions s
   WHERE s.deleted_at IS NULL AND work_session_in_force(s.id)
     AND ($1::text IS NULL OR s.person_principal_id = $1) AND ($2::text[] IS NULL OR s.org_id IN (SELECT id FROM tree))
     AND ($3::uuid[] IS NULL OR s.store_id = ANY($3::uuid[]))
     AND ($4::text IS NULL OR (s.status = $4 AND s.ended_at IS NOT NULL))
     AND s.work_date BETWEEN $5::date AND $6::date AND ($8::uuid[] IS NULL OR s.id = ANY($8::uuid[]))`;
  return { sql, values };
}

/** W-5 reads. */
export class PostgresWorkHoursViewStore {
  readonly #db: PoolOwner;
  constructor(poolOrConfig: PgPool | PoolConfig) { this.#db = new PoolOwner(poolOrConfig); }
  async close(): Promise<void> { await this.#db.close(); }
  organizationAncestors(orgId: string): Promise<readonly string[] | undefined> { return ancestorsOf(this.#db.pool, orgId); }

  /** Display names of stores, for the work screens (a removed store keeps its name). */
  async storeNames(storeIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (storeIds.length === 0) return new Map();
    const { rows } = await this.#db.pool.query<{ id: string; name: string }>("SELECT id::text AS id, name FROM organization_stores WHERE id = ANY($1::uuid[])", [[...storeIds]]);
    return new Map(rows.map((r) => [r.id, r.name]));
  }

  /** A store's company and name, for screens addressed by store; undefined when it doesn't exist. */
  async storeInfo(storeId: string): Promise<{ readonly orgId: string; readonly name: string; readonly active: boolean } | undefined> {
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(storeId)) return undefined;
    const { rows } = await this.#db.pool.query<{ org_id: string; name: string; status: string }>("SELECT org_id, name, status FROM organization_stores WHERE id = $1::uuid", [storeId]);
    const row = rows[0];
    return row ? Object.freeze({ orgId: row.org_id, name: row.name, active: row.status === "active" }) : undefined;
  }

  /** A company's active stores, by name, for staff placement forms. */
  async storesOf(orgId: string): Promise<readonly { readonly id: string; readonly name: string }[]> {
    const { rows } = await this.#db.pool.query<{ id: string; name: string }>("SELECT id::text AS id, name FROM organization_stores WHERE org_id = $1 AND status = 'active' ORDER BY name, id", [orgId]);
    return Object.freeze(rows.map((r) => Object.freeze({ id: r.id, name: r.name })));
  }

  /** Display names for people in a list the caller may already read; the profile name wins over the account name. */
  async personNames(personIds: readonly string[]): Promise<ReadonlyMap<string, string>> {
    if (personIds.length === 0) return new Map();
    const { rows } = await this.#db.pool.query<{ id: string; name: string | null }>(
      "SELECT p.id, COALESCE(pp.display_name, p.display_name) AS name FROM principals p LEFT JOIN person_profiles pp ON pp.principal_id = p.id WHERE p.id = ANY($1::text[])", [[...personIds]]);
    return new Map(rows.filter((r) => r.name).map((r) => [r.id, r.name!]));
  }

  async listSessions(f: WorkSessionFilter): Promise<readonly WorkSessionRecord[]> {
    const { sql, values } = sessionWhere(f);
    values.push(f.after?.workDate ?? null, f.after?.id ?? null, Math.min(Math.max(f.limit ?? 100, 1), 501));
    const { rows } = await this.#db.pool.query<SessionRow>(`${sql.replace("%COLUMNS%", SESSION_COLUMNS)}
      AND ($9::date IS NULL OR (s.work_date, s.id) > ($9::date, $10::uuid))
      ORDER BY s.work_date, s.id LIMIT $11`, values);
    return Object.freeze(rows.map(workSessionFromRow));
  }

  async totals(f: WorkSessionFilter): Promise<{ approvedSeconds: number; pendingSeconds: number; rejectedSeconds: number; open: number }> {
    const { sql, values } = sessionWhere(f);
    const { rows } = await this.#db.pool.query<{ approved: string; pending: string; rejected: string; open: number }>(sql.replace("%COLUMNS%",
      `coalesce(sum(s.duration_seconds) FILTER (WHERE s.status = 'approved'), 0)::text AS approved,
       coalesce(sum(s.duration_seconds) FILTER (WHERE s.status = 'pending' AND s.ended_at IS NOT NULL), 0)::text AS pending,
       coalesce(sum(s.duration_seconds) FILTER (WHERE s.status = 'rejected'), 0)::text AS rejected,
       count(*) FILTER (WHERE s.ended_at IS NULL)::int AS open`), values);
    const r = rows[0];
    return { approvedSeconds: Number(r?.approved ?? 0), pendingSeconds: Number(r?.pending ?? 0), rejectedSeconds: Number(r?.rejected ?? 0), open: r?.open ?? 0 };
  }

  async decisions(ids: readonly string[]): Promise<readonly WorkDecisionRecord[]> {
    const { rows } = await this.#db.pool.query<DecisionRow>(`SELECT ${DECISION_COLUMNS} FROM work_decisions WHERE id = ANY($1::uuid[])`, [[...ids]]);
    return Object.freeze(rows.map(decisionFromRow));
  }
}
