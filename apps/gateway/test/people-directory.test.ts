import assert from "node:assert/strict";
import test from "node:test";
import type { PeopleDirectoryQuery, PeopleDirectoryRow, PeopleDirectoryStore } from "@studenthub/profile";
import { createPeopleDirectory, parsePeopleDirectoryQuery } from "../src/people-directory.js";
import { REAL_PROFILE_SESSION, startRealProfileServer } from "./helpers/real-profile-server.js";

const row: PeopleDirectoryRow = { principalId: "person-2", name: "Written Name", universeName: "Universe Name", arabicName: "اسم عربي", workStatus: "active", nationality: { id: "11111111-1111-4111-8111-111111111111", name: "Kuwait" }, detailsMissing: 2, civilState: "waiting", imported: true, employeeId: "C00123", phoneLast4: "0000" };

async function fixture(t: Parameters<typeof startRealProfileServer>[0], rows: PeopleDirectoryRow[] = [row]) {
  let calls = 0, choices = 0, seen: [PeopleDirectoryQuery,string][] = [];
  const store: PeopleDirectoryStore = { async page(query,today) { calls++; seen.push([query,today]); return { rows, total: rows.length }; } };
  const f = await startRealProfileServer(t, { peopleStaff: true, now: () => new Date("2026-11-12T22:30:00Z"), extend: services => ({ people: createPeopleDirectory({ sessions: services.sessions, authz: services.authz, store, now: services.now, choices: async () => { choices++; return { countries: [{ id: row.nationality!.id, name: "Kuwait" }] }; } }) }) });
  return { ...f, store, seen, get calls(){return calls}, get choices(){return choices}, json: (path:string,session=REAL_PROFILE_SESSION) => fetch(`${f.url}${path}`,{headers:{accept:"application/json",cookie:f.cookie(session)}}) };
}

test("DIR_ACCESS staff gate is live and hides the route", async t => {
  const f=await fixture(t);
  const noSession=await fetch(`${f.url}/workspace/people`,{headers:{accept:"text/html"}}); assert.equal(noSession.status,401);
  await f.authz.clearGrantsForPrincipal("person-1");
  const ordinaryHtml=await f.get("/workspace/people"),ordinaryJson=await f.json("/workspace/people");
  assert.equal(ordinaryHtml.status,404,"DIR_ACCESS ordinary person is hidden");assert.equal(ordinaryJson.status,404);const hiddenBody=await ordinaryJson.text();assert.equal(hiddenBody,await(await f.json("/workspace/not-a-real-page")).text(),"DIR_ACCESS hidden JSON matches an absent page");
  assert.doesNotMatch(await ordinaryHtml.text(),/href="\/workspace\/people"/);
  (f.login as unknown as {navigation:unknown}).navigation={open:async()=>({status:200,body:{contexts:[{orgId:"root",role:"staff",organizationName:"StudentHub"}],active:{orgId:"root",role:"staff",organizationName:"StudentHub"}}})};
  assert.doesNotMatch(await(await f.get("/workspace?org_id=root&role=staff")).text(),/>People<\/a>/,"DIR_ACCESS sidebar hidden without live staff grant");
  await f.authz.grantMany("person-1",[{orgId:"root",role:"staff",scope:"self"}]);assert.equal((await f.get("/workspace/people")).status,404,"DIR_ACCESS self scope is hidden");assert.doesNotMatch(await(await f.get("/workspace/companies?org_id=root&role=staff")).text(),/>People<\/a>/,"DIR_ACCESS Companies sidebar hidden without live staff grant");
  await f.authz.grantMany("person-1",[{orgId:"other",role:"staff",scope:"subtree"}]);assert.equal((await f.get("/workspace/people")).status,404);
  await f.authz.grantMany("person-1",[{orgId:"root",role:"admin",scope:"subtree"}]);assert.equal((await f.get("/workspace/people")).status,200);
  assert.match(await(await f.get("/workspace?org_id=root&role=staff")).text(),/>People<\/a>/,"DIR_ACCESS sidebar shown for live operator staff");
  assert.doesNotMatch(await(await f.get("/workspace/people")).text(),/href="\/workspace\/people\//);
});

test("DIR_QUERY closed vocabulary rejects before the store and passes Kuwait today", async t => {
  const f=await fixture(t); const before=f.calls;
  assert.equal((await f.json("/workspace/people?q=a&q=b")).status,400,"DIR_QUERY repeated key rejected before store");
  for(const query of ["?wat=1",`?q=${"x".repeat(101)}`,"?status=bad","?nationality=no","?nationality=11111111-1111-6111-8111-111111111111","?civil=bad","?details=bad","?page=0","?page=1000000"]){assert.equal((await f.json(`/workspace/people${query}`)).status,400,query);}
  assert.equal(f.calls,before,"DIR_QUERY repeated key rejected before store");
  const q="?q=Noor&status=active&nationality=11111111-1111-4111-8111-111111111111&civil=waiting&details=missing&page=2";
  assert.equal((await f.json(`/workspace/people${q}`)).status,200);
  assert.deepEqual(f.seen.at(-1),[{q:"Noor",status:"active",nationality:"11111111-1111-4111-8111-111111111111",civil:"waiting",details:"missing",page:2},"2026-11-13"]);
  assert.equal(parsePeopleDirectoryQuery(new URLSearchParams("q="))?.page,1);
});

test("DIR_ROWS HTML and JSON expose the safe matching projection",async t=>{
  const f=await fixture(t),html=await(await f.get("/workspace/people")).text(),json=await(await f.json("/workspace/people")).text();
  for(const fact of ["Written Name","اسم عربي","Actively looking","Kuwait","2 details missing","Waiting","Imported","C00123","•••• 0000"])assert.match(html,new RegExp(fact));
  assert.match(html,/Photo and ID images are checked on the person's page/);assert.match(html,/Until the final import/);assert.doesNotMatch(html,/href="\/workspace\/people\/person-2/);
  const parsed=JSON.parse(json);assert.equal(parsed.total,1);assert.equal(parsed.page,1);assert.equal(parsed.pageSize,25);assert.equal(parsed.rows[0].phone,"•••• 0000","DIR_ROWS full phone is never rendered");
  for(const secret of ["registry@example.invalid","+96550000000","123456789012","civil_front","document"]) { assert.doesNotMatch(html,new RegExp(secret,"i"));assert.doesNotMatch(json,new RegExp(secret,"i")); }
});

test("DIR_ONE_QUERY page cost is one store read and HTML alone reads countries",async t=>{
  for(const count of [0,1,60]){const f=await fixture(t,Array.from({length:count},(_,i)=>({...row,principalId:`p-${i}`})));const calls=f.calls,choices=f.choices;await f.get("/workspace/people");assert.equal(f.calls-calls,1,`DIR_ONE_QUERY HTML ${count}`);assert.equal(f.choices-choices,1);const after=f.calls,c2=f.choices;await f.json("/workspace/people");assert.equal(f.calls-after,1,`DIR_ONE_QUERY JSON ${count}`);assert.equal(f.choices,c2);}
});
