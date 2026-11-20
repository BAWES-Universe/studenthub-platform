import assert from"node:assert/strict";import{test}from"node:test";import{NotificationsService,NotificationKindRegistry,NOTIFICATION_KINDS,NOTIFICATION_REGISTRY,organizationStatusChangedKind,recordNotification,type FeedRow,type NotificationEvent,type NotificationKindDefinition}from"../src/notifications.js";
import{recordOrganizationStatusChanged}from"@studenthub/db";
const row=(overrides:Partial<NotificationEvent<"organization.status_changed">>={}):NotificationEvent=>({id:"8b116ac4-6500-48a0-b6ba-2c0d18ce7d91",recipientPrincipalId:"owner",kind:"organization.status_changed",subjectReference:"organization:org",parameters:{status:"inactive"},createdAt:"2026-01-01T00:00:00Z",readAt:null,...overrides});
test("SHU188_EVENT event recording preserves closed data and deduplicates",async()=>{const stored=new Map<string,unknown>();const port={async record(e:{recipientPrincipalId:string;dedupeKey:string}){stored.set(`${e.recipientPrincipalId}:${e.dedupeKey}`,e)}};const event={recipientPrincipalId:"owner",kind:"organization.status_changed" as const,subjectReference:"organization:org" as const,parameters:{status:"inactive" as const},dedupeKey:"receipt"};await recordNotification(port,event);await recordNotification(port,event);assert.equal(stored.size,1);assert.deepEqual([...stored.values()][0],event)});
test("SHU188_EVENT producer SQL deduplicates the real transaction write",async()=>{let sql="",values:unknown[]=[];await recordOrganizationStatusChanged({async query(text:string,input?:unknown[]){sql=text;values=input??[];return{} as never}} as never,"org","inactive","receipt");assert.match(sql,/ON CONFLICT\(recipient_principal_id,dedupe_key\) DO NOTHING/);assert.deepEqual(values,["org","organization:org",JSON.stringify({status:"inactive"}),"receipt"])});
test("SHU188_RENDER current name, visibility and fixed reads render the page",async()=>{let reads=0;const events={async list(){reads++;return[row(),row({id:"c947e15e-71dc-4cf0-aad4-607e11bcbfde",subjectReference:"organization:hidden"})]},async markRead(){return true},async markAllRead(){}};const subjects={async readOrganizations(){reads++;return[{id:"org",name:"Renamed company"},{id:"hidden",name:"Forbidden"}]},async liveOrganizationIds(){reads++;return new Set(["org","hidden"])}};const authz={async listGrantsForPrincipal(){reads++;return[{id:"g",principalId:"owner",orgId:"org",role:"org-owner" as const,scope:"self" as const}]}};const page=await new NotificationsService(events,subjects,authz).list("owner");assert.equal(reads,4);assert.equal(page.items.length,1);assert.match(page.items[0]!.text,/Renamed company.*Inactive/);assert.doesNotMatch(JSON.stringify(page),/Forbidden/)});
test("SHU188_RENDER deleted companies are excluded from feed and unread count",async()=>{const events={async list(){return[row()]},async countVisibleUnread(){return 0},async markRead(){return true},async markAllRead(){}};const service=new NotificationsService(events,{async readOrganizations(){return[{id:"org",name:"Deleted company"}]},async liveOrganizationIds(){return new Set<string>()}},{async listGrantsForPrincipal(){return[{id:"g",principalId:"owner",orgId:"org",role:"org-owner" as const,scope:"self" as const}]}});assert.deepEqual((await service.list("owner")).items,[]);assert.equal(await service.count("owner"),0)});
test("SHU188_FEED read ownership is passed to storage and missing ids stay missing",async()=>{const calls:string[][]=[];const service=new NotificationsService({async list(){return[]},async markRead(recipient,id){calls.push([recipient,id]);return recipient==="owner"},async markAllRead(){}},{async readOrganizations(){return[]},async liveOrganizationIds(){return new Set()}},{async listGrantsForPrincipal(){return[]}});assert.equal(await service.markRead("owner","opaque"),true);assert.equal(await service.markRead("other","opaque"),false);assert.deepEqual(calls,[["owner","opaque"],["other","opaque"]])});
const staffRow=(id:string,messageId:string,readAt:string|null=null):NotificationEvent=>({id,recipientPrincipalId:"person",kind:"staff.message",subjectReference:`staff_message:${messageId}`,parameters:{},createdAt:"2026-01-02T00:00:00Z",readAt});
test("COMMS_FEED_STAFF staff messages render at read time beside organization rows, with one extra read",async()=>{let reads=0;const asked:string[][]=[];const events={async list(){reads++;return[staffRow("a","0f6a1c2e-1111-4a3a-9e2f-000000000001"),row({id:"b",recipientPrincipalId:"person"}),staffRow("c","0f6a1c2e-2222-4a3a-9e2f-000000000002","2026-01-03T00:00:00Z"),staffRow("d","0f6a1c2e-3333-4a3a-9e2f-000000000003")]},async markRead(){return true},async markAllRead(){}};const subjects={async readOrganizations(){reads++;return[{id:"org",name:"Company"}]},async liveOrganizationIds(){reads++;return new Set(["org"])},async readStaffMessages(recipient:string,ids:readonly string[]){reads++;asked.push([recipient,...ids]);return[{id:"0f6a1c2e-1111-4a3a-9e2f-000000000001",kind:"message" as const,body:"Bring your contract"},{id:"0f6a1c2e-2222-4a3a-9e2f-000000000002",kind:"civil_id_request" as const,body:null}]}};const authz={async listGrantsForPrincipal(){reads++;return[{id:"g",principalId:"person",orgId:"org",role:"org-owner" as const,scope:"self" as const}]}};const page=await new NotificationsService(events,subjects,authz).list("person");assert.equal(reads,5);assert.deepEqual(asked,[["person","0f6a1c2e-1111-4a3a-9e2f-000000000001","0f6a1c2e-2222-4a3a-9e2f-000000000002","0f6a1c2e-3333-4a3a-9e2f-000000000003"]]);assert.deepEqual(page.items.map(i=>[i.id,i.text,i.href,i.read]),[["a","Message from StudentHub: Bring your contract","/notifications",false],["b","Company status changed to Inactive.","/workspace?org_id=org&role=org-owner",false],["c","StudentHub asked you to add your civil ID.","/profile/civil-id",true]]);assert.equal(page.unreadCount,2)});
test("COMMS_FEED_STAFF a page without staff rows does not read staff messages",async()=>{let staffReads=0;const service=new NotificationsService({async list(){return[row()]},async markRead(){return true},async markAllRead(){}},{async readOrganizations(){return[]},async liveOrganizationIds(){return new Set<string>()},async readStaffMessages(){staffReads++;return[]}},{async listGrantsForPrincipal(){return[]}});await service.list("owner");assert.equal(staffReads,0)});
test("COMMS_FEED_WORK work decisions render the date and outcome and link to that day's hours history",async()=>{const rows:NotificationEvent[]=[{id:"w1",recipientPrincipalId:"person",kind:"work.session_approved",subjectReference:"work_session:s1",parameters:{workDate:"2026-11-10"},createdAt:"2026-11-11T00:00:00Z",readAt:null},{id:"w2",recipientPrincipalId:"person",kind:"work.session_rejected",subjectReference:"work_session:s2",parameters:{workDate:"2026-11-09"},createdAt:"2026-11-10T00:00:00Z",readAt:"2026-11-10T01:00:00Z"}];const page=await new NotificationsService({async list(){return rows},async markRead(){return true},async markAllRead(){}},{async readOrganizations(){return[]},async liveOrganizationIds(){return new Set<string>()}},{async listGrantsForPrincipal(){return[]}}).list("person");assert.deepEqual(page.items.map(i=>[i.text,i.href,i.read]),[["Your hours for 2026-11-10 were approved.","/work/history/2026-11-10",false],["Your hours for 2026-11-09 were rejected.","/work/history/2026-11-09",true]]);assert.equal(page.unreadCount,1)});

const emptySubjects={async readOrganizations(){return[]},async liveOrganizationIds(){return new Set<string>()}},noGrants={async listGrantsForPrincipal(){return[]}};
const feedRow=(id:string,kind:string,subjectReference:string,parameters:unknown):FeedRow=>({id,recipientPrincipalId:"person",kind,subjectReference,parameters,createdAt:"2026-11-12T00:00:00Z",readAt:null});
test("COMMS_FEED_REGISTRY the registry holds every stored kind and owns each kind's payload check",()=>{
 assert.deepEqual(NOTIFICATION_REGISTRY.kinds(),[...NOTIFICATION_KINDS]);
 assert.equal(NOTIFICATION_REGISTRY.accepts({kind:"organization.status_changed",subjectReference:"organization:org",parameters:{status:"active"}}),true);
 assert.equal(NOTIFICATION_REGISTRY.accepts({kind:"organization.status_changed",subjectReference:"organization:org",parameters:{status:"active",extra:1}}),false);
 assert.equal(NOTIFICATION_REGISTRY.accepts({kind:"staff.message",subjectReference:"staff_message:not-a-uuid",parameters:{}}),false);
 assert.equal(NOTIFICATION_REGISTRY.accepts({kind:"work.session_approved",subjectReference:"work_session:s1",parameters:{workDate:"2026-02-29"}}),false);
 assert.equal(NOTIFICATION_REGISTRY.accepts({kind:"work.session_approved",subjectReference:"work_session:s1",parameters:{workDate:"2026-02-28"}}),true);
 assert.equal(NOTIFICATION_REGISTRY.accepts({kind:"unknown.kind",subjectReference:"x:y",parameters:{}}),false);
 assert.throws(()=>new NotificationKindRegistry([organizationStatusChangedKind,organizationStatusChangedKind]),/duplicate/);
 assert.throws(()=>new NotificationKindRegistry([{...organizationStatusChangedKind,kind:"Bad Kind"}]),/invalid/);
});
test("COMMS_FEED_REGISTRY recording refuses a payload the kind's check rejects",async()=>{
 const port={async record(){}};
 await assert.rejects(recordNotification(port,{recipientPrincipalId:"p",kind:"work.session_approved",subjectReference:"work_session:s1",parameters:{workDate:"2026-13-01"},dedupeKey:"k"}),/payload/);
});
test("COMMS_FEED_REGISTRY a new kind renders through one registration, with no change to the feed",async()=>{
 const reads:string[][]=[];
 const badge:NotificationKindDefinition={kind:"test.badge_awarded",subject:r=>r.startsWith("badge:")?r.slice(6):null,parameters:v=>typeof v==="object"&&v!==null&&Object.keys(v).length===0,async render(rows){reads.push(rows.map(r=>r.id));return new Map(rows.map(r=>[r.id,{text:`You earned ${r.subjectReference.slice(6)}.`,href:"/badges"}]))}};
 const registry=new NotificationKindRegistry([...NOTIFICATION_REGISTRY.kinds().map(k=>NOTIFICATION_REGISTRY.get(k)!),badge]);
 const rows=[feedRow("a","test.badge_awarded","badge:first-shift",{}),feedRow("b","work.session_approved","work_session:s1",{workDate:"2026-11-10"}),feedRow("c","test.badge_awarded","wrong:ref",{}),feedRow("d","other.unregistered","x:y",{})];
 const page=await new NotificationsService({async list(){return rows},async markRead(){return true},async markAllRead(){}},emptySubjects,noGrants,registry).list("person");
 assert.deepEqual(page.items.map(i=>[i.id,i.text,i.href]),[["a","You earned first-shift.","/badges"],["b","Your hours for 2026-11-10 were approved.","/work/history/2026-11-10"]]);
 assert.deepEqual(reads,[["a"]]);
});
test("COMMS_FEED_TYPES the types filter is checked against the registry and narrows the stored read",async()=>{
 const asked:(readonly string[]|undefined)[]=[];
 const rows=[feedRow("w","work.session_rejected","work_session:s2",{workDate:"2026-11-09"}),feedRow("o","organization.status_changed","organization:org",{status:"active"})];
 const service=new NotificationsService({async list(_r,_l,_o,kinds){asked.push(kinds);return rows},async markRead(){return true},async markAllRead(){}},emptySubjects,noGrants);
 assert.deepEqual((await service.list("person",1,["work.session_rejected","work.session_rejected"])).items.map(i=>i.id),["w"]);
 await service.list("person",1);
 assert.deepEqual(asked,[["work.session_rejected"],undefined]);
 await assert.rejects(service.list("person",1,["work.session_rejected","nope"]),/unknown notification type/);
 assert.equal(asked.length,2);
 assert.deepEqual(NOTIFICATION_REGISTRY.types(["staff.message"]),["staff.message"]);
 assert.equal(NOTIFICATION_REGISTRY.types(["staff.message","Staff.Message"]),null);
});
test("COMMS_FEED_REGISTRY dates and enums match the database rule exactly",()=>{
 const work=(workDate:unknown)=>NOTIFICATION_REGISTRY.accepts({kind:"work.session_rejected",subjectReference:"work_session:s1",parameters:{workDate}});
 assert.deepEqual(["2028-02-29","0001-01-01","2026-12-31"].map(work),[true,true,true]);
 assert.deepEqual(["2026-02-29","0000-01-01","2026-04-31","2026-13-01",20261110,null].map(work),[false,false,false,false,false,false]);
 const status=(value:unknown)=>NOTIFICATION_REGISTRY.accepts({kind:"organization.status_changed",subjectReference:"organization:org",parameters:{status:value}});
 assert.deepEqual(["active","under_review","inactive","none","toString","constructor","Active"].map(status),[true,true,true,true,false,false,false]);
});
test("COMMS_FEED_RECRUIT each recruit event renders from the request as it is now, links to the right list, and reads its events once a page",async()=>{
 const events=[{id:"1",event:"invitation.sent"},{id:"2",event:"interview.scheduled"},{id:"3",event:"application.shortlisted"},{id:"4",event:"invitation.accepted"},{id:"5",event:"request_application.received"},{id:"6",event:"request_application.rejected"}].map(e=>({...e,requestId:"9b1c/x",positionTitle:"Cashier",companyName:"Acme"}));
 const rows=events.map(e=>feedRow(`n${e.id}`,`recruit.${e.event}`,`recruit_outbox:${e.id}`,{})).concat([feedRow("gone","recruit.invitation.sent","recruit_outbox:77",{}),feedRow("swapped","recruit.interview.cancelled","recruit_outbox:2",{})]);
 const asked:string[][]=[];
 const service=new NotificationsService({async list(){return rows},async markRead(){return true},async markAllRead(){}},{...emptySubjects,async readRecruitEvents(recipient:string,ids:readonly string[]){asked.push([recipient,...ids]);return events}},noGrants);
 const page=await service.list("person");
 assert.deepEqual(page.items.map(i=>[i.id,i.text,i.href]),[
  ["n1","You're invited to apply for Cashier at Acme.","/recruit/invitations"],
  ["n2","Your interview for Cashier at Acme is scheduled.","/recruit/my-interviews"],
  ["n3","You were shortlisted for Cashier at Acme.","/recruit/jobs?applied=1"],
  ["n4","An invitation to Cashier at Acme was accepted.","/recruit/staff/requests/9b1c%2Fx/invitations"],
  ["n5","Someone applied for Cashier at Acme.","/recruit/requests/9b1c%2Fx/applications"],
  ["n6","Your application for Cashier at Acme was not taken forward.","/recruit/open-requests?applied=1"]],"a missing event, or one stored under another kind, is left out");
 assert.equal(asked.length,7,"one read per recruit kind on the page (seven here), never per row");
 assert.ok(asked.every(a=>a[0]==="person"));
 for(const kind of NOTIFICATION_KINDS.filter(k=>k.startsWith("recruit.")))for(const [subjectReference,parameters,ok] of [["recruit_outbox:1",{},true],["recruit_outbox:9223372036854775807",{},true],["recruit_outbox:0",{},false],["recruit_outbox:01",{},false],["recruit_outbox:1",{text:"x"},false],["recruit_outbox:x",{},false],["staff_message:1",{},false]] as const)
  assert.equal(NOTIFICATION_REGISTRY.accepts({kind,subjectReference,parameters}),ok,`${kind} ${subjectReference}`);
 assert.equal(NOTIFICATION_KINDS.filter(k=>k.startsWith("recruit.")).length,11);
});
