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
     WHERE i.status = 'scheduled' AND i.scheduled_at > $2::timestamptz AND r.status NOT IN ('filled','closed')) AS "totalInterviewScheduled"`;

// Retained: the assignment has lasted more than 365 days, counting up to its end date or, while it runs, up to today.
const HIRING = `SELECT
  (SELECT count(*)::int FROM work_assignments) AS hired,
  (SELECT count(*)::int FROM work_assignments WHERE LEAST(COALESCE(end_date, $1::date), $1::date) - start_date > 365) AS retained,
  (SELECT count(*)::int FROM recruit_invitations) AS invitations`;

// $1 is the Asia/Kuwait day. Requests keep legacy's KWD filter (no currency on file means KWD).
const KWD_REQUESTS = "recruit_requests r LEFT JOIN organization_commercial_terms t ON t.org_id = r.org_id AND t.field = 'currency_code'";
const OVERVIEW = `SELECT
  (SELECT count(*)::int FROM person_profiles) AS candidates,
  (SELECT count(DISTINCT person_principal_id)::int FROM work_assignments WHERE start_date <= $1::date AND (end_date IS NULL OR end_date >= $1::date)) AS assigned,
  (SELECT count(*)::int FROM recruit_pipeline_cards) AS suggested,
  (SELECT count(*)::int FROM ${KWD_REQUESTS} WHERE r.status <> 'draft' AND COALESCE(t.value, 'KWD') = 'KWD') AS requests,
  (SELECT count(*)::int FROM ${KWD_REQUESTS} WHERE (r.status = 'filled' OR (r.status = 'closed' AND r.close_reason = 'fulfilled')) AND COALESCE(t.value, 'KWD') = 'KWD') AS "requestsDelivered"`;

// $1 operator org ids, $2 first day of the oldest month, $3 the Asia/Kuwait day. Each organization rolls up to its
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
  WHERE a.end_date >= $2::date AND a.end_date <= $3::date GROUP BY 1, 2`;

export class PostgresStatisticsStore {
  readonly #pool: pg.Pool; readonly #owns: boolean; readonly #summary: PostgresMorningSummaryStore;
  readonly #operators: readonly string[];
  /** `operatorOrgIds` are StudentHub's own organizations: they are not companies, and companies sit under them. */
  constructor(options: { connectionString?: string; pool?: pg.Pool; operatorOrgIds?: readonly string[] } = {}) {
    this.#owns = !options.pool; this.#operators = options.operatorOrgIds ?? ["root"];
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
    this.#summary = new PostgresMorningSummaryStore({ pool: this.#pool });
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
      return { activeRequests: shared.activeRequests!, assignedExpiredCivilID: shared.assignedExpiredCivilID!, totalExpiredCards: shared.totalExpiredCards!, id_need_generated: shared.id_need_generated!, ...own };
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

  /** Top-level companies, and placements ended in `months` (`YYYY-MM`) up to one Asia/Kuwait day, both from one snapshot. */
  async firings(day: string, months: readonly string[]): Promise<{ companies: { orgId: string; name: string }[]; counts: { orgId: string; month: string; total: number }[] }> {
    if (!DAY.test(day) || months.length === 0 || !months.every(m => /^\d{4}-\d{2}$/.test(m))) throw new RangeError("invalid months");
    const from = `${[...months].sort()[0]}-01`;
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const companies = (await c.query<{ orgId: string; name: string }>(FIRING_COMPANIES, [this.#operators])).rows;
      const counts = (await c.query<{ orgId: string; month: string; total: number }>(`${FIRINGS}`, [this.#operators, from, day])).rows;
      await c.query("COMMIT");
      return { companies, counts };
    } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { c.release(); }
  }
}
