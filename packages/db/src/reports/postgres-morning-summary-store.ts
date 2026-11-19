import pg from "pg";
import { databaseUrl } from "../connection.js";

/**
 * The morning summary's Postgres side (contract P-2). It reads the counters whose source has
 * landed, keeps each staff member's email subscription, and sends a day's summary once.
 * Counter keys and the "not available" rule live in `packages/reports`; this store only
 * answers the counters it has a query for.
 */
export type MorningSummaryRawCounts = Readonly<Record<string, number>>;
export interface MorningSummarySendResult { readonly day: string; readonly recipients: number; readonly parameters: unknown }

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KUWAIT_DAY = (p: string) => `scheduled_at >= (${p}::date::timestamp AT TIME ZONE 'Asia/Kuwait') AND scheduled_at < ((${p}::date + 1)::timestamp AT TIME ZONE 'Asia/Kuwait')`;

// One statement, so every counter reads the same snapshot.
const COUNTS = `SELECT
  (SELECT count(*)::int FROM recruit_interviews i JOIN recruit_pipeline_cards c ON c.id = i.card_id JOIN recruit_requests r ON r.id = c.request_id
     WHERE i.status = 'scheduled' AND i.${KUWAIT_DAY("$1")} AND r.status NOT IN ('filled','closed')) AS "interviewScheduledToday",
  (SELECT count(*)::int FROM recruit_requests r LEFT JOIN organization_commercial_terms t ON t.org_id = r.org_id AND t.field = 'currency_code'
     WHERE r.status IN ('open','filling') AND COALESCE(t.value, 'KWD') = 'KWD') AS "activeRequests",
  (SELECT count(*)::int FROM person_civil_ids p WHERE p.expiry_date < $1::date AND p.released_at IS NULL
     AND EXISTS (SELECT 1 FROM work_assignments a WHERE a.person_principal_id = p.principal_id AND (a.end_date IS NULL OR a.end_date >= $1::date))) AS "assignedExpiredCivilID"`;

/**
 * Who may get the email: subscribed, still StudentHub staff (a staff or admin grant over an
 * operator organization's subtree), account not paused. Used when the email is queued and
 * again by the outbox claim on every delivery attempt, so an opt-out, a lost grant or a pause
 * after queueing stops the send.
 */
export const morningSummaryEligible = (principal: string, orgs: string) => `(EXISTS (SELECT 1 FROM morning_summary_subscriptions s WHERE s.principal_id = ${principal})
    AND EXISTS (SELECT 1 FROM grants g WHERE g.principal_id = ${principal} AND g.role IN ('staff','admin') AND g.scope = 'subtree' AND g.org_id = ANY(${orgs}::text[]))
    AND NOT EXISTS (SELECT 1 FROM account_pauses p WHERE p.principal_id = ${principal} AND p.resumed_at IS NULL))`;
const RECIPIENTS = (orgs: string) => `SELECT s.principal_id FROM morning_summary_subscriptions s WHERE ${morningSummaryEligible("s.principal_id", orgs)} ORDER BY s.principal_id`;

export class PostgresMorningSummaryStore {
  readonly #pool: pg.Pool; readonly #owns: boolean; readonly #operatorOrgIds: readonly string[];
  constructor(options: { connectionString?: string; pool?: pg.Pool; operatorOrgIds?: readonly string[] } = {}) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
    this.#operatorOrgIds = options.operatorOrgIds ?? ["root"];
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /** The counters this store can read for one Asia/Kuwait day. */
  async counts(day: string, client: Pick<pg.Pool, "query"> = this.#pool): Promise<MorningSummaryRawCounts> {
    if (!DAY.test(day)) throw new RangeError("invalid day");
    return (await client.query<Record<string, number>>(COUNTS, [day])).rows[0]!;
  }

  /**
   * Sends one day's summary, once. In one transaction it takes the day's lock, stops if the
   * day already ran, reads the counters, lets `build` turn them into the email's closed
   * parameters (it throws to send nothing), queues one email per current recipient and
   * records the run. Returns null when the day already ran.
   */
  async sendDay(day: string, at: Date, build: (counts: MorningSummaryRawCounts) => unknown): Promise<MorningSummarySendResult | null> {
    if (!DAY.test(day)) throw new RangeError("invalid day");
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('morning_summary:' || $1, 0))", [day]);
      if ((await c.query("SELECT 1 FROM morning_summary_runs WHERE day = $1::date", [day])).rowCount) { await c.query("ROLLBACK"); return null; }
      const parameters = build(await this.counts(day, c));
      const queued = await c.query(`INSERT INTO email_outbox(class, recipient_principal_id, template_parameters, idempotency_key)
        SELECT 'staff.morning_summary', r.principal_id, $2::jsonb, 'staff.morning_summary:' || $1 || ':' || r.principal_id FROM (${RECIPIENTS("$3")}) r
        ON CONFLICT (idempotency_key) DO NOTHING`, [day, JSON.stringify(parameters), this.#operatorOrgIds]);
      const counters = (parameters as { counters?: unknown } | null)?.counters ?? {};
      await c.query("INSERT INTO morning_summary_runs(day, counters, recipients, ran_at) VALUES($1::date, $2::jsonb, $3, $4)", [day, JSON.stringify(counters), queued.rowCount ?? 0, at]);
      await c.query("COMMIT");
      return { day, recipients: queued.rowCount ?? 0, parameters };
    } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { c.release(); }
  }

  async isSubscribed(principalId: string): Promise<boolean> {
    return Boolean((await this.#pool.query("SELECT 1 FROM morning_summary_subscriptions WHERE principal_id = $1", [principalId])).rowCount);
  }
  async setSubscribed(principalId: string, on: boolean, at: Date): Promise<void> {
    if (on) await this.#pool.query("INSERT INTO morning_summary_subscriptions(principal_id, subscribed_at) VALUES($1, $2) ON CONFLICT (principal_id) DO NOTHING", [principalId, at]);
    else await this.#pool.query("DELETE FROM morning_summary_subscriptions WHERE principal_id = $1", [principalId]);
  }
  /** Current recipients, as the next send would pick them. */
  async recipients(): Promise<string[]> {
    return (await this.#pool.query<{ principal_id: string }>(RECIPIENTS("$1"), [this.#operatorOrgIds])).rows.map(r => r.principal_id);
  }
}
