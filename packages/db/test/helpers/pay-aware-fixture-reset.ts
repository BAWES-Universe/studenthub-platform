import type pg from "pg";

/** Test-owner administration only. Never import from product code.
 * Require the exact attested local binding, or the hosted Platform CI scratch service.
 * PostgreSQL transactional DDL restores the guard on rollback, including failed
 * TRUNCATE/ENABLE. No session_replication_role or broad trigger disable is used.
 */
export function assertDisposableFixturePool(
  pool: { readonly options: { readonly connectionString?: string | undefined } },
  env: Readonly<NodeJS.ProcessEnv> = process.env,
): void {
  const connectionString = pool.options.connectionString;
  if (!connectionString || env.DATABASE_URL !== connectionString) {
    throw new Error("Fixture reset requires the pool to use the exact DATABASE_URL binding");
  }
  const url = new URL(connectionString);
  if (!["postgres:", "postgresql:"].includes(url.protocol) ||
      !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname) ||
      !/^\/[a-zA-Z0-9_]+$/.test(url.pathname) || ["/postgres", "/template0", "/template1"].includes(url.pathname) || url.search || url.hash) {
    throw new Error("Fixture reset requires an explicit local disposable database");
  }
  // The existing application-checks job provisions this service for each job.
  // A matching database name or loopback address alone is not a CI attestation.
  const hostedScratch =
    env.GITHUB_ACTIONS === "true" &&
    env.RUNNER_ENVIRONMENT === "github-hosted" &&
    env.GITHUB_REPOSITORY?.toLowerCase() === "bawes-universe/studenthub-platform" &&
    env.GITHUB_WORKFLOW === "Platform CI" &&
    env.GITHUB_JOB === "application-checks" &&
    /^(pull_request|push)$/.test(env.GITHUB_EVENT_NAME ?? "") &&
    /^[1-9][0-9]*$/.test(env.GITHUB_RUN_ID ?? "") &&
    url.hostname === "localhost" && url.port === "55432" &&
    url.pathname === "/studenthub_authz" && url.username === "postgres";
  if (!hostedScratch && env.TEST_DISPOSABLE_DATABASE_URL !== connectionString) {
    throw new Error("Fixture reset requires the hosted scratch service or explicit TEST_DISPOSABLE_DATABASE_URL attestation");
  }
}

const guards = [
  ["pay_transfers", "pay_transfers_no_truncate"],
  ["pay_transfer_lines", "pay_transfer_lines_no_truncate"],
  ["pay_line_audit", "pay_line_audit_no_truncate"],
  // A principals reset cascades into the work lane's stand-up tables.
  ["work_standup_answers", "work_standup_answers_no_truncate"],
  ["work_standup_questions", "work_standup_questions_no_truncate"],
] as const;

export async function resetPayAwareFixture(pool: pg.Pool, statement: string): Promise<void> {
  assertDisposableFixturePool(pool);
  if (!/^TRUNCATE [a-z_, ]+(?: RESTART IDENTITY)? CASCADE$/.test(statement)) {
    throw new Error("Fixture reset accepts only a static TRUNCATE table list");
  }
  const client = await pool.connect();
  let destroy = false;
  try {
    await client.query("BEGIN");
    for (const [table, trigger] of guards) await client.query(`ALTER TABLE ${table} DISABLE TRIGGER ${trigger}`);
    await client.query(statement);
    for (const [table, trigger] of guards) await client.query(`ALTER TABLE ${table} ENABLE TRIGGER ${trigger}`);
    await client.query("COMMIT");
  } catch (error) {
    try { await client.query("ROLLBACK"); } catch { destroy = true; }
    throw error;
  } finally {
    client.release(destroy);
  }
}
