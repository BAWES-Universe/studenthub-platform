import pg from "pg";
import { databaseUrl } from "../connection.js";

/**
 * S8 ID cards' Postgres side (migration 0602). Reads the work lane's `work_assignments`,
 * `organizations`, `organization_profiles` and `organization_stores`, and the person's names,
 * read-only; writes only `id_cards` and `id_card_events`. The service in `packages/reports`
 * owns the rules (who is staff, the three-month expiry); this store applies them in SQL.
 */
export type IdCardView = "needs" | "expired" | "issued";
export type IdCardAction = "issue" | "renew";
export type IdCardRefusal = "unknown_person" | "not_assigned" | "no_card";
export interface IdCardPlacementRow { readonly company: string; readonly store: string }
export interface IdCardListRow { readonly personId: string; readonly name: string | null; readonly employeeId: string | null; readonly cardNumber: number | null; readonly expiresOn: string | null; readonly placement: IdCardPlacementRow | null }
export interface IdCardRow { readonly name: string | null; readonly arabicName: string | null; readonly employeeId: string | null; readonly cardNumber: number; readonly expiresOn: string; readonly issuedAt: Date; readonly placement: IdCardPlacementRow | null }

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Someone counts as assigned on a day while an assignment of theirs has not ended. Shared with the morning summary. */
export const idCardAssigned = (person: string, day: string) =>
  `EXISTS (SELECT 1 FROM work_assignments a WHERE a.person_principal_id = ${person} AND (a.end_date IS NULL OR a.end_date >= ${day}::date))`;
/** Assigned people without a card (legacy `idNeedGenerated()->filterAssigned()`). */
export const idCardNeedsCount = (day: string) =>
  `(SELECT count(*)::int FROM principals p WHERE ${idCardAssigned("p.id", day)} AND NOT EXISTS (SELECT 1 FROM id_cards c WHERE c.person_principal_id = p.id))`;
/** Assigned people whose card has expired (legacy `idExpired()->filterAssigned()`). */
export const idCardExpiredCount = (day: string) =>
  `(SELECT count(*)::int FROM id_cards c WHERE c.expires_on < ${day}::date AND ${idCardAssigned("c.person_principal_id", day)})`;

// The assignment the card shows: the one running today, else the next to start, else none.
const PLACEMENT = (person: string, day: string) => `LEFT JOIN LATERAL (
  SELECT coalesce(op.name_en, o.name)::text AS company, s.name::text AS store FROM work_assignments a
    JOIN organizations o ON o.id = a.org_id LEFT JOIN organization_profiles op ON op.org_id = a.org_id JOIN organization_stores s ON s.id = a.store_id
   WHERE a.person_principal_id = ${person} AND (a.end_date IS NULL OR a.end_date >= ${day}::date)
   ORDER BY (a.start_date <= ${day}::date) DESC, CASE WHEN a.start_date <= ${day}::date THEN a.start_date END DESC, a.start_date, a.id LIMIT 1) placement ON true`;
const NAME = "coalesce(pp.display_name, p.display_name)::text";
// Legacy's employee ID: C and the candidate id, padded to five digits (lpad alone would cut longer ids).
const EMPLOYEE = "CASE WHEN l.legacy_candidate_id IS NULL THEN NULL WHEN length(l.legacy_candidate_id) < 5 THEN 'C' || lpad(l.legacy_candidate_id, 5, '0') ELSE 'C' || l.legacy_candidate_id END";

type ListDbRow = { person_id: string; name: string | null; employee_id: string | null; card_number: string | null; expires_on: string | null; company: string | null; store: string | null; total: number };
type CardDbRow = { name: string | null; arabic_name: string | null; employee_id: string | null; card_number: string; expires_on: string; issued_at: Date; company: string | null; store: string | null };
const placement = (r: { company: string | null; store: string | null }) => r.company !== null && r.store !== null ? { company: r.company, store: r.store } : null;

export class PostgresIdCardsStore {
  readonly #pool: pg.Pool; readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  async list(view: IdCardView, today: string, name: string | null, offset: number, limit: number): Promise<{ rows: IdCardListRow[]; total: number }> {
    if (!DAY.test(today) || !Number.isInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 500) throw new RangeError("invalid list");
    const where = view === "needs" ? `${idCardAssigned("p.id", "$1")} AND c.person_principal_id IS NULL`
      : view === "expired" ? `c.expires_on < $1::date AND ${idCardAssigned("p.id", "$1")}`
      : view === "issued" ? "c.person_principal_id IS NOT NULL" : undefined;
    if (!where) throw new RangeError("invalid view");
    // The total is counted apart from the page, in the same statement, so a page past the end still reports how many match.
    const result = await this.#pool.query<Omit<ListDbRow, "person_id"> & { person_id: string | null }>(`WITH m AS (SELECT p.id AS person_id, ${NAME} AS name, ${EMPLOYEE} AS employee_id, c.card_number::text AS card_number,
        to_char(c.expires_on, 'YYYY-MM-DD') AS expires_on, placement.company, placement.store
       FROM principals p LEFT JOIN person_profiles pp ON pp.principal_id = p.id LEFT JOIN legacy_account_links l ON l.principal_id = p.id
       LEFT JOIN id_cards c ON c.person_principal_id = p.id ${PLACEMENT("p.id", "$1")}
      WHERE ${where} AND ($2::text IS NULL OR strpos(lower(coalesce(pp.display_name, '') || ' ' || coalesce(pp.arabic_name, '') || ' ' || coalesce(p.display_name, '')), lower($2::text)) > 0))
      SELECT page.*, (SELECT count(*)::int FROM m) AS total FROM (SELECT 1) one
        LEFT JOIN LATERAL (SELECT * FROM m ORDER BY ${view === "issued" ? "expires_on, " : ""}lower(name) NULLS LAST, person_id OFFSET $3 LIMIT $4) page ON true`, [today, name, offset, limit]);
    const rows = result.rows.filter((r): r is ListDbRow => r.person_id !== null);
    return { total: result.rows[0]?.total ?? 0, rows: rows.map(r => ({ personId: r.person_id, name: r.name, employeeId: r.employee_id,
      cardNumber: r.card_number === null ? null : Number(r.card_number), expiresOn: r.expires_on, placement: placement(r) })) };
  }

  async write(action: IdCardAction, people: readonly string[], today: string, expiresOn: string, actor: string): Promise<{ personId: string; code: IdCardRefusal }[]> {
    if ((action !== "issue" && action !== "renew") || !DAY.test(today) || !DAY.test(expiresOn) || people.length === 0) throw new RangeError("invalid write");
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN");
      // Lock the people's cards (and the rows they would insert) so two staff writing the same person queue up.
      for (const person of [...people].sort()) await c.query("SELECT pg_advisory_xact_lock(hashtextextended('id_card:' || $1, 0))", [person]);
      // Share-lock the people's assignments before checking them: an end date being written now is
      // waited for and then seen, and none can be written until this card commits.
      await c.query("SELECT 1 FROM work_assignments WHERE person_principal_id = ANY($1::text[]) ORDER BY id FOR SHARE", [people]);
      const checked = await c.query<{ person_id: string; known: boolean; assigned: boolean; has_card: boolean }>(`SELECT x AS person_id, EXISTS (SELECT 1 FROM principals p WHERE p.id = x) AS known,
          ${idCardAssigned("x", "$2")} AS assigned, EXISTS (SELECT 1 FROM id_cards c WHERE c.person_principal_id = x) AS has_card
         FROM unnest($1::text[]) WITH ORDINALITY AS t(x, n) ORDER BY n`, [people, today]);
      const refusals = checked.rows.flatMap((r): { personId: string; code: IdCardRefusal }[] => !r.known ? [{ personId: r.person_id, code: "unknown_person" }] : !r.assigned ? [{ personId: r.person_id, code: "not_assigned" }]
        : action === "renew" && !r.has_card ? [{ personId: r.person_id, code: "no_card" }] : []);
      if (refusals.length) { await c.query("ROLLBACK"); return refusals; }
      for (const r of checked.rows) {
        const kind = action === "renew" ? "renewed" : r.has_card ? "reissued" : "issued";
        if (r.has_card) await c.query("UPDATE id_cards SET expires_on = $2::date, updated_at = clock_timestamp() WHERE person_principal_id = $1", [r.person_id, expiresOn]);
        else await c.query("INSERT INTO id_cards(person_principal_id, expires_on, issued_by) VALUES($1, $2::date, $3)", [r.person_id, expiresOn, actor]);
        await c.query("INSERT INTO id_card_events(person_principal_id, kind, expires_on, actor_principal_id) VALUES($1, $2, $3::date, $4)", [r.person_id, kind, expiresOn, actor]);
      }
      await c.query("COMMIT");
      return [];
    } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { c.release(); }
  }

  async card(personId: string, today: string): Promise<IdCardRow | undefined> {
    if (!DAY.test(today)) throw new RangeError("invalid day");
    const r = (await this.#pool.query<CardDbRow>(`SELECT ${NAME} AS name, pp.arabic_name::text AS arabic_name, ${EMPLOYEE} AS employee_id, c.card_number::text AS card_number,
        to_char(c.expires_on, 'YYYY-MM-DD') AS expires_on, c.issued_at, placement.company, placement.store
       FROM id_cards c JOIN principals p ON p.id = c.person_principal_id LEFT JOIN person_profiles pp ON pp.principal_id = p.id
       LEFT JOIN legacy_account_links l ON l.principal_id = p.id ${PLACEMENT("p.id", "$2")} WHERE c.person_principal_id = $1`, [personId, today])).rows[0];
    return r && { name: r.name, arabicName: r.arabic_name, employeeId: r.employee_id, cardNumber: Number(r.card_number), expiresOn: r.expires_on, issuedAt: r.issued_at, placement: placement(r) };
  }

  async counts(today: string): Promise<{ needs: number; expired: number }> {
    if (!DAY.test(today)) throw new RangeError("invalid day");
    const r = (await this.#pool.query<{ needs: number; expired: number }>(`SELECT ${idCardNeedsCount("$1")} AS needs, ${idCardExpiredCount("$1")} AS expired`, [today])).rows[0]!;
    return { needs: r.needs, expired: r.expired };
  }
}
