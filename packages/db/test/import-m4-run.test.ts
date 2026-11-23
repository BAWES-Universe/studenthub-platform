import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { main, m4Writers, postgresTarget, WRITER_LOCK_SQL, WriterSessionPool, type CliDeps, type M4Receipt } from "../../../tools/legacy-import/src/m4-cli.js";
import { M4_SOURCES, runM4, type M4Sources, type M4Table } from "../../../tools/legacy-import/src/m4-run.js";
import { fixtureIds } from "./legacy-fixture-ids.js";

// Synthetic legacy rows only; fresh legacy ids per run so the suite can share a database.

const URL = process.env.DATABASE_URL ?? "";
const ACTOR = createHash("sha256").update("legacy-import:test").digest("hex");
const NOW = "2026-11-23T00:00:00.000Z";
let pool: pg.Pool, operator: string;
before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  operator = `import-operator-${randomUUID()}`;
  await pool.query("INSERT INTO organizations (id, name, parent_org_id) VALUES ($1, 'Operator', NULL)", [operator]);
});
after(async () => pool.end());

function legacy(c: number, r: string): M4Sources {
  const empty = Object.fromEntries(Object.keys(M4_SOURCES).map((t) => [t, []])) as unknown as Record<M4Table, Record<string, unknown>[]>;
  return {
    ...empty,
    mall: [{ mall_uuid: `${r}-m`, mall_name_en: `Mall ${r}` }],
    brand: [{ brand_uuid: `${r}-b`, company_id: c, brand_name_en: `Brand ${r}` }],
    company: [{ company_id: c, parent_company_id: null, company_name: `Company ${c}`, deleted: 0 }, { company_id: c + 1, parent_company_id: c, company_name: `Sub ${c}`, deleted: 0 }],
    store: [{ store_id: c, company_id: c + 1, brand_uuid: null, mall_uuid: `${r}-m`, store_name: "Store A", deleted: 0 },
      { store_id: c + 1, company_id: c, brand_uuid: `${r}-b`, mall_uuid: null, store_name: "Store B", deleted: 0 }],
    contact: [{ contact_uuid: `${r}-p`, contact_name: "Person", contact_email: `${r}@example.com`, deleted: 0 }],
    company_contact: [{ company_contact_uuid: `${r}-l`, contact_uuid: `${r}-p`, company_id: c + 1, allow_access: 0 }],
  };
}

test("a write run imports every step in order through the real stores; a second run finds everything unchanged", async () => {
  const c = await fixtureIds(pool), r = randomUUID().slice(0, 8);
  const writers = m4Writers(pool, ACTOR, operator);
  const first = await runM4(legacy(c, r), writers, NOW);
  assert.equal(first.ok, true);
  const by = new Map(first.steps.map((s) => [s.step, s.write]));
  assert.deepEqual([by.get("company")!.inserted, by.get("brand_company")!.inserted, by.get("store")!.inserted, by.get("company_contact")!.inserted], [2, 1, 2, 1]);
  const second = await runM4(legacy(c, r), writers, NOW);
  assert.equal(second.ok, true);
  assert.ok(second.steps.every((s) => s.write!.inserted === 0 && s.write!.unchanged === s.mapped));

  const { rows } = await pool.query(
    `SELECT s.name AS store, o.name AS org, s.brand_id IS NOT NULL AS branded, s.mall_id IS NOT NULL AS in_mall
       FROM organization_stores s JOIN organizations o ON o.id = s.org_id
      WHERE s.id::text IN (SELECT platform_id FROM legacy_id_maps WHERE legacy_table = 'store' AND legacy_id = ANY($1::text[])) ORDER BY s.name`,
    [[String(c), String(c + 1)]]);
  assert.deepEqual(rows, [{ store: "Store A", org: `Sub ${c}`, branded: false, in_mall: true }, { store: "Store B", org: `Company ${c}`, branded: true, in_mall: false }]);
});

test("the write target is staging only when the database's own marker row says so, and names its target id", async () => {
  // The one test that touches the singleton marker; it leaves the table empty as it found it.
  const target = postgresTarget(URL, ACTOR, operator);
  try {
    await pool.query("DELETE FROM legacy_import_target");
    assert.equal(await target.marker(), null);
    for (const bad of ["production", "Staging", ""]) {
      await assert.rejects(pool.query("INSERT INTO legacy_import_target (environment) VALUES ($1)", [bad]), (e: { code?: string }) => e.code === "23514");
    }
    const { rows: [row] } = await pool.query<{ target_id: string }>("INSERT INTO legacy_import_target (environment) VALUES ('staging') RETURNING target_id::text");
    assert.match(row!.target_id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.deepEqual(await target.marker(), { environment: "staging", targetId: row!.target_id });
    await assert.rejects(pool.query("INSERT INTO legacy_import_target (environment) VALUES ('staging')"), (e: { code?: string }) => e.code === "23505");
    await assert.rejects(pool.query("INSERT INTO legacy_import_target (singleton, environment) VALUES (false, 'staging')"), (e: { code?: string }) => e.code === "23514");
  } finally {
    await pool.query("DELETE FROM legacy_import_target");
    await target.close();
  }
  // A database the importer cannot read the marker from is no target either.
  const elsewhere = postgresTarget(URL.replace(/\/[^/?]+(\?|$)/, "/no_such_database$1"), ACTOR, operator);
  try {
    assert.equal(await elsewhere.marker(), null);
    assert.equal(await elsewhere.hasOperator(operator), false);
    assert.equal(await elsewhere.claimWriter(), false);
  } finally { await elsewhere.close(); }
});

test("the operator parent must exist in the target database", async () => {
  const target = postgresTarget(URL, ACTOR, operator);
  try {
    assert.equal(await target.hasOperator(operator), true);
    assert.equal(await target.hasOperator(`absent-${randomUUID()}`), false);
  } finally { await target.close(); }
});

const WRITER_PID_SQL = `SELECT pid FROM pg_locks WHERE locktype = 'advisory' AND granted AND objsubid = 1
  AND ((classid::bigint << 32) | objid::bigint) = hashtextextended('legacy-import:m4-writer', 0)`;

test("every checkout of the writer session pool is the lock-holding session, fenced, and a broken release ends it", async () => {
  const c = await fixtureIds(pool), r = randomUUID().slice(0, 8);
  const target = postgresTarget(URL, ACTOR, operator);
  try {
    assert.equal(await target.claimWriter(), true);
    const { rows: [holder] } = await pool.query<{ pid: number }>(WRITER_PID_SQL);
    // A non-empty import through the session-bound writers, then the backend each checkout uses.
    const report = await runM4(legacy(c, r), target.writers(), NOW);
    assert.equal(report.ok, true);
    assert.ok(report.steps.some((s) => (s.write?.inserted ?? 0) > 0));
    const client = await pool.connect();
    try {
      const { rows: [lockPid] } = await client.query<{ pid: number }>(WRITER_PID_SQL);
      assert.equal(lockPid!.pid, holder!.pid, "the same session still holds the lock after every batch");
    } finally { client.release(); }
    assert.equal(await target.stillHeld(), true);
    assert.equal(target.lost(), false);
  } finally { await target.close(); }

  const side = new pg.Pool({ connectionString: URL, max: 1 });
  const session = await side.connect();
  try {
    assert.equal((await session.query<{ held: boolean }>(WRITER_LOCK_SQL)).rows[0]!.held, true);
    const { rows: [own] } = await session.query<{ pid: number }>("SELECT pg_backend_pid() AS pid");
    const writer = new WriterSessionPool(session);
    for (let i = 0; i < 3; i++) {
      const checkout = await writer.connect();
      assert.equal((await checkout.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid, own!.pid);
      checkout.release();
    }
    assert.equal(((await writer.query("SELECT pg_backend_pid() AS pid")) as { rows: { pid: number }[] }).rows[0]!.pid, own!.pid);
    // One checkout at a time; a store that releases the session as broken ends all further writes.
    const held = await writer.connect();
    await assert.rejects(writer.connect(), (e: Error) => e.message === "m4.writerSessionBusy");
    held.release(new Error("broken"));
    assert.equal(writer.lost, true);
    await assert.rejects(writer.connect(), (e: Error) => e.message === "m4.writerLost");
    writer.close();
  } finally {
    try { session.release(true); } catch { /* already released */ }
    await side.end();
  }
  const next = postgresTarget(URL, ACTOR, operator);
  try { assert.equal(await next.claimWriter(), true); } finally { await next.close(); }
});

test("the fence fails closed when the live session no longer holds the writer lock, whatever else it holds", async () => {
  const side = new pg.Pool({ connectionString: URL, max: 1 });
  const session = await side.connect();
  try {
    assert.equal((await session.query<{ held: boolean }>(WRITER_LOCK_SQL)).rows[0]!.held, true);
    // Another bigint advisory lock on the same session must not pass for the writer lock.
    await session.query("SELECT pg_advisory_lock(424242)");
    const writer = new WriterSessionPool(session);
    assert.equal(await writer.fence(), true);
    await session.query("SELECT pg_advisory_unlock(hashtextextended('legacy-import:m4-writer', 0))");
    assert.equal(await writer.fence(), false);
    assert.equal(writer.lost, true);
    await assert.rejects(writer.connect(), (e: Error) => e.message === "m4.writerLost");
  } finally {
    // Destroying the session also drops any lock it still holds, even after a failed assertion.
    try { session.release(true); } catch { /* already released */ }
    await side.end();
  }
});

test("a lost lock session mid-write: no later batch runs, the attempt fails with writerLost and the lock is free", async () => {
  const c = await fixtureIds(pool), r = randomUUID().slice(0, 8);
  const dir = mkdtempSync(path.join(tmpdir(), "m4-lost-"));
  const sources = legacy(c, r);
  await pool.query("DELETE FROM legacy_import_target");
  const { rows: [marker] } = await pool.query<{ target_id: string }>("INSERT INTO legacy_import_target (environment) VALUES ('staging') RETURNING target_id::text");
  writeFileSync(path.join(dir, "refresh.json"), JSON.stringify({ ok: true, startedAt: "2026-11-23T01:00:00.000Z", finishedAt: "2026-11-23T01:05:00.000Z", totalRows: 1 }));
  const revision = "a".repeat(40), artifact = "e".repeat(64);
  const env = {
    M4_OUTPUT_DIR: path.join(dir, "out"), M4_REVISION: revision, M4_ARTIFACT_DIGEST: artifact, M4_TARGET_ID: marker!.target_id, M4_OPERATOR_ORG_ID: operator,
    LEGACY_REFRESH_REPORT: path.join(dir, "refresh.json"), LEGACY_REFRESH_LOCK: path.join(dir, "lock"),
    M4_IMPORT_ACTOR: ACTOR, M4_DATABASE_URL: URL,
  };
  let killed: number | undefined;
  const deps = (invocation: string, extra: Record<string, string> = {}): CliDeps => ({
    env: { ...env, ...extra, M4_INVOCATION: invocation },
    lock: async () => ({ held: true, release: () => undefined }),
    reader: () => ({ rows: async (sql) => sources[/FROM `([a-z_]+)`$/.exec(sql)![1] as M4Table] }),
    target: (e) => {
      const real = postgresTarget(e.M4_DATABASE_URL!, ACTOR, operator);
      return { ...real, writers: () => {
        const w = real.writers();
        // After the (non-empty) companies batch commits, the lock session is terminated.
        return { ...w, brandLinks: async (rows) => {
          const { rows: [holder] } = await pool.query<{ pid: number }>(WRITER_PID_SQL);
          killed = holder!.pid;
          await pool.query("SELECT pg_terminate_backend($1)", [killed]);
          return w.brandLinks(rows);
        } };
      } };
    },
    provenance: () => ({ head: revision, clean: true, artifact }),
    now: () => new Date(NOW),
    log: () => undefined,
    error: () => undefined,
  });
  try {
    const planInvocation = randomUUID();
    assert.equal(await main(["plan"], deps(planInvocation)), 0);
    const plan = (JSON.parse(readFileSync(path.join(dir, "out", `${planInvocation}.plan.receipt.json`), "utf8")) as M4Receipt).plan!;
    const invocation = randomUUID();
    assert.equal(await main(["write"], deps(invocation, { M4_EXPECTED_PLAN: plan })), 1);
    assert.ok(killed);
    const receipt = JSON.parse(readFileSync(path.join(dir, "out", `${invocation}.write.receipt.json`), "utf8")) as M4Receipt;
    assert.deepEqual([receipt.status, receipt.code], ["failed", "m4.writerLost"]);
    assert.equal(receipt.steps.at(-1)!.step, "company");
    assert.equal(receipt.steps.at(-1)!.write!.inserted, 2);
    assert.deepEqual(receipt.unconfirmed, ["brand_company", "store", "company_contact"]);
    // The companies committed before the loss; nothing after it was written.
    const mapped = async (table: string, ids: string[]) => (await pool.query("SELECT 1 FROM legacy_id_maps WHERE legacy_table = $1 AND legacy_id = ANY($2::text[])", [table, ids])).rowCount;
    assert.equal(await mapped("company", [String(c), String(c + 1)]), 2);
    assert.equal(await mapped("brand_company", [`${r}-b`]), 0);
    assert.equal(await mapped("store", [String(c), String(c + 1)]), 0);
    assert.equal(await mapped("company_contact", [`${r}-l`]), 0);
    // The server released the lock with the session: a new writer can take it.
    const next = postgresTarget(URL, ACTOR, operator);
    try { assert.equal(await next.claimWriter(), true); } finally { await next.close(); }
  } finally {
    await pool.query("DELETE FROM legacy_import_target");
    rmSync(dir, { recursive: true, force: true });
  }
});

test("one writer per target database: a second writer is refused until the first has closed", async () => {
  const first = postgresTarget(URL, ACTOR, operator), second = postgresTarget(URL, ACTOR, operator);
  try {
    assert.equal(await first.claimWriter(), true);
    assert.equal(await first.claimWriter(), true);
    assert.equal(await second.claimWriter(), false);
    // The lock is the session's own: batch transactions on other connections do not release it.
    await first.writers().companies([]);
    assert.equal(await second.claimWriter(), false);
    await first.close();
    assert.equal(await second.claimWriter(), true);
  } finally {
    await second.close();
  }
});
