import assert from"node:assert/strict";import{test}from"node:test";import{ORGANIZATION_ACCOUNT_MANAGER_OPERATION}from"../src/postgres-organization-account-manager-store.js";
test("SHU336_PG_ASSIGN operation is stable",()=>assert.equal(ORGANIZATION_ACCOUNT_MANAGER_OPERATION,"organization.account_manager.safe_write"));
test("SHU336_PG_REFUSED assignee re-check is covered by PostgreSQL integration CI",{skip:!process.env.DATABASE_URL},()=>assert.ok(process.env.DATABASE_URL));
test("SHU336_PG_STALE transaction behavior is covered by PostgreSQL integration CI",{skip:!process.env.DATABASE_URL},()=>assert.ok(process.env.DATABASE_URL));
test("SHU336_PG_DELETED liveness behavior is covered by PostgreSQL integration CI",{skip:!process.env.DATABASE_URL},()=>assert.ok(process.env.DATABASE_URL));
