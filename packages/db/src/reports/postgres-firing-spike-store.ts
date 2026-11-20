import pg from "pg";
import { databaseUrl } from "../connection.js";
import { readFirings, type FiringRows } from "./postgres-statistics-store.js";

/**
 * The firing spike email's Postgres side (contract P-3, slice 4). It keeps each staff member's
 * subscription and runs one day's check once: in one transaction it takes the day's lock, stops
 * if the day already ran, reads the hit map's numbers, records each company and month that
 * alerts for the first time (`firing_spike_alerts`, legacy's `is_alerted`) and queues one email
 * per current recipient. Which months alert is decided in `packages/reports`.
 */
export interface FiringSpikeRow { readonly orgId: string; readonly month: string; readonly parameters: { readonly total: number; readonly twelveMonthTotal: number; readonly level: string } }

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Who may get the email: subscribed, still StudentHub staff (a staff or admin grant over an
 * operator organization's subtree), account not paused. Used when the email is queued and again
 * by the outbox claim on every delivery attempt, so an opt-out, a lost grant or a pause stops it.
 */
export const firingSpikeEligible = (principal: string, orgs: string) => `(EXISTS (SELECT 1 FROM firing_spike_subscriptions s WHERE s.principal_id = ${principal})
    AND EXISTS (SELECT 1 FROM grants g WHERE g.principal_id = ${principal} AND g.role IN ('staff','admin') AND g.scope = 'subtree' AND g.org_id = ANY(${orgs}::text[]))
    AND NOT EXISTS (SELECT 1 FROM account_pauses p WHERE p.principal_id = ${principal} AND p.resumed_at IS NULL))`;
// Someone who switched the class off in their email preferences is suppressed at delivery, so they are no one to tell either.
const RECIPIENTS = (orgs: string) => `SELECT s.principal_id FROM firing_spike_subscriptions s WHERE ${firingSpikeEligible("s.principal_id", orgs)}
    AND NOT EXISTS (SELECT 1 FROM email_preferences e WHERE e.principal_id = s.principal_id AND e.class = 'staff.firing_spike' AND NOT e.enabled) ORDER BY s.principal_id`;

export class PostgresFiringSpikeStore {
  readonly #pool: pg.Pool; readonly #owns: boolean; readonly #operatorOrgIds: readonly string[];
  constructor(options: { connectionString?: string; pool?: pg.Pool; operatorOrgIds?: readonly string[] } = {}) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
    this.#operatorOrgIds = options.operatorOrgIds ?? ["root"];
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /** Runs one Asia/Kuwait day's check once; `decide` turns the hit map's rows into alerts (it throws to send nothing). Null when the day already ran. */
  async sendDay(day: string, months: readonly string[], at: Date, decide: (data: FiringRows) => readonly FiringSpikeRow[]): Promise<{ readonly alerts: number } | null> {
    if (!DAY.test(day)) throw new RangeError("invalid day");
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('firing_spike:' || $1, 0))", [day]);
      if ((await c.query("SELECT 1 FROM firing_spike_runs WHERE day = $1::date", [day])).rowCount) { await c.query("ROLLBACK"); return null; }
      const alerts = decide(await readFirings(c, this.#operatorOrgIds, day, months));
      const recipients = (await c.query<{ principal_id: string }>(RECIPIENTS("$1"), [this.#operatorOrgIds])).rows.map(r => r.principal_id);
      let alerted = 0;
      // With nobody to tell, nothing is recorded: the month can still alert once someone turns the email on.
      for (const a of recipients.length ? alerts : []) {
        // A company and month alerts once (legacy's is_alerted), even if it gets worse later in the month.
        const fresh = await c.query(`INSERT INTO firing_spike_alerts(org_id, month, level, total, twelve_month_total, recipients, alerted_at)
          VALUES($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (org_id, month) DO NOTHING`, [a.orgId, a.month, a.parameters.level, a.parameters.total, a.parameters.twelveMonthTotal, recipients.length, at]);
        if (!fresh.rowCount) continue;
        alerted++;
        await c.query(`INSERT INTO email_outbox(class, recipient_principal_id, template_parameters, idempotency_key)
          SELECT 'staff.firing_spike', r, $1::jsonb, 'staff.firing_spike:' || $2 || ':' || $3 || ':' || r FROM unnest($4::text[]) r
          ON CONFLICT (idempotency_key) DO NOTHING`, [JSON.stringify(a.parameters), a.orgId, a.month, recipients]);
      }
      await c.query("INSERT INTO firing_spike_runs(day, alerts, ran_at) VALUES($1::date, $2, $3)", [day, alerted, at]);
      await c.query("COMMIT");
      return { alerts: alerted };
    } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { c.release(); }
  }

  async isSubscribed(principalId: string): Promise<boolean> {
    return Boolean((await this.#pool.query("SELECT 1 FROM firing_spike_subscriptions WHERE principal_id = $1", [principalId])).rowCount);
  }
  async setSubscribed(principalId: string, on: boolean, at: Date): Promise<void> {
    if (on) await this.#pool.query("INSERT INTO firing_spike_subscriptions(principal_id, subscribed_at) VALUES($1, $2) ON CONFLICT (principal_id) DO NOTHING", [principalId, at]);
    else await this.#pool.query("DELETE FROM firing_spike_subscriptions WHERE principal_id = $1", [principalId]);
  }
  /** Current recipients, as the next check would pick them. */
  async recipients(): Promise<string[]> {
    return (await this.#pool.query<{ principal_id: string }>(RECIPIENTS("$1"), [this.#operatorOrgIds])).rows.map(r => r.principal_id);
  }
}
