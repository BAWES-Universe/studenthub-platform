import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const file=new URL("../../../dist/packages/profile/src/civil-id-ocr.js",import.meta.url),suite=fileURLToPath(new URL("../../../dist/packages/profile/test/civil-id-ocr.test.js",import.meta.url));
const mutants=[
 ["OCR_PARSE","expiry = iso;","expiry ??= iso;"],
 ["OCR_PARSE","normalizeCivilIdNumber(raw)","raw"],
 ["OCR_JOB","this.jobs.some(j => j.documentId === p.documentId && j.version === p.version)","false"],
 ["OCR_JOB","if (!current) {","if (false) {"],
 ["OCR_LEASE","job.leaseOwner === owner","true"],
 ["OCR_FAILURE","e instanceof CivilIdOcrError ? e.code : \"provider_unavailable\"","e instanceof Error ? e.message : \"provider_unavailable\""],
 ["OCR_FAILURE","unreadable: !parsed.number && !parsed.expiry","unreadable: false"],
 ["OCR_SECRECY","ciphertext: sealed.ciphertext","ciphertext: Buffer.from(parsed.number)"],
 ["OCR_REVIEW","{ ...r, needsReview: true","{ number: \"OCR-overwrite\", needsReview: true"],
 ["OCR_REVIEW","if (r && !r.needsReview)","if (false)"],
];
let killed=0;for(const[token,from,to]of mutants){const original=await readFile(file,"utf8");assert.equal(original.split(from).length-1,1,`${token} binding: ${from}`);try{await writeFile(file,original.replace(from,to));const result=spawnSync(process.execPath,["--test",`--test-name-pattern=^${token} `,suite],{encoding:"utf8"});assert.notEqual(result.status,0,`${token} mutant survived: ${from}`);killed++;}finally{await writeFile(file,original);}}
console.log(`Killed ${killed} civil ID OCR mutants; Postgres SKIP LOCKED, CHECK and transaction mutants are CI-reviewed.`);
