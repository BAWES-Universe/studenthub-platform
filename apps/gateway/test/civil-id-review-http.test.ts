import assert from "node:assert/strict";
import test from "node:test";
import { InMemoryCivilIdReviewStore } from "@studenthub/profile";
import { startRealProfileServer } from "./helpers/real-profile-server.js";

test("REV_FIXES unconfigured civil ID review routes use the closed 404",async t=>{
 const app=await startRealProfileServer(t,{civilIdReview:s=>({store:new InMemoryCivilIdReviewStore({civilStore:s.civilStore}),vault:s.vault,origin:"https://studenthub.test.invalid",now:s.now,isStaff:async()=>true})});
 const response=await app.get("/workspace/civil-ids");
 assert.equal(response.status,404,"REV_FIXES configured storage without StaffDocuments stays unconfigured");
 assert.match(await response.text(),/Not found/,"REV_FIXES unconfigured route has the closed body");
});

test("REV_STAFF unauthenticated civil ID review route is closed",async t=>{
 const app=await startRealProfileServer(t);
 const response=await fetch(`${app.url}/workspace/civil-ids`,{headers:{accept:"text/html"}});
 assert.equal(response.status,404,"REV_STAFF absent review service is not exposed");
});
