import assert from "node:assert/strict";
import test from "node:test";
import { inflateRawSync } from "node:zlib";
import { ABK_SOURCE_HEADERS, generateAbkWorkbook } from "../../../dist/packages/payroll/src/abk-workbook.js";
import { nativeAbkXlsxEncoder } from "../../../dist/packages/payroll/src/abk-xlsx-encoder.js";

// Only decode the small synthetic workbook emitted by this test. Read central
// directory sizes so ZIP entries using data descriptors work too.
function fixtureZip(bytes) {
  const data=Buffer.from(bytes);
  assert.equal(data.readUInt32LE(0),0x04034b50);
  const end=data.lastIndexOf(Buffer.from([0x50,0x4b,0x05,0x06]));
  assert.ok(end>=0 && end+22<=data.length);
  const entries=data.readUInt16LE(end+10);
  assert.ok(entries>0 && entries<30);
  const files=new Map();
  let pos=data.readUInt32LE(end+16);
  for(let i=0;i<entries;i++){
    assert.ok(pos+46<=end);
    assert.equal(data.readUInt32LE(pos),0x02014b50);
    const method=data.readUInt16LE(pos+10);
    const comp=data.readUInt32LE(pos+20), size=data.readUInt32LE(pos+24);
    const nameLen=data.readUInt16LE(pos+28), extra=data.readUInt16LE(pos+30), comment=data.readUInt16LE(pos+32);
    const local=data.readUInt32LE(pos+42);
    assert.ok(size<=128_000 && local+30<=end && pos+46+nameLen+extra+comment<=end);
    const name=data.toString("utf8",pos+46,pos+46+nameLen);
    assert.equal(data.readUInt32LE(local),0x04034b50);
    const start=local+30+data.readUInt16LE(local+26)+data.readUInt16LE(local+28);
    assert.ok(start+comp<=end);
    const input=data.subarray(start,start+comp);
    assert.ok(method===0 || method===8);
    const raw=method===0 ? input : inflateRawSync(input,{maxOutputLength:128_000});
    assert.equal(raw.length,size);
    files.set(name,raw.toString("utf8"));
    pos+=46+nameLen+extra+comment;
  }
  return files;
}

test("native ABK XLSX writer emits ordered headers, explicit identifier text and numeric amount",async()=>{
  const bytes=await generateAbkWorkbook([{
    tcId:"101",currency:"KWD",amount:"11.250",beneficiaryName:"Stored Synthetic",
    beneficiaryIban:"KW00ABKK000000000001234",
    snapshotBank:{ibanCode:"ABKK",swiftCode:"SYNTHKW0"},
    candidate:{bankAccountName:"=1+1",bank:{abkCode:"7"}},
  }],{headers:ABK_SOURCE_HEADERS,sheetName:"Worksheet",debitAccount:"00000001"},nativeAbkXlsxEncoder);
  const entries=fixtureZip(bytes);
  assert.match(entries.get("xl/workbook.xml"),/<sheet\b[^>]*\bname="Worksheet"/);
  const xml=entries.get("xl/worksheets/sheet1.xml");
  assert.equal(typeof xml,"string");
  const shared=entries.get("xl/sharedStrings.xml");
  assert.equal(typeof shared,"string");
  const strings=[...shared.matchAll(/<si><t(?:\s[^>]*)?>([\s\S]*?)<\/t><\/si>/g)].map(match=>match[1]);
  const cells=[...xml.matchAll(/<c\b([^>]*)><v>([^<]*)<\/v><\/c>/g)].map(([,attrs,value])=>{
    const ref=/\br="([^"]+)"/.exec(attrs)?.[1];
    const type=/\bt="([^"]+)"/.exec(attrs)?.[1]??"n";
    return [ref,type,type==="s"?strings[Number(value)]:value];
  });
  assert.deepEqual(cells.filter(([ref])=>["A1","B1","C1","L1","A2","B2","C2","E2","L2"].includes(ref)),
    [["A1","s","Debit Account"],["B1","s","Name"],["C1","s","IBAN"],["L1","s","Amount"],
     ["A2","s","00000001"],["B2","s","=1+1"],["C2","s","001234"],["E2","s","007"],["L2","n","11.25"]]);
  assert.doesNotMatch(xml,/<f(?:\s|>)/);
});
