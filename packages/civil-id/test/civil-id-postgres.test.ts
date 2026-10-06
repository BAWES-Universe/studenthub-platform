import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { CIVIL_ID_FIXTURES as f, civilIdFixture } from "../src/fixtures.js";
import { CivilIdError } from "../src/format.js";
import { isCivilIdValidOn } from "../src/expiry-gate.js";
import { PostgresCivilIdStore } from "../src/postgres-civil-id-store.js";
import { confirmCivilId, listCivilIdReviewQueue, runCivilIdOcrJob, setOwnCivilId } from "../src/verification.js";

// Dedicated scratch DATABASE_URL is mandatory, exactly as for the authz suite.
// Each run owns a random schema, including during mutation runs. No public-table cleanup.
const schema = `civil_id_test_${randomUUID().replaceAll("-", "")}`;
let admin: pg.Pool | undefined;
let pool: pg.Pool;
let store: PostgresCivilIdStore;
before(async () => {
  assert.ok(process.env.DATABASE_URL, "DATABASE_URL must point to scratch PostgreSQL 16/17");
  admin = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await admin.query(`CREATE SCHEMA ${schema}`);
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL, options: `-c search_path=${schema}`, max: 8 });
  await runMigrations(pool);
  store = new PostgresCivilIdStore(pool);
});
beforeEach(async () => {
  await pool.query("ALTER TABLE civil_id_verification_audit DISABLE TRIGGER civil_id_audit_no_truncate");
  try { await pool.query("TRUNCATE candidate_civil_id, civil_id_ocr_job, civil_id_verification_audit RESTART IDENTITY"); }
  finally { await pool.query("ALTER TABLE civil_id_verification_audit ENABLE TRIGGER civil_id_audit_no_truncate"); }
});
after(async () => {
  if (pool) await pool.end();
  if (admin) {
    try { await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`); }
    finally { await admin.end(); }
  }
});
const identity = (principalId: string) => ({ kind: "principal" as const, principalId });
const input = (person = f.P as string, number = f.number as string) => ({ identity: identity(person),
  countryCode: "KW", civilIdNumber: number, expiryDate: f.expiryDate });
const request = (jobId = "job-1", candidateRef = f.P as string) => ({ jobId, candidateRef, frontImage: new Uint8Array([0]) });
const ocr = (civilIdNumber = f.number as string, expiryDate = f.expiryDate as string) => ({
  readCivilId: async () => ({ countryCode: "KW", civilIdNumber, expiryDate }),
});
async function counts() {
  const { rows } = await pool.query(`SELECT
    (SELECT count(*)::int FROM candidate_civil_id) AS ids,
    (SELECT count(*)::int FROM civil_id_ocr_job) AS jobs,
    (SELECT count(*)::int FROM civil_id_verification_audit) AS audits`);
  return rows[0];
}
async function refused(work: Promise<unknown>, code: string) {
  await assert.rejects(work, (error: unknown) => error instanceof CivilIdError && error.code === code
    && error.message === code && error.cause === undefined);
}

test("SHU-146/parity-contract", async () => {
  const deps = await civilIdFixture(store);
  const first = await runCivilIdOcrJob(request(), { ...deps, ocr: ocr() });
  assert.equal(first.job.status, "succeeded");
  assert.equal(first.job.expired, false);
  assert.equal(first.job.timeZone, "Asia/Kuwait");
  // New adapter instance reads persisted state, not process-local dedupe.
  const restarted = { ...deps, store: new PostgresCivilIdStore(pool) };
  let retry!: Awaited<ReturnType<typeof runCivilIdOcrJob>>;
  await assert.doesNotReject(async () => {
    retry = await runCivilIdOcrJob(request(), { ...restarted, ocr: ocr() });
  });
  assert.equal(retry.kind, "already_processed");
  assert.deepEqual(retry.job, first.job);
  assert.deepEqual(await counts(), { ids: 1, jobs: 1, audits: 1 });
  const queue = await listCivilIdReviewQueue(identity(f.S), restarted);
  assert.equal(queue.length, 1);
  assert.equal(queue[0].needVerification, true);
  assert.equal(queue[0].source, "ocr");
  assert.equal(queue[0].civilIdNumber, f.number);
  assert.equal(isCivilIdValidOn(queue[0].expiryDate, new Date("2026-10-05T20:59:59Z"), first.job.timeZone), true);
  assert.equal(isCivilIdValidOn(queue[0].expiryDate, new Date("2026-10-05T21:00:00Z"), first.job.timeZone), false);
  // Prove the index itself protects bypass writers. Catch the expected violation
  // inside PostgreSQL so test diagnostics do not print a private number.
  const probe = await pool.connect();
  try {
    await probe.query("BEGIN");
    await probe.query(`CREATE FUNCTION test_civil_id_unique_guard() RETURNS boolean LANGUAGE plpgsql AS $$
      BEGIN
        INSERT INTO candidate_civil_id
          (candidate_ref, civil_id_number, country_code, expiry_date, need_verification, source,
           candidate_deleted, revision, created_at, updated_at)
        SELECT 'synthetic-index-probe', civil_id_number, country_code, expiry_date, TRUE, 'manual',
          FALSE, 1, created_at, updated_at FROM candidate_civil_id LIMIT 1;
        RETURN FALSE;
      EXCEPTION WHEN unique_violation THEN RETURN TRUE;
      END; $$`);
    const guard = await probe.query("SELECT test_civil_id_unique_guard() AS guarded");
    assert.equal(guard.rows[0].guarded, true);
  } finally {
    try { await probe.query("ROLLBACK"); } finally { probe.release(); }
  }
  const duplicate = await runCivilIdOcrJob(request("duplicate", f.Q), { ...deps, ocr: ocr() });
  assert.equal(duplicate.job.code, "civil_id_duplicate");
  assert.equal(duplicate.job.status, "failed");
  assert.deepEqual(await counts(), { ids: 1, jobs: 2, audits: 2 });
  await refused(setOwnCivilId(input(f.Q), deps), "civil_id_duplicate");
  // Fixture-only stand-in for S9's lifecycle write; S9 will own its audit.
  await pool.query("UPDATE candidate_civil_id SET candidate_deleted = TRUE WHERE candidate_ref = $1", [f.P]);
  await assert.doesNotReject(setOwnCivilId(input(f.Q), deps));
  assert.deepEqual((await listCivilIdReviewQueue(identity(f.S), deps)).map((row) => row.candidateRef), [f.Q]);
  const expired = await runCivilIdOcrJob(request("expired", f.Q), { ...deps, ocr: ocr(f.number, "2026-10-04") });
  assert.equal(expired.job.expired, true);
  assert.equal(expired.job.status, "succeeded");
  const row = await store.transaction({}, (tx) => tx.read(f.Q));
  assert.equal(row?.needVerification, true);
  assert.equal(isCivilIdValidOn(row?.expiryDate, deps.now()), false);
  const audit = JSON.stringify((await pool.query("SELECT * FROM civil_id_verification_audit")).rows);
  for (const value of [f.number, f.otherNumber, f.P, f.Q, f.S]) assert.ok(!audit.includes(value), "audit leaked private input");
});

test("SHU-146 PostgreSQL concurrent dedupe and uniqueness", async () => {
  const deps = await civilIdFixture(store);
  let calls = 0;
  const port = { readCivilId: async () => { calls++; return ocr().readCivilId(); } };
  const results = await Promise.all(Array.from({ length: 4 }, () => runCivilIdOcrJob(request(), { ...deps, ocr: port })));
  assert.equal(results.filter((r) => r.kind === "processed").length, 1);
  assert.equal(calls, 1);
  assert.deepEqual(await counts(), { ids: 1, jobs: 1, audits: 1 });
  await refused(runCivilIdOcrJob(request("job-1", f.Q), { ...deps, ocr: port }), "civil_id_request_invalid");
  // Two different candidates racing for a NEW number must serialize and refuse one claim.
  const outcomes = await Promise.allSettled([setOwnCivilId(input(f.P, f.otherNumber), deps), setOwnCivilId(input(f.Q, f.otherNumber), deps)]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
  const rejected = outcomes.find((r) => r.status === "rejected") as PromiseRejectedResult;
  assert.equal(rejected.reason.code, "civil_id_duplicate");
  assert.equal(rejected.reason.message, "civil_id_duplicate");
  assert.ok(!JSON.stringify(rejected.reason).includes(f.otherNumber));
});

test("SHU-146 PostgreSQL audit failure rolls back row and job", async () => {
  const deps = await civilIdFixture(store);
  await pool.query(`CREATE FUNCTION fail_civil_id_audit() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN RAISE EXCEPTION 'synthetic_audit_failure'; END; $$;
    CREATE TRIGGER fail_civil_id_audit BEFORE INSERT ON civil_id_verification_audit
      FOR EACH ROW EXECUTE FUNCTION fail_civil_id_audit()`);
  try {
    await refused(runCivilIdOcrJob(request(), { ...deps, ocr: ocr() }), "civil_id_unavailable");
    assert.deepEqual(await counts(), { ids: 0, jobs: 0, audits: 0 });
    await refused(setOwnCivilId(input(), deps), "civil_id_unavailable");
    assert.deepEqual(await counts(), { ids: 0, jobs: 0, audits: 0 });
  } finally {
    await pool.query("DROP TRIGGER fail_civil_id_audit ON civil_id_verification_audit; DROP FUNCTION fail_civil_id_audit()");
  }
  assert.equal((await runCivilIdOcrJob(request(), { ...deps, ocr: ocr() })).job.status, "succeeded");
});

test("SHU-146 PostgreSQL failed OCR, staff review, revocation and stale review", async () => {
  const deps = await civilIdFixture(store);
  await setOwnCivilId(input(), deps);
  const row = await store.transaction({}, (tx) => tx.read(f.P));
  const failed = await runCivilIdOcrJob(request(), { ...deps, ocr: { readCivilId: async () => { throw new Error(f.number); } } });
  assert.equal(failed.job.code, "civil_id_ocr_failed");
  assert.deepEqual(await store.transaction({}, (tx) => tx.read(f.P)), row);
  const unreadable = await runCivilIdOcrJob(request("unreadable"), { ...deps, ocr: { readCivilId: async () => null } });
  assert.equal(unreadable.job.code, "civil_id_ocr_unreadable");
  for (const person of [f.P, f.Q, f.U, "self-staff"]) {
    await refused(confirmCivilId({ identity: identity(person), candidateRef: f.P, expectedRevision: 1 }, deps), "not_found");
    await refused(listCivilIdReviewQueue(identity(person), deps), "not_found");
  }
  await confirmCivilId({ identity: identity(f.S), candidateRef: f.P, expectedRevision: 1 }, deps);
  assert.equal((await store.transaction({}, (tx) => tx.read(f.P)))?.needVerification, false);
  await setOwnCivilId(input(), deps);
  await refused(confirmCivilId({ identity: identity(f.S), candidateRef: f.P, expectedRevision: 1 }, deps), "civil_id_review_changed");
  await deps.authz.clearGrantsForPrincipal(f.S);
  await refused(confirmCivilId({ identity: identity(f.S), candidateRef: f.P, expectedRevision: 3 }, deps), "not_found");
  assert.equal((await store.transaction({}, (tx) => tx.read(f.P)))?.needVerification, true);
});

test("SHU-146 PostgreSQL ledger is append-only and hashes actors", async () => {
  const deps = await civilIdFixture(store);
  await setOwnCivilId(input(), deps);
  const { rows } = await pool.query("SELECT * FROM civil_id_verification_audit");
  assert.match(rows[0].actor_ref, /^[0-9a-f]{64}$/);
  assert.notEqual(rows[0].actor_ref, f.P);
  for (const sql of ["DELETE FROM civil_id_verification_audit", "UPDATE civil_id_verification_audit SET operation = 'confirm'", "TRUNCATE civil_id_verification_audit"]) {
    await assert.rejects(pool.query(sql), (error: unknown) => typeof error === "object" && error !== null && "code" in error && error.code === "55000");
  }
  assert.equal((await counts()).audits, 1);
});
