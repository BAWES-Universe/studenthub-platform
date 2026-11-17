// Work lane W-6 (appeals and staff corrections) and W-2 (the payable read for
// the pay lane). Ports live in packages/work (appeals.ts, payable.ts); the
// shapes here mirror them structurally because the db package can't import it.

import type { Pool as PgPool, PoolClient, PoolConfig } from "pg";
import {
  ASSIGNMENT_COLUMNS, SESSION_COLUMNS, PoolOwner, ancestorsOf, assignmentFromRow, insertDecision, insertEvent, insertSession, notifyHooks,
  sessionInForce, setSessionStatus, workSessionFromRow,
  type AssignmentRow, type NewWorkSessionRecord, type SessionRow, type WorkAssignmentRecord, type WorkDecisionHooks, type WorkDecisionNotice,
  type WorkDecisionRecord, type WorkEventRecord, type WorkSessionRecord,
} from "./postgres-work-store.js";

type IsoDate = string;
export type WorkAppealStatus = "submitted" | "awaiting_review" | "in_progress" | "resolved";
export interface WorkAppealRecord {
  readonly id: string; readonly sessionId: string; readonly personId: string; readonly orgId: string; readonly storeId: string;
  readonly reason: string; readonly status: WorkAppealStatus; readonly createdAt: string; readonly updatedAt: string;
}
export interface WorkAppealUpdateRecord {
  readonly id: string; readonly appealId: string; readonly title: string | null; readonly detail: string;
  readonly authorId: string | null; readonly createdAt: string; readonly readAt: string | null;
}
export interface WorkAppealTransaction {
  lockSession(id: string): Promise<WorkSessionRecord | undefined>;
  isReplaced(sessionId: string): Promise<boolean>;
  assignment(id: string): Promise<WorkAssignmentRecord | undefined>;
  insertSession(s: NewWorkSessionRecord): Promise<WorkSessionRecord>;
  insertDecision(d: WorkDecisionRecord): Promise<void>;
  setStatus(sessionIds: readonly string[], status: "approved", decisionId: string): Promise<void>;
  insertAppeal(a: Omit<WorkAppealRecord, "createdAt" | "updatedAt">): Promise<WorkAppealRecord>;
  lockAppeal(id: string): Promise<WorkAppealRecord | undefined>;
  setAppealStatus(id: string, status: WorkAppealStatus): Promise<WorkAppealRecord>;
  insertUpdate(u: Omit<WorkAppealUpdateRecord, "createdAt" | "readAt">): Promise<WorkAppealUpdateRecord>;
  markRead(updateId: string, personId: string): Promise<boolean>;
  event(e: WorkEventRecord): Promise<void>;
  notify(n: WorkDecisionNotice): Promise<void>;
}

const APPEAL_COLUMNS = "a.id, a.session_id, a.person_principal_id, a.org_id, a.store_id, a.reason, a.status, a.created_at, a.updated_at";
interface AppealRow { id: string; session_id: string; person_principal_id: string; org_id: string; store_id: string; reason: string; status: WorkAppealStatus; created_at: Date; updated_at: Date }
function appealFromRow(r: AppealRow): WorkAppealRecord {
  return Object.freeze({ id: r.id, sessionId: r.session_id, personId: r.person_principal_id, orgId: r.org_id, storeId: r.store_id, reason: r.reason,
    status: r.status, createdAt: r.created_at.toISOString(), updatedAt: r.updated_at.toISOString() });
}
const UPDATE_COLUMNS = "u.id, u.appeal_id, u.title, u.detail, u.author_principal_id, u.created_at, u.read_at";
interface UpdateRow { id: string; appeal_id: string; title: string | null; detail: string; author_principal_id: string | null; created_at: Date; read_at: Date | null }
function updateFromRow(r: UpdateRow): WorkAppealUpdateRecord {
  return Object.freeze({ id: r.id, appealId: r.appeal_id, title: r.title, detail: r.detail, authorId: r.author_principal_id,
    createdAt: r.created_at.toISOString(), readAt: r.read_at ? r.read_at.toISOString() : null });
}

function appealTransaction(client: PoolClient, hooks: WorkDecisionHooks): WorkAppealTransaction {
  const appealRow = async (sql: string, values: unknown[]) => {
    const { rows } = await client.query<AppealRow>(sql, values);
    return rows[0] ? appealFromRow(rows[0]) : undefined;
  };
  return {
    async lockSession(id) {
      const { rows } = await client.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM work_sessions s WHERE s.id = $1 FOR UPDATE`, [id]);
      return rows[0] ? workSessionFromRow(rows[0]) : undefined;
    },
    isReplaced: async (id) => !(await sessionInForce(client, id)),
    async assignment(id) {
      const { rows } = await client.query<AssignmentRow>(`SELECT ${ASSIGNMENT_COLUMNS} FROM work_assignments a WHERE a.id = $1`, [id]);
      return rows[0] ? assignmentFromRow(rows[0]) : undefined;
    },
    insertSession: (s) => insertSession(client, s),
    insertDecision: (d) => insertDecision(client, d),
    setStatus: (ids, status, decisionId) => setSessionStatus(client, ids, status, decisionId),
    async insertAppeal(a) {
      const row = await appealRow(`WITH a AS (INSERT INTO work_appeals(id, session_id, person_principal_id, org_id, store_id, reason, status)
        VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *) SELECT ${APPEAL_COLUMNS} FROM a`, [a.id, a.sessionId, a.personId, a.orgId, a.storeId, a.reason, a.status]);
      if (!row) throw new Error("work appeal insert returned no row");
      return row;
    },
    lockAppeal: (id) => appealRow(`SELECT ${APPEAL_COLUMNS} FROM work_appeals a WHERE a.id = $1 FOR UPDATE`, [id]),
    async setAppealStatus(id, status) {
      const row = await appealRow(`WITH a AS (UPDATE work_appeals SET status = $2 WHERE id = $1 RETURNING *) SELECT ${APPEAL_COLUMNS} FROM a`, [id, status]);
      if (!row) throw new Error("work appeal not found");
      return row;
    },
    async insertUpdate(u) {
      const { rows } = await client.query<UpdateRow>(`WITH u AS (INSERT INTO work_appeal_updates(id, appeal_id, title, detail, author_principal_id)
        VALUES($1,$2,$3,$4,$5) RETURNING *) SELECT ${UPDATE_COLUMNS} FROM u`, [u.id, u.appealId, u.title, u.detail, u.authorId]);
      if (!rows[0]) throw new Error("work appeal update insert returned no row");
      return updateFromRow(rows[0]);
    },
    async markRead(updateId, personId) {
      const { rowCount } = await client.query(`UPDATE work_appeal_updates u SET read_at = coalesce(u.read_at, clock_timestamp())
        FROM work_appeals a WHERE u.id = $1 AND a.id = u.appeal_id AND a.person_principal_id = $2`, [updateId, personId]);
      return rowCount === 1;
    },
    event: (e) => insertEvent(client, e),
    notify: (n) => notifyHooks(client, hooks, n),
  };
}

/** W-6 appeals and staff corrections. Hooks are the same comms producers as decisions. */
export class PostgresWorkAppealStore {
  readonly #db: PoolOwner;
  readonly #hooks: WorkDecisionHooks;
  constructor(poolOrConfig: PgPool | PoolConfig, hooks: WorkDecisionHooks = {}) { this.#db = new PoolOwner(poolOrConfig); this.#hooks = hooks; }
  async close(): Promise<void> { await this.#db.close(); }
  organizationAncestors(orgId: string): Promise<readonly string[] | undefined> { return ancestorsOf(this.#db.pool, orgId); }
  transaction<T>(work: (tx: WorkAppealTransaction) => Promise<T>): Promise<T> {
    const hooks = this.#hooks;
    return this.#db.transaction((client) => work(appealTransaction(client, hooks)));
  }

  async appeal(id: string): Promise<{ appeal: WorkAppealRecord; session: WorkSessionRecord; updates: readonly WorkAppealUpdateRecord[]; entries: readonly WorkSessionRecord[] } | undefined> {
    const q = this.#db.pool;
    const { rows } = await q.query<AppealRow>(`SELECT ${APPEAL_COLUMNS} FROM work_appeals a WHERE a.id = $1`, [id]);
    if (!rows[0]) return undefined;
    const appeal = appealFromRow(rows[0]);
    const [session, updates, entries] = await Promise.all([
      q.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM work_sessions s WHERE s.id = $1`, [appeal.sessionId]),
      q.query<UpdateRow>(`SELECT ${UPDATE_COLUMNS} FROM work_appeal_updates u WHERE u.appeal_id = $1 ORDER BY u.created_at DESC, u.id DESC`, [id]),
      q.query<SessionRow>(`SELECT ${SESSION_COLUMNS} FROM work_sessions s WHERE s.appeal_id = $1 ORDER BY s.created_at, s.id`, [id]),
    ]);
    if (!session.rows[0]) return undefined;
    return Object.freeze({ appeal, session: workSessionFromRow(session.rows[0]), updates: Object.freeze(updates.rows.map(updateFromRow)),
      entries: Object.freeze(entries.rows.map(workSessionFromRow)) });
  }

  async listAppeals(f: { readonly personId?: string; readonly orgIds?: readonly string[]; readonly status?: WorkAppealStatus;
    readonly range?: { readonly from: IsoDate; readonly to: IsoDate }; readonly after?: { readonly createdAt: string; readonly id: string }; readonly limit: number }):
    Promise<readonly WorkAppealRecord[]> {
    const { rows } = await this.#db.pool.query<AppealRow>(`WITH RECURSIVE tree(id) AS (
       SELECT id FROM organizations WHERE $2::text[] IS NOT NULL AND id = ANY($2::text[])
       UNION SELECT o.id FROM organizations o JOIN tree t ON o.parent_org_id = t.id)
     SELECT ${APPEAL_COLUMNS} FROM work_appeals a
     WHERE ($1::text IS NULL OR a.person_principal_id = $1) AND ($2::text[] IS NULL OR a.org_id IN (SELECT id FROM tree))
       AND ($3::text IS NULL OR a.status = $3)
       AND ($4::date IS NULL OR (a.created_at AT TIME ZONE 'Asia/Kuwait')::date BETWEEN $4::date AND $5::date)
       AND ($6::timestamptz IS NULL OR (a.created_at, a.id) < ($6::timestamptz, $7::uuid))
     ORDER BY a.created_at DESC, a.id DESC LIMIT $8`,
    [f.personId ?? null, f.orgIds ? [...f.orgIds] : null, f.status ?? null, f.range?.from ?? null, f.range?.to ?? null,
      f.after?.createdAt ?? null, f.after?.id ?? null, Math.min(Math.max(f.limit, 1), 200)]);
    return Object.freeze(rows.map(appealFromRow));
  }
}

export interface WorkPayableSessionRecord {
  readonly sessionId: string; readonly workDate: IsoDate; readonly durationSeconds: number; readonly source: "timer" | "manual" | "correction" | "import";
  readonly correctsSessionId: string | null; readonly decisionId: string | null; readonly changedAt: string;
}
export interface WorkPayableInputRecord {
  readonly version: "studenthub.work.payable-input.v1";
  readonly assignmentId: string; readonly personId: string; readonly orgId: string; readonly storeId: string; readonly payContractId: string | null;
  readonly period: { readonly start: IsoDate; readonly end: IsoDate };
  readonly approvedSeconds: number; readonly pendingSeconds: number; readonly rejectedSeconds: number; readonly openSessions: number;
  readonly sessions: readonly WorkPayableSessionRecord[];
}

/**
 * W-2: the Postgres `PayableWorkSource`. Per assignment with any session in
 * force in the period, approved seconds of closed sessions in force, with the
 * session list; pending and rejected time for audit; open sessions as a count.
 * Never computes money.
 */
export class PostgresWorkPayableSource {
  readonly #db: PoolOwner;
  constructor(poolOrConfig: PgPool | PoolConfig) { this.#db = new PoolOwner(poolOrConfig); }
  async close(): Promise<void> { await this.#db.close(); }

  async payableInputs(query: { readonly period: { readonly start: IsoDate; readonly end: IsoDate }; readonly orgId?: string; readonly includeSubtree?: boolean;
    readonly personId?: string; readonly payContractId?: string }): Promise<readonly WorkPayableInputRecord[]> {
    const { start, end } = query.period;
    if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end) || end < start) throw new RangeError("payable period must be two ISO dates, start first");
    const { rows } = await this.#db.pool.query<{
      assignment_id: string; person_principal_id: string; org_id: string; store_id: string; pay_contract_id: string | null;
      approved: string; pending: string; rejected: string; open: number;
      sessions: { id: string; work_date: string; duration_seconds: number; source: WorkPayableSessionRecord["source"]; corrects_session_id: string | null; decision_id: string | null; changed_at: string }[] | null;
    }>(`WITH RECURSIVE tree(id) AS (
       SELECT id FROM organizations WHERE $3::text IS NOT NULL AND id = $3
       UNION SELECT o.id FROM organizations o JOIN tree t ON o.parent_org_id = t.id WHERE $4::boolean)
     , live AS (
       SELECT s.* FROM work_sessions s
       WHERE s.deleted_at IS NULL AND work_session_in_force(s.id) AND s.work_date BETWEEN $1::date AND $2::date
         AND ($3::text IS NULL OR s.org_id IN (SELECT id FROM tree)) AND ($5::text IS NULL OR s.person_principal_id = $5))
     SELECT a.id AS assignment_id, a.person_principal_id, a.org_id, a.store_id, a.pay_contract_id,
       coalesce(sum(l.duration_seconds) FILTER (WHERE l.status = 'approved' AND l.ended_at IS NOT NULL), 0)::text AS approved,
       coalesce(sum(l.duration_seconds) FILTER (WHERE l.status = 'pending' AND l.ended_at IS NOT NULL), 0)::text AS pending,
       coalesce(sum(l.duration_seconds) FILTER (WHERE l.status = 'rejected'), 0)::text AS rejected,
       count(*) FILTER (WHERE l.ended_at IS NULL)::int AS open,
       jsonb_agg(jsonb_build_object('id', l.id, 'work_date', to_char(l.work_date, 'YYYY-MM-DD'), 'duration_seconds', l.duration_seconds,
         'source', l.source, 'corrects_session_id', l.corrects_session_id, 'decision_id', l.decision_id,
         'changed_at', to_char(l.status_changed_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'))
         ORDER BY l.work_date, l.started_at, l.id) FILTER (WHERE l.status = 'approved' AND l.ended_at IS NOT NULL) AS sessions
     FROM live l JOIN work_assignments a ON a.id = l.assignment_id
     WHERE ($6::uuid IS NULL OR a.pay_contract_id = $6::uuid)
     GROUP BY a.id ORDER BY a.org_id, a.person_principal_id, a.id`,
    [start, end, query.orgId ?? null, query.includeSubtree === true, query.personId ?? null, query.payContractId ?? null]);
    return Object.freeze(rows.map((r) => Object.freeze({
      version: "studenthub.work.payable-input.v1" as const, assignmentId: r.assignment_id, personId: r.person_principal_id, orgId: r.org_id, storeId: r.store_id,
      payContractId: r.pay_contract_id, period: Object.freeze({ start, end }),
      approvedSeconds: Number(r.approved), pendingSeconds: Number(r.pending), rejectedSeconds: Number(r.rejected), openSessions: r.open,
      sessions: Object.freeze((r.sessions ?? []).map((s) => Object.freeze({ sessionId: s.id, workDate: s.work_date, durationSeconds: s.duration_seconds, source: s.source,
        correctsSessionId: s.corrects_session_id, decisionId: s.decision_id, changedAt: s.changed_at }))),
    })));
  }
}
