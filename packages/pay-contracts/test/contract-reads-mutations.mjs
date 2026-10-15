import assert from"node:assert/strict";import{spawnSync}from"node:child_process";import{readFile,writeFile}from"node:fs/promises";import{fileURLToPath}from"node:url";
const path=new URL("../../../dist/packages/pay-contracts/src/contract-reads.js",import.meta.url),suite=fileURLToPath(new URL("../../../dist/packages/pay-contracts/test/contract-reads.test.js",import.meta.url)),original=await readFile(path,"utf8");
const mutations=[
 ["company terms leaked","terms: companyTerms(contract.terms)","terms: contract.terms","SHU-319/AC-01 company-view-whitelist"],
 ["candidate terms leaked","terms: candidateTerms(contract.terms)","terms: contract.terms","SHU-319/AC-02 candidate-view-whitelist"],
 ["recruiter accepted","row.role === \"org-owner\" || row.role === \"finance\"","row.role === \"org-owner\" || row.role === \"finance\" || row.role === \"recruiter\"","SHU-319/AC-03 employer-roles-limited"],
 ["subtree condition dropped","row.scope === \"subtree\" && ancestors.includes(row.org_id)","ancestors.includes(row.org_id)","SHU-319/AC-04 self-grant-on-parent-not-covering"],
 ["deleted retained","contracts.filter((contract) => contract.status !== \"deleted\")","contracts.filter((_contract) => true)","SHU-319/AC-05 deleted-hidden"],
];let killed=0;try{for(const[name,from,to,test]of mutations){assert.equal(original.split(from).length-1,1,`${name} anchor count`);await writeFile(path,original.replace(from,to));const run=spawnSync(process.execPath,["--test","--test-name-pattern",test,suite],{encoding:"utf8"});assert.notEqual(run.status,0,`${name} survived\n${run.stdout}\n${run.stderr}`);killed++;}}finally{await writeFile(path,original)}console.log(`${killed}/5 SHU-319 mutations killed`);
