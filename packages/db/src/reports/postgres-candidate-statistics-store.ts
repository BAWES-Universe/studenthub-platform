import pg from "pg";
import { databaseUrl } from "../connection.js";

/**
 * The Postgres side of a person's own statistics (`packages/reports/src/candidate-statistics.ts`).
 * Read-only over the pay lane's `pay_transfers` and `pay_transfer_lines` and the recruit lane's
 * `recruit_interviews`, `recruit_pipeline_cards` and `recruit_requests`, in one repeatable-read
 * snapshot. Only the person's own rows are read, and only the candidate's side of each line: the
 * company total, rates and transfer cost are never selected.
 *
 * The row type mirrors `CandidatePayLine` in `packages/reports` structurally (db does not depend on reports).
 */
export interface CandidateStatisticsLineRow {
  readonly currency: string;
  readonly candidateTotal: string;
  readonly paidOut: boolean;
  readonly calculation: {
    readonly version: unknown; readonly hours: unknown; readonly minutes: unknown; readonly seconds: unknown;
    readonly bonus: unknown; readonly resultKind: unknown; readonly resultCandidateTotal: unknown; readonly bonusCommission: unknown;
  } | null;
}

const LINES = `SELECT l.currency_code AS currency, l.candidate_total::text AS "candidateTotal",
    (l.paid AND t.status IN ('distributing', 'complete')) AS "paidOut",
    jsonb_build_object('version', l.calculation->'version', 'hours', l.calculation->'input'->'hours', 'minutes', l.calculation->'input'->'minutes',
      'seconds', l.calculation->'input'->'seconds', 'bonus', l.calculation->'input'->'bonus', 'resultKind', l.calculation->'result'->'kind',
      'resultCandidateTotal', l.calculation->'result'->'candidateTotal', 'bonusCommission', l.calculation->'result'->'bonusCommission') AS calculation
  FROM pay_transfer_lines l JOIN pay_transfers t ON t.id = l.transfer_id AND t.currency_code = l.currency_code
  WHERE l.person_id = $1 AND NOT t.deleted AND t.status NOT IN ('draft', 'cancelled')`;
const INTERVIEWS = `SELECT count(*)::int AS n FROM recruit_interviews i JOIN recruit_pipeline_cards c ON c.id = i.card_id JOIN recruit_requests r ON r.id = c.request_id
  WHERE c.person_principal_id = $1 AND i.status = 'scheduled' AND i.scheduled_at > $2 AND r.status NOT IN ('filled', 'closed')`;

export class PostgresCandidateStatisticsStore {
  readonly #pool: pg.Pool; readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  async read(personId: string, now: Date): Promise<{ readonly lines: readonly CandidateStatisticsLineRow[]; readonly upcomingInterviews: number }> {
    const client = await this.#pool.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      const lines = await client.query<CandidateStatisticsLineRow>(LINES, [personId]);
      const interviews = await client.query<{ n: number }>(INTERVIEWS, [personId, now]);
      await client.query("COMMIT");
      return { lines: lines.rows, upcomingInterviews: interviews.rows[0]!.n };
    } catch (e) { await client.query("ROLLBACK").catch(() => undefined); throw e; } finally { client.release(); }
  }
}
