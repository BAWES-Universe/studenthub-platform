import assert from "node:assert/strict";
import test from "node:test";
import { ABK_SOURCE_HEADERS, abkWorkbookSpec } from "../../../dist/packages/payroll/src/abk-workbook.js";
import { toAbkXlsxSheetData } from "../../../dist/packages/payroll/src/abk-xlsx-encoder.js";

const worksheet=() => abkWorkbookSpec([
  {tcId:"101",currency:"KWD",amount:"11.250",beneficiaryName:"Stored Name",
    beneficiaryIban:"KW00ABKK000000000001234",snapshotBank:{ibanCode:"ABKK",swiftCode:"OLDKW000"},
    candidate:{bankAccountName:"=1+1",bank:{abkCode:"7"}}},
  {tcId:"102",currency:"KWD",amount:"0.000",beneficiaryName:"Stored Name",
    beneficiaryIban:"KW00ABKK0000000001234",snapshotBank:{ibanCode:"ABKK",swiftCode:"OLDKW000"},
    candidate:{bankAccountName:" Synthetic ألف & <Two> 🪐 ",bank:null}},
],{headers:ABK_SOURCE_HEADERS,sheetName:"Worksheet",debitAccount:"00000001"});

function withCell(r,c,value) {
  const spec=worksheet();
  const rows=spec.rows.map(row=>[...row]);
  rows[r][c]=value;
  return {...spec,rows};
}

test("explicit cell types retain both identifier forms, formula-like names, Unicode, blanks and numeric amounts",()=>{
  const data=toAbkXlsxSheetData(worksheet());
  assert.deepEqual(data[0].map(cell=>cell.value),ABK_SOURCE_HEADERS);
  assert.ok(data[0].every(cell=>cell.type===String));
  assert.deepEqual(data[1][0],{value:"00000001",type:String});
  assert.deepEqual(data[1][1],{value:"=1+1",type:String});
  assert.deepEqual(data[1][2],{value:"001234",type:String});
  assert.deepEqual(data[1][4],{value:"007",type:String});
  assert.deepEqual(data[1][11],{value:11.25,type:Number});
  assert.deepEqual(data[2][1],{value:" Synthetic ألف & <Two> 🪐 ",type:String});
  assert.deepEqual(data[2][2],{value:"1234",type:String});
  assert.equal(data[2][4],null);
  assert.deepEqual(data[2][11],{value:0,type:Number});
});
test("refuses unchecked cell objects, wrong layout, non-finalized numbers, and ambiguous XML text",()=>{
  for(const v of [{value:"x",type:"Formula"},null,0,"hi\rthere","x\uFFFD","_x0041_","\ud800","\u{1fffe}"]) {
    assert.throws(()=>toAbkXlsxSheetData(withCell(1,1,v)));
  }
  for(const v of [null,"11.250",Infinity,-1,1.0001,1_000_000_000_000]) {
    assert.throws(()=>toAbkXlsxSheetData(withCell(1,11,v)));
  }
  const spec=worksheet();
  assert.throws(()=>toAbkXlsxSheetData({...spec,rows:[spec.rows[0]]}));
  assert.throws(()=>toAbkXlsxSheetData({...spec,rows:[spec.rows[0],[]]}));
  assert.throws(()=>toAbkXlsxSheetData({...spec,sheetName:"foo/bar"}));
});
test("copy is detached from mutable source rows for an asynchronous writer",()=>{
  const spec=worksheet();
  const data=toAbkXlsxSheetData(spec);
  spec.rows[1][1]="changed after preparation";
  assert.equal(data[1][1].value,"=1+1");
});
