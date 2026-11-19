import assert from "node:assert/strict";
import { test } from "node:test";
import pg from "pg";
import { runMigrations } from "@studenthub/db";
import { assertDisposableFixturePool, resetPayAwareFixture } from "./helpers/pay-aware-fixture-reset.js";

test("disposable owner reset restores all three guards on success and SQL failure", async () => {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    await runMigrations(pool);
    const enabled = async () => (await pool.query(`SELECT tgname,tgenabled FROM pg_trigger
      WHERE tgname IN ('pay_line_audit_no_truncate','pay_transfer_lines_no_truncate','pay_transfers_no_truncate')
      ORDER BY tgname`)).rows;
    const expected = ["pay_line_audit_no_truncate", "pay_transfer_lines_no_truncate", "pay_transfers_no_truncate"]
      .map(tgname => ({ tgname, tgenabled: "O" }));
    assert.deepEqual(await enabled(), expected);
    await resetPayAwareFixture(pool, "TRUNCATE catalogue_items CASCADE");
    assert.deepEqual(await enabled(), expected);
    await assert.rejects(resetPayAwareFixture(pool, "TRUNCATE missing_fixture_table CASCADE"), { code: "42P01" });
    assert.deepEqual(await enabled(), expected);
    await resetPayAwareFixture(pool, "TRUNCATE catalogue_items CASCADE");
    assert.deepEqual(await enabled(), expected);
  } finally { await pool.end(); }
});

test("fixture scope assertion checks inert pool options before any database use", () => {
  const local = "postgres://localhost/fixture_test";
  const remote = "postgres://example.invalid/fixture_test";
  const ci = "postgres://postgres@localhost:55432/studenthub_authz";
  const fakePool = (connectionString: string) => ({ options: { connectionString } });
  const ciEnv = {
    DATABASE_URL: ci, GITHUB_ACTIONS: "true", RUNNER_ENVIRONMENT: "github-hosted",
    GITHUB_REPOSITORY: "BAWES-Universe/studenthub-platform", GITHUB_WORKFLOW: "Platform CI",
    GITHUB_JOB: "application-checks", GITHUB_EVENT_NAME: "pull_request", GITHUB_RUN_ID: "1",
  };
  assert.throws(() => assertDisposableFixturePool(fakePool(local), {}), /exact DATABASE_URL/);
  assert.throws(() => assertDisposableFixturePool(fakePool(local), { DATABASE_URL: local }), /attestation/);
  assert.doesNotThrow(() => assertDisposableFixturePool(fakePool(local), { DATABASE_URL: local, TEST_DISPOSABLE_DATABASE_URL: local }));
  assert.throws(() => assertDisposableFixturePool(fakePool(remote), { DATABASE_URL: remote, TEST_DISPOSABLE_DATABASE_URL: remote }), /explicit local disposable database/);
  assert.throws(() => assertDisposableFixturePool(fakePool(ci), { DATABASE_URL: ci, CI: "true" }), /attestation/);
  assert.doesNotThrow(() => assertDisposableFixturePool(fakePool(ci), ciEnv));
  assert.throws(() => assertDisposableFixturePool(fakePool(ci), { ...ciEnv, RUNNER_ENVIRONMENT: "self-hosted" }), /attestation/);
  assert.throws(() => assertDisposableFixturePool(fakePool(local), { ...ciEnv, DATABASE_URL: local }), /attestation/);
});
