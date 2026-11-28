import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresAccessPausesStore, PostgresPersonLifecycleStore } from "@studenthub/db/access";

// A-02 slice 1: staff warn and tag a person. Synthetic people only.
const URL = process.env.DATABASE_URL ?? "";
const OPS_ORG = `a02-ops-${randomUUID()}`;
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresPersonLifecycleStore;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  await authz.upsertOrganization(createOrganization({ id: OPS_ORG, name: "Operator" }));
  store = new PostgresPersonLifecycleStore({ pool, staffDecision: (rows) => rows.some((r) => (r.role === "staff" || r.role === "admin") && r.scope === "subtree" && r.org_id === OPS_ORG) });
});
after(async () => pool.end());

async function person(grants: { orgId: string; role: string; scope: "self" | "subtree" }[], displayName?: string) {
  const id = `a02-person-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid`, ...(displayName ? { displayName } : {}) }));
  await authz.grantMany(id, grants);
  return id;
}
async function setup() {
  const company = `a02-org-${randomUUID()}`;
  await authz.upsertOrganization(createOrganization({ id: company, name: "Sultan Co", parentOrgId: OPS_ORG }));
  const staff = await person([{ orgId: OPS_ORG, role: "staff", scope: "subtree" }], "Sara Staff");
  const admin = await person([{ orgId: OPS_ORG, role: "admin", scope: "subtree" }], "Adel Admin");
  const recruiter = await person([{ orgId: OPS_ORG, role: "recruiter", scope: "subtree" }]);
  const owner = await person([{ orgId: company, role: "org-owner", scope: "self" }]);
  const noor = await person([{ orgId: OPS_ORG, role: "candidate", scope: "self" }], "Noor");
  return { staff, admin, recruiter, owner, noor };
}
const outbox = async (key: string) => (await pool.query<{ class: string; recipient_principal_id: string; template_parameters: unknown }>(
  "SELECT class, recipient_principal_id, template_parameters FROM email_outbox WHERE idempotency_key = $1", [key])).rows;

test("A02_WARN staff warn a person; the person is emailed the title and message; the list is newest first", async () => {
  const s = await setup();
  const first = await store.warn(s.staff, s.noor, { title: "Not appearing for interview", message: "You missed the Avenues interview." });
  assert.equal(first.kind, "warned");
  const id = (first as { warningId: string }).warningId;
  assert.deepEqual(await outbox(`person.warning:${id}`), [{ class: "account.notice", recipient_principal_id: s.noor, template_parameters: { heading: "Not appearing for interview", message: "You missed the Avenues interview." } }], "one warning email to the person");
  const second = (await store.warn(s.admin, s.noor, { title: "Late twice", message: "Please arrive on time." }) as { warningId: string }).warningId;
  const read = (await store.read(s.staff, s.noor))!;
  assert.deepEqual(read.warnings.map((w) => [w.id, w.title, w.created_by_name, w.version, w.updated_at]), [[second, "Late twice", "Adel Admin", 1, null], [id, "Not appearing for interview", "Sara Staff", 1, null]], "newest first, with who warned");
  assert.deepEqual(read.tags, []);
});

test("A02_DENY only operator staff and admin read or write; others and an unknown person change nothing", async () => {
  const s = await setup();
  const before = (await pool.query<{ n: string }>("SELECT count(*) AS n FROM person_warnings WHERE principal_id = $1", [s.noor])).rows[0]!.n;
  for (const who of [s.recruiter, s.owner, s.noor]) {
    assert.equal(await store.read(who, s.noor), null, "no read for a recruiter, a company owner or the person");
    assert.deepEqual(await store.warn(who, s.noor, { title: "T", message: "M" }), { kind: "not_found" }, "no warning");
    assert.deepEqual(await store.addTag(who, s.noor, { tag: "late", reason: "r" }), { kind: "not_found" }, "no tag");
  }
  assert.equal((await pool.query<{ n: string }>("SELECT count(*) AS n FROM person_warnings WHERE principal_id = $1", [s.noor])).rows[0]!.n, before, "nothing written");
  assert.equal(await store.read(s.staff, `a02-missing-${randomUUID()}`), null, "an unknown person");
  assert.deepEqual(await store.warn(s.staff, `a02-missing-${randomUUID()}`, { title: "T", message: "M" }), { kind: "not_found" });
});

test("A02_CORRECT a correction keeps the replaced wording, sends no email and refuses a stale form or another person's warning", async () => {
  const s = await setup(), other = await setup();
  const id = (await store.warn(s.staff, s.noor, { title: "Late", message: "First wording" }) as { warningId: string }).warningId;
  assert.deepEqual(await store.correctWarning(s.admin, s.noor, id, { title: "Late arrival", message: "Second wording", expectedVersion: 1 }), { kind: "corrected", version: 2 });
  assert.deepEqual(await store.correctWarning(s.staff, s.noor, id, { title: "Old form", message: "x", expectedVersion: 1 }), { kind: "stale", version: 2 }, "a stale form is refused");
  assert.deepEqual(await store.correctWarning(s.staff, other.noor, id, { title: "x", message: "x", expectedVersion: 2 }), { kind: "not_found" }, "only the person's own warning");
  assert.deepEqual(await store.correctWarning(s.owner, s.noor, id, { title: "x", message: "x", expectedVersion: 2 }), { kind: "not_found" }, "only staff");
  const w = (await store.read(s.staff, s.noor))!.warnings[0]!;
  assert.deepEqual([w.title, w.message, w.version, w.updated_by_name, w.created_by_name], ["Late arrival", "Second wording", 2, "Adel Admin", "Sara Staff"]);
  assert.deepEqual((await pool.query("SELECT version, title, message FROM person_warning_edits WHERE warning_id = $1", [id])).rows, [{ version: 1, title: "Late", message: "First wording" }], "the replaced wording is kept");
  assert.equal((await pool.query("SELECT 1 FROM email_outbox WHERE idempotency_key LIKE $1", [`person.warning:${id}%`])).rowCount, 1, "a correction sends no second email");
  await assert.rejects(pool.query("DELETE FROM person_warnings WHERE id = $1", [id]), /never deleted/);
  await assert.rejects(pool.query("UPDATE person_warnings SET title = 'x' WHERE id = $1", [id]), /one version at a time/);
  await assert.rejects(pool.query("UPDATE person_warning_edits SET title = 'x' WHERE warning_id = $1", [id]), /kept as written/);
});

test("A02_TAGS staff add a tag with its reason and remove it; one live tag per value; a removed tag is kept", async () => {
  const s = await setup(), other = await setup();
  const late = (await store.addTag(s.staff, s.noor, { tag: "Late", reason: "Twice late in November" }) as { tagId: string }).tagId;
  assert.deepEqual(await store.addTag(s.admin, s.noor, { tag: "late", reason: "again" }), { kind: "duplicate" }, "one live tag per value, whatever its case");
  const star = (await store.addTag(s.admin, s.noor, { tag: "Star", reason: "Great reviews" }) as { tagId: string }).tagId;
  assert.deepEqual((await store.read(s.staff, s.noor))!.tags.map((t) => [t.id, t.tag, t.reason, t.created_by_name]), [[star, "Star", "Great reviews", "Adel Admin"], [late, "Late", "Twice late in November", "Sara Staff"]], "newest first, with the reason");
  assert.deepEqual(await store.removeTag(s.staff, other.noor, late), { kind: "not_found" }, "only the person's own tag");
  assert.deepEqual(await store.removeTag(s.owner, s.noor, late), { kind: "not_found" }, "only staff");
  assert.deepEqual(await store.removeTag(s.staff, s.noor, late), { kind: "removed" });
  assert.deepEqual(await store.removeTag(s.staff, s.noor, late), { kind: "not_found" }, "removed once");
  assert.deepEqual((await store.read(s.staff, s.noor))!.tags.map((t) => t.tag), ["Star"], "a removed tag leaves the list");
  assert.equal((await pool.query("SELECT removed_by FROM person_tags WHERE id = $1", [late])).rows[0]!.removed_by, s.staff, "the removed row is kept with who removed it");
  assert.equal((await store.addTag(s.staff, s.noor, { tag: "late", reason: "Late again" })).kind, "tagged", "a removed value can be tagged again");
  await assert.rejects(pool.query("DELETE FROM person_tags WHERE id = $1", [star]), /never deleted/);
  await assert.rejects(pool.query("UPDATE person_tags SET reason = 'x' WHERE id = $1", [star]), /removed, once/);
});

test("A02_LOCK a revocation in flight is waited for: the warning is refused once it commits", async () => {
  const s = await setup();
  const revoke = await pool.connect();
  try {
    await revoke.query("BEGIN");
    await revoke.query("DELETE FROM grants WHERE principal_id = $1", [s.staff]);
    let settled = false;
    const warning = store.warn(s.staff, s.noor, { title: "T", message: "M" }).finally(() => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 300));
    assert.equal(settled, false, "the grant re-check waits for the revocation");
    await revoke.query("COMMIT");
    assert.deepEqual(await warning, { kind: "not_found" }, "refused once the revocation commits");
    assert.equal((await pool.query("SELECT 1 FROM person_warnings WHERE principal_id = $1", [s.noor])).rowCount, 0, "nothing written");
  } finally {
    await revoke.query("ROLLBACK").catch(() => undefined);
    revoke.release();
  }
});

test("A02_CASCADE deleting the person's principal removes their warnings, edits and tags with it", async () => {
  const s = await setup();
  const id = (await store.warn(s.staff, s.noor, { title: "T", message: "M" }) as { warningId: string }).warningId;
  await store.correctWarning(s.staff, s.noor, id, { title: "T2", message: "M2", expectedVersion: 1 });
  await store.addTag(s.staff, s.noor, { tag: "x", reason: "y" });
  await pool.query("DELETE FROM email_outbox WHERE recipient_principal_id = $1", [s.noor]);
  await pool.query("DELETE FROM grants WHERE principal_id = $1", [s.noor]);
  await new PostgresAccessPausesStore({ pool }).close();
  await pool.query("DELETE FROM principals WHERE id = $1", [s.noor]);
  assert.equal((await pool.query("SELECT 1 FROM person_warnings WHERE principal_id = $1", [s.noor])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM person_warning_edits WHERE warning_id = $1", [id])).rowCount, 0);
  assert.equal((await pool.query("SELECT 1 FROM person_tags WHERE principal_id = $1", [s.noor])).rowCount, 0);
});
