import pg from "pg";
import { databaseUrl } from "../connection.js";

/**
 * Marketing campaigns' Postgres side (contract A-22, the UTM half). A campaign is one set of UTM
 * values with what was spent on it; clicks are counted per campaign and per Kuwait day in
 * `marketing_campaign_clicks`. One live campaign per set of UTM values is enforced by the partial
 * unique index, so `create` and `update` report `duplicate` rather than throwing. A campaign is
 * retired (its `retired_at` set), never deleted, so the clicks already counted keep their campaign.
 *
 * The types below mirror `CampaignsStore` in `packages/reports` structurally (db does not depend
 * on reports); the gateway wiring checks that this class satisfies that interface.
 */
type CampaignField = "utmSource" | "utmMedium" | "utmCampaign" | "utmContent" | "utmTerm";
export interface CampaignValues extends Record<CampaignField, string | null> { readonly investment: string }
export interface CampaignRecord extends Record<CampaignField, string | null> {
  readonly id: string; readonly investment: string; readonly retired: boolean;
  readonly clicks: { readonly recent: number; readonly total: number };
}
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFLICT = "(utm_source, utm_medium, utm_campaign, utm_content, utm_term) WHERE retired_at IS NULL";
// Another live campaign with the same UTM values (NULLs equal, as the unique index treats them).
const SAME = "retired_at IS NULL AND utm_source IS NOT DISTINCT FROM $2 AND utm_medium IS NOT DISTINCT FROM $3 AND utm_campaign IS NOT DISTINCT FROM $4 AND utm_content IS NOT DISTINCT FROM $5 AND utm_term IS NOT DISTINCT FROM $6";

interface Row {
  id: string; utm_source: string; utm_medium: string; utm_campaign: string; utm_content: string | null; utm_term: string | null;
  investment: string; retired: boolean; recent: number; total: number;
}

export class PostgresCampaignsStore {
  readonly #pool: pg.Pool; readonly #owns: boolean;
  constructor(options: { connectionString?: string; pool?: pg.Pool } = {}) {
    this.#owns = !options.pool;
    this.#pool = options.pool ?? new pg.Pool({ connectionString: options.connectionString ?? databaseUrl() });
  }
  async close(): Promise<void> { if (this.#owns) await this.#pool.end(); }

  /** Every campaign with its clicks as of `day`; live first (by campaign name, then id), retired last. */
  async list(day: string, clickDays: number): Promise<readonly CampaignRecord[]> {
    const result = await this.#pool.query<Row>(
      `SELECT m.id, m.utm_source, m.utm_medium, m.utm_campaign, m.utm_content, m.utm_term,
              m.investment::text AS investment, (m.retired_at IS NOT NULL) AS retired,
              COALESCE((SELECT sum(c.clicks) FROM marketing_campaign_clicks c WHERE c.campaign_id = m.id AND c.day > $1::date - $2::int), 0)::int AS recent,
              COALESCE((SELECT sum(c.clicks) FROM marketing_campaign_clicks c WHERE c.campaign_id = m.id), 0)::int AS total
         FROM marketing_campaigns m
        ORDER BY (m.retired_at IS NOT NULL), m.utm_campaign, m.id`, [day, clickDays]);
    return result.rows.map(r => ({
      id: r.id, utmSource: r.utm_source, utmMedium: r.utm_medium, utmCampaign: r.utm_campaign, utmContent: r.utm_content, utmTerm: r.utm_term,
      investment: r.investment, retired: r.retired, clicks: { recent: r.recent, total: r.total },
    }));
  }

  async create(values: CampaignValues, by: string, at: Date): Promise<{ id: string } | { refused: "duplicate" }> {
    const result = await this.#pool.query<{ id: string }>(
      `INSERT INTO marketing_campaigns(id, utm_source, utm_medium, utm_campaign, utm_content, utm_term, investment, created_by_principal_id, created_at, updated_at)
         VALUES (gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7, $8, $8)
         ON CONFLICT ${CONFLICT} DO NOTHING RETURNING id`,
      [values.utmSource, values.utmMedium, values.utmCampaign, values.utmContent, values.utmTerm, values.investment, by, at]);
    return result.rowCount ? { id: result.rows[0]!.id } : { refused: "duplicate" };
  }

  async update(id: string, values: CampaignValues, at: Date): Promise<true | { refused: "unknown" | "retired" | "duplicate" }> {
    if (!UUID.test(id)) return { refused: "unknown" };
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN");
      const found = await c.query<{ retired: boolean }>("SELECT (retired_at IS NOT NULL) AS retired FROM marketing_campaigns WHERE id = $1 FOR UPDATE", [id]);
      if (!found.rowCount) { await c.query("ROLLBACK"); return { refused: "unknown" }; }
      if (found.rows[0]!.retired) { await c.query("ROLLBACK"); return { refused: "retired" }; }
      const clash = await c.query(`SELECT 1 FROM marketing_campaigns WHERE id <> $1 AND ${SAME}`,
        [id, values.utmSource, values.utmMedium, values.utmCampaign, values.utmContent, values.utmTerm]);
      if (clash.rowCount) { await c.query("ROLLBACK"); return { refused: "duplicate" }; }
      await c.query(
        `UPDATE marketing_campaigns SET utm_source = $2, utm_medium = $3, utm_campaign = $4, utm_content = $5, utm_term = $6, investment = $7, updated_at = $8 WHERE id = $1`,
        [id, values.utmSource, values.utmMedium, values.utmCampaign, values.utmContent, values.utmTerm, values.investment, at]);
      await c.query("COMMIT");
      return true;
    } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { c.release(); }
  }

  async retire(id: string, at: Date): Promise<true | { refused: "unknown" | "retired" }> {
    if (!UUID.test(id)) return { refused: "unknown" };
    const c = await this.#pool.connect();
    try {
      await c.query("BEGIN");
      const found = await c.query<{ retired: boolean }>("SELECT (retired_at IS NOT NULL) AS retired FROM marketing_campaigns WHERE id = $1 FOR UPDATE", [id]);
      if (!found.rowCount) { await c.query("ROLLBACK"); return { refused: "unknown" }; }
      if (found.rows[0]!.retired) { await c.query("ROLLBACK"); return { refused: "retired" }; }
      await c.query("UPDATE marketing_campaigns SET retired_at = $2, updated_at = $2 WHERE id = $1", [id, at]);
      await c.query("COMMIT");
      return true;
    } catch (error) { await c.query("ROLLBACK").catch(() => undefined); throw error; }
    finally { c.release(); }
  }
}
