#!/usr/bin/env node
/**
 * Seed the platform's first admin (SHU-55).
 *
 * Creates, in order:
 *   - the root organization (id 'root', name 'StudentHub') — the docs
 *     (docs/authz-roles.md) define no canonical root org, so the id/name
 *     chosen here ARE the canonical values; bootstrap is the only writer
 *     that ever touches it,
 *   - the admin principal identified by BOOTSTRAP_ADMIN_PBUUID (required).
 *     Under Authentik sub_mode=user_email the pbuuid IS the human's email,
 *     so this env var is the admin's email address,
 *   - the grant admin/subtree at the root org.
 *
 * SECOND-ADMIN GUARD (Opus amendment, hardened by GPT R3): this refuses to
 * create a second platform admin even when the caller "just wants to re-run
 * bootstrap". The one-admin property lives in the DATA, not in a deployment
 * flag: migration 0002 adds a partial unique index making a second admin
 * grant at the root org impossible at the database, so two CONCURRENT
 * bootstrap processes cannot both pass the pre-write SELECT below and each
 * create an admin. The SELECT is only a friendly fast-path for the common
 * re-run case; the constraint is the enforcement, and a 23505 on
 * one_root_admin_grant is mapped to the same refusal error.
 *
 * Exit codes: 0 ok / no-op, 1 missing env or forbidden second admin or any
 * store error. The store's pbuuid-ownership rules still apply: if
 * BOOTSTRAP_ADMIN_PBUUID already belongs to another principal the
 * registration throws and we exit non-zero — an email cannot be silently
 * re-homed to a new admin.
 *
 * Logging: the pbuuid (an email under sub_mode=user_email) is never logged
 * raw — the success line prints a masked form only (GPT R3 blocker #5).
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { PostgresAuthzStore } from "./postgres-authz-store.js";
import { runMigrations } from "./migrate.js";
import { databaseUrl } from "./connection.js";

const ROOT_ORG_ID = "root";
const ROOT_ORG_NAME = "StudentHub";

/** The partial unique index from migration 0002 — the real second-admin guard. */
const ROOT_ADMIN_INDEX = "one_root_admin_grant";

export type BootstrapResult = "created" | "noop";

function isRootAdminIndexViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: string }).code === "23505" &&
    (error as { constraint?: string }).constraint === ROOT_ADMIN_INDEX
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
  // its admin grant first wins, the other fails on the index below.
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
    // Under concurrency this check can be raced; the partial unique index is
    // the enforcement, and the grantMany catch below maps its 23505 to this
    // same refusal. Owner principal ids embed the pbuuid (an email), so they
    // are masked here like every other log line — never print a raw identity.
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

  const store = new PostgresAuthzStore(pool);
  try {
    await store.upsertOrganization({ id: ROOT_ORG_ID, name: ROOT_ORG_NAME });
    await store.registerPrincipal({
      id: adminId,
      pbuuids: [pbuuid],
      displayName,
    });
    try {
      await store.grantMany(adminId, [
        { orgId: ROOT_ORG_ID, role: "admin", scope: "subtree" },
      ]);
    } catch (error) {
      if (isRootAdminIndexViolation(error)) {
        // The SELECT above raced a concurrent bootstrap: another admin grant
        // committed between our read and this write. The database refused the
        // second root admin — report it as the same refusal as the fast path.
        throw new Error(
          `refusing to create a second platform admin: another admin grant at org ` +
            `'${ROOT_ORG_ID}' was committed concurrently (blocked by database ` +
            `constraint '${ROOT_ADMIN_INDEX}'). Bootstrap is idempotent ONLY for ` +
            `the exact same principal + grant; resolve the existing admin before ` +
            `bootstrapping another one.`,
        );
      }
      throw error;
    }
  } finally {
    // The store does not own the pool we injected, so close it explicitly.
    await store.close();
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
