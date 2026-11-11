/** E1 only: real gateway, trusted loopback TLS and native Chromium framing/CSP.
 * No provider, session, database, deployment or live enablement is involved.
 * Imports of the compiled gateway are deferred so --initialize-report still
 * works before dependencies and the build are installed.
 */
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:https';

export const universeEmbedNames = [
  'universe-embed-allowed-parent-external-script',
  'universe-embed-inline-eval-blocked',
  'universe-embed-unapproved-parent-blocked',
  'universe-embed-unapproved-outer-ancestor-blocked',
  'universe-embed-disabled-host-isolation',
  'universe-embed-default-off-host-isolation',
];

const shell = '/universe/embed';
const script = '/universe/embed/embed.js';
const title = 'StudentHub in Universe';
const scope = 'Synthetic E1 inert surface only; no E2 sign-in or live deployment acceptance.';

async function createEmbedFixture(sourceRevision) {
  const certPath = process.env.BROWSER_ACCEPTANCE_TLS_CERT || process.env.TLS_CERT_PATH;
  const keyPath = process.env.BROWSER_ACCEPTANCE_TLS_KEY || process.env.TLS_KEY_PATH;
  assert.ok(certPath && keyPath, 'Existing trusted browser TLS certificate and key are required');
  const [{ createGatewayServer }, { createUniverseEmbedConfigFromEnv }] = await Promise.all([
    import('../../dist/apps/gateway/src/index.js'),
    import('../../dist/apps/gateway/src/universe/embed-policy.js'),
  ]);
  const tls = { cert: await readFile(certPath), key: await readFile(keyPath) };
  const servers = [], requests = [];
  let gateway, embedOrigin, parentOrigin;
  const close = async () => {
    for (const server of servers.reverse()) {
      server.closeAllConnections();
      if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    }
  };
  async function listen(handler) {
    const server = createServer(tls, handler);
    servers.push(server);
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, 'localhost', resolve);
    });
    return `https://localhost:${server.address().port}`;
  }
  function parent(request, response) {
    const nested = request.url === '/nested';
    const target = nested ? `${parentOrigin}/frame` : `${embedOrigin}${shell}`;
    // Test-only parents have no script and never weaken the embedded response.
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    response.end(`<!doctype html><html lang="en"><head><title>Synthetic Universe parent</title></head><body><h1>Synthetic Universe parent</h1><iframe title="${nested ? 'Allowed parent' : 'StudentHub embed'}" src="${target}" width="360" height="600"></iframe></body></html>`);
  }
  function configure(enabled) {
    const config = createUniverseEmbedConfigFromEnv({
      UNIVERSE_EMBED_ORIGIN: embedOrigin,
      ...(enabled === undefined ? {} : { UNIVERSE_EMBED_ENABLED: String(enabled) }),
      UNIVERSE_EMBED_ANCESTORS: parentOrigin,
      UNIVERSE_EMBED_OIDC_CALLBACK_URL: `${embedOrigin}/login/callback`,
    }, parentOrigin);
    assert.ok(config, 'Actual parser reserves the synthetic embed origin');
    gateway = createGatewayServer(undefined, undefined, undefined, undefined, sourceRevision,
      undefined, undefined, undefined, undefined, undefined, config);
  }
  try {
    embedOrigin = await listen((request, response) => {
      // Keep only fixed method/path facts, never headers, cookies or bodies.
      requests.push({ method: request.method, path: request.url?.split('?', 1)[0] });
      gateway.emit('request', request, response);
    });
    parentOrigin = await listen(parent);
    const otherOrigin = await listen(parent);
    assert.equal(new Set([embedOrigin, parentOrigin, otherOrigin]).size, 3, 'Three distinct real HTTPS origins');
    configure(true);
    return { embedOrigin, parentOrigin, otherOrigin, configure, requests, close };
  } catch (error) {
    await close();
    throw error;
  }
}

function displayPolicy(response, fixture) {
  assert.equal(response.status(), 200, 'Real embed display returns 200');
  const headers = response.headers();
  assert.equal(headers['cache-control'], 'no-store', 'Display cannot be cached');
  assert.equal(headers['x-frame-options'], undefined, 'Display has no conflicting XFO');
  assert.equal(headers['set-cookie'], undefined, 'Inert display creates no session');
  const directives = headers['content-security-policy']?.split(';').map(value => value.trim());
  for (const directive of [`frame-ancestors ${fixture.parentOrigin}`, "script-src 'self'", "connect-src 'self'"]) {
    assert.ok(directives?.includes(directive), 'Actual display retains its exact CSP directive');
  }
}

async function loaded(page, fixture) {
  const display = page.waitForResponse(response => response.url() === `${fixture.embedOrigin}${shell}`);
  const external = page.waitForResponse(response => response.url() === `${fixture.embedOrigin}${script}`);
  display.catch(() => {}); external.catch(() => {});
  await page.goto(`${fixture.parentOrigin}/frame`);
  displayPolicy(await display, fixture);
  const scriptResponse = await external;
  assert.equal(scriptResponse.status(), 200, 'Real external script returns 200');
  assert.equal(scriptResponse.fromServiceWorker(), false, 'Script is not supplied by a service worker');
  assert.equal(scriptResponse.request().resourceType(), 'script', 'Browser loads an actual external script');
  const frame = page.frame({ url: `${fixture.embedOrigin}${shell}` });
  assert.ok(frame, 'Native cross-origin child loaded');
  await frame.waitForFunction(() => document.documentElement.dataset.universeEmbed === 'not-ready');
  assert.equal(await frame.getByRole('heading', { name: title, exact: true }).isVisible(), true, 'Inert shell is visible');
  assert.equal(await frame.getByRole('status').innerText(), 'StudentHub in Universe is not ready yet. Please try again later.', 'No false readiness claim');
  assert.equal(await frame.locator('script').count(), 1, 'Unmodified shell has one script');
  assert.equal(await frame.locator('script').getAttribute('src'), script, 'Unmodified shell uses its own external script');
  assert.equal(await frame.locator('form, input, button').count(), 0, 'Inert E1 exposes no authentication or mutation controls');
  return frame;
}

async function blocked(page, fixture, outer = false, parentOrigin = fixture.otherOrigin) {
  const scriptsBefore = fixture.requests.filter(value => value.path === script).length;
  const displaysBefore = fixture.requests.filter(value => value.path === shell).length;
  let cspRefusal = false;
  const onConsole = message => {
    // Retain only a boolean, not browser diagnostics or URLs.
    if (message.type() === 'error' && message.text().includes('frame-ancestors') && message.text().includes(fixture.embedOrigin)) cspRefusal = true;
  };
  page.on('console', onConsole);
  const rejected = page.waitForEvent('requestfailed', { predicate: request =>
    request.isNavigationRequest() && request.url() === `${fixture.embedOrigin}${shell}`, timeout: 15000 });
  rejected.catch(() => {});
  await page.goto(`${parentOrigin}/${outer ? 'nested' : 'frame'}`);
  const request = await rejected;
  assert.match(request.failure()?.errorText ?? '', /ERR_BLOCKED_BY_RESPONSE/, 'Browser rejects the real child response');
  for (let attempt = 0; !cspRefusal && attempt < 100; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.ok(cspRefusal, 'Browser reports a frame-ancestors refusal');
  assert.ok(fixture.requests.filter(value => value.path === shell).length > displaysBefore, 'Rejected frame reached the actual gateway');
  assert.equal(fixture.requests.filter(value => value.path === script).length, scriptsBefore, 'Blocked frame never fetches the external script');
  assert.equal(page.frames().filter(frame => frame.url() === `${fixture.embedOrigin}${shell}`).length, 0, 'Blocked shell is not a rendered child document');
  if (outer) assert.ok(page.frame({ url: `${fixture.parentOrigin}/frame` }), 'Approved immediate parent loads beneath the unapproved outer ancestor');
  page.off('console', onConsole);
  return { browserFrameAncestorsRefusal: true, blockedScriptRequests: 0, ...(outer ? { approvedImmediateParent: true } : {}) };
}

async function blockedScriptPolicy(page, frame, fixture) {
  const session = await page.context().newCDPSession(page);
  const executionContexts = [];
  session.on('Runtime.executionContextCreated', ({ context }) => executionContexts.push(context));
  try {
    await session.send('Runtime.enable');
    const { frameTree } = await session.send('Page.getFrameTree');
    const findFrame = tree => tree.frame.url === `${fixture.embedOrigin}${shell}` ? tree.frame
      : tree.childFrames?.map(findFrame).find(Boolean);
    const target = findFrame(frameTree);
    assert.ok(target, 'CSP probe targets the actual embedded document');
    const execution = executionContexts.find(context => context.auxData?.frameId === target.id && context.auxData?.isDefault);
    assert.ok(execution, 'CSP eval uses the embedded document main world');
    await frame.evaluate(() => {
      const probe = { violations: [] };
      window.__universeCspProbe = probe;
      probe.listener = event => probe.violations.push({ directive: event.effectiveDirective, blocked: event.blockedURI, disposition: event.disposition });
      document.addEventListener('securitypolicyviolation', probe.listener);
      const inline = document.createElement('script');
      inline.id = 'universe-csp-inline-probe';
      inline.textContent = 'document.documentElement.dataset.inlineProbe = "executed"';
      document.head.append(inline);
    });
    // DevTools normally allows unsafe eval even when the document forbids it.
    // Explicitly turn OFF that bypass; Playwright evaluate alone is not proof.
    const evaluation = await session.send('Runtime.evaluate', {
      expression: 'window.eval(\'document.documentElement.dataset.evalProbe = "executed"\')',
      contextId: execution.id, allowUnsafeEvalBlockedByCSP: false, returnByValue: true,
    });
    assert.equal(evaluation.exceptionDetails?.exception?.className, 'EvalError', 'Browser throws EvalError with the DevTools CSP bypass disabled');
    await frame.waitForFunction(() => ['inline', 'eval'].every(blocked => window.__universeCspProbe.violations.some(value =>
      value.blocked === blocked && value.directive.startsWith('script-src') && value.disposition === 'enforce')));
    const policy = await frame.evaluate(() => ({
      inlineExecuted: document.documentElement.dataset.inlineProbe === 'executed',
      evalExecuted: document.documentElement.dataset.evalProbe === 'executed',
    }));
    assert.equal(policy.inlineExecuted, false, 'Actual CSP blocks DOM-inserted inline script');
    assert.equal(policy.evalExecuted, false, 'Actual CSP blocks dynamic eval');
    await frame.evaluate(() => {
      document.removeEventListener('securitypolicyviolation', window.__universeCspProbe.listener);
      document.querySelector('#universe-csp-inline-probe').remove();
      delete window.__universeCspProbe;
    });
  } finally { await session.detach(); }
}

async function deniedRoutes(page, fixture) {
  const paths = [shell, script, '/assets/studenthub.css', '/profile', '/login/universe', '/login/callback', '/health', '/'];
  for (const route of paths) {
    const response = await page.goto(`${fixture.embedOrigin}${route}`);
    assert.equal(response.status(), 404, 'Reserved disabled host denies display, assets and ordinary routes');
    const headers = response.headers();
    assert.equal(headers['x-frame-options'], 'DENY', 'Disabled host retains XFO DENY');
    assert.ok(headers['content-security-policy']?.includes("frame-ancestors 'none'"), 'Disabled host retains non-frameable CSP');
    assert.equal(headers['cache-control'], 'no-store', 'Disabled response is not cached');
    assert.equal(headers['set-cookie'], undefined, 'Disabled host creates no session');
    assert.equal(headers.location, undefined, 'Disabled host never redirects into login');
    assert.equal(await page.locator('script, form, input, button').count(), 0, 'Disabled host exposes no executable shell or controls');
    assert.equal(await page.evaluate(() => document.documentElement.dataset.universeEmbed), undefined, 'Disabled host never executes shell script');
  }
  return paths.length;
}

export async function runUniverseEmbed({ browser, run, screenshot, sourceRevision = null }) {
  for (const name of universeEmbedNames) await run(name, async () => {
    const fixture = await createEmbedFixture(sourceRevision);
    let context;
    try {
      // Deliberately no ignoreHTTPSErrors, bypassCSP, routing or launch changes.
      context = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
      const page = await context.newPage();
      page.setDefaultTimeout(15000);
      page.setDefaultNavigationTimeout(15000);
      let result;
      if (name === 'universe-embed-allowed-parent-external-script') {
        const frame = await loaded(page, fixture);
        assert.deepEqual(await context.cookies(), [], 'Inert E1 writes no cookies');
        assert.deepEqual(await frame.evaluate(() => ({ local: localStorage.length, session: sessionStorage.length })), { local: 0, session: 0 }, 'Inert E1 writes no browser storage');
        result = { externalScriptExecuted: true, screenshot: await screenshot(page, name) };
      } else if (name === 'universe-embed-inline-eval-blocked') {
        const frame = await loaded(page, fixture);
        await blockedScriptPolicy(page, frame, fixture);
        result = { externalScriptExecuted: true, inlineScriptBlocked: true, evalBlocked: true };
      } else if (name.includes('unapproved-')) {
        result = await blocked(page, fixture, name.includes('outer-ancestor'));
      } else {
        if (name === 'universe-embed-disabled-host-isolation') {
          await loaded(page, fixture);
          fixture.configure(false);
        } else fixture.configure(undefined);
        const routesPerRestart = await deniedRoutes(page, fixture);
        fixture.configure(name === 'universe-embed-default-off-host-isolation' ? undefined : false);
        assert.equal(await deniedRoutes(page, fixture), routesPerRestart, 'Fresh gateway instance keeps the host reserved');
        await blocked(page, fixture, false, fixture.parentOrigin);
        result = { deniedRouteChecks: routesPerRestart * 2, gatewayReinitializationChecked: true, approvedParentDenied: true };
      }
      return { ...result, notes: scope };
    } finally {
      if (context) await context.close();
      await fixture.close();
    }
  });
}
