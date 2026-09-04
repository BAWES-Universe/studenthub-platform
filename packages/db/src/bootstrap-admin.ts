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
 * SECOND-ADMIN GUARD (Opus amendment): this refuses to create a second
 * platform admin even when the caller "just wants to re-run bootstrap".
 * The one-admin property lives in the DATA, not in a deployment flag: if any
 * admin grant at the root org already exists and is not byte-identical to
 * the one this run would create, the process exits non-zero with a clear
 * error. Re-running with the exact same principal+grant is a no-op success.
 *
 * Exit codes: 0 ok / no-op, 1 missing env or forbidden second admin or any
 * store error. The store's pbuuid-ownership rules still apply: if
 * BOOTSTRAP_ADMIN_PBUUID already belongs to another principal the
 * registration throws and we exit non-zero — an email cannot be silently
 * re-homed to a new admin.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

import { PostgresAuthzStore } from "./postgres-authz-store.js";
import { runMigrations } from "./migrate.js";
import { databaseUrl } from "./connection.js";

const ROOT_ORG_ID = "root";
const ROOT_ORG_NAME = "StudentHub";

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `BOOTSTRAP_ADMIN_PBUUID: environment variable ${name} is required ` +
        "(the admin principal's pbuuid; under sub_mode=user_email this is the admin's email)",
    );
  }
  return value.trim();
}

async function main(): Promise<void> {
  const pbuuid = requireEnv("BOOTSTRAP_ADMIN_PBUUID");
  const displayName = process.env.BOOTSTRAP_ADMIN_NAME?.trim() || undefined;
  const adminId = `principal-${pbuuid}`;

  const pool = new pg.Pool({ connectionString: databaseUrl() });
  const store = new PostgresAuthzStore(pool);
  try {
    // Schema first: bootstrap must be runnable against a brand-new database.
    await runMigrations(pool);

    // --- Second-admin guard, checked BEFORE any write ----------------------
    const { rows } = await pool.query<{ principal_id: string; scope: string }>(
      "SELECT principal_id, scope FROM grants WHERE org_id = $1 AND role = 'admin'",
      [ROOT_ORG_ID],
    );
    if (rows.length > 0) {
      const identical = rows.every(
        (row) => row.principal_id === adminId && row.scope === "subtree",
      );
      if (!identical) {
        const owners = [...new Set(rows.map((row) => row.principal_id))].join(", ");
        throw new Error(
          `refusing to create a second platform admin: an admin grant at org ` +
            `'${ROOT_ORG_ID}' already exists for principal(s): ${owners}. ` +
            `Bootstrap is idempotent ONLY for the exact same principal + grant; ` +
            `resolve the existing admin before bootstrapping another one.`,
        );
      }
      // Exact same admin already bootstrapped: no-op success. Rows still
      // fall through to the upserts below, which are idempotent no-ops.
    }

    await store.upsertOrganization({ id: ROOT_ORG_ID, name: ROOT_ORG_NAME });
    await store.registerPrincipal({
      id: adminId,
      pbuuids: [pbuuid],
      displayName,
    });
    await store.grantMany(adminId, [
      { orgId: ROOT_ORG_ID, role: "admin", scope: "subtree" },
    ]);

    const done = rows.length > 0 ? "already present (no-op)" : "created";
    console.log(
      `db: platform admin ${done}: principal '${adminId}' (pbuuid '${pbuuid}') ` +
        `role 'admin' scope 'subtree' at org '${ROOT_ORG_ID}'`,
    );
  } finally {
    // The store does not own the pool we injected, so close it explicitly.
    await store.close();
    await pool.end();
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((error: unknown) => {
    console.error("db: bootstrap:admin failed:", error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
