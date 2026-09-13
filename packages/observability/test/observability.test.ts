import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { sanitizeEvent, newSpan, inSpan, currentTraceId, Telemetry, observedJob, telemetryMode, LIMIT, LATENCY_BUCKETS } from '../src/index.js';
import { createLocalSentry, EVENT_LIMIT, EVENT_TTL_MS } from '../src/local-sentry.js';
import { createGatewayServer } from '../../../apps/gateway/src/index.js';
import { createAuthzFixture } from '../../../apps/gateway/test/helpers/authz.js';
import type { BrowserLoginApplication } from '../../../apps/gateway/src/web-ui.js';
const SAFE = { version: 1, traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), component: 'gateway', journey: 'profile_read', outcome: 'failure', fault: 'dependency_unavailable', durationMs: 12 };
const secrets = {
  cookie: '__Host-studenthub_session=SYNTHETIC_COOKIE_903', authorization: 'Bearer SYNTHETIC_BEARER_903',
  id_token: 'SYNTHETIC_OIDC_ID_903', access_token: 'SYNTHETIC_ACCESS_903', refresh_token: 'SYNTHETIC_REFRESH_903',
  code: 'SYNTHETIC_OIDC_CODE_903', state: 'SYNTHETIC_OIDC_STATE_903', client_secret: 'SYNTHETIC_CLIENT_SECRET_903',
  password: 'SYNTHETIC_PASSWORD_903', apiKey: 'SYNTHETIC_API_KEY_903', private_key: 'SYNTHETIC_PRIVATE_KEY_903',
  database_url: 'postgres://synthetic:SYNTHETIC_DB_PASSWORD_903@invalid/db',
  resume: 'https://docs.invalid/resume.pdf?X-Amz-Signature=SYNTHETIC_SIGNATURE_903',
  civil_front: 'https://docs.invalid/SYNTHETIC_CIVIL_FRONT_903', civil_back: 'https://docs.invalid/SYNTHETIC_CIVIL_BACK_903',
  bank_id: 'SYNTHETIC_BANK_903', IBAN: 'KW00SYNTHETIC_IBAN_903', account_name: 'SYNTHETIC_ACCOUNT_903',
  civil_id: 'SYNTHETIC_CIVIL_ID_903', email: 'synthetic903@example.invalid', phone: '+96500000903',
  displayName: 'SYNTHETIC_PROFILE_NAME_903', address: 'SYNTHETIC_ADDRESS_903', ip_address: '192.0.2.93',
  coordinates: 'SYNTHETIC_COORDINATES_903', hourly_rate: 'SYNTHETIC_PAY_903',
};
const values = Object.values(secrets);
function privateAbsent(value: unknown) { const wire = JSON.stringify(value); for (const secret of values) assert.ok(!wire.includes(secret), `private sentinel leaked: ${secret}`); }
async function listen(server: ReturnType<typeof createGatewayServer>) {
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address !== 'string'); return `http://127.0.0.1:${address.port}`;
}

test('redaction: exhaustive sensitive categories and SDK surfaces are discarded', async () => {
  const sentry = createLocalSentry();
  try {
    for (const [key, value] of Object.entries(secrets)) {
      const hostile = { ...SAFE, [key]: value, request: { headers: secrets, cookies: secrets, data: secrets, url: value },
        user: secrets, profile: secrets, extra: { nested: [secrets] }, tags: secrets, contexts: secrets,
        breadcrumbs: [{ message: value, data: secrets }], exception: { values: [{ value, stacktrace: secrets }] },
        attachments: [{ filename: value, data: value }], message: value, logentry: { formatted: value },
        transaction: value, environment: value, release: value, server_name: value, modules: secrets,
        spans: [secrets], replay: secrets, toJSON() { throw new Error(value); } };
      const safe = sanitizeEvent(hostile); assert.deepEqual(safe, SAFE); privateAbsent(safe);
      await sentry.capture(hostile);
      const events = await sentry.snapshot(); assert.ok(events.length > 0); privateAbsent(events);
      assert.deepEqual(Object.keys(events.at(-1)!).sort(), ['type', 'timestamp', 'contexts', 'event_id', 'fingerprint', 'level', 'measurements', 'message', 'platform', 'tags'].sort());
    }
  } finally { await sentry.close(); }
});

test('redaction: poisoned allowed fields, accessors, proxies and cyclic objects fail closed', () => {
  for (const key of Object.keys(SAFE)) for (const value of values) assert.equal(sanitizeEvent({ ...SAFE, [key]: value }), null);
  for (const durationMs of [NaN, Infinity, -1, 3_600_001, '12', {}, null]) assert.equal(sanitizeEvent({ ...SAFE, durationMs }), null);
  for (const field of ['traceId', 'spanId', 'parentSpanId']) assert.equal(sanitizeEvent({ ...SAFE, [field]: secrets.email }), null);
  let invoked = false;
  const getter = { ...SAFE }; Object.defineProperty(getter, 'journey', { get() { invoked = true; throw new Error('private'); } });
  assert.equal(sanitizeEvent(getter), null); assert.equal(invoked, false);
  assert.equal(sanitizeEvent(new Proxy({}, { getOwnPropertyDescriptor() { throw new Error('private'); } })), null);
  const cycle: Record<string, unknown> = { ...SAFE }; cycle.profile = cycle; assert.deepEqual(sanitizeEvent(cycle), SAFE);
});

test('correlation: only minted contexts propagate across async boundaries', async () => {
  const root = newSpan();
  await inSpan(root, async () => { await Promise.resolve(); assert.equal(currentTraceId(), root.traceId); const child = newSpan(); assert.equal(child.traceId, root.traceId); assert.equal(child.parentSpanId, root.spanId); });
  const forged = { traceId: secrets.email, spanId: secrets.cookie };
  assert.notEqual(newSpan(forged).traceId, forged.traceId);
  assert.notEqual(inSpan(forged, currentTraceId), forged.traceId);
  const telemetry = new Telemetry('local');
  try { telemetry.record(forged, 'gateway', 'profile_read', 'failure', 'none', 1); assert.equal((await telemetry.snapshot()).counters.accepted, 0); }
  finally { await telemetry.close(); }
});

test('configuration: external ingestion stays disabled regardless of Sentry credentials', async () => {
  for (const SHU_TELEMETRY_MODE of [undefined, '', 'external', 'production', 'true']) {
    assert.equal(telemetryMode({ SHU_TELEMETRY_MODE, SENTRY_DSN: 'https://secret@external.invalid/123', SENTRY_AUTH_TOKEN: secrets.apiKey }), 'disabled');
  }
  assert.equal(telemetryMode({ SHU_TELEMETRY_MODE: 'local' }), 'local');
  const telemetry = new Telemetry(); telemetry.record(newSpan(), 'gateway', 'profile_read', 'failure', 'none', 1);
  assert.deepEqual(await telemetry.snapshot(), { metrics: {}, events: [], counters: { accepted: 0, dropped: 0, unavailable: 0 } });
});

test('retention: Sentry ring is bounded and expires; no raw SDK enrichment survives', async () => {
  let clock = 0; const sentry = createLocalSentry(() => clock);
  try {
    for (let i = 0; i < EVENT_LIMIT + 10; i++) await sentry.capture({ ...SAFE, durationMs: i });
    let events = await sentry.snapshot(); assert.equal(events.length, EVENT_LIMIT); assert.equal(events[0].measurements?.journey_duration.value, 10);
    clock = EVENT_TTL_MS; events = await sentry.snapshot(); assert.equal(events.length, 0);
  } finally { await sentry.close(); }
});

test('metrics: fixed dimensions, latency buckets and worker outcomes preserve results', async () => {
  const telemetry = new Telemetry('local');
  try {
    const span = newSpan(); telemetry.record(span, 'gateway', 'profile_read', 'success', 'none', 51);
    assert.equal(await observedJob(async () => 42, telemetry), 42);
    const error = new Error(JSON.stringify(secrets));
    await assert.rejects(observedJob(async () => { throw error; }, telemetry), e => e === error);
    const snapshot = await telemetry.snapshot(); privateAbsent(snapshot);
    assert.equal(snapshot.metrics['gateway:profile_read:success'].count, 1);
    assert.deepEqual(snapshot.metrics['gateway:profile_read:success'].buckets, LATENCY_BUCKETS.map(b => b >= 51 ? 1 : 0));
    assert.equal(snapshot.metrics['worker:job:success'].count, 1); assert.equal(snapshot.metrics['worker:job:failure'].count, 1);
    assert.equal(snapshot.events.length, 3);
  } finally { await telemetry.close(); }
});

test('gateway: concurrent web, audit and worker failures share only the minted correlation', async () => {
  const telemetry = new Telemetry('local'); const audit: unknown[] = [];
  const fixture = await createAuthzFixture({ auditSink: { record: event => { audit.push(event); } } });
  const login: BrowserLoginApplication = {
    start: async () => { throw new Error(JSON.stringify(secrets)); }, callback: async () => { throw new Error(JSON.stringify(secrets)); },
    profile: async () => ({ status: 200, body: { personId: 'synthetic-person' } }), logout: async () => ({ status: 204 }),
    web: { origin: 'https://synthetic.invalid', readProfile: async () => { throw new Error(JSON.stringify(secrets)); } },
  };
  const server = createGatewayServer({ callTool: async () => observedJob(async () => { throw new Error(JSON.stringify(secrets)); }, telemetry) }, undefined, fixture.middleware, login, null, telemetry);
  const origin = await listen(server);
  try {
    const [mcp, web] = await Promise.all([
      fetch(`${origin}/mcp/tools/call`, { method: 'POST', headers: { 'x-actor-assertion': await fixture.mint(), 'x-request-id': secrets.email, traceparent: secrets.email, authorization: secrets.authorization }, body: JSON.stringify({ name: secrets.email, arguments: secrets }) }),
      fetch(`${origin}/profile?person_id=${secrets.email}`, { headers: { accept: 'text/html', cookie: secrets.cookie } }),
    ]);
    assert.equal(mcp.status, 502); assert.equal(web.status, 503); await mcp.text(); await web.text();
    const trace = mcp.headers.get('x-request-id'); assert.match(trace!, /^[a-f0-9]{32}$/); assert.notEqual(trace, web.headers.get('x-request-id'));
    assert.equal((audit[0] as { requestId: string }).requestId, trace);
    const snapshot = await telemetry.snapshot(); privateAbsent(snapshot);
    const events = snapshot.events as any[];
    const gateway = events.find(e => e.tags.component === 'gateway' && e.tags.journey === 'mcp_call');
    const worker = events.find(e => e.tags.component === 'worker');
    assert.equal(gateway.contexts.trace.trace_id, trace); assert.equal(worker.contexts.trace.trace_id, trace);
    assert.equal(worker.contexts.trace.parent_span_id, gateway.contexts.trace.span_id);
    const webEvent = events.find(e => e.tags.component === 'web');
    assert.equal(webEvent.tags.fault, 'render_failure'); assert.equal(webEvent.contexts.trace.trace_id, web.headers.get('x-request-id'));
    assert.equal(snapshot.metrics['gateway:mcp_call:failure'].count, 1); assert.equal(snapshot.metrics['web:profile_read:failure'].count, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await telemetry.close(); }
});

test('isolation: stalled telemetry cannot stall HTTP and queue overflow is bounded', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shu90-stall-'));
  writeFileSync(join(dir, 'stall.mjs'), 'setInterval(() => {}, 1000);');
  const telemetry = new Telemetry('local', pathToFileURL(join(dir, 'stall.mjs')));
  const server = createGatewayServer(undefined, undefined, undefined, undefined, null, telemetry);
  const origin = await listen(server);
  try {
    const started = performance.now(); const response = await fetch(`${origin}/health`); assert.equal(response.status, 200); await response.text();
    assert.ok(performance.now() - started < 1000, 'business response waited for telemetry');
    for (let i = 0; i < LIMIT * 3; i++) telemetry.record(newSpan(), 'worker', 'job', 'success', 'none', 1);
    const snapshot = await telemetry.snapshot(); assert.equal(snapshot.counters.accepted, LIMIT); assert.ok(snapshot.counters.dropped >= LIMIT * 2);
    const after = await telemetry.snapshot(); assert.equal(after.counters.unavailable, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await telemetry.close(); rmSync(dir, { recursive: true }); }
});

test('isolation: crashing SDK and missing worker cannot change business results', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'shu90-crash-'));
  writeFileSync(join(dir, 'crash.mjs'), 'throw new Error("SYNTHETIC_PRIVATE_CRASH");');
  for (const file of ['crash.mjs', 'missing.mjs']) {
    const telemetry = new Telemetry('local', pathToFileURL(join(dir, file)));
    try { assert.equal(await observedJob(async () => 'ok', telemetry), 'ok'); const snapshot = await telemetry.snapshot(); assert.equal(snapshot.events.length, 0); assert.equal(snapshot.counters.unavailable, 1); assert.ok(!JSON.stringify(snapshot).includes('SYNTHETIC_PRIVATE_CRASH')); }
    finally { await telemetry.close(); }
  }
  rmSync(dir, { recursive: true });
});

test('gateway: all browser journeys record outcomes without request, response or cookie data', async () => {
  const telemetry = new Telemetry('local');
  const login: BrowserLoginApplication = {
    start: async () => ({ status: 302, headers: { location: secrets.resume, 'set-cookie': secrets.cookie } }),
    callback: async () => { throw new Error(JSON.stringify(secrets)); },
    profile: async () => ({ status: 200, body: secrets }), logout: async () => ({ status: 204 }),
  };
  const server = createGatewayServer(undefined, undefined, undefined, login, null, telemetry); const origin = await listen(server);
  try {
    const paths = ['/', '/login/universe?return_to=' + encodeURIComponent(secrets.resume), '/login/callback?code=' + secrets.code + '&state=' + secrets.state, '/profile?person_id=' + secrets.email, '/logout', '/private/' + secrets.email];
    const statuses = [200, 302, 503, 200, 204, 404];
    for (const [i, path] of paths.entries()) {
      const response = await fetch(origin + path, { method: i === 4 ? 'POST' : 'GET', redirect: 'manual', headers: { cookie: '__Host-studenthub_browser=' + 's'.repeat(43), authorization: secrets.authorization, baggage: secrets.email } });
      assert.equal(response.status, statuses[i]); await response.text();
    }
    const snapshot = await telemetry.snapshot(); privateAbsent(snapshot); assert.equal(snapshot.events.length, 6);
    for (const key of ['landing:success', 'login_start:success', 'login_callback:failure', 'profile_read:success', 'logout:success', 'unknown:refused']) assert.equal(snapshot.metrics['gateway:' + key].count, 1);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await telemetry.close(); }
});

test('gateway: uncaught rendering failures are contained and diagnosed', async () => {
  const telemetry = new Telemetry('local');
  const login = { get web() { throw new Error(secrets.password); } } as unknown as BrowserLoginApplication;
  const server = createGatewayServer(undefined, undefined, undefined, login, null, telemetry); const origin = await listen(server);
  try {
    const response = await fetch(origin + '/', { headers: { accept: 'text/html' } });
    assert.equal(response.status, 503); privateAbsent(await response.json());
    const snapshot = await telemetry.snapshot(); privateAbsent(snapshot);
    assert.equal((snapshot.events[0] as any).tags.fault, 'unhandled_failure');
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await telemetry.close(); }
});

test('alerts: failure, latency and transport rules bind thresholds and ownership', async () => {
  const { evaluateAlerts } = await import('../src/alerts.js');
  const base = { counters: { dropped: 0, unavailable: 0 }, metrics: {} };
  assert.deepEqual(evaluateAlerts(base), []);
  const input = { counters: { dropped: 1, unavailable: 1 }, metrics: {
    'gateway:profile_read:failure': { count: 5, buckets: [0, 0, 0, 0, 0, 5, 5, 5] },
    'gateway:profile_read:success': { count: 15, buckets: [15, 15, 15, 15, 15, 15, 15, 15] },
  } };
  const alerts = evaluateAlerts(input);
  assert.deepEqual(alerts.map(a => a.code).sort(), ['journey_failures', 'journey_latency', 'telemetry_dropped', 'telemetry_unavailable']);
  assert.ok(alerts.every(a => a.owner === 'platform-on-call' && a.runbook === 'docs/observability.md'));
  assert.deepEqual(evaluateAlerts({ ...base, metrics: { 'gateway:profile_read:failure': { count: 4, buckets: [0, 4, 4, 4, 4, 4, 4, 4] } } }), []);
});

test('SDK: ambient credentials never cause network calls and failures are reported safely', async (t) => {
  const { default: http } = await import('node:http');
  const { default: https } = await import('node:https');
  const { default: net } = await import('node:net');
  const { NodeClient } = await import('@sentry/node');
  let calls = 0; const blocked = () => { calls++; throw new Error(secrets.apiKey); };
  t.mock.method(http, 'request', blocked); t.mock.method(https, 'request', blocked);
  t.mock.method(net.Socket.prototype, 'connect', blocked); t.mock.method(globalThis, 'fetch', blocked);
  const prior = process.env.SENTRY_DSN; process.env.SENTRY_DSN = 'https://synthetic@external.invalid/123';
  const sentry = createLocalSentry();
  try {
    assert.equal(await sentry.capture(SAFE), true); assert.equal((await sentry.snapshot()).length, 1); assert.equal(calls, 0);
    t.mock.method(NodeClient.prototype, 'captureEvent', () => { throw new Error(secrets.password); });
    assert.equal(await sentry.capture(SAFE), false); privateAbsent(await sentry.snapshot());
  } finally { await sentry.close(); if (prior === undefined) delete process.env.SENTRY_DSN; else process.env.SENTRY_DSN = prior; }
});

test('retention: aggregate window expires and shutdown clears metrics without an outage', async (t) => {
  const telemetry = new Telemetry('local');
  try {
    telemetry.record(newSpan(), 'gateway', 'health', 'success', 'none', 1);
    assert.equal((await telemetry.snapshot()).metrics['gateway:health:success'].count, 1);
    const clock = Date.now(); t.mock.method(Date, 'now', () => clock + 300_001);
    assert.deepEqual((await telemetry.snapshot()).metrics, {});
    await telemetry.close(); const after = await telemetry.snapshot();
    assert.deepEqual(after.metrics, {}); assert.equal(after.counters.unavailable, 0);
  } finally { await telemetry.close(); }
});

test('gateway: aborted response emits exactly one abort while business work completes', async () => {
  const { request } = await import('node:http');
  const telemetry = new Telemetry('local');
  let enter!: () => void, release!: () => void;
  const entered = new Promise<void>(r => { enter = r; }); const released = new Promise<void>(r => { release = r; });
  const login: BrowserLoginApplication = {
    start: async () => ({ status: 302 }), callback: async () => ({ status: 302 }), logout: async () => ({ status: 204 }),
    profile: async () => { enter(); await released; return { status: 200, body: secrets }; },
  };
  const server = createGatewayServer(undefined, undefined, undefined, login, null, telemetry); const origin = await listen(server);
  try {
    const closed = new Promise<void>(resolve => server.once('connection', socket => socket.once('close', () => resolve())));
    const req = request(origin + '/profile'); req.on('error', () => undefined); req.end();
    await entered; req.destroy(); await closed;
    const snapshot = await telemetry.snapshot(); privateAbsent(snapshot);
    assert.equal(snapshot.metrics['gateway:profile_read:aborted'].count, 1);
    assert.equal(snapshot.events.length, 1); assert.equal((snapshot.events[0] as any).tags.fault, 'response_aborted');
    release(); await new Promise<void>(r => setImmediate(r));
    assert.equal((await telemetry.snapshot()).events.length, 1);
  } finally { release(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await telemetry.close(); }
});
