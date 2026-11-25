import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createPrincipal } from "@studenthub/contracts";
import { PostgresAccessSessionsStore, PostgresAuthzStore, runMigrations } from "@studenthub/db";

const URL = process.env.DATABASE_URL ?? "";
let pool: pg.Pool, sessions: PostgresAccessSessionsStore, authz: PostgresAuthzStore;
const hashed = (token: string) => createHash("sha256").update(token).digest("base64url");

before(async () => {
  if (!URL) throw Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: URL });
  await runMigrations(pool);
  sessions = new PostgresAccessSessionsStore({ pool });
  authz = new PostgresAuthzStore(pool);
});
after(async () => pool.end());

async function person() {
  const id = `u03-${randomUUID()}`;
  await authz.registerPrincipal(createPrincipal({ id, pbuuids: [], displayName: `Person ${id}` }));
  return id;
}
async function signIn(personId: string, sql = "") {
  const token = randomUUID().replace(/-/g, "") + "abcdefghijk";
  await pool.query(`INSERT INTO login_sessions (id, person_id, expires_at) VALUES ($1, $2, now() + interval '1 day')`, [hashed(token), personId]);
  if (sql) await pool.query(`UPDATE login_sessions SET ${sql} WHERE id = $1`, [hashed(token)]);
  return token;
}

test("U03_LIST a person sees only their own live sessions, this one first, with when each started", async () => {
  const [me, other] = [await person(), await person()];
  const older = await signIn(me, "created_at = now() - interval '2 days'");
  const current = await signIn(me);
  await signIn(me, "created_at = NULL");
  await signIn(me, "expires_at = now() - interval '1 second'");
  await signIn(other);
  const rows = await sessions.list(me, current);
  assert.deepEqual(rows.map((row) => row.current), [true, false, false], "expired and other people's sessions are left out");
  assert.ok(rows[0]!.signedInAt && Math.abs(Date.parse(rows[0]!.signedInAt) - Date.now()) < 60_000, "a new session records its start");
  assert.ok(rows[1]!.signedInAt && Date.parse(rows[1]!.signedInAt) < Date.now() - 86_400_000);
  assert.equal(rows[2]!.signedInAt, null, "a session from before the record says so");
  assert.deepEqual((await sessions.list(me, older)).map((row) => row.current), [true, false, false]);
  assert.deepEqual((await sessions.list(other, current)).map((row) => row.current), [false], "another person's cookie is never theirs");
});

test("U03_END ending everywhere deletes every session of the person and no one else's", async () => {
  const [me, other] = [await person(), await person()];
  await signIn(me); await signIn(me);
  const theirs = await signIn(other);
  assert.equal(await sessions.endAll(me), 2);
  assert.equal((await pool.query("SELECT 1 FROM login_sessions WHERE person_id = $1", [me])).rowCount, 0);
  assert.equal((await sessions.list(other, theirs)).length, 1);
  assert.equal(await sessions.endAll(me), 0);
});

test("U03_INDEX sessions are found by person through an index", async () => {
  const { rows } = await pool.query("SELECT indexdef FROM pg_indexes WHERE tablename = 'login_sessions' AND indexname = 'login_sessions_person_id_idx'");
  assert.match(rows[0]?.indexdef ?? "", /\(person_id\)/);
});
