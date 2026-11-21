import assert from 'node:assert/strict';
import test from 'node:test';
import { ABK_SOURCE_HEADERS, abkWorkbookSpec, generateAbkWorkbook } from '../../../dist/packages/payroll/src/abk-workbook.js';
export const contract = { headers: ABK_SOURCE_HEADERS, sheetName:'Synthetic ABK', debitAccount:'00000001' };
export const lines = [
  {tcId:'101',currency:'KWD',amount:'11.250',beneficiaryName:'Ignored snapshot',beneficiaryIban:'KW00ABKK000000000001234',snapshotBank:{ibanCode:'ABKK',swiftCode:'SYNTHKW0'},candidate:{bankAccountName:'Synthetic ألف & <One>',bank:{abkCode:'7'}}},
  {tcId:'102',currency:'KWD',amount:'7.375',beneficiaryName:'=1+1',beneficiaryIban:'KW00TEST000000000000099',snapshotBank:{ibanCode:'TEST',swiftCode:'OTHERKW0'},candidate:null},
  {tcId:'103',currency:'KWD',amount:'100.000',beneficiaryName:'Ignored',beneficiaryIban:'KW00TEST000000000000100',snapshotBank:{ibanCode:'TEST',swiftCode:'OTHERKW0'},candidate:{bankAccountName:'Synthetic Three',bank:null}},
];
test('literal 17-column source mapping, no total row and exact finalized amounts',()=>{
  const spec=abkWorkbookSpec(lines,contract);
  assert.equal(spec.rows.length,4);
  assert.deepEqual(spec.rows[1],['00000001','Synthetic ألف & <One>','001234','KW','007','KW','KW','Kuwait','KW','KW','KWD',11.25,'Within Bank','SYNTHKW0XXX','Bill Settlement','S 101','OUR']);
  assert.deepEqual(spec.rows[2],['00000001','=1+1','KW00TEST000000000000099','KW',null,'KW','KW','Kuwait','KW','KW','KWD',7.375,'Local Transfers','OTHERKW0XXX','Bill Settlement','S 102','OUR']);
  assert.equal(spec.rows[3][4],null);
  assert.equal(spec.rows.slice(1).reduce((sum,row)=>sum+Math.round(row[11]*1000),0),118625);
});
test('does not mutate input and retains source order',()=>{
  const before=JSON.stringify(lines);
  assert.equal(abkWorkbookSpec([...lines].reverse(),contract).rows[1][15],'S 103');
  assert.equal(JSON.stringify(lines),before);
});
for (const [label,changed] of [['mixed currency',{currency:'USD'}],['unrounded amount',{amount:'0.0005'}],['negative amount',{amount:'-1.000'}],['exponent',{amount:'1e3'}],['precision loss',{amount:'1000000000000.000'}],['XML control',{beneficiaryIban:'BAD\u0000'}],['missing IBAN',{beneficiaryIban:''}]]) {
  test(`rejects ${label}`,()=>assert.throws(()=>abkWorkbookSpec([{...lines[0],...changed}],contract)));
}
test('duplicate IDs, empty batch, missing headers and invalid sheet fail closed',()=>{
  assert.throws(()=>abkWorkbookSpec([lines[0],lines[0]],contract));
  assert.throws(()=>abkWorkbookSpec([],contract));
  assert.throws(()=>abkWorkbookSpec(lines,{...contract,headers:[]}));
  assert.throws(()=>abkWorkbookSpec(lines,{...contract,sheetName:'bad/name'}));
});
test('zero preserved and legacy all-occurrence nine-zero stripping is explicit',()=>{
  const spec=abkWorkbookSpec([{...lines[0],amount:'0.000',beneficiaryIban:'KW00ABKK0000000001200000000034'}],contract);
  assert.equal(spec.rows[1][11],0);
  assert.equal(spec.rows[1][2],'1234');
});
test('validates before invoking encoder and rejects non-ZIP response',async()=>{
  let calls=0; const encoder={async encode(){calls++;return new Uint8Array([1,2,3,4]);}};
  await assert.rejects(()=>generateAbkWorkbook([],contract,encoder));assert.equal(calls,0);
  await assert.rejects(()=>generateAbkWorkbook(lines,contract,encoder));assert.equal(calls,1);
});

test('headers are Yii source-derived, not ignored label strings',()=>{
 assert.deepEqual(ABK_SOURCE_HEADERS,['Debit Account','Name','IBAN','Beneficiary Bank Address','Beneficiary Bank Name','Beneficiary Bank Branch Id','Beneficiary City','Beneficiary Country','Beneficiary Address 1','Beneficiary Address 2','Txn Currency','Amount','Type','Beneficiary Bank Identifier','Purpose Of Transfer','Payment Details','Charge']);
});
test('failed attempt has no retained state; correction retry emits exactly one corrected row',()=>{
 const broken={...lines[0],amount:'11.2505'};
 assert.throws(()=>abkWorkbookSpec([broken],contract));
 const corrected=abkWorkbookSpec([{...broken,amount:'11.250'}],contract);
 assert.equal(corrected.rows.length,2);assert.equal(corrected.rows[1][11],11.25);
 assert.deepEqual(corrected,abkWorkbookSpec([{...broken,amount:'11.250'}],contract));
});
