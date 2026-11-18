import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {withE2Browser} from './e2-browser-process.mjs';
function fake(version='pinned') {
 const state={closed:0,options:null};
 const browser={version:()=>version,close:async()=>{state.closed++;}};
 return {state,browser,chromium:{launch:async options=>{state.options=options;return browser;}}};
}
test('E2 resolver options are confined to its own process and close on success',async()=>{
 const f=fake();const result=await withE2Browser({chromium:f.chromium,expectedVersion:'pinned'},async browser=>{assert.equal(browser,f.browser);return 'done';});
 assert.equal(result,'done');assert.equal(f.state.closed,1);
 assert.deepEqual(f.state.options,{headless:true,channel:'chromium',args:['--host-resolver-rules=MAP *.browser.test 127.0.0.1, EXCLUDE localhost','--no-proxy-server']});
});
test('E2 process closes after a matrix failure or version mismatch',async()=>{
 const f=fake();await assert.rejects(withE2Browser({chromium:f.chromium,expectedVersion:'pinned'},async()=>{throw Error('synthetic matrix failure');}),/synthetic matrix failure/);assert.equal(f.state.closed,1);
 const wrong=fake('wrong');await assert.rejects(withE2Browser({chromium:wrong.chromium,expectedVersion:'pinned'},async()=>assert.fail('must not run')),/must match pinned/);assert.equal(wrong.state.closed,1);
});
test('baseline and BFCache launches preserve the original paired-launch contract',async()=>{
 const runner=await readFile(new URL('./run.mjs',import.meta.url),'utf8');
 assert.ok(runner.includes("browser=await chromium.launch({headless:true,channel:'chromium'});"));
 assert.ok(runner.includes("bfcacheBrowser=await chromium.launch({headless:true,channel:'chromium',ignoreDefaultArgs:['--disable-back-forward-cache']});"));
 assert.equal(runner.includes('--host-resolver-rules'),false);
 assert.equal(runner.includes('--no-proxy-server'),false);
 assert.ok(runner.includes('await runUniverseEmbedE2({browser:e2Browser,'));
 assert.ok(runner.indexOf('await withE2Browser(')>runner.indexOf('await runUniverseEmbed({'));
});
