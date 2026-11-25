import pg from "pg";
import { databaseUrl } from "../connection.js";
import { PostgresMorningSummaryStore } from "./postgres-morning-summary-store.js";

/**
 * Staff statistics, Postgres side (contract P-3, slice 1). Read-only: every number is counted
 * from the source rows when the page is asked for, so it always reconciles with them. Counter
 * keys, labels and the "not available" rule live in `packages/reports`; this store answers the
 * counters it has a query for. The counters the morning summary also has come from its store,
 * read in the same snapshot, so both pages show the same number.
 */
export interface StatisticsHiringCounts { readonly hired: number; readonly retained: number; readonly invitations: number }

const DAY = /^\d{4}-\d{2}-\d{2}$/;

// Transfers keep legacy's KWD filter; a deleted transfer is never counted, and a cancelled one is never paid, so it is not "in progress".
const LIVE_KWD_TRANSFER = "NOT t.deleted AND t.status <> 'cancelled' AND t.currency_code = 'KWD'";

// $1 is the Asia/Kuwait day, $2 the current instant. Minors are candidates only: a profile with a candidate grant.
const COUNTS = `SELECT
  (SELECT count(*)::int FROM work_appeals WHERE status = 'submitted') AS "workLogAppeals",
  (SELECT count(*)::int FROM person_profiles p WHERE p.birth_date > ($1::date - interval '16 years')::date
     AND EXISTS (SELECT 1 FROM grants g WHERE g.principal_id = p.principal_id AND g.role = 'candidate')) AS "totalMinor",
  (SELECT count(*)::int FROM company_registrations WHERE status = 'pending') AS "companyUnderReview",
  (SELECT count(*)::int FROM work_assignment_requests q LEFT JOIN organization_commercial_terms t ON t.org_id = q.org_id AND t.field = 'currency_code'
     WHERE q.status = 'pending' AND COALESCE(t.value, 'KWD') = 'KWD') AS "totalStoreAssignmentRequests",
  (SELECT count(*)::int FROM recruit_pipeline_cards c JOIN recruit_requests r ON r.id = c.request_id
     WHERE c.stage = 'interviewing' AND r.status NOT IN ('filled','closed')
       AND NOT EXISTS (SELECT 1 FROM recruit_interviews i WHERE i.card_id = c.id AND i.status IN ('scheduled','completed'))) AS "totalInterviewRequests",
  (SELECT count(*)::int FROM recruit_interviews i JOIN recruit_pipeline_cards c ON c.id = i.card_id JOIN recruit_requests r ON r.id = c.request_id
     WHERE i.status = 'scheduled' AND i.scheduled_at > $2::timestamptz AND r.status NOT IN ('filled','closed')) AS "totalInterviewScheduled",
  (SELECT count(DISTINCT l.transfer_id)::int FROM pay_transfer_lines l JOIN pay_transfers t ON t.id = l.transfer_id
     WHERE NOT l.paid AND l.candidate_total = l.company_total AND ${LIVE_KWD_TRANSFER}) AS "transfersWithNoProfitInProgress"`;

// Retained: the assignment has lasted more than 365 days, counting up to its end date or, while it runs, up to today.
const HIRING = `SELECT
  (SELECT count(*)::int FROM work_assignments) AS hired,
  (SELECT count(*)::int FROM work_assignments WHERE LEAST(COALESCE(end_date, $1::date), $1::date) - start_date > 365) AS retained,
  (SELECT count(*)::int FROM recruit_invitations) AS invitations`;

// $1 the months asked for (YYYY-MM), $2 the first day of the oldest, $3 the first day after the newest, all in Kuwait time.
const INVITATIONS = `SELECT to_char(k.at, 'YYYY-MM') AS month,
    count(*) FILTER (WHERE i.status IN ('sent','seen'))::int AS "noAnswer",
    count(*) FILTER (WHERE i.status = 'accepted')::int AS accepted,
    count(*) FILTER (WHERE i.status = 'declined')::int AS declined,
    count(*) FILTER (WHERE i.status = 'withdrawn')::int AS withdrawn
  FROM recruit_invitations i CROSS JOIN LATERAL (SELECT i.created_at AT TIME ZONE 'Asia/Kuwait' AS at) k
  WHERE i.created_at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kuwait') AND i.created_at < ($3::date::timestamp AT TIME ZONE 'Asia/Kuwait')
    AND to_char(k.at, 'YYYY-MM') = ANY($1::text[])
  GROUP BY 1 ORDER BY 1`;
// $1 the Kuwait days asked for, $2 the first, $3 the last. Sent: the provider accepted it; failed: an attempt that failed.
const EMAILS = `SELECT to_char(a.at AT TIME ZONE 'Asia/Kuwait', 'YYYY-MM-DD') AS day,
    count(*) FILTER (WHERE a.outcome = 'sent')::int AS sent, count(*) FILTER (WHERE a.outcome = 'failed')::int AS failed
  FROM email_attempts a
  WHERE a.at >= ($2::date::timestamp AT TIME ZONE 'Asia/Kuwait') AND a.at < (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kuwait')
    AND to_char(a.at AT TIME ZONE 'Asia/Kuwait', 'YYYY-MM-DD') = ANY($1::text[])
  GROUP BY 1 ORDER BY 1`;

// $1 staff principal ids, $2 the first Kuwait day, $3 the last (inclusive). Each count is by the staff member who did it, when it was recorded.
const RECRUITER_ACTIVITY = `WITH r AS (SELECT ($2::date::timestamp AT TIME ZONE 'Asia/Kuwait') AS lo, (($3::date + 1)::timestamp AT TIME ZONE 'Asia/Kuwait') AS hi),
  s AS (SELECT unnest($1::text[]) AS id),
  placements AS (SELECT a.created_by AS id, count(*)::int AS n FROM work_assignments a, r WHERE a.created_by = ANY($1::text[]) AND a.created_at >= r.lo AND a.created_at < r.hi GROUP BY 1),
  requests AS (SELECT q.created_by_principal_id AS id, count(*)::int AS n FROM recruit_requests q, r WHERE q.created_by_principal_id = ANY($1::text[]) AND q.created_at >= r.lo AND q.created_at < r.hi GROUP BY 1),
  suggestions AS (SELECT e.actor_principal_id AS id, count(*)::int AS n FROM recruit_pipeline_events e, r WHERE e.from_stage IS NULL AND e.actor_principal_id = ANY($1::text[]) AND e.at >= r.lo AND e.at < r.hi GROUP BY 1),
  notes AS (SELECT n.author_principal_id AS id, count(*)::int AS n FROM recruit_request_notes n, r WHERE n.removed_at IS NULL AND n.author_principal_id = ANY($1::text[]) AND n.created_at >= r.lo AND n.created_at < r.hi GROUP BY 1),
  invitations AS (SELECT i.invited_by_principal_id AS id, count(*)::int AS n, count(*) FILTER (WHERE i.status = 'accepted')::int AS accepted, count(*) FILTER (WHERE i.status = 'declined')::int AS declined
    FROM recruit_invitations i, r WHERE i.invited_by_principal_id = ANY($1::text[]) AND i.created_at >= r.lo AND i.created_at < r.hi GROUP BY 1)
  SELECT s.id, COALESCE(pp.display_name, p.display_name) AS name,
    COALESCE(placements.n, 0) AS placements, COALESCE(requests.n, 0) AS requests, COALESCE(suggestions.n, 0) AS suggestions, COALESCE(notes.n, 0) AS notes,
    COALESCE(invitations.n, 0) AS invitations, COALESCE(invitations.accepted, 0) AS "invitationsAccepted", COALESCE(invitations.declined, 0) AS "invitationsDeclined"
  FROM s LEFT JOIN principals p ON p.id = s.id LEFT JOIN person_profiles pp ON pp.principal_id = s.id
    LEFT JOIN placements ON placements.id = s.id LEFT JOIN requests ON requests.id = s.id LEFT JOIN suggestions ON suggestions.id = s.id
    LEFT JOIN notes ON notes.id = s.id LEFT JOIN invitations ON invitations.id = s.id`;

// $1 is the Asia/Kuwait day. Requests keep legacy's KWD filter (no currency on file means KWD), and so do transfers.
const KWD_REQUESTS = "recruit_requests r LEFT JOIN organization_commercial_terms t ON t.org_id = r.org_id AND t.field = 'currency_code'";
const OVERVIEW = `SELECT
  (SELECT count(*)::int FROM person_profiles) AS candidates,
  (SELECT count(DISTINCT person_principal_id)::int FROM work_assignments WHERE start_date <= $1::date AND (end_date IS NULL OR end_date >= $1::date)) AS assigned,
  (SELECT count(*)::int FROM recruit_pipeline_cards) AS suggested,
  (SELECT count(*)::int FROM ${KWD_REQUESTS} WHERE r.status <> 'draft' AND COALESCE(t.value, 'KWD') = 'KWD') AS requests,
  (SELECT count(*)::int FROM ${KWD_REQUESTS} WHERE (r.status = 'filled' OR (r.status = 'closed' AND r.close_reason = 'fulfilled')) AND COALESCE(t.value, 'KWD') = 'KWD') AS "requestsDelivered",
  (SELECT count(*)::int FROM pay_transfer_lines l JOIN pay_transfers t ON t.id = l.transfer_id WHERE NOT l.paid AND t.status = 'distributing' AND ${LIVE_KWD_TRANSFER}) AS "payableCandidates",
  (SELECT count(*)::int FROM pay_transfers t WHERE t.status = 'locked' AND ${LIVE_KWD_TRANSFER}) AS "transfersLocked",
  (SELECT count(*)::int FROM pay_transfers t WHERE t.status = 'payment_sent' AND ${LIVE_KWD_TRANSFER}) AS "transfersPaymentSent"`;

// $1 operator org ids, $2 first day of the oldest month, $3 the Asia/Kuwait day, $4 the months asked for (only those are counted). Each organization rolls up to its
// top-level company: the ancestor whose parent is an operator organization (or none). Deleted top-level companies are
// left out; a deleted sub-company's placements stay in its live parent's history, as legacy counts them by parent_company_id.
const TOP = `WITH RECURSIVE up(org_id, at, parent, depth) AS (
    SELECT id, id, parent_org_id, 0 FROM organizations WHERE NOT (id = ANY($1::text[]))
    UNION ALL SELECT up.org_id, o.id, o.parent_org_id, up.depth + 1 FROM up JOIN organizations o ON o.id = up.parent
      WHERE NOT (o.id = ANY($1::text[])) AND up.depth < 32),
  top AS (SELECT org_id, at AS company_id FROM up WHERE parent IS NULL OR parent = ANY($1::text[])),
  companies AS (SELECT o.id, o.name FROM organizations o JOIN top t ON t.org_id = o.id AND t.company_id = o.id
    WHERE NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = o.id))`;
const FIRING_COMPANIES = `${TOP} SELECT id AS "orgId", name FROM companies`;
const FIRINGS = `${TOP} SELECT t.company_id AS "orgId", to_char(a.end_date, 'YYYY-MM') AS month, count(*)::int AS total
  FROM work_assignments a JOIN top t ON t.org_id = a.org_id JOIN companies c ON c.id = t.company_id
  WHERE a.end_date >= $2::date AND a.end_date <= $3::date AND to_char(a.end_date, 'YYYY-MM') = ANY($4::text[]) GROUP BY 1, 2`;

export class PostgresStatisticsStore {
  readonly #pool: pg.Pool; readonly #owns: boolean; readonly #summary: PostgresMorningSummaryStore;
  readonly #operators: readonly string[];
  /** `operatorOrgIds` are StudentHub's own organizations: they are not companies, and companies sit under them. */
  constructor(options: { connectionString?: string; pool?: pg.Pool; operatorOrgIds?: readonly string[] } = {}) {
    this.#owns = !options.pool; this.#operators = options.operatorOrgIds ?? ["root"];
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
    this.#summary = new PostgresMorningSummaryStore({ pool: this.#pool, operatorOrgIds: this.#operators });
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /** The staff dashboard counters this store can read, for one Asia/Kuwait day, all from one snapshot. */
  async staffCounts(day: string, now: Date): Promise<Readonly<Record<string, number>>> {
    if (!DAY.test(day)) throw new RangeError("invalid day");
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const shared = await this.#summary.counts(day, c);
      const own = (await c.query<Record<string, number>>(COUNTS, [day, now])).rows[0]!;
      await c.query("COMMIT");
      return { activeRequests: shared.activeRequests!, assignedExpiredCivilID: shared.assignedExpiredCivilID!, totalExpiredCards: shared.totalExpiredCards!, id_need_generated: shared.id_need_generated!,
        assignedIdleCandidates: shared.assignedIdleCandidates!, companyMoreThen40DaysWithoutPayment: shared.companyMoreThen40DaysWithoutPayment!, ...own };
    } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { c.release(); }
  }

  /** The overview figures this store reads, as of one Asia/Kuwait day. */
  async overviewCounts(day: string): Promise<Readonly<Record<string, number>>> {
    if (!DAY.test(day)) throw new RangeError("invalid day");
    return (await this.#pool.query<Record<string, number>>(OVERVIEW, [day])).rows[0]!;
  }

  /** Hired, retained after a year, and invitations sent, as of one Asia/Kuwait day. */
  async hiring(day: string): Promise<StatisticsHiringCounts> {
    if (!DAY.test(day)) throw new RangeError("invalid day");
    return (await this.#pool.query<StatisticsHiringCounts>(HIRING, [day])).rows[0]!;
  }

  /** Invitations sent in each of `months` (`YYYY-MM`, Kuwait time), by how they stand now; months with none are left out. */
  async invitationsByMonth(months: readonly string[]): Promise<{ month: string; noAnswer: number; accepted: number; declined: number; withdrawn: number }[]> {
    if (months.length === 0 || !months.every(m => /^\d{4}-(0[1-9]|1[0-2])$/.test(m))) throw new RangeError("invalid months");
    const sorted = [...months].sort(), last = sorted[sorted.length - 1]!.split("-").map(Number) as [number, number];
    const after = last[1] === 12 ? `${last[0] + 1}-01-01` : `${last[0]}-${String(last[1] + 1).padStart(2, "0")}-01`;
    return (await this.#pool.query(INVITATIONS, [months, `${sorted[0]}-01`, after])).rows;
  }

  /** Emails sent, and attempts that failed, on each of `days` (Kuwait dates); days with none are left out. */
  async emailsByDay(days: readonly string[]): Promise<{ day: string; sent: number; failed: number }[]> {
    if (days.length === 0 || !days.every(d => DAY.test(d))) throw new RangeError("invalid days");
    const sorted = [...days].sort();
    return (await this.#pool.query(EMAILS, [days, sorted[0], sorted[sorted.length - 1]])).rows;
  }

  /** What each of `staff` recorded over the Kuwait days `from` to `to` (inclusive), and their names. */
  async recruiterActivity(staff: readonly string[], from: string, to: string): Promise<{ names: Map<string, string>; counts: Map<string, RecruiterActivityRow> }> {
    if (!DAY.test(from) || !DAY.test(to) || from > to) throw new RangeError("invalid range");
    const { rows } = await this.#pool.query<RecruiterActivityRow & { id: string; name: string | null }>(RECRUITER_ACTIVITY, [staff, from, to]);
    const names = new Map<string, string>(), counts = new Map<string, RecruiterActivityRow>();
    for (const { id, name, ...c } of rows) { if (name) names.set(id, name); counts.set(id, c); }
    return { names, counts };
  }

  /** Top-level companies, and placements ended in `months` (`YYYY-MM`) up to one Asia/Kuwait day, both from one snapshot. */
  async firings(day: string, months: readonly string[]): Promise<FiringRows> {
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const rows = await readFirings(c, this.#operators, day, months);
      await c.query("COMMIT");
      return rows;
    } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { c.release(); }
  }
}

export interface RecruiterActivityRow { placements: number; requests: number; suggestions: number; notes: number; invitations: number; invitationsAccepted: number; invitationsDeclined: number }
export interface FiringRows { companies: { orgId: string; name: string }[]; counts: { orgId: string; month: string; total: number }[] }
/** The hit map's companies and counts, read on `client` (inside the caller's transaction). */
export async function readFirings(client: pg.PoolClient, operators: readonly string[], day: string, months: readonly string[]): Promise<FiringRows> {
  if (!DAY.test(day) || months.length === 0 || !months.every(m => /^\d{4}-\d{2}$/.test(m))) throw new RangeError("invalid months");
  const from = `${[...months].sort()[0]}-01`;
  const companies = (await client.query<{ orgId: string; name: string }>(FIRING_COMPANIES, [operators])).rows;
  const counts = (await client.query<{ orgId: string; month: string; total: number }>(FIRINGS, [operators, from, day, months])).rows;
  return { companies, counts };
}
