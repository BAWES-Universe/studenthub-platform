import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { after, before, test } from "node:test";
import pg from "pg";
import { createOrganization, createPrincipal } from "@studenthub/contracts";
import { PostgresAuthzStore, PostgresOrganizationAccountManagerReads, runMigrations } from "@studenthub/db";
const URL=process.env.DATABASE_URL??"",ROOT=`shu339-root-${randomUUID()}`;let pool:pg.Pool,authz:PostgresAuthzStore,reads:PostgresOrganizationAccountManagerReads;
before(async()=>{if(!URL)throw new Error("DATABASE_URL is required to run the db suite");pool=new pg.Pool({connectionString:URL});await runMigrations(pool);authz=new PostgresAuthzStore(pool);reads=new PostgresOrganizationAccountManagerReads({pool});await authz.upsertOrganization(createOrganization({id:ROOT,name:"operator"}))});after(async()=>pool.end());
test("SHU339_PG_READS batches requested organization managers only",async()=>{const orgs=await Promise.all(Array.from({length:4},async()=>{const id=`shu339-org-${randomUUID()}`;await authz.upsertOrganization(createOrganization({id,name:id,parentOrgId:ROOT}));return id}));const people=await Promise.all([0,1,2].map(async()=>{const id=`shu339-person-${randomUUID()}`;await authz.registerPrincipal(createPrincipal({id,pbuuids:[]}));return id}));await pool.query("INSERT INTO organization_account_managers(org_id,principal_id) VALUES($1,$2),($3,$4),($5,$6)",[orgs[0],people[0],orgs[1],people[1],orgs[3],people[2]]);const found=await reads.readMany(orgs.slice(0,3));assert.equal(found.size,2);assert.equal(found.get(orgs[0]!),people[0]);assert.equal(found.get(orgs[1]!),people[1]);assert.equal(found.has(orgs[2]!),false);assert.equal(found.has(orgs[3]!),false);assert.deepEqual(await reads.readMany([]),new Map())});
