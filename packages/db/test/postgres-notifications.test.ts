import assert from "node:assert/strict";
import {randomUUID} from "node:crypto";
import {readFile} from "node:fs/promises";
import {after, before, test} from "node:test";
import pg from "pg";
import {createOrganization, createPrincipal} from "@studenthub/contracts";
import {PostgresAuthzStore, PostgresNotificationsStore, runMigrations} from "@studenthub/db";
import {NotificationFeed} from "../../notifications/src/notifications.js";

test("SHU188_EVENT notification schema stores events without text and indexes feed lookups", async () => {
  const sql=await readFile(new URL("../migrations/0352_notifications.sql",import.meta.url),"utf8");
  assert.match(sql,/kind text NOT NULL CHECK/);assert.match(sql,/UNIQUE \(recipient_principal_id, dedupe_key\)/);
  assert.match(sql,/recipient_principal_id, read_at, created_at DESC/);assert.doesNotMatch(sql,/message|rendered_text|company_name/);
});

const DB_URL=process.env.DATABASE_URL??"";
let pool:pg.Pool,authz:PostgresAuthzStore,store:PostgresNotificationsStore;
before(async()=>{if(!DB_URL)throw new Error("DATABASE_URL is required to run the db suite");pool=new pg.Pool({connectionString:DB_URL});await runMigrations(pool);authz=new PostgresAuthzStore(pool);store=new PostgresNotificationsStore({pool})});
after(async()=>pool?.end());

test("SHU188_FEED postgres store pages 25 newest and read mutations are recipient-owned",async()=>{
  const owner=`shu188-feed-owner-${randomUUID()}`,other=`shu188-feed-other-${randomUUID()}`,org=`shu188-feed-org-${randomUUID()}`;
  for(const id of[owner,other])await authz.registerPrincipal(createPrincipal({id,pbuuids:[],email:`${id}@example.invalid`}));
  await authz.upsertOrganization(createOrganization({id:org,name:"Current company"}));await authz.grantMany(owner,[{orgId:org,role:"org-owner"}]);
  for(let i=0;i<26;i++)await pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_ref,parameters,dedupe_key,created_at) VALUES($1,'organization.status_changed',$2,$3::jsonb,$4,$5)",[owner,`organization:${org}`,JSON.stringify({status:"active"}),`receipt-${i}`,new Date(Date.UTC(2026,0,1,0,0,i))]);
  const otherRow=await pool.query<{id:string}>("INSERT INTO notifications(recipient_principal_id,kind,subject_ref,parameters,dedupe_key) VALUES($1,'organization.status_changed',$2,$3::jsonb,'other-receipt') RETURNING id",[other,`organization:${org}`,JSON.stringify({status:"active"})]);
  const page=await store.list(owner,1,25);assert.equal(page.length,25);assert.equal(page[0]?.createdAt.toString(),new Date(Date.UTC(2026,0,1,0,0,25)).toString());assert.equal(await store.countUnread(owner),26);
  assert.equal(await store.markRead(owner,otherRow.rows[0]!.id),false);assert.equal(await store.markRead(other,otherRow.rows[0]!.id),true);assert.equal(await store.markRead(owner,page[0]!.id),true);assert.equal(await store.countUnread(owner),25);await store.markAllRead(owner);assert.equal(await store.countUnread(owner),0);
});

test("SHU188_RENDER postgres feed uses current names and omits revoked and deleted subjects from feed and count",async()=>{
  const owner=`shu188-render-owner-${randomUUID()}`,org=`shu188-render-org-${randomUUID()}`;await authz.registerPrincipal(createPrincipal({id:owner,pbuuids:[],email:`${owner}@example.invalid`}));await authz.upsertOrganization(createOrganization({id:org,name:"Old company"}));await authz.grantMany(owner,[{orgId:org,role:"org-owner"}]);
  await pool.query("INSERT INTO notifications(recipient_principal_id,kind,subject_ref,parameters,dedupe_key) VALUES($1,'organization.status_changed',$2,$3::jsonb,$4)",[owner,`organization:${org}`,JSON.stringify({status:"under_review"}),randomUUID()]);await pool.query("UPDATE organizations SET name='Renamed company' WHERE id=$1",[org]);
  const feed=new NotificationFeed(store,store);assert.equal((await feed.list(owner))[0]?.text,"Renamed company status changed to Under review.");assert.equal(await feed.count(owner),1);await pool.query("DELETE FROM grants WHERE principal_id=$1 AND org_id=$2",[owner,org]);assert.deepEqual(await feed.list(owner),[]);assert.equal(await feed.count(owner),0);
  await authz.grantMany(owner,[{orgId:org,role:"org-owner"}]);await pool.query("INSERT INTO organization_deletions(org_id,receipt_ref) VALUES($1,$2)",[org,randomUUID().replaceAll("-","").padEnd(64,"0")]);assert.deepEqual(await feed.list(owner),[]);assert.equal(await feed.count(owner),0);
});
