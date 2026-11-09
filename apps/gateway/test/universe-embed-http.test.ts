/** E1 HTTP boundary. Goldens captured from a1a9e9e1dd404c78cae17d4292b2596a49ef88b8. */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { IncomingMessage, type Server } from 'node:http';
import { Socket } from 'node:net';
import { runInNewContext } from 'node:vm';
import { ROUTES } from '../src/routes/index.js';
import { createUniverseEmbedConfigFromEnv } from '../src/universe/embed-policy.js';

const { createGatewayServer } = await import(process.env.E1_GATEWAY_MODULE ?? '../src/index.js') as typeof import('../src/index.js');
const MAIN = 'https://app.example.test', EMBED = 'https://embed.example.test';
const ancestors = ['https://universe.example.test', 'https://preview.example.test'];
function config(enabled: boolean) {
  return createUniverseEmbedConfigFromEnv({ UNIVERSE_EMBED_ORIGIN: EMBED,
    UNIVERSE_EMBED_ENABLED: String(enabled), UNIVERSE_EMBED_ANCESTORS: ancestors.join(','),
    UNIVERSE_EMBED_OIDC_CALLBACK_URL: `${EMBED}/login/callback` }, MAIN);
}
type Reply = { status: number; headers: Record<string, string>; body: string };
type RequestCase = { method: string; path: string; accept?: string };
/** Emit requests directly so duplicate/missing/malformed Host reaches our boundary,
 * rather than being silently repaired by fetch or rejected by Node's HTTP parser. */
function request(server: Server, c: RequestCase, host: string[] = ['embed.example.test'], extra: Record<string, string> = {}): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No response: ${c.method} ${c.path}`)), 2000);
    const req = new IncomingMessage(new Socket());
    req.method = c.method; req.url = c.path;
    req.rawHeaders = host.flatMap(value => ['Host', value]);
    req.headers = { ...(host.length ? { host: host[0] } : {}), accept: c.accept ?? 'application/json', ...extra };
    req.push(null);
    const headers: Record<string, string> = {};
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200, headersSent: false, writableEnded: false, writableFinished: false, destroyed: false,
      setHeader(name: string, value: unknown) { headers[name.toLowerCase()] = String(value); return this; },
      getHeader(name: string) { return headers[name.toLowerCase()]; },
      removeHeader(name: string) { delete headers[name.toLowerCase()]; },
      writeHead(status: number, values: Record<string, unknown> = {}) {
        this.statusCode = status; this.headersSent = true;
        for (const [key, value] of Object.entries(values)) this.setHeader(key, value);
        return this;
      },
      end(body: unknown = '') {
        this.writableEnded = this.writableFinished = true;
        clearTimeout(timer); res.emit('finish');
        resolve({ status: this.statusCode, headers, body: Buffer.isBuffer(body) ? body.toString() : String(body) });
        return this;
      },
      destroy() { clearTimeout(timer); reject(new Error('Response destroyed')); return this; },
    });
    server.emit('request', req, res);
  });
}
function server(embed: ReturnType<typeof config>, login?: unknown, telemetry?: unknown) {
  return createGatewayServer(undefined, undefined, undefined, login as never, null, telemetry as never,
    undefined, undefined, undefined, undefined, embed);
}
function appPolicy(reply: Reply) {
  assert.match(reply.headers['content-security-policy'] ?? '', /frame-ancestors 'none'/);
  assert.equal(reply.headers['x-frame-options'], 'DENY');
  assert.equal(reply.headers['set-cookie'], undefined);
  assert.equal(reply.headers.location, undefined);
  assert.equal(reply.headers['cache-control'], 'no-store');
  assert.equal(reply.headers['x-content-type-options'], 'nosniff');
}
const manifest: Array<RequestCase & { status: number; type: string }> = [
  { method: 'GET', path: '/universe/embed', status: 200, type: 'text/html' },
  { method: 'GET', path: '/universe/embed/embed.js', status: 200, type: 'javascript' },
  { method: 'GET', path: '/assets/studenthub.css', status: 200, type: 'text/css' },
  ...['status', 'profile'].map(name => ({ method: 'GET', path: `/universe/embed/${name}`, status: 503, type: 'application/json' })),
  ...['challenge', 'identity'].map(name => ({ method: 'POST', path: `/universe/embed/${name}`, status: 503, type: 'application/json' })),
  ...['/login/universe', '/login/callback', '/universe/embed/done'].map(path => ({ method: 'GET', path, status: 503, type: 'text/html' })),
  ...['/universe/embed/connect', '/logout'].map(path => ({ method: 'POST', path, status: 503, type: 'text/html' })),
];
const ordinary: RequestCase[] = [
  ...['/', '/health', '/assets/workspace-history.js', '/profile', '/admin/jobs', '/admin/outbox', '/notifications',
    '/workspace/my-companies', '/workspace/companies', '/workspace', '/exports/example', '/unknown'].map(path => ({ method: 'GET', path })),
  ...['/notifications/read-all', '/notifications/example/read', '/exports/company-directory', '/mcp/tools/call'].map(path => ({ method: 'POST', path })),
];

test('E1 enabled host serves the complete inert manifest and only the shell is frameable', async () => {
  const s = server(config(true));
  for (const c of manifest) {
    const r = await request(s, c);
    assert.equal(r.status, c.status, c.path);
    assert.ok(r.headers['content-type']?.includes(c.type), c.path);
    assert.equal(r.headers['set-cookie'], undefined);
    assert.equal(r.headers.location, undefined);
    if (c.path === '/universe/embed') {
      const csp = r.headers['content-security-policy'];
      assert.ok(csp);
      assert.ok(csp.split(';').map(x => x.trim()).includes(`frame-ancestors ${ancestors.join(' ')}`));
      assert.match(csp, /script-src 'self'(?:;|$)/);
      assert.match(csp, /connect-src 'self'(?:;|$)/);
      assert.equal(r.headers['x-frame-options'], undefined);
      assert.match(r.body, /not.ready/i);
      const scripts = [...r.body.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
      assert.equal(scripts.length, 1);
      assert.match(scripts[0]![1]!, /src=["']\/universe\/embed\/embed\.js["']/);
      assert.equal(scripts[0]![2]!.trim(), '');
    } else {
      appPolicy(r);
      if (c.type === 'application/json') assert.deepEqual(JSON.parse(r.body), { error: 'not_ready' });
      if (c.type === 'text/html') assert.match(r.body, /not.ready/i);
    }
  }
});

test('E1 shell script executes without network, messaging, cookies or storage', async () => {
  const reply = await request(server(config(true)), { method: 'GET', path: '/universe/embed/embed.js' });
  let effects = 0;
  const forbidden = () => { effects++; throw new Error('Inert script attempted IO'); };
  const document = { documentElement: { dataset: {} }, get cookie() { forbidden(); return ''; }, set cookie(_value: string) { forbidden(); } };
  runInNewContext(reply.body, { document, fetch: forbidden, XMLHttpRequest: forbidden,
    WebSocket: forbidden, EventSource: forbidden, postMessage: forbidden,
    localStorage: new Proxy({}, { get: forbidden }), sessionStorage: new Proxy({}, { get: forbidden }),
    parent: new Proxy({}, { get: forbidden }), top: new Proxy({}, { get: forbidden }),
    navigator: new Proxy({}, { get: forbidden }) }, { timeout: 100 });
  assert.equal(effects, 0);
  assert.deepEqual(document.documentElement.dataset, { universeEmbed: 'not-ready' });
});

test('E1 exact allowlist rejects unrelated paths, aliases and wrong methods', async () => {
  const s = server(config(true));
  const rejected = [...ordinary, ...manifest.flatMap(c => ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']
    .filter(method => method !== c.method).map(method => ({ method, path: c.path }))),
    ...['/universe/embed/', '/universe//embed', '/universe/%65mbed', '/universe/embed/../embed', '/UNIVERSE/embed',
      'https://embed.example.test/universe/embed', '/universe/embed/unknown', '/favicon.ico'].map(path => ({ method: 'GET', path }))];
  for (const c of rejected) { const r = await request(s, c); assert.equal(r.status, 404, `${c.method} ${c.path}`); appPolicy(r); }
});

test('E1 reserved disabled host stays closed across restart with a preexisting session cookie', async () => {
  const cookie = `__Host-studenthub_session=${'s'.repeat(43)}; __Host-studenthub_browser=${'b'.repeat(43)}`;
  const live = server(config(true));
  assert.equal((await request(live, manifest[0]!, undefined, { cookie })).status, 200);
  const disabled = server(config(false));
  const absentFlag = server(createUniverseEmbedConfigFromEnv({ UNIVERSE_EMBED_ORIGIN: EMBED }, MAIN));
  for (const s of [disabled, absentFlag]) for (const c of [...manifest, ...ordinary]) {
    const r = await request(s, c, undefined, { cookie }); assert.equal(r.status, 404, c.path); appPolicy(r);
  }
});

test('E1 validates raw Host before dispatch and ignores forwarded authority', async () => {
  for (const enabled of [true, false]) {
    const s = server(config(enabled));
    for (const hosts of [[], ['embed.example.test', 'embed.example.test'], ['app.example.test', 'embed.example.test'],
      [''], [' embed.example.test'], ['embed.example.test '], ['user@embed.example.test'], ['embed.example.test:wat'],
      ['embed.example.test:0'], ['embed.example.test:65536'], ['embed.example.test..'], ['embed.example.test/path'],
      ['embed.example.test#x'], ['embed.example.test?x'], ['embed_example.test'], ['embed.example.test:443:443']]) {
      const r = await request(s, { method: 'GET', path: '/health' }, hosts);
      assert.equal(r.status, 400, JSON.stringify(hosts)); appPolicy(r);
    }
    for (const host of ['embed.example.test', 'EMBED.EXAMPLE.TEST', 'embed.example.test.', 'EMBED.EXAMPLE.TEST.:443', 'embed.example.test:443']) {
      const r = await request(s, manifest[0]!, [host], { 'x-forwarded-host': 'app.example.test', forwarded: 'host=app.example.test' });
      assert.equal(r.status, enabled ? 200 : 404, host);
    }
    for (const host of ['app.example.test', 'unknown.example.test', 'embed.example.test:444']) {
      const r = await request(s, { method: 'GET', path: '/health' }, [host], { 'x-forwarded-host': 'embed.example.test', forwarded: 'host=embed.example.test' });
      assert.equal(r.status, 200, host);
    }
  }
});

test('E1 terminal gate reaches no registered route, inline service or telemetry', async () => {
  const routeCalls = new Map<string, number>();
  const original = ROUTES.map(r => r.handle);
  let serviceCalls = 0, telemetryCalls = 0;
  const forbidden = new Proxy({}, { get() { serviceCalls++; throw new Error('Ordinary service accessed'); } });
  try {
    ROUTES.forEach((r, i) => { (r as { handle: typeof r.handle }).handle = async ctx => {
      routeCalls.set(r.name, (routeCalls.get(r.name) ?? 0) + 1); return original[i]!(ctx);
    }; });
    // Positive control proves all registered route spies are wired to the dispatch path.
    await request(server(undefined), { method: 'GET', path: '/unknown' }, ['app.example.test']);
    assert.equal(routeCalls.size, ROUTES.length); routeCalls.clear();
    for (const enabled of [true, false]) {
      const s = server(config(enabled), forbidden, { record() { telemetryCalls++; } });
      for (const c of [...manifest, ...ordinary]) {
        const r = await request(s, c, undefined, { cookie: `__Host-studenthub_session=${'s'.repeat(43)}` });
        assert.equal(r.status, enabled ? manifest.find(m => m.method === c.method && m.path === c.path)?.status ?? 404 : 404);
      }
    }
    assert.equal(routeCalls.size, 0); assert.equal(serviceCalls, 0); assert.equal(telemetryCalls, 0);
  } finally { ROUTES.forEach((r, i) => { (r as { handle: typeof r.handle }).handle = original[i]!; }); }
});

// Each hash includes status, every stable header and the complete response body.
// Only per-request trace IDs and health's clock timestamp are removed.
function golden(reply: Reply, path: string): string {
  const headers = Object.fromEntries(Object.entries(reply.headers).filter(([key]) => key !== 'x-request-id' && key !== 'date').sort(([a], [b]) => a.localeCompare(b)));
  let body = reply.body;
  if (path === '/health') { const health = JSON.parse(body); health.timestamp = '<clock>'; body = JSON.stringify(health); }
  return createHash('sha256').update(JSON.stringify({ status: reply.status, headers, body })).digest('hex');
}
const goldenCases: RequestCase[] = [...ordinary, ...manifest.filter(c => !ordinary.some(o => o.path === c.path))]
  .flatMap(c => ['application/json', 'text/html'].map(accept => ({ method: c.method, path: c.path, accept })));
const GOLDENS: string[] = [
  "76b077c710b8efcd67edfe4aefa1aa9e57071cc6d356a94a0df106897f391d17",
  "76b077c710b8efcd67edfe4aefa1aa9e57071cc6d356a94a0df106897f391d17",
  "700c4622357231c819d451074fab975ca99b21e7aec178f2c2ffbc0b77f2bdd7",
  "700c4622357231c819d451074fab975ca99b21e7aec178f2c2ffbc0b77f2bdd7",
  "a716ac5bcc587e77eea9701e91f8f691e63676e2a92d99e956d5fe02930f13d7",
  "a716ac5bcc587e77eea9701e91f8f691e63676e2a92d99e956d5fe02930f13d7",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "8847a6d95137eaa98fe86cce1feb257e03e494bddf137d675bebbb8294175a82",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "8aa2251211750dbdb8af6518dc86c5a9cb2c6456428ca0df0aeb77136b18de03",
  "962a9b7ab918d098697fb0936d840f5234b664de012687c4e40e1f2fcf39b33c",
  "178cd90d3a62fe1bd6c068c73d807df81e5819bf6c4e0f1f80dd9030111abf9f",
  "cf19a3b20b43d4c0c4831a84dfcd02842ec4c921a9dc35585c9aae9979128044",
  "009d08a1f5cf10c03cc205df5ecdb7db64caa900f73a114b85cdb4892dd6579a",
  "57eb11e12ec3921672475e0ff96a72ecd4e4c5941ba70c0f0f832f0d98c8da98",
  "3e341a2136271404abce7549855eba0b47896692aca6dac6c7a8c129002a2004",
  "57eb11e12ec3921672475e0ff96a72ecd4e4c5941ba70c0f0f832f0d98c8da98",
  "9ba0a2230818044920e694bc17d4b7d48ae71304c43be05efd46eccd8c4023fc",
  "9ba0a2230818044920e694bc17d4b7d48ae71304c43be05efd46eccd8c4023fc",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b876da759a3a05291f4d13c77d4f3802f50eedc5d5633aa7044e29fe21053319",
  "b876da759a3a05291f4d13c77d4f3802f50eedc5d5633aa7044e29fe21053319",
  "9ba0a2230818044920e694bc17d4b7d48ae71304c43be05efd46eccd8c4023fc",
  "9ba0a2230818044920e694bc17d4b7d48ae71304c43be05efd46eccd8c4023fc",
  "9ba0a2230818044920e694bc17d4b7d48ae71304c43be05efd46eccd8c4023fc",
  "9ba0a2230818044920e694bc17d4b7d48ae71304c43be05efd46eccd8c4023fc",
  "70a01e3cfb9909caff716438d45359cb218208c6d4954a5cfb8a5c91ab1057f7",
  "70a01e3cfb9909caff716438d45359cb218208c6d4954a5cfb8a5c91ab1057f7",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "2560a85480b2437fb42380ced07f578e6976d25a7dc918edfb91f8882bf4efd8",
  "2560a85480b2437fb42380ced07f578e6976d25a7dc918edfb91f8882bf4efd8",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "8847a6d95137eaa98fe86cce1feb257e03e494bddf137d675bebbb8294175a82",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "8847a6d95137eaa98fe86cce1feb257e03e494bddf137d675bebbb8294175a82",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "b00c7c6cce9e3a276cd912c96eac55ff59b513d3474d13315654859ecd4979b1",
  "8847a6d95137eaa98fe86cce1feb257e03e494bddf137d675bebbb8294175a82"
];

test('E1 main-host stable responses match the pinned pre-change gateway with gate absent, disabled and enabled', async () => {
  assert.equal(GOLDENS.length, goldenCases.length, 'Pinned baseline must cover the entire table');
  for (const embed of [undefined, config(false), config(true)]) {
    const s = server(embed);
    for (const [i, c] of goldenCases.entries()) {
      const r = await request(s, c, ['app.example.test']);
      assert.equal(golden(r, c.path), GOLDENS[i], `${c.method} ${c.path} ${c.accept}`);
    }
  }
});

test('E1 no reserved configuration preserves malformed Host legacy behavior', async () => {
  for (const hosts of [[], ['bad host'], ['app.example.test', 'embed.example.test']]) {
    const r = await request(server(undefined), { method: 'GET', path: '/health' }, hosts);
    assert.equal(r.status, 200);
  }
});
