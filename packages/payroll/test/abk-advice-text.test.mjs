import test from 'node:test';
import assert from 'node:assert/strict';
import { generateAbkAdviceText } from '../../../dist/packages/payroll/src/abk-advice-text.js';
const contract={batchId:'T9001V1',date:'11/19/2026',currency:'KWD',debitAccount:'00000001',originCode:'000',newline:'\n'};
const lines=[
 {tcId:'101',beneficiaryName:'SYNTHETIC ONE',beneficiaryIban:'KW00ABKK000000000001234',bankIbanCode:'ABKK',bankSwiftCode:'SYNTHKW0',currency:'KWD',paidAmount:'11.250'},
 {tcId:'102',beneficiaryName:'SYNTHETIC TWO',beneficiaryIban:'KW00TEST000000000000099',bankIbanCode:'TEST',bankSwiftCode:'OTHERKW0',currency:'KWD',paidAmount:'7.375'},
];
// Independent literal oracle, not joined/formatted using production helpers.
const golden='FHR,T9001V1,11/19/2026,2,18.625;\nAPO,00000001,000,SYNTHETIC ONE,001234,KW,ABKK,KW,KW,KW,KW,KW,KWD,11.250,WIB,SYNTHKW0XXX,OBS,S 101,O,,,,,,,;\nAPO,00000001,000,SYNTHETIC TWO,KW00TEST000000000000099,KW,TEST,KW,KW,KW,KW,KW,KWD,7.375,KASIP,OTHERKW0XXX,OBS,S 102,O,,,,,,,;\n';
test('LF exact byte contract: no padding/BOM, blank tail fields, source order and trailing newline',()=>{
 assert.deepEqual(generateAbkAdviceText(lines,contract),new Uint8Array(Buffer.from(golden,'utf8')));
 assert.equal(golden.split('\n')[1].split(',').length,26);
});
test('explicit CRLF exact bytes and no mixed newline',()=>{
 const actual=Buffer.from(generateAbkAdviceText(lines,{...contract,newline:'\r\n'}));
 assert.deepEqual(actual,Buffer.from(golden.replaceAll('\n','\r\n')));
 assert.equal(actual.toString().replaceAll('\r\n','').includes('\n'),false);
});
test('UTF8 Arabic literal bytes, no BOM or replacement chars',()=>{
 const bytes=Buffer.from(generateAbkAdviceText([{...lines[0],beneficiaryName:'ألف'}],contract));
 assert.ok(bytes.includes(Buffer.from([0xd8,0xa3,0xd9,0x84,0xd9,0x81])));
 assert.notEqual(bytes.subarray(0,3).toString('hex'),'efbbbf');
 assert.equal(bytes.toString().includes('\ufffd'),false);
});
test('empty input reproduces zero-count header-only legacy shape',()=>{
 assert.equal(Buffer.from(generateAbkAdviceText([],contract)).toString(),'FHR,T9001V1,11/19/2026,0,0.000;\n');
});
test('exact integer-fils sum and zero amounts',()=>{
 const result=Buffer.from(generateAbkAdviceText([{...lines[0],paidAmount:'0.001'},{...lines[1],paidAmount:'0.009'}],contract)).toString();
 assert.ok(result.startsWith('FHR,T9001V1,11/19/2026,2,0.010;\n'));
 assert.ok(Buffer.from(generateAbkAdviceText([{...lines[0],paidAmount:'0.000'}],contract)).toString().includes(',0.000,WIB,'));
});
test('rounding is outside this generator; correction retry is deterministic',()=>{
 assert.throws(()=>generateAbkAdviceText([{...lines[0],paidAmount:'11.2505'}],contract));
 assert.deepEqual(generateAbkAdviceText(lines,contract),generateAbkAdviceText(lines,contract));
});
for(const value of ['BAD,NAME','BAD;NAME','BAD\r\nAPO','BAD\u0000','\ud800']) test('reject unescaped/invalid name '+JSON.stringify(value),()=>assert.throws(()=>generateAbkAdviceText([{...lines[0],beneficiaryName:value}],contract)));
test('duplicates, mixed currency, negative amounts, invalid batch/date/newline fail closed',()=>{
 assert.throws(()=>generateAbkAdviceText([lines[0],lines[0]],contract));
 assert.throws(()=>generateAbkAdviceText([{...lines[0],currency:'USD'}],contract));
 assert.throws(()=>generateAbkAdviceText([{...lines[0],paidAmount:'-1.000'}],contract));
 for(const change of [{batchId:'T1V1\nAPO'},{date:'02/29/2025'},{date:'13/01/2026'},{newline:'\r'}]) assert.throws(()=>generateAbkAdviceText(lines,{...contract,...change}));
 assert.doesNotThrow(()=>generateAbkAdviceText(lines,{...contract,date:'02/29/2024'}));
});
