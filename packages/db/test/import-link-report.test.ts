import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { LINK_REPORT_RULES, LinkReportError, linkReportCounts, readLinkReport } from "@studenthub/db/import";
import { fixtureIds } from "./legacy-fixture-ids.js";

// Synthetic rows only. The report is database-wide, so every assertion is about this run's own
// fixture ids (a fresh block per run), never about totals other suites also write to.

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
});
after(async () => { await pool.end(); });

const snapshot = async (id: number) => {
  await pool.query("INSERT INTO legacy_candidate_snapshots (legacy_candidate_id, snapshot, source_revision) VALUES ($1, $2, $3)",
    [String(id), JSON.stringify({ candidate_id: String(id) }), "a".repeat(40)]);
};
const person = async () => {
  const id = `link-report-${randomUUID()}`;
  await pool.query("INSERT INTO principals (id, display_name) VALUES ($1, 'Test Person')", [id]);
  return id;
};
const link = async (principalId: string, id: number) => {
  await pool.query("INSERT INTO legacy_account_links (principal_id, legacy_candidate_id, linked_by_ref, method) VALUES ($1, $2, $3, 'staff')",
    [principalId, String(id), "a".repeat(64)]);
  await pool.query("INSERT INTO legacy_account_link_events (principal_id, legacy_candidate_id, kind, actor_ref, method) VALUES ($1, $2, 'linked', $3, 'staff')",
    [principalId, String(id), "a".repeat(64)]);
};
const unlink = async (principalId: string, id: number) => {
  await pool.query("DELETE FROM legacy_account_links WHERE principal_id = $1", [principalId]);
  await pool.query("INSERT INTO legacy_account_link_events (principal_id, legacy_candidate_id, kind, actor_ref, method) VALUES ($1, $2, 'unlinked', $3, 'staff')",
    [principalId, String(id), "a".repeat(64)]);
};
const promoted = async (principalId: string, id: number, o: { phone?: string; handle?: string; civil?: string; email?: string }) => {
  await pool.query(`INSERT INTO legacy_contact_promotions (principal_id, legacy_candidate_id, revision, phone, handle, civil_id, email)
    VALUES ($1, $2, 'contact-promotion-v1', $3, $4, $5, $6)`,
  [principalId, String(id), o.phone ?? "promoted", o.handle ?? "promoted", o.civil ?? "promoted", o.email ?? "promoted"]);
};

test("the link report lists unlinked, not imported, multiply offered, taken and mismatched records by legacy id only", async () => {
  const a = await fixtureIds(pool);
  const [unlinked, linked, gone, offered, taken, civilTaken, mismatch, changed, clean] = [a + 2, a + 10, a + 3, a + 100, a + 4, a + 5, a + 6, a + 7, a + 8];
  for (const id of [unlinked, linked, offered, taken, civilTaken, mismatch, changed, clean]) await snapshot(id);

  const p1 = await person(), p2 = await person(), p3 = await person(), p4 = await person(), p5 = await person(), p6 = await person(), p7 = await person(), p8 = await person(), p9 = await person();
  await link(p1, linked);
  // A link to a candidate the import does not carry (archived in legacy, say).
  await link(p2, gone);
  // Linked to one person, unlinked, then linked to another.
  await link(p3, offered);
  await unlink(p3, offered);
  await link(p4, offered);
  // The same person relinking is not multiply offered.
  await link(p5, taken);
  await unlink(p5, taken);
  await link(p5, taken);
  await promoted(p5, taken, { handle: "taken" });
  await link(p6, civilTaken);
  await promoted(p6, civilTaken, { civil: "taken", email: "answered" });
  await link(p7, mismatch);
  await promoted(p7, mismatch, { email: "mismatch" });
  await link(p8, changed);
  await promoted(p8, changed, { email: "addressChanged", phone: "personWritten" });
  await link(p9, clean);
  await promoted(p9, clean, { email: "unverifiable", phone: "none", civil: "undecryptable" });

  const report = await readLinkReport(pool);
  const mine = (rule: (typeof LINK_REPORT_RULES)[number]) => report.ids[rule].filter((id) => Number(id) >= a && Number(id) < a + 1000);
  assert.deepEqual(mine("link.unlinked"), [String(unlinked)]);
  assert.deepEqual(mine("link.notImported"), [String(gone)]);
  assert.deepEqual(mine("link.multiplyOffered"), [String(offered)]);
  assert.deepEqual(mine("link.contactTaken"), [String(taken), String(civilTaken)]);
  assert.deepEqual(mine("link.emailMismatch"), [String(mismatch), String(changed)]);

  // Numeric order across lengths, each id once, and only plain legacy ids.
  for (const rule of LINK_REPORT_RULES) {
    const ids = report.ids[rule];
    assert.ok(ids.every((id) => /^[1-9][0-9]{0,17}$/.test(id)));
    assert.equal(new Set(ids).size, ids.length);
    for (let i = 1; i < ids.length; i++) assert.ok(BigInt(ids[i - 1]!) < BigInt(ids[i]!), `${rule} in numeric order`);
  }
  // Nothing but ids and totals: no principal id leaves the report.
  const text = JSON.stringify(report);
  for (const p of [p1, p2, p3, p4, p5, p6, p7, p8, p9]) assert.ok(!text.includes(p));

  const counts = linkReportCounts(report);
  assert.deepEqual(Object.keys(counts.rules), [...LINK_REPORT_RULES]);
  assert.ok(counts.imported >= 8 && counts.linked >= 7 && counts.linked <= counts.imported);
  for (const rule of LINK_REPORT_RULES) assert.equal(counts.rules[rule], report.ids[rule].length);
});

test("the link report reads and writes nothing else: it runs read-only and fails with a fixed code only", async () => {
  const a = await fixtureIds(pool);
  await snapshot(a + 1);
  const before = (await pool.query("SELECT count(*)::int AS n FROM legacy_account_links")).rows[0].n;
  await readLinkReport(pool);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM legacy_account_links")).rows[0].n, before);

  // A database that lacks the tables: one fixed error, no detail or cause.
  const empty = `link_report_${randomUUID().replaceAll("-", "")}`;
  await pool.query(`CREATE SCHEMA ${empty}`);
  const other = new pg.Pool({ connectionString: URL, options: `-c search_path=${empty}` });
  try {
    await assert.rejects(readLinkReport(other), (error: unknown) => {
      assert.ok(error instanceof LinkReportError);
      assert.equal(error.code, "m3.link.reportFailed");
      assert.equal(error.message, "m3.link.reportFailed");
      assert.equal((error as { cause?: unknown }).cause, undefined);
      return true;
    });
  } finally {
    await other.end();
    await pool.query(`DROP SCHEMA ${empty} CASCADE`);
  }
});
