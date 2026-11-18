import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPrincipal } from "@studenthub/contracts";
import { PostgresAccessAbuseStore, PostgresAuthzStore, runMigrations } from "@studenthub/db";
import { parseCidr } from "../../access/src/index.js";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, store: PostgresAccessAbuseStore, authz: PostgresAuthzStore;

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  store = new PostgresAccessAbuseStore({ pool });
  authz = new PostgresAuthzStore(pool);
});
after(async () => pool.end());

async function person() {
  const id = `a8-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], displayName: `Person ${id}` }));
  return id;
}

test("A8_LIMITS the count is per person and kind, exact under concurrency, and starts again in the next window", async () => {
  const [one, two] = [await person(), await person()];
  const window = 1_800_000_000;
  const counts = await Promise.all(Array.from({ length: 20 }, () => store.hit(one, "write", window)));
  assert.deepEqual([...counts].sort((a, b) => a - b), Array.from({ length: 20 }, (_, index) => index + 1), "every request counted once");
  assert.equal(await store.hit(one, "upload", window), 1, "uploads counted apart from writes");
  assert.equal(await store.hit(two, "write", window), 1, "another person has their own count");
  assert.equal(await store.hit(one, "write", window + 600), 1, "a new window starts at one");
  // A second store over another pool (another gateway process) shares the count.
  const other = new PostgresAccessAbuseStore({ connectionString: URL });
  try { assert.equal(await other.hit(one, "write", window), 21); } finally { await other.close(); }
});

test("A8_BLOCKS blocks keep who, when and why, can be removed once, and are never deleted", async () => {
  const admin = await person();
  const net = `198.18.${Math.floor(Math.random() * 256)}.${Math.floor(Math.random() * 256)}/32`;
  assert.deepEqual(await store.changeBlock(admin, { action: "block", cidr: parseCidr(net)!, reason: "Credential stuffing" }), { kind: "blocked" });
  assert.deepEqual(await store.changeBlock(admin, { action: "block", cidr: parseCidr(net)!, reason: "Again" }), { kind: "refused", reason: "already_blocked" });
  const row = (await store.blocks()).find((item) => item.cidr === net);
  assert.equal(row?.reason, "Credential stuffing");
  assert.equal(row?.createdBy.principalId, admin);
  assert.deepEqual(await store.changeBlock(admin, { action: "unblock", cidr: parseCidr(net)!, reason: "Was a shared office" }), { kind: "unblocked" });
  assert.equal((await store.blocks()).some((item) => item.cidr === net), false);
  assert.deepEqual(await store.changeBlock(admin, { action: "unblock", cidr: parseCidr(net)!, reason: "Was a shared office" }), { kind: "refused", reason: "not_blocked" });
  await assert.rejects(pool.query("DELETE FROM ip_blocks WHERE cidr = $1::cidr", [net]), /never deleted/);
  await assert.rejects(pool.query("UPDATE ip_blocks SET reason = 'edited' WHERE cidr = $1::cidr", [net]), /only be removed, once/);
  await assert.rejects(pool.query("UPDATE ip_blocks SET id = gen_random_uuid() WHERE cidr = $1::cidr AND created_by = $2", [net, admin]), /only be removed, once/);
  assert.equal((await pool.query("SELECT count(*)::int AS n FROM ip_blocks WHERE cidr = $1::cidr AND created_by = $2", [net, admin])).rows[0].n, 1, "this test's row stays");
});
