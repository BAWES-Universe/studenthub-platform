// Cutover lane M-3 (SHU-157, I8): the identity link report for staff follow-up. Q14-L gives each
// person a self-service link and staff a manual one; this lists, by legacy candidate id only,
// the records that still need a person to look at them:
//
// - link.unlinked: an imported candidate (legacy_candidate_snapshots) that no principal is linked
//   to yet (legacy_account_links);
// - link.notImported: a link to a candidate the import does not carry (archived or quarantined in
//   legacy, or not imported yet), so the person sees no imported profile;
// - link.multiplyOffered: a candidate that has been linked to more than one principal over time
//   (legacy_account_link_events), for example linked, unlinked, then linked to someone else;
// - link.contactTaken: a promoted person whose staged phone, handle or civil ID another person
//   already holds (legacy_contact_promotions, outcome taken);
// - link.emailMismatch: a promoted person whose current address does not hash to the candidate's
//   verified legacy address, or changed under the promotion (outcome mismatch or addressChanged).
//   A candidate promoted for more than one principal over time (relinked) is listed once.
//
// Links are keyed by principal and legacy id, never by email. The report reads only ids and
// outcome codes: no name, contact value, digest, address or principal id leaves this module.
// Everything is read in one read-only, repeatable-read transaction, so the lists and totals
// describe one moment. It writes nothing.

import type { Pool as PgPool } from "pg";

export const LINK_REPORT_RULES = ["link.unlinked", "link.notImported", "link.multiplyOffered", "link.contactTaken", "link.emailMismatch"] as const;
export type LinkReportRule = (typeof LINK_REPORT_RULES)[number];

export interface LinkReport {
  /** Imported candidates (snapshots). */
  readonly imported: number;
  /** Imported candidates with a link. */
  readonly linked: number;
  /** Legacy candidate ids per rule, in numeric order, each id at most once per rule. */
  readonly ids: { readonly [R in LinkReportRule]: readonly string[] };
}

const LEGACY_ID = /^[1-9][0-9]{0,17}$/;
/** Numeric order for digit strings without a leading zero. */
const ORDER = "ORDER BY length(legacy_candidate_id), legacy_candidate_id COLLATE \"C\"";

const QUERIES: { readonly [R in LinkReportRule]: string } = {
  "link.unlinked": `SELECT s.legacy_candidate_id AS id FROM legacy_candidate_snapshots s
    WHERE NOT EXISTS (SELECT 1 FROM legacy_account_links l WHERE l.legacy_candidate_id = s.legacy_candidate_id) ${ORDER}`,
  "link.notImported": `SELECT l.legacy_candidate_id AS id FROM legacy_account_links l
    WHERE NOT EXISTS (SELECT 1 FROM legacy_candidate_snapshots s WHERE s.legacy_candidate_id = l.legacy_candidate_id) ${ORDER}`,
  "link.multiplyOffered": `SELECT legacy_candidate_id AS id FROM legacy_account_link_events WHERE kind = 'linked'
    GROUP BY legacy_candidate_id HAVING count(DISTINCT principal_id) > 1 ${ORDER}`,
  "link.contactTaken": `SELECT legacy_candidate_id AS id FROM legacy_contact_promotions
    WHERE 'taken' IN (phone, handle, civil_id) GROUP BY legacy_candidate_id ${ORDER}`,
  "link.emailMismatch": `SELECT legacy_candidate_id AS id FROM legacy_contact_promotions
    WHERE email IN ('mismatch', 'addressChanged') GROUP BY legacy_candidate_id ${ORDER}`,
};

const TOTALS = `SELECT (SELECT count(*) FROM legacy_candidate_snapshots)::int AS imported,
  (SELECT count(*) FROM legacy_candidate_snapshots s
    WHERE EXISTS (SELECT 1 FROM legacy_account_links l WHERE l.legacy_candidate_id = s.legacy_candidate_id))::int AS linked`;

/** Thrown for any failure, with a fixed code only: a database error could carry values. */
export class LinkReportError extends Error {
  readonly code = "m3.link.reportFailed";
  constructor() { super("m3.link.reportFailed"); this.name = "LinkReportError"; }
}

/** Reads the report in one read-only snapshot. Ids that are not plain legacy ids fail the read. */
export async function readLinkReport(pool: PgPool): Promise<LinkReport> {
  let client;
  try { client = await pool.connect(); } catch { throw new LinkReportError(); }
  let broken = false;
  try {
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    const { rows: [totals] } = await client.query<{ imported: number; linked: number }>(TOTALS);
    const ids = {} as { [R in LinkReportRule]: string[] };
    for (const rule of LINK_REPORT_RULES) {
      const { rows } = await client.query<{ id: string }>(QUERIES[rule]);
      const list = rows.map((r) => r.id);
      if (!list.every((id) => typeof id === "string" && LEGACY_ID.test(id)) || new Set(list).size !== list.length) throw new LinkReportError();
      ids[rule] = list;
    }
    await client.query("COMMIT");
    if (!totals || !Number.isInteger(totals.imported) || !Number.isInteger(totals.linked)) throw new LinkReportError();
    return { imported: totals.imported, linked: totals.linked, ids };
  } catch {
    try { await client.query("ROLLBACK"); } catch { broken = true; }
    throw new LinkReportError();
  } finally {
    client.release(broken);
  }
}

/** Counts per rule, for a receipt that must carry no id. */
export function linkReportCounts(report: LinkReport): { imported: number; linked: number; rules: Record<LinkReportRule, number> } {
  const rules = {} as Record<LinkReportRule, number>;
  for (const rule of LINK_REPORT_RULES) rules[rule] = report.ids[rule].length;
  return { imported: report.imported, linked: report.linked, rules };
}
