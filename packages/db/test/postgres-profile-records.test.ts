import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import { PostgresProfileRecordStore, PostgresReferenceResolver, principalAuditRef, runMigrations } from "@studenthub/db";
import { ProfileRecordError, ProfileRecords, type StoredProfileRecord } from "@studenthub/profile-records";

const DB_URL = process.env.DATABASE_URL ?? "";
const P = "principal-candidate-p";
const Q = "principal-candidate-q";
const FIXED = new Date("2026-10-04T12:00:00.000Z");
let pool: pg.Pool;

before(async () => {
  if (!DB_URL) throw new Error("DATABASE_URL is required for PostgreSQL profile-record tests");
  pool = new pg.Pool({ connectionString: DB_URL });
  await runMigrations(pool);
});
beforeEach(async () => {
  // Owner administration for isolation; app paths cannot truncate the audit ledger.
  await pool.query("ALTER TABLE authorization_mutation_audit DISABLE TRIGGER authorization_mutation_audit_no_truncate");
  try {
    await pool.query("TRUNCATE authorization_mutation_audit, candidate_profile_records, catalogue_submissions, catalogue_items RESTART IDENTITY CASCADE");
  } finally {
    await pool.query("ALTER TABLE authorization_mutation_audit ENABLE TRIGGER authorization_mutation_audit_no_truncate");
  }
  await pool.query("DELETE FROM principals WHERE id = ANY($1)", [[P, Q]]);
  await pool.query("INSERT INTO principals (id) VALUES ($1), ($2)", [P, Q]);
});
after(async () => { await pool.end(); });

function service() {
  return new ProfileRecords(new PostgresProfileRecordStore(pool), new PostgresReferenceResolver(pool), () => FIXED);
}

async function catalogueItem(type: string, status: "active" | "deleted"): Promise<string> {
  const id = randomUUID();
  await pool.query(
    `INSERT INTO catalogue_items (id, catalogue_type, name, normalized_name, status, created_by_ref, updated_by_ref, created_at, updated_at, deleted_at)
     VALUES ($1, $2, $3, $3, $4, $5, $5, $6, $6, $7)`,
    [id, type, `Synthetic ${type} ${id.slice(0, 8)}`, status, "a".repeat(64), FIXED, status === "deleted" ? FIXED : null],
  );
  return id;
}

test("SHU144/PG-01 records persist across store instances, soft delete and restore keep values", async () => {
  const university = await catalogueItem("university", "active");
  const created = await service().create(P, "education", { educationType: "standard", universityId: university, graduationYear: 2026, currentlyStudying: false });
  await service().remove(P, "education", created.id);
  const { rows } = await pool.query("SELECT status, deleted_at FROM candidate_profile_records WHERE id = $1", [created.id]);
  assert.equal(rows.length, 1, "removal must not physically delete the row");
  assert.equal(rows[0].status, "deleted");
  const restored = await service().restore(P, "education", created.id);
  assert.deepEqual(restored.fields, created.fields);
  assert.deepEqual((await service().background(P)).education.map((row) => row.id), [created.id]);
});

test("SHU144/PG-02 another owner gets not_found and changes zero rows", async () => {
  const created = await service().create(P, "experience", { title: "Cashier", employer: "Synthetic Store", startYear: 2023 });
  const before = (await pool.query("SELECT * FROM candidate_profile_records ORDER BY id")).rows;
  const auditBefore = (await pool.query("SELECT count(*)::int AS n FROM authorization_mutation_audit")).rows[0].n;
  for (const attempt of [
    () => service().update(Q, "experience", created.id, { title: "x", employer: "y", startYear: 2020 }),
    () => service().remove(Q, "experience", created.id),
    () => service().restore(Q, "experience", created.id),
  ]) {
    await assert.rejects(attempt(), (error: unknown) => error instanceof ProfileRecordError && error.code === "not_found");
  }
  assert.deepEqual((await pool.query("SELECT * FROM candidate_profile_records ORDER BY id")).rows, before);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM authorization_mutation_audit")).rows[0].n, auditBefore);
  assert.equal((await service().background(Q)).experience.length, 0);
});

test("SHU144/PG-03 a failed audit insert rolls back the mutation in the same transaction", async () => {
  const store = new PostgresProfileRecordStore(pool);
  const record: StoredProfileRecord = { id: randomUUID(), ownerId: P, kind: "skill", status: "active", fields: { name: "Excel" }, createdAt: FIXED.toISOString(), updatedAt: FIXED.toISOString() };
  await assert.rejects(store.transaction(async (tx) => {
    await tx.insert(record);
    // A negative count violates the closed audit shape, so the database refuses the audit row.
    await tx.audit({ operation: "profile_record.create", ownerId: P, kind: "skill", activeBefore: 0, activeAfter: -1 });
  }));
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM candidate_profile_records")).rows[0].n, 0);
});

test("SHU144/PG-04 audit rows hold hashed owner refs and closed summaries only", async () => {
  const link = await service().create(P, "link", { title: "Private portfolio", url: "https://example.invalid/private" });
  await service().remove(P, "link", link.id);
  const { rows } = await pool.query("SELECT operation, actor_principal_ref, target_principal_ref, target_org_refs, before_summary, after_summary FROM authorization_mutation_audit ORDER BY id");
  assert.deepEqual(rows.map((row) => row.operation), ["profile_record.create", "profile_record.remove"]);
  for (const row of rows) {
    assert.equal(row.actor_principal_ref, principalAuditRef(P));
    assert.equal(row.target_principal_ref, principalAuditRef(P));
    assert.deepEqual(row.target_org_refs, []);
    assert.doesNotMatch(JSON.stringify(row), /Private|example\.invalid|principal-candidate/);
  }
  assert.deepEqual(rows[1].before_summary, { kind: "link", activeCount: 1 });
  assert.deepEqual(rows[1].after_summary, { kind: "link", activeCount: 0 });
  await assert.rejects(pool.query(
    `INSERT INTO authorization_mutation_audit (request_ref, actor_principal_ref, operation, target_principal_ref, before_summary, after_summary)
     VALUES ($1, $1, 'profile_record.create', $1, '{"kind":"link","activeCount":0,"title":"x"}', '{"kind":"link","activeCount":1}')`,
    ["c".repeat(64)],
  ), /auth_audit_before_summary_shape/);
});

test("SHU144/PG-05 deleted catalogue entries are refused for new education", async () => {
  const university = await catalogueItem("university", "active");
  const deletedMajor = await catalogueItem("major", "deleted");
  await assert.rejects(
    service().create(P, "education", { educationType: "standard", universityId: university, majorId: deletedMajor, currentlyStudying: true }),
    (error: unknown) => error instanceof ProfileRecordError && error.code === "invalid_major",
  );
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM candidate_profile_records")).rows[0].n, 0);
});

test("SHU144/PG-06 concurrent skill writes for one owner cannot create a duplicate", async () => {
  const results = await Promise.allSettled([
    service().create(P, "skill", { name: "Excel" }),
    service().create(P, "skill", { name: "excel" }),
  ]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM candidate_profile_records WHERE status = 'active'")).rows[0].n, 1);
});
