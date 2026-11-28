// M-5 candidate hours against PostgreSQL: the link and store lookups the importer runs, and the run
// through the work lane's real import store. Synthetic principals, stores and rows only.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PostgresWorkImportStore } from "@studenthub/db/work";
import { postgresTarget } from "../../../tools/legacy-import/src/m4-cli.js";
import { candidateLookupIds, placementRef, planCandidateWork, runCandidateWork, type M5CandidateSources } from "../../../tools/legacy-import/src/m5-candidate.js";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
});
after(async () => pool.end());

/** A company with one store, mapped from a legacy store id the way M-4 maps it. */
async function mappedStore(legacyStoreId: string) {
  const org = (await pool.query("INSERT INTO organizations (id, name) VALUES ($1, 'Synthetic company') RETURNING id", [`m5c-org-${randomUUID()}`])).rows[0].id as string;
  const store = randomUUID();
  await pool.query("INSERT INTO organization_stores (id, org_id, name, created_by_ref, updated_by_ref) VALUES ($1, $2, 'Synthetic store', $3, $3)", [store, org, "a".repeat(64)]);
  await pool.query("INSERT INTO legacy_id_maps (legacy_table, legacy_id, entity, platform_id, outcome, digest) VALUES ('store', $1, 'store', $2, 'imported', $3)",
    [legacyStoreId, store, "b".repeat(64)]);
  return { org, store };
}
/** A principal linked to a legacy candidate id, as a sign-in link leaves it. */
async function linked(legacyCandidateId: string) {
  const id = `m5c-person-${randomUUID()}`;
  await pool.query("INSERT INTO principals (id) VALUES ($1)", [id]);
  await pool.query("INSERT INTO legacy_account_links (principal_id, legacy_candidate_id, linked_by_ref, method) VALUES ($1, $2, $3, 'legacy_login')", [id, legacyCandidateId, "c".repeat(64)]);
  return id;
}

test("CAND_M5_PG_RUN the lookups and the run through the real store: placements, sessions, decisions, a re-run unchanged, an unlinked candidate skipped", async () => {
  const target = postgresTarget(URL, "a".repeat(64), "root", null);
  const store = new PostgresWorkImportStore(pool);
  try {
    // Legacy ids unique to this run: links and the store map are keyed by them database-wide.
    const base = Date.now() * 10;
    const cand = String(base), ghost = String(base + 1), legacyStore = String(base + 2), unmapped = String(base + 3);
    const { org, store: storeId } = await mappedStore(legacyStore);
    const person = await linked(cand);
    const tag = randomUUID().slice(0, 8);
    const hour = (uuid: string, candidate: string, s: string, day: string, status: number) => ({
      candidate_working_hour_uuid: uuid, candidate_id: candidate, store_id: s, date: day, start_time: `${day} 09:00:00`, end_time: `${day} 10:00:00`,
      total_time: 3600, start_location_lat: "29.3", start_location_long: "47.9", end_location_lat: "29.3", end_location_long: "47.9", note: null, status, via: "App",
    });
    const sources = {
      candidate: [{ candidate_id: cand, store_id: legacyStore, deleted: 0 }, { candidate_id: ghost, store_id: legacyStore, deleted: 0 }],
      candidate_working_hour: [hour(`${tag}-1`, cand, legacyStore, "2026-11-01", 1), hour(`${tag}-2`, cand, legacyStore, "2026-11-02", 2),
        hour(`${tag}-3`, ghost, legacyStore, "2026-11-01", 1), hour(`${tag}-4`, cand, unmapped, "2026-10-20", 1)],
      candidate_work_log_feedback: [{ cwlf_uuid: `${tag}-f`, candidate_id: cand, store_id: legacyStore, date: "2026-11-01", candidate_working_hour_uuid: `${tag}-1`,
        status: 1, note: null, reason: null, is_public: 0, rating: 4, created_by: 9, created_at: "2026-11-01 12:00:00" }],
      candidate_working_date: [],
    } as unknown as M5CandidateSources;

    const ids = candidateLookupIds(sources);
    const links = await target.candidateLinks()(ids.candidates);
    const stores = await target.storeMap()(ids.stores);
    assert.deepEqual(Object.fromEntries(links), { [cand]: person });
    assert.deepEqual(Object.fromEntries(stores), { [legacyStore]: { storeId, orgId: org } });

    const plan = planCandidateWork(sources, links, stores);
    const first = await runCandidateWork(store, plan);
    assert.deepEqual([first.tables.work_assignments.inserted, first.tables.work_sessions.inserted, first.tables.work_decisions.inserted], [1, 2, 1]);
    assert.deepEqual(first.refs.work_sessions.issues, { no_person: [`cwh:${tag}-3`], no_store: [`cwh:${tag}-4`] });
    assert.ok(![`cwh:${tag}-3`, `cwh:${tag}-4`].some((r) => first.refs.work_sessions.missing.includes(r)), "reported rows are skipped, not missing");

    const placement = (await pool.query("SELECT person_principal_id, org_id, store_id::text, to_char(start_date,'YYYY-MM-DD') AS start_date, end_date, source FROM work_assignments WHERE legacy_ref = $1",
      [placementRef(cand, legacyStore, "2026-11-01")])).rows[0];
    assert.deepEqual(placement, { person_principal_id: person, org_id: org, store_id: storeId, start_date: "2026-11-01", end_date: null, source: "import" },
      "the current store stays open where the hours end");
    const session = (await pool.query("SELECT status, decision_id IS NOT NULL AS decided FROM work_sessions WHERE legacy_ref = $1", [`cwh:${tag}-1`])).rows[0];
    assert.deepEqual(session, { status: "approved", decided: true }, "the imported decision is linked to its session");

    const again = await runCandidateWork(store, plan);
    assert.deepEqual([again.tables.work_assignments.unchanged, again.tables.work_sessions.unchanged, again.tables.work_decisions.unchanged], [1, 2, 1]);
    assert.deepEqual([again.tables.work_sessions.inserted, again.tables.work_sessions.conflicts], [0, 0]);
  } finally { await target.close(); }
});
