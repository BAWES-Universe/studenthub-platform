/**
 * @studenthub/db — the platform's Postgres data layer (SHU-55).
 *
 * Deliberately thin: one AuthzStore implementation behind the EXACT
 * contracts interfaces, a versioned migration runner, and admin seeding.
 * Raw `pg` only — no ORM, no query builder (architecture decision, SHU-55).
 */
export * from "./profile/index.js";
export * from "./access/index.js";
export * from "./catalogue/index.js";
export * from "./organizations/index.js";
export * from "./pay-contracts/index.js";
export * from "./ops/index.js";
export * from "./documents/index.js";
export * from "./notifications/index.js";
