/**
 * Shared connection configuration for the Postgres-backed authz store.
 *
 * DATABASE_URL is the single knob every db entry point (migrate, bootstrap,
 * tests, the store itself) reads. The default below is the SHU-55 LAB
 * database: a localhost-only throwaway Postgres for development and tests —
 * deliberately NOT a secret-bearing production credential. Production wiring
 * always passes DATABASE_URL explicitly.
 */

export const DEFAULT_DATABASE_URL =
  "postgres://postgres:shu55labpw@127.0.0.1:55432/studenthub_authz";

export function databaseUrl(): string {
  return process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
}
