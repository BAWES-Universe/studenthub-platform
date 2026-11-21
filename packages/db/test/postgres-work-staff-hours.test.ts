import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { DEFAULT_STAFF_HOURS_PER_DAY, PostgresWorkImportStore, PostgresWorkStaffTimeStore } from "@studenthub/db/work";
import { mapLegacyStaffHours } from "../../work/src/index.js";

// Staff hours per day (0509): legacy `staff.hours_per_day` imported per principal, read by the
// staff hours export. Synthetic rows only.
const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, imports: PostgresWorkImportStore, time: PostgresWorkStaffTimeStore;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  imports = new PostgresWorkImportStore(pool);
  time = new PostgresWorkStaffTimeStore(pool);
});
after(async () => pool.end());

async function principal() {
  const id = `staff-hours-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  return id;
}
const empty = { inserted: 0, unchanged: 0, updated: 0, conflicts: [], refused: [] };
/** A fresh legacy staff id, so runs never share refs. */
const legacyId = () => String(1 + Math.floor(Math.random() * 1e12));
const row = (staffPrincipalId: string, hours: number, id = legacyId()) => {
  const mapped = mapLegacyStaffHours({ staff_id: id, hours_per_day: hours }).hours!;
  return { legacyRef: mapped.legacyRef, staffPrincipalId, hours: mapped.hours };
};

test("STAFF_HOURS_PG imported once per principal; a replay is unchanged and a changed number is a conflict, never overwritten", async () => {
  const [a, b] = [await principal(), await principal()];
  const ra = row(a, 6), rb = row(b, 0);
  assert.deepEqual(await imports.importStaffHours([ra, rb]), { ...empty, inserted: 2 });
  assert.deepEqual(await imports.importStaffHours([ra, rb]), { ...empty, unchanged: 2 });
  // Legacy changed the number: reported with both digests, the stored one stays.
  const legacyEdit = await imports.importStaffHours([{ ...ra, hours: 9 }]);
  assert.equal(legacyEdit.conflicts.length, 1);
  assert.notEqual(legacyEdit.conflicts[0]!.existingDigest, legacyEdit.conflicts[0]!.incomingDigest);
  // Changed here since: the replay of the same legacy row is a conflict too, not unchanged, and nothing is reset.
  await pool.query("UPDATE work_staff_hours_per_day SET hours = 7 WHERE staff_principal_id = $1", [a]);
  const localEdit = await imports.importStaffHours([ra]);
  assert.deepEqual([localEdit.unchanged, localEdit.conflicts.map((c) => c.legacyRef)], [0, [ra.legacyRef]]);
  assert.deepEqual(Object.fromEntries(await time.hoursPerDay([a, b])), { [a]: 7, [b]: 0 });
});

test("STAFF_HOURS_PG a second legacy record for one person, a bad number or bad ref is refused and the batch goes on", async () => {
  const [a, b, c] = [await principal(), await principal(), await principal()];
  const first = row(a, 8), twin = row(a, 4), half = { ...row(b, 8), hours: 7.5 }, over = { ...row(b, 8), hours: 25 }, ok = row(c, 5);
  const result = await imports.importStaffHours([first, twin, half, over, { ...row(c, 5), legacyRef: "bad ref" }, ok]);
  assert.deepEqual(result, { ...empty, inserted: 2, refused: [{ legacyRef: "bad ref", code: "invalid" }, { legacyRef: twin.legacyRef, code: "invalid" },
    { legacyRef: half.legacyRef, code: "invalid" }, { legacyRef: over.legacyRef, code: "invalid" }] });
  // Smallint would round 7.5 to 8: the half hour is refused before it is written.
  assert.deepEqual(Object.fromEntries(await time.hoursPerDay([a, b, c])), { [a]: 8, [b]: DEFAULT_STAFF_HOURS_PER_DAY, [c]: 5 });
  assert.equal((await pool.query("SELECT 1 FROM work_staff_hours_per_day WHERE staff_principal_id = $1", [b])).rowCount, 0);
});

test("STAFF_HOURS_PG the table holds whole hours 0 to 24, an import carries its digest, and who and where a row came from never change", async () => {
  const [a, b] = [await principal(), await principal()];
  const ra = row(a, 8);
  await imports.importStaffHours([ra]);
  await assert.rejects(pool.query("INSERT INTO work_staff_hours_per_day(staff_principal_id, hours, legacy_ref) VALUES($1, 8, $2)", [b, `staff:${legacyId()}`]), { code: "23514" });
  await assert.rejects(pool.query("INSERT INTO work_staff_hours_per_day(staff_principal_id, hours) VALUES($1, 25)", [b]), { code: "23514" });
  await assert.rejects(pool.query("INSERT INTO work_staff_hours_per_day(staff_principal_id, hours, legacy_digest) VALUES($1, 8, repeat('a', 64))", [b]), { code: "23514" });
  for (const set of [`staff_principal_id = '${b}'`, "legacy_ref = 'staff:1'", "legacy_digest = repeat('b', 64)", "created_at = now() - interval '1 day'"]) {
    await assert.rejects(pool.query(`UPDATE work_staff_hours_per_day SET ${set} WHERE staff_principal_id = $1`, [a]), { code: "23514" }, set);
  }
  // The number itself may change, and the change is stamped.
  const before = (await pool.query("SELECT updated_at FROM work_staff_hours_per_day WHERE staff_principal_id = $1", [a])).rows[0].updated_at as Date;
  await pool.query("UPDATE work_staff_hours_per_day SET hours = 4, updated_at = '2000-01-01' WHERE staff_principal_id = $1", [a]);
  const stamped = (await pool.query("SELECT updated_at FROM work_staff_hours_per_day WHERE staff_principal_id = $1", [a])).rows[0].updated_at as Date;
  assert.ok(stamped.getTime() >= before.getTime());
  // A row made here (no legacy ref) needs no digest.
  await pool.query("INSERT INTO work_staff_hours_per_day(staff_principal_id, hours) VALUES($1, 6)", [b]);
  assert.deepEqual(Object.fromEntries(await time.hoursPerDay([a, b])), { [a]: 4, [b]: 6 });
});

test("STAFF_HOURS_PG the export port reads each staff member's hours, legacy's 8 when none is held, and nothing for nobody", async () => {
  const [held, none] = [await principal(), await principal()];
  await imports.importStaffHours([row(held, 5)]);
  assert.equal(DEFAULT_STAFF_HOURS_PER_DAY, 8);
  assert.deepEqual([...(await time.hoursPerDay([none, held]))], [[none, 8], [held, 5]]);
  assert.equal((await time.hoursPerDay([])).size, 0);
});

test("STAFF_HOURS_PG reconciliation covers the table by legacy ref; a held conflict or a gap is never clean", async () => {
  // Reconciliation reads the whole table, so the check runs against every ref held there.
  const [a, b] = [await principal(), await principal()];
  const ra = row(a, 8), rb = row(b, 6);
  await imports.importStaffHours([ra, rb]);
  const all = (await pool.query<{ legacy_ref: string }>("SELECT legacy_ref FROM work_staff_hours_per_day WHERE legacy_ref IS NOT NULL")).rows.map((r) => r.legacy_ref);
  const ok = await imports.reconcileStaffImport("work_staff_hours_per_day", all);
  assert.deepEqual([ok.table, ok.missing, ok.extra, ok.held, ok.verified === all.length, ok.clean], ["work_staff_hours_per_day", [], [], [], true, true]);
  const changed = await imports.importStaffHours([{ ...rb, hours: 7 }]);
  assert.equal((await imports.reconcileStaffImport("work_staff_hours_per_day", all, [], changed.conflicts.map((c) => c.legacyRef))).clean, false);
  const gap = `staff:${legacyId()}`;
  const withGap = await imports.reconcileStaffImport("work_staff_hours_per_day", [...all, gap], [gap]);
  assert.deepEqual([withGap.skipped, withGap.clean], [[gap], false]);
});
