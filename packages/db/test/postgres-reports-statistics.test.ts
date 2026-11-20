import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresMorningSummaryStore, PostgresStatisticsStore } from "@studenthub/db/reports";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresStatisticsStore;
let company: string, storeId: string, creator: string;
const DAY = "2026-11-20", NOW = new Date("2026-11-20T06:00:00Z");

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  store = new PostgresStatisticsStore({ pool });
  company = `st-co-${randomUUID()}`; storeId = randomUUID();
  await authz.upsertOrganization(createOrganization({ id: company, name: company }));
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Avenues',$3,$3)", [storeId, company, "a".repeat(64)]);
  creator = await principal("creator");
});
after(async () => pool.end());

async function principal(prefix: string): Promise<string> {
  const id = `st-${prefix}-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  return id;
}
const counts = () => store.staffCounts(DAY, NOW);
async function delta(key: string, act: () => Promise<unknown>): Promise<number> {
  const before = (await counts())[key]!; await act(); return (await counts())[key]! - before;
}
const request = async (status = "open", org = company, at = storeId) => {
  const id = randomUUID();
  await pool.query(`INSERT INTO recruit_requests(id,org_id,store_id,created_by_principal_id,position_title,description,compensation_text,position_type,headcount,status,close_reason)
    VALUES($1,$2,$3,$4,'Cashier','Front till','3 KWD an hour','part_time',1,$5,$6)`, [id, org, at, creator, status, status === "closed" ? "cancelled" : null]);
  return id;
};
const card = async (requestId: string, stage = "interviewing") => {
  const id = randomUUID();
  await pool.query("INSERT INTO recruit_pipeline_cards(id,request_id,person_principal_id,stage) VALUES($1,$2,$3,$4)", [id, requestId, await principal("candidate"), stage]);
  return id;
};
const interview = (cardId: string, at: string, status = "scheduled") => pool.query("INSERT INTO recruit_interviews(id,card_id,scheduled_at,duration_minutes,mode,status,closed_at) VALUES($1,$2,$3,30,'phone',$4,$5)",
  [randomUUID(), cardId, at, status, status === "scheduled" ? null : at]);
const assign = async (start: string, end: string | null) => {
  const person = await principal("worker"), id = randomUUID();
  await pool.query(`INSERT INTO work_assignments(id,person_principal_id,org_id,store_id,contract_resolution,start_date,end_date,source,created_by)
    VALUES($1,$2,$3,$4,'{}',$5,$6,'staff',$7)`, [id, person, company, storeId, start, end, creator]);
  return { id, person };
};

test("REPORTS_STATISTICS_PG answers every available counter, and the shared ones equal the morning summary's in the same snapshot", async () => {
  const raw = await counts();
  for (const key of ["workLogAppeals", "totalExpiredCards", "assignedExpiredCivilID", "id_need_generated", "activeRequests", "totalMinor", "companyUnderReview", "totalStoreAssignmentRequests", "totalInterviewRequests", "totalInterviewScheduled"])
    assert.ok(Number.isSafeInteger(raw[key]) && raw[key]! >= 0, key);
  const morning = await new PostgresMorningSummaryStore({ pool }).counts(DAY);
  for (const key of ["activeRequests", "assignedExpiredCivilID", "totalExpiredCards", "id_need_generated"]) assert.equal(raw[key], morning[key], key);
  await assert.rejects(store.staffCounts("20-11-2026", NOW), RangeError);
  await assert.rejects(store.hiring("nope"), RangeError);
});

test("REPORTS_STATISTICS_PG work log appeals count only the ones just submitted", async () => {
  const { id: assignment, person } = await assign("2020-01-01", "2020-01-31");
  let day = 0;
  const session = async () => {
    const id = randomUUID(), date = `2020-01-${String(++day).padStart(2, "0")}`;
    await pool.query(`INSERT INTO work_sessions(id,assignment_id,person_principal_id,org_id,store_id,work_date,started_at,ended_at,source,status,legacy_ref,legacy_digest)
      VALUES($1,$2,$3,$4,$5,$7::date,($7::date + time '06:00') AT TIME ZONE 'UTC',($7::date + time '10:00') AT TIME ZONE 'UTC','import','rejected',$6,repeat('a',64))`, [id, assignment, person, company, storeId, `legacy:session:${id}`, date]);
    return id;
  };
  const appeal = async (status: string) => pool.query("INSERT INTO work_appeals(id,session_id,person_principal_id,org_id,store_id,reason,status,legacy_ref) VALUES($1,$2,$3,$4,$5,'x',$6,$7)",
    [randomUUID(), await session(), person, company, storeId, status, `legacy:appeal:${randomUUID()}`]);
  assert.equal(await delta("workLogAppeals", async () => { await appeal("submitted"); await appeal("submitted"); }), 2);
  assert.equal(await delta("workLogAppeals", async () => { await appeal("awaiting_review"); await appeal("in_progress"); await appeal("resolved"); }), 0);
});

test("REPORTS_STATISTICS_PG minors are people whose birth date is less than 16 years before the Kuwait day", async () => {
  const born = async (date: string | null) => {
    const id = await principal("person");
    await pool.query("INSERT INTO person_profiles(principal_id,birth_date,birth_date_written_at) VALUES($1,$2::date,CASE WHEN $2::date IS NULL THEN NULL ELSE now() END)", [id, date]);
  };
  assert.equal(await delta("totalMinor", async () => { await born("2010-11-21"); await born("2015-01-01"); }), 2);
  assert.equal(await delta("totalMinor", async () => { await born("2010-11-20"); await born("1999-05-05"); await born(null); }), 0, "16 today, adults and no birth date are not minors");
});

test("REPORTS_STATISTICS_PG company registrations waiting for review are the pending ones", async () => {
  const register = async () => {
    const id = randomUUID();
    await pool.query(`INSERT INTO company_registrations(id,submitter_principal_id,company_name,contact_name,contact_position,phone_number,company_email,requesting_for)
      VALUES($1,$2,'Acme','Sara','Owner','96512345678','sara@example.invalid','Cashiers')`, [id, await principal("submitter")]);
    return id;
  };
  let rejected = "";
  assert.equal(await delta("companyUnderReview", async () => { await register(); rejected = await register(); }), 2);
  assert.equal(await delta("companyUnderReview", () => pool.query("UPDATE company_registrations SET status='rejected', reviewed_by=$2, reviewed_at=now(), review_reason='Not a company' WHERE id=$1", [rejected, creator])), -1);
});

test("REPORTS_STATISTICS_PG store assignment requests: pending ones, for KWD companies (no currency means KWD)", async () => {
  const ask = async (status: string, org = company, at = storeId) => pool.query(`INSERT INTO work_assignment_requests(id,person_principal_id,org_id,store_id,status,requested_by,requested_at,decided_by,decided_at)
    VALUES(gen_random_uuid(),$1,$2,$3,$4,$5,clock_timestamp(),$6,$7)`, [await principal("asker"), org, at, status, creator, status === "pending" ? null : creator, status === "pending" ? null : new Date()]);
  assert.equal(await delta("totalStoreAssignmentRequests", async () => { await ask("pending"); await ask("pending"); }), 2);
  assert.equal(await delta("totalStoreAssignmentRequests", async () => { await ask("accepted"); await ask("rejected"); await ask("cancelled"); }), 0);
  const usd = `st-usd-${randomUUID()}`, usdStore = randomUUID();
  await authz.upsertOrganization(createOrganization({ id: usd, name: usd }));
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Mall',$3,$3)", [usdStore, usd, "a".repeat(64)]);
  await pool.query("INSERT INTO organization_commercial_terms(org_id,field,value) VALUES($1,'currency_code','USD')", [usd]);
  assert.equal(await delta("totalStoreAssignmentRequests", () => ask("pending", usd, usdStore)), 0, "a USD company's request is not counted");
});

test("REPORTS_STATISTICS_PG interviews to schedule and upcoming interviews, on requests still open", async () => {
  const open = await request("open"), filling = await request("filling");
  assert.equal(await delta("totalInterviewRequests", async () => { await card(open); await card(filling); }), 2, "interviewing with no interview yet");
  assert.equal(await delta("totalInterviewRequests", async () => {
    await card(open, "suggested"); await card(await request("closed"));
    const cancelledOnly = await card(open); await interview(cancelledOnly, "2026-11-19T09:00:00Z", "cancelled");
  }), 1, "other stages and closed requests do not count; one with only a cancelled interview still needs one");
  let scheduled = "";
  assert.equal(await delta("totalInterviewScheduled", async () => {
    scheduled = await card(open); await interview(scheduled, "2026-11-20T06:00:01Z");
    await interview(await card(filling), "2026-12-01T09:00:00Z");
  }), 2);
  assert.equal(await delta("totalInterviewRequests", async () => { const c = await card(open); await interview(c, "2026-11-25T09:00:00Z"); }), 0, "a scheduled interview takes it off the list");
  assert.equal(await delta("totalInterviewScheduled", async () => {
    await interview(await card(open), "2026-11-20T06:00:00Z"); // not after now
    await interview(await card(open), "2026-11-21T09:00:00Z", "completed");
    const filled = await request("filling"); await interview(await card(filled), "2026-11-30T09:00:00Z"); await pool.query("UPDATE recruit_requests SET status='filled' WHERE id=$1", [filled]);
  }), 0, "past, completed and filled-request interviews are not upcoming");
});

test("REPORTS_STATISTICS_PG hiring: every assignment is a hire; retained once it has lasted more than 365 days, running ones counted to today", async () => {
  const before = await store.hiring(DAY), laterBefore = await store.hiring("2027-06-02");
  await assign("2024-01-01", "2025-01-01"); // 366 days: retained
  await assign("2024-01-01", "2024-12-31"); // 365 days: not
  await assign("2025-11-19", null); // running 366 days on DAY: retained
  await assign("2025-11-20", null); // running 365 days: not
  await assign("2026-01-01", "2027-06-01"); // ends later; so far 323 days: not
  const r = await request("open");
  for (let i = 0; i < 3; i++) await pool.query("INSERT INTO recruit_invitations(id,request_id,person_principal_id,invited_by_principal_id) VALUES($1,$2,$3,$4)", [randomUUID(), r, await principal("invitee"), creator]);
  const now = await store.hiring(DAY);
  assert.deepEqual({ hired: now.hired - before.hired, retained: now.retained - before.retained, invitations: now.invitations - before.invitations }, { hired: 5, retained: 2, invitations: 3 });
  assert.equal((await store.hiring("2027-06-02")).retained - laterBefore.retained, 4, "later on, the one still running and the one that ended in 2027 count too");
});
