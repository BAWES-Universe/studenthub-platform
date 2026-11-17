import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { after, before, beforeEach, test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { PostgresLoginStore } from "@studenthub/db/access";
import { PostgresUniverseEmbedStore, universeEmbedDigest } from "@studenthub/db/universe";

let pool: pg.Pool;
let store: PostgresUniverseEmbedStore;
let login: PostgresLoginStore;
let person: string;
const ref = () => randomBytes(32).toString("base64url");
const dbNow = async () => Number((await pool.query("SELECT extract(epoch FROM clock_timestamp()) AS now")).rows[0].now);

before(async () => {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required to run the db suite");
  pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  await runMigrations(pool);
  store = new PostgresUniverseEmbedStore(pool);
  login = new PostgresLoginStore(pool);
});
beforeEach(async () => {
  person = `e2-${randomUUID()}`;
  await pool.query("INSERT INTO principals(id) VALUES($1::text)", [person]);
});
after(async () => { if (pool) await pool.end(); });

/** Instance → connect → state → callback completion → /done. */
async function bound() {
  const browser = ref(), cookie = ref(), state = ref(), session = ref();
  const instance = await store.ensureInstance(browser, cookie, 43_200);
  const handoff = await store.createHandoff(instance, browser, 600);
  assert.equal(await store.attachState(handoff, state), true);
  await login.sessions.put({ id: session, personId: person });
  assert.equal(await store.completeHandoff(state, session, person), true);
  assert.equal(await store.consumeHandoff(instance, browser, session), person);
  return { browser, cookie, state, session, instance, handoff };
}

test("E2_DB one instance per browser binding, also under concurrent first loads", async () => {
  const browser = ref();
  const [a, b] = await Promise.all([store.ensureInstance(browser, ref(), 43_200), store.ensureInstance(browser, ref(), 43_200)]);
  assert.equal(a, b);
  const cookie = ref();
  assert.equal(await store.ensureInstance(browser, cookie, 43_200), a);
  assert.equal(await store.findInstance(cookie, browser), a);
  assert.equal(await store.findInstance(cookie, ref()), undefined, "a cookie never names another browser's instance");
});

test("E2_DB a second connect supersedes the first; the older start cannot attach a state", async () => {
  const browser = ref();
  const instance = await store.ensureInstance(browser, ref(), 43_200);
  const h1 = await store.createHandoff(instance, browser, 600);
  const h2 = await store.createHandoff(instance, browser, 600);
  assert.equal(await store.attachState(h1, ref()), false);
  const state = ref();
  assert.equal(await store.attachState(h2, state), true);
  assert.equal(await store.attachState(h2, ref()), false, "a handoff binds one state only");
  const states = (await pool.query("SELECT status FROM universe_embed_handoffs WHERE instance_id=$1 ORDER BY created_at", [instance])).rows;
  assert.deepEqual(states.map(r => r.status), ["superseded", "pending"]);
  // Concurrent connects leave exactly one current handoff.
  await Promise.all([1, 2, 3, 4].map(() => store.createHandoff(instance, browser, 600)));
  const current = (await pool.query("SELECT count(*)::int n FROM universe_embed_handoffs WHERE instance_id=$1 AND status IN ('pending','completed')", [instance])).rows[0].n;
  assert.equal(current, 1);
});

test("E2_DB completion refuses superseded or expired handoffs and /done consumes once, only for the cookie session", async () => {
  const browser = ref();
  const instance = await store.ensureInstance(browser, ref(), 43_200);
  const h1 = await store.createHandoff(instance, browser, 600);
  const s1 = ref();
  await store.attachState(h1, s1);
  await store.createHandoff(instance, browser, 600);
  assert.equal(await store.completeHandoff(s1, ref(), person), false, "superseded");

  const h3 = await store.createHandoff(instance, browser, 600);
  const s3 = ref();
  await store.attachState(h3, s3);
  await pool.query("UPDATE universe_embed_handoffs SET expires_at = clock_timestamp() - interval '1 second' WHERE id=$1", [h3]);
  assert.equal(await store.completeHandoff(s3, ref(), person), false, "expired");

  const ok = await bound();
  assert.equal(await store.consumeHandoff(ok.instance, ok.browser, ok.session), undefined, "already used");
  const other = await store.ensureInstance(ref(), ref(), 43_200);
  assert.equal(await store.consumeHandoff(other, ok.browser, ok.session), undefined);
});

test("E2_DB /done refuses a completed handoff whose session is no longer live", async () => {
  const browser = ref(), state = ref(), session = ref();
  const instance = await store.ensureInstance(browser, ref(), 43_200);
  const handoff = await store.createHandoff(instance, browser, 600);
  await store.attachState(handoff, state);
  await login.sessions.put({ id: session, personId: person });
  await store.completeHandoff(state, session, person);
  await login.sessions.delete(session);
  assert.equal(await store.consumeHandoff(instance, browser, session), undefined);
});

test("E2_DB challenges are one-use and generation-bound; the lease ends at min(iat + 600, session expiry)", async () => {
  const b = await bound();
  const view = await store.readBinding(b.instance, b.browser, b.session);
  assert.deepEqual(view, { personId: person, generation: 0, locked: false });
  const c1 = ref(), c2 = ref();
  assert.equal(await store.issueChallenge(b.instance, b.browser, b.session, c1, 60), true);
  assert.equal(await store.issueChallenge(b.instance, b.browser, b.session, c2, 60), true);
  assert.equal(await store.issueChallenge(b.instance, b.browser, ref(), ref(), 60), false, "another session cannot ask");
  assert.equal(await store.consumeChallenge(b.instance, c1), 0);
  assert.equal(await store.consumeChallenge(b.instance, c1), undefined, "one use");
  const iat = Math.floor(await dbNow()) - 50;
  const expires = await store.writeLease(b.instance, 0, "subject@example.test", iat, 600);
  assert.equal(expires!.getTime() / 1000, iat + 600, "late attestation: lease ends at iat + 600, not receipt + 600");
  assert.equal(await store.consumeChallenge(b.instance, c2), undefined, "an old-generation challenge cannot renew");
  assert.equal(await store.writeLease(b.instance, 0, "subject@example.test", iat, 600), undefined, "stale generation");
  const leased = await store.readBinding(b.instance, b.browser, b.session);
  assert.equal(leased?.generation, 1);
  assert.equal(leased?.lease?.hostSubjectDigest, universeEmbedDigest("subject@example.test"));

  // Session expiry caps the lease.
  await pool.query("UPDATE login_sessions SET expires_at = clock_timestamp() + interval '120 seconds' WHERE id=$1", [universeEmbedDigest(b.session)]);
  const c3 = ref();
  await store.issueChallenge(b.instance, b.browser, b.session, c3, 60);
  assert.equal(await store.consumeChallenge(b.instance, c3), 1);
  const capped = await store.writeLease(b.instance, 1, "subject@example.test", Math.floor(await dbNow()), 600);
  assert.ok(capped!.getTime() / 1000 <= (await dbNow()) + 121);
  // An attestation whose iat + 600 is already past writes no lease.
  const c4 = ref();
  await store.issueChallenge(b.instance, b.browser, b.session, c4, 60);
  await store.consumeChallenge(b.instance, c4);
  assert.equal(await store.writeLease(b.instance, 2, "subject@example.test", Math.floor(await dbNow()) - 700, 600), undefined);
});

test("E2_DB lock, invalidation and stored digests", async () => {
  const b = await bound();
  await pool.query("INSERT INTO external_identities(issuer, subject, person_id, locked_at, locked_reason) VALUES ('https://issuer.test', $1, $2, now(), 'stable_id_mismatch')", [`${person}@example.test`, person]);
  assert.equal((await store.readBinding(b.instance, b.browser, b.session))?.locked, true);
  assert.deepEqual(await store.identitySubjects(person, "https://issuer.test"), [`${person}@example.test`]);
  await store.invalidateBinding(b.instance);
  assert.equal(await store.readBinding(b.instance, b.browser, b.session), undefined);
  // No plaintext bearer reference is stored anywhere.
  const dump = JSON.stringify((await pool.query(
    `SELECT (SELECT json_agg(i) FROM universe_embed_instances i) a, (SELECT json_agg(r) FROM universe_embed_instance_refs r) b,
            (SELECT json_agg(h) FROM universe_embed_handoffs h) c, (SELECT json_agg(x) FROM universe_embed_bindings x) d,
            (SELECT json_agg(y) FROM universe_embed_challenges y) e`)).rows);
  for (const value of [b.browser, b.cookie, b.state, b.session]) assert.equal(dump.includes(value), false);
});
