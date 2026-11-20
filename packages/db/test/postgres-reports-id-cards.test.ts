import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresIdCardsStore, PostgresMorningSummaryStore } from "@studenthub/db/reports";

const URL = process.env.DATABASE_URL ?? "";
const DAY = "2026-11-19";
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresIdCardsStore;
let company: string, storeId: string, otherStore: string, creator: string, tag: string;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  store = new PostgresIdCardsStore({ pool });
  company = `idc-co-${randomUUID()}`; storeId = randomUUID(); otherStore = randomUUID();
  // A unique word in every name, so the global lists can be narrowed to this suite's people.
  tag = `idc${randomUUID().replace(/-/g, "").slice(0, 10).replace(/[0-9]/g, d => "ghijklmnop"[Number(d)]!)}`;
  await authz.upsertOrganization(createOrganization({ id: company, name: "Legal Co Name" }));
  await pool.query("INSERT INTO organization_profiles(org_id,name_en) VALUES($1,'Sultan Center')", [company]);
  await pool.query("INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) VALUES($1,$2,'Avenues',$3,$3),($4,$2,'Marina',$3,$3)", [storeId, company, "a".repeat(64), otherStore]);
  creator = await person("creator");
});
after(async () => pool.end());

async function person(name: string): Promise<string> {
  const id = `idc-${name}-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], email: `${id}@example.invalid` }));
  await pool.query("INSERT INTO person_profiles(principal_id,display_name,display_name_written_at) VALUES($1,$2,now())", [id, `${name} ${tag}`]);
  return id;
}
const assign = (id: string, start: string, end: string | null, at = storeId) => pool.query(`INSERT INTO work_assignments(id,person_principal_id,org_id,store_id,contract_resolution,start_date,end_date,source,created_by)
  VALUES($1,$2,$3,$4,'{}',$5,$6,'staff',$7)`, [randomUUID(), id, company, at, start, end, creator]);
const ids = async (view: "needs" | "expired" | "issued", day = DAY) => (await store.list(view, day, tag, 0, 500)).rows.map(r => r.personId);

test("REPORTS_ID_CARDS_PG staff lists: assigned without a card, expired among the assigned, and every card", async () => {
  const current = await person("Current"), upcoming = await person("Upcoming"), ended = await person("Ended"), never = await person("Never");
  await assign(current, "2026-01-01", null); await assign(upcoming, "2026-12-01", "2027-01-31"); await assign(ended, "2026-01-01", "2026-11-18");
  assert.deepEqual(new Set(await ids("needs")), new Set([current, upcoming]), "a running or upcoming assignment needs a card; an ended one or none does not");
  assert.deepEqual(await store.write("issue", [current], DAY, "2027-02-19", creator), []);
  assert.deepEqual(await ids("needs"), [upcoming]);
  const [row] = (await store.list("issued", DAY, tag, 0, 50)).rows;
  assert.equal(row?.personId, current); assert.equal(row?.expiresOn, "2027-02-19"); assert.deepEqual(row?.placement, { company: "Sultan Center", store: "Avenues" });
  assert.deepEqual(await ids("expired", "2027-02-19"), [], "a card expiring today is still valid");
  assert.deepEqual(await ids("expired", "2027-02-20"), [current]);
  await pool.query("UPDATE work_assignments SET end_date='2027-02-19' WHERE person_principal_id=$1", [current]);
  assert.deepEqual(await ids("expired", "2027-02-20"), [], "an expired card of someone no longer assigned is not listed as expired");
  assert.deepEqual(await ids("issued", "2027-02-20"), [current], "but the card is still in the full list");
  assert.deepEqual((await store.list("needs", DAY, tag.toUpperCase(), 0, 50)).total, 1, "the name search ignores case");
  assert.deepEqual((await store.list("needs", DAY, `${tag}-nobody`, 0, 50)).total, 0);
  assert.deepEqual(await store.list("needs", DAY, tag, 50, 50), { total: 1, rows: [] }, "a page past the end still reports how many match");
  void never;
});

test("REPORTS_ID_CARDS_PG issue, reissue and renew write the card and one event each; a refused batch writes nothing", async () => {
  const a = await person("Alia"), b = await person("Badr"), unassigned = await person("Free");
  await assign(a, "2026-01-01", null); await assign(b, "2026-01-01", null);
  assert.deepEqual(await store.write("renew", [a], DAY, "2027-02-19", creator), [{ personId: a, code: "no_card" }]);
  assert.deepEqual(await store.write("issue", [a, unassigned, "idc-missing"], DAY, "2027-02-19", creator),
    [{ personId: unassigned, code: "not_assigned" }, { personId: "idc-missing", code: "unknown_person" }]);
  assert.equal((await pool.query("SELECT 1 FROM id_cards WHERE person_principal_id=$1", [a])).rowCount, 0, "all or nothing: the valid person in a refused batch got no card");
  assert.deepEqual(await store.write("issue", [a, b], DAY, "2027-02-19", creator), []);
  const first = (await store.card(a, DAY))!;
  assert.deepEqual(await store.write("renew", [a], "2027-03-01", "2027-06-01", creator), []);
  assert.deepEqual(await store.write("issue", [b], DAY, "2027-02-28", creator), [], "issuing again re-issues, as legacy does");
  const renewed = (await store.card(a, DAY))!;
  assert.equal(renewed.cardNumber, first.cardNumber, "renewal keeps the card number"); assert.equal(renewed.expiresOn, "2027-06-01");
  const events = await pool.query<{ person_principal_id: string; kind: string; expires_on: string; actor_principal_id: string }>(
    "SELECT person_principal_id, kind, to_char(expires_on,'YYYY-MM-DD') expires_on, actor_principal_id FROM id_card_events WHERE person_principal_id = ANY($1) ORDER BY id", [[a, b]]);
  assert.deepEqual(events.rows.map(r => [r.person_principal_id, r.kind, r.expires_on, r.actor_principal_id]),
    [[a, "issued", "2027-02-19", creator], [b, "issued", "2027-02-19", creator], [a, "renewed", "2027-06-01", creator], [b, "reissued", "2027-02-28", creator]]);
  for (const sql of ["UPDATE id_card_events SET kind='issued'", "DELETE FROM id_card_events", "TRUNCATE id_card_events", "TRUNCATE id_card_events CASCADE"])
    await assert.rejects(pool.query(sql), /append-only/, sql);
  await assert.rejects(pool.query("TRUNCATE id_cards CASCADE"), /id_cards rows are retained|append-only/, "CASCADE would take the events with it");
  await assert.rejects(pool.query("TRUNCATE id_cards"), /cannot truncate a table referenced in a foreign key|id_cards rows are retained/);
  assert.equal((await pool.query("SELECT tgname FROM pg_trigger WHERE tgname = ANY($1) AND tgtype & 32 <> 0", [["id_cards_no_truncate", "id_card_events_no_truncate"]])).rowCount, 2, "both are TRUNCATE statement triggers");
  await assert.rejects(pool.query("DELETE FROM id_cards WHERE person_principal_id=$1", [a]), /foreign key/, "a card with events cannot be deleted");
  assert.equal((await pool.query("SELECT 1 FROM id_card_events WHERE person_principal_id = ANY($1)", [[a, b]])).rowCount, 4, "every refused statement left the history in place");
});

test("REPORTS_ID_CARDS_PG the person's card shows the store running today, else the next one, and the legacy employee ID", async () => {
  const p = await person("Card");
  await assign(p, "2026-01-01", "2026-12-31", storeId); await assign(p, "2027-01-01", null, otherStore);
  await store.write("issue", [p], DAY, "2027-02-19", creator);
  assert.deepEqual((await store.card(p, DAY))?.placement, { company: "Sultan Center", store: "Avenues" });
  assert.deepEqual((await store.card(p, "2027-01-02"))?.placement, { company: "Sultan Center", store: "Marina" }, "a move shows on the card without a new one");
  await pool.query("UPDATE work_assignments SET end_date='2027-01-31' WHERE person_principal_id=$1 AND store_id=$2", [p, otherStore]);
  assert.equal((await store.card(p, "2027-02-01"))?.placement, null, "no assignment left: the card shows none");
  const card = (await store.card(p, DAY))!;
  assert.equal(card.name, `Card ${tag}`); assert.equal(card.employeeId, null); assert.equal(card.expiresOn, "2027-02-19");
  const legacy = String(90_000_000 + Math.floor(Math.random() * 9_999_999));
  await pool.query("INSERT INTO legacy_account_links(principal_id,legacy_candidate_id,linked_by_ref,method) VALUES($1,$2,$3,'staff')", [p, legacy, "b".repeat(64)]);
  assert.equal((await store.card(p, DAY))!.employeeId, `C${legacy}`, "a long legacy id is not cut");
  assert.equal(await store.card(await person("Nobody"), DAY), undefined);
});

test("REPORTS_ID_CARDS_PG the morning summary counts assigned people without a card and with an expired one", async () => {
  const summary = new PostgresMorningSummaryStore({ pool }), day = "2031-05-10";
  const read = async () => { const [c, s] = await Promise.all([store.counts(day), summary.counts(day)]); assert.equal(s.id_need_generated, c.needs); assert.equal(s.totalExpiredCards, c.expired); return c; };
  const base = await read();
  const needs = await person("Needs"), expired = await person("Expired"), fine = await person("Fine");
  for (const p of [needs, expired, fine]) await assign(p, "2031-01-01", null);
  await store.write("issue", [expired], "2031-01-01", "2031-04-01", creator);
  await store.write("issue", [fine], "2031-05-01", "2031-08-01", creator);
  assert.deepEqual(await read(), { needs: base.needs + 1, expired: base.expired + 1 });
});

test("REPORTS_ID_CARDS_PG a legacy card needs its legacy id instead of an issuing staff member", async () => {
  const p = await person("Legacy");
  await assert.rejects(pool.query("INSERT INTO id_cards(person_principal_id,expires_on) VALUES($1,'2026-01-01')", [p]), /check constraint/);
  await pool.query("INSERT INTO id_cards(person_principal_id,expires_on,legacy_ref) VALUES($1,'2026-01-01',$2)", [p, String(Math.floor(Math.random() * 1e12))]);
  await assert.rejects(pool.query("UPDATE id_cards SET issued_by=$2 WHERE person_principal_id=$1", [p, creator]), /check constraint/);
});

test("REPORTS_ID_CARDS_PG an assignment end being written while a card is issued is waited for, so the card is refused", async () => {
  const p = await person("Leaving");
  await assign(p, "2026-01-01", null);
  const other = await pool.connect();
  try {
    await other.query("BEGIN");
    await other.query("UPDATE work_assignments SET end_date = '2026-11-18' WHERE person_principal_id = $1", [p]);
    const updater = (await other.query<{ pid: number }>("SELECT pg_backend_pid() AS pid")).rows[0]!.pid;
    const pending = store.write("issue", [p], DAY, "2027-02-19", creator);
    // Commit only once the issue is seen waiting on the updater's row lock; without the share lock it never waits and this fails.
    for (let deadline = Date.now() + 5000; ; await new Promise(r => setTimeout(r, 20))) {
      if ((await pool.query("SELECT 1 FROM pg_stat_activity WHERE $1 = ANY(pg_blocking_pids(pid))", [updater])).rowCount) break;
      if (Date.now() > deadline) assert.fail("issuing a card never waited for the assignment being ended");
    }
    await other.query("COMMIT");
    assert.deepEqual(await pending, [{ personId: p, code: "not_assigned" }]);
  } finally { other.release(); }
  assert.equal((await pool.query("SELECT 1 FROM id_cards WHERE person_principal_id = $1", [p])).rowCount, 0);
});
