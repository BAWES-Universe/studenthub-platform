import assert from "node:assert/strict";
import test from "node:test";
import pg from "pg";
import { PostgresOrganizationProfileStore, organizationProfileRecordRef, safeWritePrincipalRef } from "../src/index.js";

const database=process.env.DATABASE_URL;
test("SHU-300 Postgres store refuses a stale confirm atomically",{skip:database?false:"DATABASE_URL is required by test:db"},async()=>{
  const pool=new pg.Pool({connectionString:database}); const suffix=`shu300_${Date.now()}`; const principal=`${suffix}_owner`,org=`${suffix}_org`;
  await pool.query("INSERT INTO organizations(id,name) VALUES($1,$1)",[org]);
  await pool.query("INSERT INTO principals(id) VALUES($1)",[principal]);
  await pool.query("INSERT INTO grants(principal_id,org_id,role,scope) VALUES($1,$2,'org-owner','self')",[principal,org]);
  await pool.query("INSERT INTO organization_profiles(org_id,website) VALUES($1,'before')",[org]);
  const store=new PostgresOrganizationProfileStore({pool});
  try{
    const port=store.forPrincipal(principal,org); await pool.query("UPDATE organization_profiles SET website='concurrent' WHERE org_id=$1",[org]);
    const outcome=await port.commit({personRef:organizationProfileRecordRef(org),principalRef:safeWritePrincipalRef(principal),tokenId:"token",
      field:"website",expectedBefore:"before",value:"after",changeSetDigest:"a".repeat(64),receipt:{contractVersion:"3.0.0",receiptRef:"b".repeat(64),
        personRef:organizationProfileRecordRef(org),principalRef:safeWritePrincipalRef(principal),changeSetDigest:"a".repeat(64),fields:["website"],committedAt:new Date().toISOString()}});
    assert.deepEqual(outcome,{ok:false,reason:"state_changed"});
    assert.equal((await pool.query("SELECT website FROM organization_profiles WHERE org_id=$1",[org])).rows[0].website,"concurrent");
  }finally{await pool.query("DELETE FROM principals WHERE id=$1",[principal]);await pool.query("DELETE FROM organizations WHERE id=$1",[org]);await pool.end();}
});
