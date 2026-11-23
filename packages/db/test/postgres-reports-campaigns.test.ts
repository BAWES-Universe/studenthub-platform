import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { PostgresCampaignsStore } from "@studenthub/db/reports";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, authz: PostgresAuthzStore, store: PostgresCampaignsStore, staff: string;
const AT = new Date("2026-11-23T09:00:00Z");

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  authz = new PostgresAuthzStore(pool);
  store = new PostgresCampaignsStore({ pool });
  staff = `camp-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id: staff, pbuuids: [], email: `${staff}@example.invalid` }));
});
after(async () => { await store.close(); await pool.end(); });

interface Vals { utmSource: string; utmMedium: string; utmCampaign: string; utmContent: string | null; utmTerm: string | null; investment: string }
const vals = (over: Partial<Vals> = {}): Vals =>
  ({ utmSource: "news", utmMedium: "email", utmCampaign: `c-${randomUUID().slice(0, 8)}`, utmContent: null, utmTerm: null, investment: "0", ...over });
async function click(id: string, day: string, clicks: number): Promise<void> {
  await pool.query("INSERT INTO marketing_campaign_clicks(campaign_id, day, clicks) VALUES($1,$2,$3)", [id, day, clicks]);
}

test("REPORTS_CAMPAIGNS create then list: recent clicks are the window, total is all time, optionals are null", async () => {
  const v = vals({ investment: "12.500" });
  const made = await store.create(v, staff, AT);
  assert.ok("id" in made);
  await click(made.id, "2026-11-20", 3); // inside 30 days of 2026-11-23
  await click(made.id, "2026-10-01", 7); // older than 30 days
  const row = (await store.list("2026-11-23", 30)).find(r => r.id === made.id);
  assert.deepEqual(row, { id: made.id, utmSource: "news", utmMedium: "email", utmCampaign: v.utmCampaign, utmContent: null, utmTerm: null, investment: "12.500", retired: false, clicks: { recent: 3, total: 10 } });
});

test("REPORTS_CAMPAIGNS one live campaign per set of UTM values, nulls counting as equal; a retired set can be used again", async () => {
  const v = vals();
  const first = await store.create(v, staff, AT);
  assert.ok("id" in first);
  assert.deepEqual(await store.create(v, staff, AT), { refused: "duplicate" }, "same UTM values, empty content and term, is the same campaign");
  assert.deepEqual(await store.create(vals({ utmCampaign: v.utmCampaign, utmContent: "x" }), staff, AT) && "id", "id", "a different content is a different campaign");
  assert.equal(await store.retire(first.id, AT), true);
  const again = await store.create(v, staff, AT);
  assert.ok("id" in again, "once retired, those UTM values are free again");
  assert.notEqual(again.id, first.id);
});

test("REPORTS_CAMPAIGNS update: unknown id, a retired campaign, a clash with another live one, else it changes", async () => {
  assert.deepEqual(await store.update("not-a-uuid", vals(), AT), { refused: "unknown" });
  assert.deepEqual(await store.update(randomUUID(), vals(), AT), { refused: "unknown" });
  const a = await store.create(vals(), staff, AT), b = await store.create(vals(), staff, AT);
  assert.ok("id" in a && "id" in b);
  const bRow = (await store.list("2026-11-23", 30)).find(r => r.id === b.id)!;
  assert.deepEqual(await store.update(a.id, vals({ utmSource: bRow.utmSource ?? "", utmMedium: bRow.utmMedium ?? "", utmCampaign: bRow.utmCampaign ?? "" }), AT), { refused: "duplicate" });
  assert.equal(await store.update(a.id, vals({ utmCampaign: a.id.slice(0, 8), investment: "9.000" }), AT), true);
  const changed = (await store.list("2026-11-23", 30)).find(r => r.id === a.id)!;
  assert.equal(changed.investment, "9.000");
  await store.retire(a.id, AT);
  assert.deepEqual(await store.update(a.id, vals(), AT), { refused: "retired" });
});

test("REPORTS_CAMPAIGNS retire: unknown id, once only, and the clicks keep their campaign", async () => {
  assert.deepEqual(await store.retire("not-a-uuid", AT), { refused: "unknown" });
  const c = await store.create(vals(), staff, AT);
  assert.ok("id" in c);
  await click(c.id, "2026-11-22", 4);
  assert.equal(await store.retire(c.id, AT), true);
  assert.deepEqual(await store.retire(c.id, AT), { refused: "retired" });
  const row = (await store.list("2026-11-23", 30)).find(r => r.id === c.id)!;
  assert.equal(row.retired, true);
  assert.equal(row.clicks.total, 4, "retiring keeps the clicks already counted");
});

test("REPORTS_CAMPAIGNS list puts retired campaigns last", async () => {
  const tag = randomUUID().slice(0, 8);
  const live = await store.create(vals({ utmCampaign: `zzz-live-${tag}` }), staff, AT), dead = await store.create(vals({ utmCampaign: `aaa-dead-${tag}` }), staff, AT);
  assert.ok("id" in live && "id" in dead);
  await store.retire(dead.id, AT);
  const rows = await store.list("2026-11-23", 30);
  const iLive = rows.findIndex(r => r.id === live.id), iDead = rows.findIndex(r => r.id === dead.id);
  assert.ok(iLive < iDead, "a live campaign sorts before a retired one even when its name sorts later");
});

test("REPORTS_CAMPAIGNS update racing another writer for the same UTM values is refused as duplicate, not an error", async () => {
  const a = await store.create(vals(), staff, AT), b = await store.create(vals(), staff, AT);
  assert.ok("id" in a && "id" in b);
  const target = vals({ utmCampaign: `race-${randomUUID().slice(0, 8)}` });
  const other = await pool.connect();
  try {
    // Another writer takes the values first and has not committed, so the store's pre-check cannot see it.
    await other.query("BEGIN");
    await other.query("UPDATE marketing_campaigns SET utm_campaign = $2 WHERE id = $1", [a.id, target.utmCampaign]);
    const racing = store.update(b.id, target, AT);
    await new Promise(r => setTimeout(r, 200));
    await other.query("COMMIT");
    assert.deepEqual(await racing, { refused: "duplicate" });
  } finally { other.release(); }
});
