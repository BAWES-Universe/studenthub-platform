/** E2-only DNS/proxy configuration must never alter the baseline/BFCache pair. */
import assert from 'node:assert/strict';
export async function withE2Browser({chromium,expectedVersion},run) {
  const browser=await chromium.launch({headless:true,channel:'chromium',args:[
    '--host-resolver-rules=MAP *.browser.test 127.0.0.1, EXCLUDE localhost',
    '--no-proxy-server',
  ]});
  try {
    assert.equal(browser.version(),expectedVersion,'E2 Chromium must match pinned Playwright manifest');
    return await run(browser);
  } finally {await browser.close();}
}
