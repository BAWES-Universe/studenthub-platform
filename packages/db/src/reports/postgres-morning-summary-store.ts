import pg from "pg";
import { databaseUrl } from "../connection.js";
import { PostgresBankDetailsStore } from "../postgres-bank-details-store.js";
import { idCardExpiredCount, idCardNeedsCount } from "./postgres-id-cards-store.js";

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

// Active clients with no request in 40 days (legacy `Company::last40daysWithoutRequest`, @55119d3): top-level
// KWD companies, not deleted, that are
//  - old: legacy asked for a creation date over 40 days back. The platform keeps no company creation date,
//    so the oldest sign of the company stands in for it: an assignment that started, or a request made,
//    before the Kuwait day 40 days before the report day. This is a deliberate change: a company older than
//    that whose first assignment and first request are newer is not counted here, where legacy counted it;
//  - active, as legacy's `filterActive`: someone assigned on the report day (any start date), or a request
//    open or filling (legacy `started`), or a request of any status updated in the 30 Kuwait days to the
//    report day (legacy `is_request_updates_in_30_days`); only requests made by the end of the report day;
//  - without a request, of any status, drafts included, made from the Kuwait day 40 days before the report
//    day to the end of the report day.
// Every sign rolls up from sub-companies that are not deleted, as legacy did for staff, active requests and
// updates. Legacy kept the last request date on the requesting company only, so a parent whose requests all
// came from sub-companies counted as never requesting; rolling requests up too is a deliberate platform
// choice. Request status and updated_at are read as they are now, so a past report day sees today's status.
// One statement, so every counter reads the same snapshot. $1 is the Asia/Kuwait day, $2 the operator
// organizations: they are not companies, and each organization rolls up to its top-level company under them.
const COUNTS = `WITH RECURSIVE up(org_id, at, parent, depth) AS (
    SELECT id, id, parent_org_id, 0 FROM organizations WHERE NOT (id = ANY($2::text[]))
    UNION ALL SELECT up.org_id, o.id, o.parent_org_id, up.depth + 1 FROM up JOIN organizations o ON o.id = up.parent
      WHERE NOT (o.id = ANY($2::text[])) AND up.depth < 32),
  top AS (SELECT org_id, at AS company_id FROM up WHERE parent IS NULL OR parent = ANY($2::text[]))
SELECT
  (SELECT count(*)::int FROM organizations c LEFT JOIN organization_commercial_terms ct ON ct.org_id = c.id AND ct.field = 'currency_code'
     WHERE c.id IN (SELECT company_id FROM top) AND COALESCE(ct.value, 'KWD') = 'KWD'
       AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = c.id)
       AND EXISTS (SELECT 1 FROM work_assignments a JOIN top t ON t.org_id = a.org_id
         WHERE t.company_id = c.id AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = t.org_id) AND a.start_date <= $1::date - 40 AND (a.end_date IS NULL OR a.end_date >= $1::date))
       AND NOT EXISTS (SELECT 1 FROM pay_transfers p JOIN top t ON t.org_id = p.company_id
         WHERE t.company_id = c.id AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = t.org_id) AND NOT p.deleted AND p.payment_received_on > $1::date - 40 AND p.payment_received_on <= $1::date)) AS "companyMoreThen40DaysWithoutPayment",
  (SELECT count(*)::int FROM organizations c LEFT JOIN organization_commercial_terms ct ON ct.org_id = c.id AND ct.field = 'currency_code'
     WHERE c.id IN (SELECT company_id FROM top) AND COALESCE(ct.value, 'KWD') = 'KWD'
       AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = c.id)
       AND EXISTS (SELECT 1 FROM top t WHERE t.company_id = c.id AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = t.org_id) AND (
             EXISTS (SELECT 1 FROM work_assignments a WHERE a.org_id = t.org_id AND a.start_date < $1::date - 40)
          OR EXISTS (SELECT 1 FROM recruit_requests r WHERE r.org_id = t.org_id AND r.created_at < (($1::date - 40)::timestamp AT TIME ZONE 'Asia/Kuwait'))))
       AND EXISTS (SELECT 1 FROM top t WHERE t.company_id = c.id AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = t.org_id) AND (
             EXISTS (SELECT 1 FROM work_assignments a WHERE a.org_id = t.org_id AND a.start_date <= $1::date AND (a.end_date IS NULL OR a.end_date >= $1::date))
          OR EXISTS (SELECT 1 FROM recruit_requests r WHERE r.org_id = t.org_id AND r.created_at < (($1::date + 1)::timestamp AT TIME ZONE 'Asia/Kuwait')
               AND (r.status IN ('open','filling')
                 OR (r.updated_at >= (($1::date - 29)::timestamp AT TIME ZONE 'Asia/Kuwait') AND r.updated_at < (($1::date + 1)::timestamp AT TIME ZONE 'Asia/Kuwait'))))))
       AND NOT EXISTS (SELECT 1 FROM recruit_requests r JOIN top t ON t.org_id = r.org_id
         WHERE t.company_id = c.id AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id = t.org_id) AND r.created_at >= (($1::date - 40)::timestamp AT TIME ZONE 'Asia/Kuwait') AND r.created_at < (($1::date + 1)::timestamp AT TIME ZONE 'Asia/Kuwait'))) AS "last40daysNoRequest",
  (SELECT count(DISTINCT a.person_principal_id)::int FROM work_assignments a
     WHERE a.start_date < ($1::date - interval '2 months')::date AND (a.end_date IS NULL OR a.end_date >= $1::date)
       AND NOT EXISTS (SELECT 1 FROM pay_transfer_lines l JOIN pay_transfers p ON p.id = l.transfer_id
         WHERE l.person_id = a.person_principal_id AND l.paid AND NOT p.deleted AND p.status <> 'cancelled'
           AND p.period_end >= ($1::date - interval '2 months')::date AND p.period_end <= $1::date)) AS "assignedIdleCandidates",
  (SELECT count(*)::int FROM recruit_interviews i JOIN recruit_pipeline_cards c ON c.id = i.card_id JOIN recruit_requests r ON r.id = c.request_id
     WHERE i.status = 'scheduled' AND i.${KUWAIT_DAY("$1")} AND r.status NOT IN ('filled','closed')) AS "interviewScheduledToday",
  (SELECT count(*)::int FROM recruit_requests r LEFT JOIN organization_commercial_terms t ON t.org_id = r.org_id AND t.field = 'currency_code'
     WHERE r.status IN ('open','filling') AND COALESCE(t.value, 'KWD') = 'KWD') AS "activeRequests",
  (SELECT count(*)::int FROM person_civil_ids p WHERE p.expiry_date < $1::date AND p.released_at IS NULL
     AND EXISTS (SELECT 1 FROM work_assignments a WHERE a.person_principal_id = p.principal_id AND (a.end_date IS NULL OR a.end_date >= $1::date))) AS "assignedExpiredCivilID",
  ${idCardExpiredCount("$1")} AS "totalExpiredCards",
  ${idCardNeedsCount("$1")} AS "id_need_generated"`;

// Legacy `Candidate::withoutBankInfoOrWithPayment` (grouped by candidate): people placed today
// (legacy `store_id > 0`; here an assignment running on the report day), and people with an unpaid
// line on a transfer whose payment has arrived (being distributed, or complete). Intentional changes:
// - KWD only, as the staff statistics page asks the helper (legacy's email counted every currency;
//   the summary's other shared counters are KWD too). A placement counts at an organization that
//   bills in KWD, a line on a KWD transfer.
// - A deleted transfer is left out; legacy checked only that the line was not deleted. The pay lifecycle
//   deletes only draft, locked or cancelled transfers, so this is a guard.
// - Legacy left out deleted candidates; people have no deleted state on the platform.
// How many of them have no bank details is asked of the bank-details store, the table's only reader;
// this query never names that table.
const BANK_INFO_CANDIDATES = `SELECT a.person_principal_id AS id FROM work_assignments a
    LEFT JOIN organization_commercial_terms ct ON ct.org_id = a.org_id AND ct.field = 'currency_code'
    WHERE a.start_date <= $1::date AND (a.end_date IS NULL OR a.end_date >= $1::date) AND COALESCE(ct.value, 'KWD') = 'KWD'
  UNION
  SELECT l.person_id FROM pay_transfer_lines l JOIN pay_transfers p ON p.id = l.transfer_id
    WHERE NOT l.paid AND NOT p.deleted AND p.currency_code = 'KWD' AND p.status IN ('distributing','complete')
`;

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
  readonly #pool: pg.Pool; readonly #owns: boolean; readonly #operatorOrgIds: readonly string[]; readonly #bank: Pick<PostgresBankDetailsStore, "countWithoutDetails">;
  constructor(options: { connectionString?: string; pool?: pg.Pool; operatorOrgIds?: readonly string[] } = {}) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
    this.#operatorOrgIds = options.operatorOrgIds ?? ["root"];
    this.#bank = new PostgresBankDetailsStore({ pool: this.#pool });
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /**
   * The counters this store can read for one Asia/Kuwait day, all from one snapshot. A caller
   * already in a repeatable-read transaction passes its client; otherwise the store opens one.
   */
  async counts(day: string, client?: Pick<pg.Pool, "query">): Promise<MorningSummaryRawCounts> {
    if (!DAY.test(day)) throw new RangeError("invalid day");
    if (client) return this.#read(day, client);
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const counts = await this.#read(day, c);
      await c.query("COMMIT");
      return counts;
    } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { c.release(); }
  }

  async #read(day: string, client: Pick<pg.Pool, "query">): Promise<MorningSummaryRawCounts> {
    const counts = (await client.query<Record<string, number>>(COUNTS, [day, this.#operatorOrgIds])).rows[0]!;
    const candidates = (await client.query<{ id: string }>(BANK_INFO_CANDIDATES, [day])).rows.map(r => r.id);
    return { ...counts, missingBankInfo: await this.#bank.countWithoutDetails(candidates, client) };
  }

  /**
   * Sends one day's summary, once. It first reads the counters in their own repeatable-read
   * snapshot and releases that connection, so it never holds two at once. Then, in one read
   * committed transaction, it takes the day's lock, stops if the day already ran (the lock and
   * this check see the latest runs), lets `build` turn the counters into the email's closed
   * parameters (it throws to send nothing), queues one email per current recipient and
   * records the run. Returns null when the day already ran.
   */
  async sendDay(day: string, at: Date, build: (counts: MorningSummaryRawCounts) => unknown): Promise<MorningSummarySendResult | null> {
    if (!DAY.test(day)) throw new RangeError("invalid day");
    const counts = await this.counts(day);
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('morning_summary:' || $1, 0))", [day]);
      if ((await c.query("SELECT 1 FROM morning_summary_runs WHERE day = $1::date", [day])).rowCount) { await c.query("ROLLBACK"); return null; }
      const parameters = build(counts);
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
