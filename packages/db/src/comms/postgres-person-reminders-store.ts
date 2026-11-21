import pg from "pg";
import { databaseUrl } from "../connection.js";

/**
 * Person reminder emails (comms lane slice 10), legacy's `Candidate::birthdayAlert`,
 * `Candidate::civilIdExpire` and `Candidate::notifyCivilIDExpiring`. Each kind is queued once per
 * Asia/Kuwait day; the schedule (13:30, the 15th and 28th) lives in `packages/comms`.
 */
export const PERSON_REMINDER_KINDS = ["birthday", "civil_id_expired", "civil_id_expiring"] as const;
export type PersonReminderKind = typeof PERSON_REMINDER_KINDS[number];
export const PERSON_REMINDER_CLASS = { birthday: "person.birthday", civil_id_expired: "person.civil_id_expired", civil_id_expiring: "person.civil_id_expiring" } as const;
/** Legacy's "expiring" reminder covered every civil ID that expires within 25 days, already expired ones included. */
export const CIVIL_ID_EXPIRING_DAYS = 25;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const notPaused = (p: string) => `NOT EXISTS (SELECT 1 FROM account_pauses ap WHERE ap.principal_id = ${p} AND ap.resumed_at IS NULL)`;
/** Legacy sent the civil ID reminders only to people placed at a store; here, a work assignment that has not ended by the day. */
const assigned = (p: string, d: string) => `EXISTS (SELECT 1 FROM work_assignments wa WHERE wa.person_principal_id = ${p} AND (wa.end_date IS NULL OR wa.end_date >= ${d}))`;
// A 29 February birthday is wished on 28 February in other years.
const birthdayOn = (birth: string, d: string) => `(to_char(${birth}, 'MM-DD') = to_char(${d}, 'MM-DD')
  OR (to_char(${birth}, 'MM-DD') = '02-29' AND to_char(${d}, 'MM-DD') = '02-28' AND to_char((date_trunc('year', ${d}) + interval '2 months' - interval '1 day')::date, 'DD') = '28'))`;

/**
 * Who a reminder of each kind is for on day `d`. Used when the emails are queued and again by the
 * outbox claim on every delivery attempt, so a pause, a released or renewed civil ID, an ended
 * assignment or a corrected birth date after queueing stops the send.
 */
export const personReminderEligible: { readonly [K in PersonReminderKind]: (p: string, d: string) => string } = {
  birthday: (p, d) => `(EXISTS (SELECT 1 FROM person_profiles pp WHERE pp.principal_id = ${p} AND pp.birth_date IS NOT NULL AND ${birthdayOn("pp.birth_date", d)}) AND ${notPaused(p)})`,
  civil_id_expired: (p, d) => `(EXISTS (SELECT 1 FROM person_civil_ids ci WHERE ci.principal_id = ${p} AND ci.released_at IS NULL AND ci.expiry_date = ${d}) AND ${assigned(p, d)} AND ${notPaused(p)})`,
  civil_id_expiring: (p, d) => `(EXISTS (SELECT 1 FROM person_civil_ids ci WHERE ci.principal_id = ${p} AND ci.released_at IS NULL AND ci.expiry_date < ${d} + ${CIVIL_ID_EXPIRING_DAYS}) AND ${assigned(p, d)} AND ${notPaused(p)})`,
};

// The first word of the person's name (legacy's greeting), with no control characters and at most 255 characters; empty when there is none.
const FIRST_NAME = `left(btrim(regexp_replace(split_part(coalesce(nullif(btrim(pp.display_name), ''), nullif(btrim(pp.arabic_name), ''), nullif(btrim(q.display_name), ''), ''), ' ', 1), '[\\u0001-\\u001f\\u007f-\\u009f]', '', 'g')), 255)`;
const PARAMETERS: { readonly [K in PersonReminderKind]: string } = {
  birthday: `jsonb_build_object('name', ${FIRST_NAME})`,
  civil_id_expired: `jsonb_build_object('name', ${FIRST_NAME})`,
  civil_id_expiring: `jsonb_build_object('name', ${FIRST_NAME}, 'expiry', to_char(ci.expiry_date, 'YYYY-MM-DD'), 'status', CASE WHEN ci.expiry_date < $1::date THEN 'expired' ELSE 'expiring' END)`,
};

export class PostgresPersonRemindersStore {
  readonly #pool: pg.Pool; readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /**
   * Queues one kind's reminders for one day, once: under the day's lock it stops if the day already
   * ran, queues one email per eligible person with an address (key `<class>:<day>:<principal>`) and
   * records the run, all in one transaction. Returns how many were queued, or null if the day ran.
   */
  async sendDay(kind: PersonReminderKind, day: string, at: Date): Promise<number | null> {
    if (!PERSON_REMINDER_KINDS.includes(kind)) throw new RangeError("invalid reminder kind");
    if (!DAY.test(day) || Number.isNaN(Date.parse(`${day}T00:00:00Z`))) throw new RangeError("invalid day");
    const emailClass = PERSON_REMINDER_CLASS[kind];
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('person_reminder:' || $1 || ':' || $2, 0))", [kind, day]);
      if ((await c.query("SELECT 1 FROM person_reminder_runs WHERE kind = $1 AND day = $2::date", [kind, day])).rowCount) { await c.query("ROLLBACK"); return null; }
      const queued = await c.query(`INSERT INTO email_outbox(class, recipient_principal_id, template_parameters, idempotency_key)
        SELECT $2::text, q.id, ${PARAMETERS[kind]}, $2::text || ':' || $1::text || ':' || q.id
        FROM principals q LEFT JOIN person_profiles pp ON pp.principal_id = q.id LEFT JOIN person_civil_ids ci ON ci.principal_id = q.id
        WHERE q.email IS NOT NULL AND btrim(q.email) <> '' AND ${personReminderEligible[kind]("q.id", "$1::date")}
        ORDER BY q.id
        ON CONFLICT (idempotency_key) DO NOTHING`, [day, emailClass]);
      await c.query("INSERT INTO person_reminder_runs(kind, day, recipients, ran_at) VALUES($1, $2::date, $3, $4)", [kind, day, queued.rowCount ?? 0, at]);
      await c.query("COMMIT");
      return queued.rowCount ?? 0;
    } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { c.release(); }
  }
}
