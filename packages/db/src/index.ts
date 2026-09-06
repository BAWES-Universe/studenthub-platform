/**
 * @studenthub/db — the platform's Postgres data layer (SHU-55).
 *
 * Deliberately thin: one AuthzStore implementation behind the EXACT
 * contracts interfaces, a versioned migration runner, and admin seeding.
 * Raw `pg` only — no ORM, no query builder (architecture decision, SHU-55).
 */
export { PostgresAuthzStore } from "./postgres-authz-store.js";
export { runMigrations } from "./migrate.js";
export { bootstrapAdmin, type BootstrapResult } from "./bootstrap-admin.js";
export { DEFAULT_DATABASE_URL, databaseUrl } from "./connection.js";
