import assert from "node:assert/strict";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import test from "node:test";
import { handleOrganizationProfile, createOrganizationProfileWrite } from "../src/organization-profile.js";
import { organizationProfileRecordRef, safeWritePrincipalRef } from "@studenthub/db";
import type { SafeWriteStore } from "@studenthub/safe-write-contract";

test("SHU-300 HTTP real handler previews an owner write with hardened headers",async()=>{
  const principalId="owner-http"; const orgId="org-http";
  const store:SafeWriteStore={ownedRecord:p=>p===safeWritePrincipalRef(principalId)?organizationProfileRecordRef(orgId):null,
    readField:()=>"Before",commit:()=>({ok:true})};
  const service=createOrganizationProfileWrite({sessions:{get:async()=>({personId:principalId} as never)},
    store:{forPrincipal:()=>store,readReceipt:async()=>null},secret:"http-organization-profile-test-secret"});
  const request=Readable.from([JSON.stringify({orgId,field:"website",value:"https://example.test"})]) as IncomingMessage;
  request.url="/organizations/profile/preview"; request.method="POST";
  request.headers={origin:"https://hub.example","content-type":"application/json",cookie:`__Host-studenthub_session=${"s".repeat(43)}`};
  let status=0;let headers:Record<string,string>={};let payload="";let sent=false;
  const response={get headersSent(){return sent;},writeHead(code:number,next:Record<string,string>){status=code;headers=next;sent=true;},
    end(value:string){payload=value;},destroy(){}} as unknown as ServerResponse;
  assert.equal(await handleOrganizationProfile(request,response,service,"https://hub.example"),true);
  assert.equal(status,200); assert.equal(headers["x-content-type-options"],"nosniff");
  assert.equal(headers["referrer-policy"],"no-referrer");
  assert.equal((JSON.parse(payload) as {changes:unknown[]}).changes.length,1);
});
