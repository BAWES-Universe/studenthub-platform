import assert from "node:assert/strict";
import {test} from "node:test";
import {TEST_SECRET,type CommitInput,type SafeWriteStore} from "@studenthub/safe-write-contract";
import * as normal from "../src/status-writes.js";

const subject=process.env.SHU313_TEST_MODULE?await import(process.env.SHU313_TEST_MODULE) as typeof normal:normal;

test("SHU-313/AC-01 unchanged-no-event",()=>{
  assert.equal(subject.organizationStatusEvent("active","active"),null);
  assert.equal(subject.organizationStatusEvent(null,"none"),null);
  for(const value of ["active","under_review","inactive"] as const)assert.equal(subject.organizationStatusEvent(value,value),null);
});

test("SHU-313/AC-02 transition-recorded",()=>{
  assert.deepEqual(subject.organizationStatusEvent("under_review","active"),{from:"under_review",to:"active"});
  assert.deepEqual(subject.organizationStatusEvent(null,"inactive"),{from:null,to:"inactive"});
});

test("SHU-313/AC-03 clear-is-null",()=>{
  assert.deepEqual(subject.organizationStatusEvent("active","none"),{from:"active",to:null});
});

test("SHU-313 real status write records only committed changes",async()=>{
  const org="org-a",principal=subject.organizationStatusPrincipalRef("staff"),record=subject.organizationStatusRecordRef(org);
  let value:string|null=null,stale=false;
  const events:Array<{from:string|null;to:string|null}>=[];
  const store:SafeWriteStore={
    ownedRecord:()=>record,
    readField:()=>value,
    commit:(input:CommitInput)=>{
      if(stale){value="inactive";stale=false}
      if(!subject.organizationStatusStateDecision(value,input.expectedBefore))return {ok:false,reason:"state_changed"};
      const event=subject.organizationStatusEvent(value,input.value);
      value=input.value==="none"?null:input.value;
      if(event)events.push(event);
      return {ok:true};
    },
  };
  const writer=subject.buildOrganizationStatusWrite({store,secret:TEST_SECRET});
  const change={personRef:record,field:"status",value:"active"};
  const first=await writer.preview({principalRef:principal,change});assert.ok(first.ok);
  const committed=await writer.confirm({principalRef:principal,change,token:first.token});assert.ok(committed.ok);
  assert.deepEqual(events,[{from:null,to:"active"}]);
  const same=await writer.preview({principalRef:principal,change});assert.ok(same.ok);
  const unchanged=await writer.confirm({principalRef:principal,change,token:same.token});assert.ok(unchanged.ok);
  assert.equal(events.length,1);
  const stalePreview=await writer.preview({principalRef:principal,change:{...change,value:"under_review"}});assert.ok(stalePreview.ok);stale=true;
  assert.deepEqual(await writer.confirm({principalRef:principal,change:{...change,value:"under_review"},token:stalePreview.token}),{ok:false,reason:"state_changed"});
  assert.equal(events.length,1);
});

test("SHU335_HISTORY_VIEW returns normalized newest-first entries without leaking row fields",()=>{
  const instant="2025-01-02T03:04:05.000Z";
  const rows=[
    {from_status:"under_review",to_status:"active",occurred_at:new Date("2025-01-01T00:00:00.000Z"),receipt_ref:"secret-1"},
    {from_status:"active",to_status:"inactive",occurred_at:instant,receipt_ref:"secret-2"},
    {from_status:"inactive",to_status:null,occurred_at:"2025-01-03T00:00:00.000Z",receipt_ref:"secret-3"},
  ];
  const history=subject.organizationStatusHistoryView(rows);
  assert.deepEqual(history,[
    {from:"inactive",to:null,occurredAt:"2025-01-03T00:00:00.000Z"},
    {from:"active",to:"inactive",occurredAt:instant},
    {from:"under_review",to:"active",occurredAt:"2025-01-01T00:00:00.000Z"},
  ]);
  assert.deepEqual(Object.keys(history[0]!).sort(),["from","occurredAt","to"]);
  assert.equal(new Date(instant).toISOString(),history[1]!.occurredAt);
});

test("SHU335_HISTORY_LIMIT returns exactly the newest 50 rows",()=>{
  const rows=Array.from({length:60},(_,i)=>({from_status:null,to_status:"active",occurred_at:new Date(Date.UTC(2025,0,1,0,0,i)).toISOString()}));
  const history=subject.organizationStatusHistoryView(rows);
  assert.equal(history.length,50);
  assert.deepEqual(history.map(row=>row.occurredAt),rows.slice(10).reverse().map(row=>row.occurred_at));
});
