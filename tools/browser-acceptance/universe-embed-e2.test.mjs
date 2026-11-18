import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {crossSiteStartupRefused,universeEmbedE2Names} from './universe-embed-e2.mjs';
test('E2 cases are unique and registered in the actual evidence runner',async()=>{
 assert.equal(new Set(universeEmbedE2Names).size,8);
 const runner=await readFile(new URL('./run.mjs',import.meta.url),'utf8');
 assert.ok(runner.includes('...universeEmbedE2Names]'));
 assert.ok(runner.includes('await runUniverseEmbedE2({browser:e2Browser,run,screenshot,sourceRevision:evidence.candidateSha})'));
});
test('E2 production startup refuses unsupported topology',crossSiteStartupRefused);
test('E2 proof uses native cookie delivery and the actual runtime, not browser request substitution',async()=>{
 const browser=await readFile(new URL('./universe-embed-e2.mjs',import.meta.url),'utf8');
 const fixture=await readFile(new URL('./universe-embed-e2-fixture.mjs',import.meta.url),'utf8');
 for(const banned of ['addCookies(','.route(',"dispatchEvent(new Event('visibilitychange'",'ignoreHTTPSErrors: true','bypassCSP: true'])assert.equal(browser.includes(banned),false);
 assert.ok(fixture.includes('new PostgresUniverseEmbedStore(pool)'));
 assert.ok(fixture.includes('new PostgresLoginStore(pool)'));
 assert.ok(fixture.includes("import('../../dist/apps/gateway/src/index.js')"));
});

test('Cancel-retry coverage requires native close/retry and independent completion counts',async()=>{
 assert.ok(universeEmbedE2Names.includes('universe-e2-cancel-retry-en'));
 assert.ok(universeEmbedE2Names.includes('universe-e2-cancel-retry-ar'));
 const browser=await readFile(new URL('./universe-embed-e2.mjs',import.meta.url),'utf8');
 assert.ok(browser.includes('await canceledPopup.close();await page.bringToFront()'));
 assert.ok(browser.includes('sessions:0,handoffs:{pending:1}'));
 assert.ok(browser.includes('sessions:1,handoffs:{superseded:1,consumed:1}'));
 assert.equal(browser.includes('page.reload('),false);
});
