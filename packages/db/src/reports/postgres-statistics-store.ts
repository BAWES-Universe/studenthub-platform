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

// $1 is the Asia/Kuwait day, $2 the current instant.
const COUNTS = `SELECT
  (SELECT count(*)::int FROM work_appeals WHERE status = 'submitted') AS "workLogAppeals",
  (SELECT count(*)::int FROM person_profiles WHERE birth_date > ($1::date - interval '16 years')::date) AS "totalMinor",
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

export class PostgresStatisticsStore {
  readonly #pool: pg.Pool; readonly #owns: boolean; readonly #summary: PostgresMorningSummaryStore;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.#owns = !options.pool;
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

  /** Hired, retained after a year, and invitations sent, as of one Asia/Kuwait day. */
  async hiring(day: string): Promise<StatisticsHiringCounts> {
    if (!DAY.test(day)) throw new RangeError("invalid day");
    return (await this.#pool.query<StatisticsHiringCounts>(HIRING, [day])).rows[0]!;
  }
}
