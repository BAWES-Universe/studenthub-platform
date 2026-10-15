import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const path=new URL("../../../dist/packages/pay-contracts/src/contract-changes.js",import.meta.url);
const suite=fileURLToPath(new URL("../../../dist/packages/pay-contracts/test/contract-changes.test.js",import.meta.url));
const original=await readFile(path,"utf8");
const mutations=[
 ["terms check accepts every value","payContractTermsValue(normalized) !== value","false","SHU-318/AC-01 conformance"],
 ["overlap rethrown","error.code === \"overlapping_contract\" || error.code === \"contract_changed\"","error.code === \"contract_changed\"","SHU-318/AC-02 overlap-on-update-refused"],
 ["stale accepted","return current === expected;","return true;","SHU-318/AC-03 stale-confirm"],
 ["end date dropped","...(value.endDate === undefined ? {} : { endDate: value.endDate })","...({})","SHU-318/AC-04 before-is-current"],
 ["retired switch accepted","normalized.currencyId !== old.currencyId","false","SHU-318/AC-05 retired-currency-refused"],
 ["spent token not looked up","input.store.tokenUsed !== undefined &&","false &&","SHU-318/AC-06 replayed-token"],
];
try{for(const[index,[name,from,to,test]]of mutations.entries()){assert.equal(original.split(from).length-1,1,`mutation binds exactly once: ${name}`);await writeFile(path,original.replace(from,to));const r=spawnSync(process.execPath,["--test-reporter=tap",`--test-name-pattern=^${test} `,suite],{encoding:"utf8",timeout:30000,env:{...process.env,SHU318_TEST_MODULE:`${fileURLToPath(path)}?mutation=${index}`}}),out=r.stdout+r.stderr;assert.notEqual(r.status,0,`${name}: mutation survived`);assert.match(out,new RegExp(`not ok \\d+ - ${test} `),`${name}: child failed without named assertion (${r.error?.message??r.status})\n${out}`);await writeFile(path,original);}}finally{await writeFile(path,original)}
console.log("6/6 SHU-318 mutations killed");
