/** One-case diagnostic only. Never replaces the required full CI matrix. */
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import {execFileSync} from 'node:child_process';
import path from 'node:path';
import {runOneE2Diagnostic,universeEmbedE2Names} from './universe-embed-e2.mjs';
import {withE2Browser} from './e2-browser-process.mjs';
import {safeE2Failure} from './e2-safe-progress.mjs';
const name=process.argv[2]??'universe-e2-signin-return-en-390';
const report={diagnosticOnly:true,fullMatrixAcceptance:'NOT_ESTABLISHED',case:name,status:'NOT_RUN'};
let stage='preflight';
try {
  assert.ok(universeEmbedE2Names.includes(name),'Known E2 case required');
  const sourceRevision=execFileSync('git',['rev-parse','HEAD'],{encoding:'utf8'}).trim();
  assert.match(sourceRevision,/^[a-f0-9]{40}$/);
  const require=createRequire(import.meta.url);
  const manifest=JSON.parse(await readFile(path.join(path.dirname(require.resolve('playwright-core/package.json')),'browsers.json'),'utf8'));
  const expectedVersion=manifest.browsers.find(x=>x.name==='chromium').browserVersion;
  const {chromium}=await import('playwright');
  stage='browser-launch';
  await withE2Browser({chromium,expectedVersion},async browser=>{
    stage='case';
    await runOneE2Diagnostic({browser,sourceRevision,screenshot:async()=>undefined,run:async(_name,action)=>{
      try {await action();report.status='PASS';}
      catch(error){report.status='FAIL';report.failure=safeE2Failure(error)??{failureKind:'operation'};process.exitCode=1;}
    }},name);
  });
} catch {report.blockedStage=stage;process.exitCode=1;}
process.stdout.write(JSON.stringify(report)+'\n');
