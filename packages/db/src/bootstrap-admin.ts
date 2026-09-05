#!/usr/bin/env node
/**
 * Seed the platform's first admin (SHU-55).
 *
 * Creates, in order, inside ONE transaction:
 *   - the root organization (id 'root', name 'StudentHub') — the docs
 *     (docs/authz-roles.md) define no canonical root org, so the id/name
 *     chosen here ARE the canonical values; bootstrap is the only writer
 *     that ever touches it,
 *   - the admin principal identified by BOOTSTRAP_ADMIN_PBUUID (required).
 *     Under Authentik sub_mode=user_email the pbuuid IS the human's email,
 *     so this env var is the admin's email address,
 *   - the grant admin/subtree at the root org.
 *
 * SECOND-ADMIN GUARD (Opus amendment, hardened by GPT R3): refuses to create
 * a second platform admin even when the caller "just wants to re-run
 * bootstrap". The one-admin property lives in the DATA, not in a deployment
 * flag:
 *   - migration 0002 adds a partial unique index (one_root_admin_grant)
 *     making a second admin grant at the root org impossible at the database —
 *     the enforcement, whatever the caller does,
 *   - the SELECT below is only a friendly fast-path for the sequential
 *     re-run-with-a-different-identity case,
 *   - the writes run in ONE transaction (GPT R3, round 2): if the grant is
 *     rejected by the index (a concurrent bootstrap won the race), the whole
 *     transaction rolls back — the losing principal and pbuuid are NOT left
 *     behind. A rejected bootstrap leaves zero trace.
 *
 * The writes are direct SQL mirroring PostgresAuthzStore's registerPrincipal
 * and grantMany semantics exactly, because those methods each own their own
 * transaction and cannot share one — and bootstrap must be atomic.
 *
 * Exit codes: 0 ok / no-op, 1 missing env or forbidden second admin or any
 * store error. If BOOTSTRAP_ADMIN_PBUUID already belongs to another principal
 * the registration throws and we exit non-zero — an email cannot be silently
 * re-homed to a new admin.
 *
 * Logging: the pbuuid (an email under sub_mode=user_email) is never logged
 * raw — success and refusal lines print masked forms only (GPT R3, round 1).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { runMigrations } from "./migrate.js";
import { databaseUrl } from "./connection.js";

const ROOT_ORG_ID = "root";
const ROOT_ORG_NAME = "StudentHub";

/** The partial unique index from migration 0002 — the real second-admin guard. */
const ROOT_ADMIN_INDEX = "one_root_admin_grant";
/** The pbuuid ownership backstop from migration 0001 (principal_pbuuids PK). */
const PBUUID_INDEX = "principal_pbuuids_pkey";

export type BootstrapResult = "created" | "noop";

function isUniqueViolation(
  error: unknown,
): error is { readonly code: string; readonly constraint?: string } {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505"
  );
}

/** Mask an email-like pbuuid for logs: never print the raw identity. */
function maskPbuuid(pbuuid: string): string {
  const at = pbuuid.lastIndexOf("@");
  if (at > 0) return `${pbuuid.slice(0, 1)}***${pbuuid.slice(at)}`;
  return `${pbuuid.length > 8 ? pbuuid.slice(0, 3) : ""}…(${pbuuid.length} chars)`;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `${name}: environment variable is required (the admin principal's pbuuid; ` +
        "under sub_mode=user_email this is the admin's email)",
    );
  }
  return value.trim();
}

/**
 * Create the platform's first admin on the given pool. Exported separately
 * from the CLI wrapper so the concurrency regression test can race two
 * independent bootstraps (two pools) against one database.
 *
 * @returns "created" when the admin grant did not exist before this run,
 *          "noop" when the identical principal + grant was already present.
 */
export async function bootstrapAdmin(
  pool: pg.Pool,
  options: { readonly pbuuid: string; readonly displayName?: string },
): Promise<BootstrapResult> {
  const { pbuuid, displayName } = options;
  const adminId = `principal-${pbuuid}`;

  // Schema first: bootstrap must be runnable against a brand-new database.
  await runMigrations(pool);

  // --- Second-admin guard, friendly fast path -----------------------------
  // Not the enforcement — migration 0002's partial unique index is. Two
  // concurrent bootstraps can both read zero rows here; whichever commits
  // its admin grant first wins, the other fails on the index inside the
  // transaction below and rolls back completely.
  const { rows } = await pool.query<{ principal_id: string; scope: string }>(
    "SELECT principal_id, scope FROM grants WHERE org_id = $1 AND role = 'admin'",
    [ROOT_ORG_ID],
  );
  // `identical` must require at least one matching row: [].every() is
  // vacuously true, which would mislabel a first-ever run as a no-op.
  const identical =
    rows.length > 0 &&
    rows.every(
      (row) => row.principal_id === adminId && row.scope === "subtree",
    );
  if (rows.length > 0 && !identical) {
    // Fast-path refusal for the common re-run-with-a-different-identity case.
    // Owner principal ids embed the pbuuid (an email), so they are masked
    // here like every other log line — never print a raw identity.
    const owners = [
      ...new Set(
        rows.map((row) => maskPbuuid(row.principal_id.replace(/^principal-/, ""))),
      ),
    ].join(", ");
    throw new Error(
      `refusing to create a second platform admin: an admin grant at org ` +
        `'${ROOT_ORG_ID}' already exists (owner principal id masked in logs: ` +
        `principal-${owners}). Bootstrap is idempotent ONLY for the exact same ` +
        `principal + grant; resolve the existing admin before bootstrapping ` +
        `another one.`,
    );
  }

  // --- One transaction: org + principal + pbuuid + grant -------------------
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    await client.query(
      `INSERT INTO organizations (id, name, parent_org_id)
       VALUES ($1, $2, NULL)
       ON CONFLICT (id) DO UPDATE SET name = EXCLUDED.name`,
      [ROOT_ORG_ID, ROOT_ORG_NAME],
    );
    await client.query(
      `INSERT INTO principals (id, display_name, email)
       VALUES ($1, $2, NULL)
       ON CONFLICT (id) DO UPDATE SET display_name = EXCLUDED.display_name`,
      [adminId, displayName ?? null],
    );
    // Stale-mapping removal, same as PostgresAuthzStore.registerPrincipal:
    // drop every pbuuid row this principal previously owned before inserting
    // the current set.
    await client.query("DELETE FROM principal_pbuuids WHERE principal_id = $1", [
      adminId,
    ]);
    await client.query(
      "INSERT INTO principal_pbuuids (principal_id, pbuuid) VALUES ($1, $2)",
      [adminId, pbuuid],
    );
    await client.query(
      `INSERT INTO grants (principal_id, org_id, role, scope)
       VALUES ($1, $2, 'admin', 'subtree')
       ON CONFLICT (principal_id, org_id, role) DO UPDATE SET
         scope = CASE
           WHEN grants.scope = 'subtree' OR EXCLUDED.scope = 'subtree'
             THEN 'subtree'
           ELSE grants.scope
         END`,
      [adminId, ROOT_ORG_ID],
    );

    await client.query("COMMIT");
  } catch (error) {
    // A failing ROLLBACK (e.g. connection dropped) must not mask the original
    // error — the server aborts the transaction on disconnect anyway.
    try {
      await client.query("ROLLBACK");
    } catch {
      // Swallow: the original error below is the one the caller needs.
    }

    if (isUniqueViolation(error)) {
      if (error.constraint === ROOT_ADMIN_INDEX) {
        // The fast-path SELECT raced a concurrent bootstrap: another admin
        // grant committed between our read and this write. The database
        // refused the second root admin AND rolled back our principal — zero
        // trace, exactly the atomicity requirement.
        throw new Error(
          `refusing to create a second platform admin: another admin grant at ` +
            `org '${ROOT_ORG_ID}' was committed concurrently (blocked by ` +
            `database constraint '${ROOT_ADMIN_INDEX}'; the whole bootstrap ` +
            `transaction rolled back). Bootstrap is idempotent ONLY for the ` +
            `exact same principal + grant; resolve the existing admin before ` +
            `bootstrapping another one.`,
        );
      }
      if (error.constraint === PBUUID_INDEX) {
        // The pbuuid is owned by another principal (pbuuid PK backstop).
        // Identify the owner best-effort for the message — enforcement
        // already happened in the constraint.
        let ownerId: string | undefined;
        try {
          const ownerRows = await client.query<{ principal_id: string }>(
            "SELECT principal_id FROM principal_pbuuids WHERE pbuuid = $1",
            [pbuuid],
          );
          ownerId = ownerRows.rows[0]?.principal_id;
        } catch {
          // Diagnostics are best-effort; fall through to the generic message.
        }
        throw new TypeError(
          ownerId === undefined
            ? `pbuuid '${maskPbuuid(pbuuid)}' registration conflict: it is owned ` +
              `by another principal (or was between our read and write)`
            : `pbuuid '${maskPbuuid(pbuuid)}' is already owned by principal ` +
              `'${maskPbuuid(ownerId.replace(/^principal-/, ""))}'; detach it ` +
              `before registering it as the bootstrap admin`,
        );
      }
    }
    throw error;
  } finally {
    client.release();
  }

  return identical ? "noop" : "created";
}

async function main(): Promise<void> {
  const pbuuid = requireEnv("BOOTSTRAP_ADMIN_PBUUID");
  const displayName = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || undefined;

  const pool = new pg.Pool({ connectionString: databaseUrl() });
  try {
    const result = await bootstrapAdmin(pool, { pbuuid, displayName });
    const done = result === "noop" ? "already present (no-op)" : "created";
    // Masked pbuuid only — the raw identity never reaches the logs.
    console.log(
      `db: platform admin ${done}: role 'admin' scope 'subtree' at org ` +
        `'${ROOT_ORG_ID}' (pbuuid '${maskPbuuid(pbuuid)}')`,
    );
  } finally {
    await pool.end();
  }
}

// Run only when executed directly (`node dist/bootstrap-admin.js`), not when
// imported by the test suite.
if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error("db: bootstrap:admin failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
