/** Universe E2: handoff, host-verification lease and the own-profile view (gateway, in-memory store). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { IncomingMessage, request as httpRequest, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Socket } from 'node:net';
import { runInNewContext } from 'node:vm';
import { generateEd25519KeyPair, MemoryReplayStore, signAssertion, type ActorAssertionClaims } from '@bawes/actor-assertion';
import { createSyntheticLoginRig } from '@studenthub/login-contract';
import type { UniverseEmbedBindingView, UniverseEmbedStore } from '@studenthub/db/universe';
import { createGatewayServer } from '../src/index.js';
import { createLoginApplication } from '../src/login-application.js';
import { createUniverseEmbedConfigFromEnv, type UniverseEmbedConfig } from '../src/universe/embed-policy.js';
import { requestToken } from '../src/universe/embed-cookies.js';
import { handoffBoundStates } from '../src/universe/embed-login-states.js';
import { LEASE_CLOCK_MARGIN_SECONDS, LEASE_SECONDS, type EmbedProfileView, type UniverseEmbedRuntime } from '../src/universe/embed-service.js';
import { UNIVERSE_EMBED_E2_SCRIPT } from '../src/universe/embed-script.js';
import { sameProviderSubjectMapping, verifyHostAttestation } from '../src/universe/host-identity.js';
import { assertSameSiteEmbed, assertSeparateHosts, embedProfilesFrom, wireUniverse } from '../src/wiring/universe.js';

const MAIN = 'https://app.example.test', EMBED = 'https://embed.example.test', UNIVERSE = 'https://universe.example.test';
const PUSHER = 'universe-pusher@test', AUDIENCE = 'studenthub-embed/identity@test';
const SUBJECT = 'universe:student:synthetic-1';
const digest = (value: string) => createHash('sha256').update(value).digest('base64url');

/** In-memory twin of PostgresUniverseEmbedStore with an explicit clock (seconds). */
class MemoryEmbedStore implements UniverseEmbedStore {
  now = Math.floor(Date.now() / 1000);
  readonly instances = new Map<string, { browser: string; expires: number }>();
  readonly refs = new Map<string, string>();
  readonly handoffs = new Map<string, { instance: string; browser: string; status: string; state?: string; session?: string; person?: string; expires: number }>();
  readonly bindings = new Map<string, { browser: string; session: string; person: string; generation: number; leaseSubject?: string; leaseExpires?: number }>();
  readonly challenges = new Map<string, { instance: string; generation: number; expires: number }>();
  readonly sessionExpiry = new Map<string, number>();
  readonly locked = new Set<string>();
  readonly subjects = new Map<string, string[]>();
  /** Like the login_sessions join in readBinding: is the session behind a digest still live? */
  sessionLive: (sessionDigest: string) => boolean = () => true;
  leaseWrites: Array<{ iat: number }> = [];
  /** Like the database sequence: a generation value is never reused. */
  nextGeneration = 1;
  async ensureInstance(browser: string, ref: string, ttl: number) {
    const b = digest(browser);
    let id = [...this.instances].find(([, v]) => v.browser === b && v.expires > this.now)?.[0];
    if (!id) {
      for (const [key, v] of this.instances) if (v.browser === b) this.instances.delete(key);
      id = randomUUID(); this.instances.set(id, { browser: b, expires: this.now + ttl });
    }
    this.refs.set(digest(ref), id);
    return id;
  }
  async findInstance(ref: string, browser: string) {
    const id = this.refs.get(digest(ref));
    const i = id ? this.instances.get(id) : undefined;
    return i && i.browser === digest(browser) && i.expires > this.now ? id : undefined;
  }
  async createHandoff(instance: string, browser: string, ttl: number) {
    for (const h of this.handoffs.values()) if (h.instance === instance && (h.status === 'pending' || h.status === 'completed')) {
      Object.assign(h, { status: 'superseded', session: undefined, person: undefined });
    }
    const id = randomUUID();
    this.handoffs.set(id, { instance, browser: digest(browser), status: 'pending', expires: this.now + ttl });
    return id;
  }
  async attachState(id: string, state: string) {
    const h = this.handoffs.get(id);
    if (!h || h.status !== 'pending' || h.state || h.expires <= this.now) return false;
    h.state = digest(state); return true;
  }
  async handoffCurrent(id: string) {
    const h = this.handoffs.get(id);
    return !!h && h.status === 'pending' && !!h.state && h.expires > this.now;
  }
  async completeHandoff(state: string, session: string, person: string) {
    const h = [...this.handoffs.values()].find(x => x.state === digest(state));
    if (!h || h.status !== 'pending' || h.expires <= this.now) return false;
    Object.assign(h, { status: 'completed', session: digest(session), person });
    this.sessionExpiry.set(digest(session), this.now + 43_200);
    return true;
  }
  async consumeHandoff(instance: string, browser: string, session: string) {
    const h = [...this.handoffs.values()].find(x => x.instance === instance && x.browser === digest(browser)
      && x.session === digest(session) && x.status === 'completed' && x.expires > this.now);
    if (!h) return undefined;
    h.status = 'consumed';
    this.bindings.set(instance, { browser: digest(browser), session: digest(session), person: h.person!, generation: this.nextGeneration++ });
    for (const [k, c] of this.challenges) if (c.instance === instance) this.challenges.delete(k);
    return h.person;
  }
  async readBinding(instance: string, browser: string, session: string): Promise<UniverseEmbedBindingView | undefined> {
    const b = this.bindings.get(instance);
    if (!b || b.browser !== digest(browser) || b.session !== digest(session) || !this.sessionLive(b.session)) return undefined;
    const live = b.leaseExpires !== undefined && b.leaseExpires > this.now;
    return { personId: b.person, generation: b.generation, locked: this.locked.has(b.person),
      ...(live ? { lease: { hostSubjectDigest: b.leaseSubject!, expiresAt: new Date(b.leaseExpires! * 1000) } } : {}) };
  }
  async invalidateBinding(instance: string, generation?: number) {
    if (generation !== undefined && this.bindings.get(instance)?.generation !== generation) return;
    this.bindings.delete(instance);
    for (const [k, c] of this.challenges) if (c.instance === instance) this.challenges.delete(k);
  }
  async issueChallenge(instance: string, browser: string, session: string, challenge: string, ttl: number) {
    const b = this.bindings.get(instance);
    if (!b || b.browser !== digest(browser) || b.session !== digest(session)) return false;
    this.challenges.set(digest(challenge), { instance, generation: b.generation, expires: this.now + ttl });
    return true;
  }
  async consumeChallenge(instance: string, challenge: string) {
    const c = this.challenges.get(digest(challenge));
    const b = this.bindings.get(instance);
    if (!c || !b || c.instance !== instance || c.generation !== b.generation || c.expires <= this.now) return undefined;
    this.challenges.delete(digest(challenge));
    return c.generation;
  }
  async writeLease(instance: string, generation: number, subject: string, iat: number, seconds: number) {
    this.leaseWrites.push({ iat });
    const b = this.bindings.get(instance);
    const sessionExpires = b ? this.sessionExpiry.get(b.session) : undefined;
    if (!b || b.generation !== generation || sessionExpires === undefined) return undefined;
    const expires = Math.min(iat + seconds, sessionExpires);
    if (expires <= this.now) return undefined;
    Object.assign(b, { generation: this.nextGeneration++, leaseSubject: digest(subject), leaseExpires: expires });
    return { expiresAt: new Date(expires * 1000), remainingSeconds: expires - this.now };
  }
  async identitySubjects(person: string, issuer: string) { return this.subjects.get(`${person}\u0000${issuer}`) ?? []; }
}

type Reply = { status: number; headers: Record<string, string | string[]>; body: string };
function send(server: Server, method: string, path: string, headers: Record<string, string> = {}, body = ''): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`No response: ${method} ${path}`)), 3000);
    const req = new IncomingMessage(new Socket());
    req.method = method; req.url = path;
    const all = { host: 'embed.example.test', ...headers };
    req.rawHeaders = Object.entries(all).flatMap(([k, v]) => [k, v]);
    req.headers = Object.fromEntries(Object.entries(all).map(([k, v]) => [k.toLowerCase(), v]));
    if (body) req.push(body);
    req.push(null);
    const out: Record<string, string | string[]> = {};
    const res = Object.assign(new EventEmitter(), {
      statusCode: 200, headersSent: false, writableEnded: false, writableFinished: false, destroyed: false,
      setHeader(name: string, value: string | string[]) { out[name.toLowerCase()] = value; return this; },
      getHeader(name: string) { return out[name.toLowerCase()]; },
      removeHeader(name: string) { delete out[name.toLowerCase()]; },
      writeHead(status: number, values: Record<string, string | string[]> = {}) {
        this.statusCode = status; this.headersSent = true;
        for (const [key, value] of Object.entries(values)) this.setHeader(key, value);
        return this;
      },
      end(chunk: unknown = '') {
        this.writableEnded = this.writableFinished = true; clearTimeout(timer); res.emit('finish');
        resolve({ status: this.statusCode, headers: out, body: String(chunk) }); return this;
      },
      destroy() { clearTimeout(timer); reject(new Error('destroyed')); return this; },
    });
    server.emit('request', req, res);
  });
}

/**
 * A browser cookie jar for the embed host (all cookies are __Host-, Path=/).
 * It sends every cookie on every request, which is only how a real browser
 * behaves when the embed and all its frame ancestors are one site (SameSite=Lax).
 * wireUniverse refuses any other topology (assertSameSiteEmbed, tested below).
 */
class Browser {
  jar = new Map<string, string>();
  constructor(readonly server: Server) {}
  cookie() { return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; '); }
  take(reply: Reply) {
    const raw = reply.headers['set-cookie'];
    for (const line of raw === undefined ? [] : Array.isArray(raw) ? raw : [raw]) {
      const [pair] = line.split(';');
      const [name, ...value] = pair!.split('=');
      if (/Max-Age=0/.test(line)) this.jar.delete(name!); else this.jar.set(name!, value.join('='));
    }
    return reply;
  }
  async go(method: string, path: string, headers: Record<string, string> = {}, body = '') {
    return this.take(await send(this.server, method, path, { ...(this.jar.size ? { cookie: this.cookie() } : {}), ...headers }, body));
  }
  token() { return requestToken(this.jar.get('__Host-studenthub_embed')!); }
  api(method: string, path: string, payload?: unknown, origin = EMBED) {
    return this.go(method, path, { 'x-studenthub-embed': this.token(), ...(method === 'POST' ? { origin } : {}),
      ...(payload === undefined ? {} : { 'content-type': 'application/json' }) }, payload === undefined ? '' : JSON.stringify(payload));
  }
}

async function harness(options: { profile?: EmbedProfileView; duringRead?: () => void; duringSessionGet?: () => void } = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  const store = new MemoryEmbedStore();
  const pusher = await generateEd25519KeyPair();
  const other = await generateEd25519KeyPair();
  const base = createUniverseEmbedConfigFromEnv({ UNIVERSE_EMBED_ORIGIN: EMBED, UNIVERSE_EMBED_ENABLED: 'true',
    UNIVERSE_EMBED_ANCESTORS: UNIVERSE, UNIVERSE_EMBED_OIDC_CALLBACK_URL: `${EMBED}/login/callback` }, MAIN)!;
  const profileReads: string[] = [];
  store.sessionLive = (sessionDigest) => [...rig.sessions.records.keys()].some(id => digest(id) === sessionDigest);
  const sessionGet = rig.sessions.get.bind(rig.sessions);
  rig.sessions.get = async (id) => { const found = await sessionGet(id); options.duringSessionGet?.(); return found; };
  const runtime: UniverseEmbedRuntime = {
    store,
    sessions: rig.sessions,
    login: { dependencies: { oidc: rig.provider, jwks: rig.provider, clock: rig.clock, entropy: rig.entropy, states: rig.states,
      sessions: rig.sessions, identities: rig.identities, authorization: rig.authorization },
      config: { ...rig.config, allowedReturnUrls: [`${EMBED}/universe/embed/done`] } },
    authorizationOrigin: new URL(rig.config.issuer).origin,
    hostIdentity: { pusherIssuer: PUSHER, audience: AUDIENCE, subjectPolicy: { humanSubjectPattern: /^universe:student:[a-z0-9-]+$/ },
      keys: async (issuer, kid) => issuer === PUSHER && (kid === undefined || kid === 'k1') ? pusher.publicKeyPem
        : issuer === 'someone-else' ? other.publicKeyPem : undefined,
      replay: new MemoryReplayStore() },
    mapping: sameProviderSubjectMapping(rig.config.issuer, (person, issuer) => store.identitySubjects(person, issuer)),
    profiles: { async read(person) { profileReads.push(person); options.duringRead?.(); return options.profile ?? { state: 'populated', fields: [{ key: 'displayName', value: 'Synthetic Person', source: 'imported_snapshot' }] }; } },
  };
  const config: UniverseEmbedConfig = Object.freeze({ ...base, runtime });
  const server = createGatewayServer(undefined, undefined, undefined, undefined, null, undefined,
    undefined, undefined, undefined, undefined, config);
  const attest = async (challenge: string, over: Partial<ActorAssertionClaims> = {}, key = pusher.privateKeyPem) => {
    const now = Math.floor(Date.now() / 1000);
    return signAssertion({ v: 1, iss: PUSHER, kid: 'k1', aud: AUDIENCE, sub: SUBJECT, iat: now, exp: now + 60, jti: challenge, ...over }, key);
  };
  return { rig, store, server, attest, profileReads, other, runtime };
}

/** Load the frame, sign in through the handoff, return to /done. */
async function signIn(h: Awaited<ReturnType<typeof harness>>, browser = new Browser(h.server)) {
  const frame = await browser.go('GET', '/universe/embed', { 'sec-fetch-dest': 'iframe' });
  assert.equal(frame.status, 200);
  const connect = await browser.go('POST', '/universe/embed/connect',
    { origin: EMBED, 'content-type': 'application/x-www-form-urlencoded' }, `t=${browser.token()}`);
  assert.equal(connect.status, 302);
  // The redirect target is the origin the display's form-action allows.
  assert.equal(new URL(String(connect.headers.location)).origin, h.runtime.authorizationOrigin);
  const request = h.rig.provider.authorizationRequests.at(-1)!;
  const code = h.rig.provider.authorize();
  const callback = await browser.go('GET', `/login/callback?state=${encodeURIComponent(request.state)}&code=${code}`);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, `${EMBED}/universe/embed/done`);
  const done = await browser.go('GET', '/universe/embed/done');
  return { browser, done };
}

async function verifyHost(h: Awaited<ReturnType<typeof harness>>, browser: Browser, over: Partial<ActorAssertionClaims> = {}, key?: string) {
  const challenge = JSON.parse((await browser.api('POST', '/universe/embed/challenge', {})).body).challenge as string;
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  return { challenge, reply: JSON.parse((await browser.api('POST', '/universe/embed/identity', { attestation: await h.attest(challenge, over, key) })).body) };
}

test('E2 display: browser binding first, one instance kept on reload, frameable only as the embed shell', async () => {
  const h = await harness();
  const browser = new Browser(h.server);
  const first = await browser.go('GET', '/universe/embed', { 'sec-fetch-dest': 'iframe' });
  const cookies = first.headers['set-cookie'] as string[];
  assert.deepEqual(cookies.map(c => c.split('=')[0]), ['__Host-studenthub_browser', '__Host-studenthub_embed']);
  for (const c of cookies) assert.match(c, /; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  assert.match(String(first.headers['content-security-policy']), new RegExp(`frame-ancestors ${UNIVERSE};`));
  // The connect form is redirected to the identity provider; form-action must allow exactly that origin.
  assert.match(String(first.headers['content-security-policy']), new RegExp(`form-action 'self' ${new URL(h.rig.config.issuer).origin};`));
  assert.equal(first.headers['x-frame-options'], undefined);
  assert.equal(h.store.instances.size, 1);
  const reload = await browser.go('GET', '/universe/embed', { 'sec-fetch-dest': 'iframe' });
  assert.equal(reload.headers['set-cookie'], undefined, 'reload reuses the instance and its cookie');
  assert.equal(h.store.instances.size, 1);
  // A second embed cookie for the same browser binding names the same instance.
  browser.jar.delete('__Host-studenthub_embed');
  await browser.go('GET', '/universe/embed', { 'sec-fetch-dest': 'iframe' });
  assert.equal(h.store.instances.size, 1);
  assert.equal(new Set(h.store.refs.values()).size, 1);
});

test('E2 copied or top-level URL shows only "Open this in Universe", creates nothing, even with a binding', async () => {
  const h = await harness();
  h.store.subjects.set(`person-1\u0000${h.rig.config.issuer}`, [SUBJECT]);
  const { browser } = await signIn(h);
  assert.equal((await verifyHost(h, browser)).reply.state, 'ready', 'a verified binding exists');
  const top = await browser.go('GET', '/universe/embed', { 'sec-fetch-dest': 'document' });
  assert.match(top.body, /Open this in Universe/);
  assert.doesNotMatch(top.body, /Synthetic Person|embed\.js/);
  assert.equal(top.headers['set-cookie'], undefined);
  assert.equal(top.headers['x-frame-options'], 'DENY');
});

test('E2 handoff: connect → callback → done binds the instance; host verification gates the profile', async () => {
  const h = await harness();
  h.store.subjects.set(`person-1\u0000${h.rig.config.issuer}`, [SUBJECT]);
  const { browser, done } = await signIn(h);
  assert.equal(done.status, 200);
  assert.match(done.body, /You&#39;re signed in\. Go back to Universe\./);
  assert.deepEqual(JSON.parse((await browser.api('GET', '/universe/embed/status')).body), { state: 'needs_universe' });
  assert.deepEqual(JSON.parse((await browser.api('GET', '/universe/embed/profile')).body), { state: 'needs_universe' });
  assert.deepEqual(h.profileReads, [], 'no profile data before host verification');
  const { reply } = await verifyHost(h, browser);
  assert.equal(reply.state, 'ready');
  assert.equal(reply.renewAfterSeconds, 480);
  assert.ok(reply.leaseSeconds >= 593 && reply.leaseSeconds <= 600 - LEASE_CLOCK_MARGIN_SECONDS, String(reply.leaseSeconds));
  assert.deepEqual(JSON.parse((await browser.api('GET', '/universe/embed/status')).body), { state: 'ready' });
  const profile = JSON.parse((await browser.api('GET', '/universe/embed/profile')).body);
  assert.equal(profile.state, 'populated');
  assert.deepEqual(h.profileReads, ['person-1']);
  // The authorization request used the embed's own callback and static return.
  assert.equal(h.rig.provider.authorizationRequests.at(-1)!.redirectUri, h.rig.config.callbackUrl);
});

test('E2 connect needs the exact Origin and the per-transaction value', async () => {
  const h = await harness();
  const browser = new Browser(h.server);
  await browser.go('GET', '/universe/embed', { 'sec-fetch-dest': 'iframe' });
  const form = { 'content-type': 'application/x-www-form-urlencoded' };
  for (const [headers, body] of [
    [{ ...form, origin: 'https://sibling.example.test' }, `t=${browser.token()}`],
    [{ ...form }, `t=${browser.token()}`],
    [{ ...form, origin: EMBED }, 't=wrong'],
    [{ ...form, origin: EMBED }, `t=${browser.token()}&t=${browser.token()}`],
    [{ ...form, origin: EMBED }, `t=${encodeURIComponent('é'.repeat(43))}`],
  ] as const) {
    const reply = await browser.go('POST', '/universe/embed/connect', headers, body);
    assert.equal(reply.status, 400);
    assert.equal(reply.headers.location, undefined);
  }
  assert.equal(h.rig.provider.authorizationRequests.length, 0);
  for (const path of ['/universe/embed/challenge', '/universe/embed/identity', '/logout']) {
    assert.equal((await browser.api('POST', path, {}, 'https://sibling.example.test')).status, 403, path);
  }
  assert.equal((await browser.go('GET', '/universe/embed/status')).status, 403, 'JSON reads need the value too');
});

test('E2 handoff race: a superseded start issues no authorization request; a superseded callback completes nothing', async () => {
  const h = await harness();
  const browser = new Browser(h.server);
  await browser.go('GET', '/universe/embed', { 'sec-fetch-dest': 'iframe' });
  const instance = [...h.store.instances.keys()][0]!;
  const browserRef = browser.jar.get('__Host-studenthub_browser')!;
  // Barrier: A creates H1, B creates H2 (superseding H1), then A resumes its start.
  const h1 = await h.store.createHandoff(instance, browserRef, 600);
  await h.store.createHandoff(instance, browserRef, 600);
  const startA = createLoginApplication({ oidc: h.rig.provider, jwks: h.rig.provider, clock: h.rig.clock, entropy: h.rig.entropy,
    sessions: h.rig.sessions, identities: h.rig.identities, authorization: h.rig.authorization,
    states: handoffBoundStates(h.rig.states, h.store, h1) }, { ...h.rig.config, allowedReturnUrls: [`${EMBED}/universe/embed/done`] });
  await assert.rejects(startA.start({ browserSessionId: browserRef, returnTo: `${EMBED}/universe/embed/done` }));
  assert.equal(h.rig.provider.authorizationRequests.length, 0, 'A issues no authorization request');

  // A attaches its state, then pauses inside the base state write; B supersedes A meanwhile.
  const h3 = await h.store.createHandoff(instance, browserRef, 600);
  let release!: () => void;
  const paused = new Promise<void>(resolve => { release = resolve; });
  const slowStates = { put: async (record: Parameters<typeof h.rig.states.put>[0]) => { await paused; return h.rig.states.put(record); },
    consume: (state: string) => h.rig.states.consume(state) };
  const startPaused = createLoginApplication({ oidc: h.rig.provider, jwks: h.rig.provider, clock: h.rig.clock, entropy: h.rig.entropy,
    sessions: h.rig.sessions, identities: h.rig.identities, authorization: h.rig.authorization,
    states: handoffBoundStates(slowStates, h.store, h3) }, { ...h.rig.config, allowedReturnUrls: [`${EMBED}/universe/embed/done`] })
    .start({ browserSessionId: browserRef, returnTo: `${EMBED}/universe/embed/done` });
  await new Promise(resolve => setImmediate(resolve));
  await h.store.createHandoff(instance, browserRef, 600);
  release();
  await assert.rejects(startPaused, 'superseded while its state was being written: no redirect');
  assert.equal(h.rig.provider.authorizationRequests.length, 0);

  // Two real connects: completing the first (superseded) one is refused and its session deleted.
  const form = { origin: EMBED, 'content-type': 'application/x-www-form-urlencoded' };
  await browser.go('POST', '/universe/embed/connect', form, `t=${browser.token()}`);
  const first = h.rig.provider.authorizationRequests.at(-1)!;
  await browser.go('POST', '/universe/embed/connect', form, `t=${browser.token()}`);
  const second = h.rig.provider.authorizationRequests.at(-1)!;
  const stale = await browser.go('GET', `/login/callback?state=${encodeURIComponent(first.state)}&code=${h.rig.provider.authorizeFor(first)}`);
  assert.equal(stale.status, 400);
  assert.equal(stale.headers['set-cookie'], undefined);
  assert.equal(h.rig.sessions.records.size, 0, 'the refused completion deleted its new session');
  const fresh = await browser.go('GET', `/login/callback?state=${encodeURIComponent(second.state)}&code=${h.rig.provider.authorizeFor(second)}`);
  assert.equal(fresh.status, 302);
  assert.equal((await browser.go('GET', '/universe/embed/done')).status, 200);
});

test('E2 /done refuses direct, pre-existing, swapped, expired and reused handoffs', async () => {
  const h = await harness();
  const direct = new Browser(h.server);
  await direct.go('GET', '/universe/embed', { 'sec-fetch-dest': 'iframe' });
  await h.rig.sessions.put({ id: 'A'.repeat(43), personId: 'person-1' });
  direct.jar.set('__Host-studenthub_session', 'A'.repeat(43));
  const pre = await direct.go('GET', '/universe/embed/done');
  assert.equal(pre.status, 400, 'a pre-existing same-person session with no completed handoff');
  assert.match(pre.body, /Start again/);

  const { browser } = await signIn(h);
  const again = await browser.go('GET', '/universe/embed/done');
  assert.equal(again.status, 400, 'a used handoff cannot bind twice');

  const swapped = new Browser(h.server);
  await swapped.go('GET', '/universe/embed', { 'sec-fetch-dest': 'iframe' });
  await swapped.go('POST', '/universe/embed/connect', { origin: EMBED, 'content-type': 'application/x-www-form-urlencoded' }, `t=${swapped.token()}`);
  const request = h.rig.provider.authorizationRequests.at(-1)!;
  await swapped.go('GET', `/login/callback?state=${encodeURIComponent(request.state)}&code=${h.rig.provider.authorizeFor(request)}`);
  swapped.jar.set('__Host-studenthub_session', browser.jar.get('__Host-studenthub_session')!);
  assert.equal((await swapped.go('GET', '/universe/embed/done')).status, 400, 'swapped session cookie');

  const late = new Browser(h.server);
  await late.go('GET', '/universe/embed', { 'sec-fetch-dest': 'iframe' });
  await late.go('POST', '/universe/embed/connect', { origin: EMBED, 'content-type': 'application/x-www-form-urlencoded' }, `t=${late.token()}`);
  const lateRequest = h.rig.provider.authorizationRequests.at(-1)!;
  await late.go('GET', `/login/callback?state=${encodeURIComponent(lateRequest.state)}&code=${h.rig.provider.authorizeFor(lateRequest)}`);
  h.store.now += 601;
  assert.equal((await late.go('GET', '/universe/embed/done')).status, 400, 'expired handoff');
});

test('E2 lease: host A with platform B, wrong issuer/audience, replayed or old challenges all show no profile', async () => {
  const h = await harness();
  h.store.subjects.set(`person-1\u0000${h.rig.config.issuer}`, [SUBJECT]);
  const cases: Array<[Partial<ActorAssertionClaims>, string]> = [
    [{ sub: 'universe:student:someone-else' }, 'different_account'],
    [{ aud: 'studenthub-embed/identity@other' }, 'start_again'],
    [{ iss: 'someone-else' }, 'start_again'],
  ];
  for (const [over, state] of cases) {
    const { browser } = await signIn(h);
    // The other issuer signs its own claims, so only the explicit host-issuer check can refuse it.
    const { reply } = await verifyHost(h, browser, over, over.iss === 'someone-else' ? h.other.privateKeyPem : undefined);
    assert.deepEqual(reply, { state });
    assert.deepEqual(JSON.parse((await browser.api('GET', '/universe/embed/profile')).body), { state: 'signed_out' });
  }
  // Old challenge reuse after a successful verification cannot renew.
  const { browser } = await signIn(h);
  const { challenge } = await verifyHost(h, browser);
  const replay = JSON.parse((await browser.api('POST', '/universe/embed/identity', { attestation: await h.attest(challenge) })).body);
  assert.deepEqual(replay, { state: 'start_again' });
  assert.deepEqual(h.profileReads, []);
  // A duplicate delivery says nothing against the binding it already made.
  assert.deepEqual(JSON.parse((await browser.api('GET', '/universe/embed/status')).body).state, 'ready');
});

test('E2 lease: a replayed attestation after renewal, or an unavailable verifier, keeps the binding', async () => {
  const h = await harness();
  h.store.subjects.set(`person-1\u0000${h.rig.config.issuer}`, [SUBJECT]);
  const { browser } = await signIn(h);
  const first = await verifyHost(h, browser);
  assert.equal(first.reply.state, 'ready');
  assert.equal((await verifyHost(h, browser)).reply.state, 'ready', 'renewed');
  const replayed = await browser.api('POST', '/universe/embed/identity', { attestation: await h.attest(first.challenge) });
  assert.deepEqual(JSON.parse(replayed.body), { state: 'start_again' });
  assert.equal(JSON.parse((await browser.api('GET', '/universe/embed/status')).body).state, 'ready');
  // Key resolution down: an outage, not evidence against the person.
  const keys = h.runtime.hostIdentity.keys;
  Object.assign(h.runtime.hostIdentity, { keys: async () => { throw new Error('key service down'); } });
  const challenge = JSON.parse((await browser.api('POST', '/universe/embed/challenge', {})).body).challenge as string;
  const down = await browser.api('POST', '/universe/embed/identity', { attestation: await h.attest(challenge) });
  assert.equal(down.status, 503);
  Object.assign(h.runtime.hostIdentity, { keys });
  assert.equal(JSON.parse((await browser.api('GET', '/universe/embed/status')).body).state, 'ready');
});

test('E2 lease ends at attestation iat + 600 s, never at receipt time; expiry clears; renewal keeps the same person', async () => {
  const h = await harness();
  h.store.subjects.set(`person-1\u0000${h.rig.config.issuer}`, [SUBJECT]);
  const { browser } = await signIn(h);
  // One clock for the attestation and the store, so the remaining lease is exact.
  const now = h.store.now;
  const { reply } = await verifyHost(h, browser, { iat: now - 50, exp: now + 10 });
  assert.equal(reply.state, 'ready');
  assert.equal(h.store.leaseWrites.at(-1)!.iat, now - 50, 'the lease is computed from the attested iat');
  assert.equal(reply.leaseSeconds, 550 - LEASE_CLOCK_MARGIN_SECONDS, 'the client is told the remaining lease, not a fresh 600 s');
  assert.equal(LEASE_SECONDS, 600);
  // Renewal with a fresh challenge and the same person succeeds.
  assert.equal((await verifyHost(h, browser)).reply.state, 'ready');
  // Expiry without renewal: no profile.
  const binding = [...h.store.bindings.values()][0]!;
  h.store.now = binding.leaseExpires! + 1;
  assert.deepEqual(JSON.parse((await browser.api('GET', '/universe/embed/profile')).body), { state: 'needs_universe' });
});

test('E2 lock, session revocation and sign-out invalidate the binding', async () => {
  const h = await harness();
  h.store.subjects.set(`person-1\u0000${h.rig.config.issuer}`, [SUBJECT]);
  let { browser } = await signIn(h);
  await verifyHost(h, browser);
  h.store.locked.add('person-1');
  assert.deepEqual(JSON.parse((await browser.api('GET', '/universe/embed/profile')).body), { state: 'start_again' });
  h.store.locked.clear();

  ({ browser } = await signIn(h));
  await verifyHost(h, browser);
  await h.rig.sessions.delete(browser.jar.get('__Host-studenthub_session')!);
  assert.deepEqual(JSON.parse((await browser.api('GET', '/universe/embed/status')).body), { state: 'signed_out' });

  ({ browser } = await signIn(h));
  await verifyHost(h, browser);
  const out = await browser.api('POST', '/logout', {});
  assert.equal(out.status, 200);
  assert.match(String(out.headers['set-cookie']), /^__Host-studenthub_session=; Path=\/; HttpOnly; Secure; SameSite=Lax; Max-Age=0$/);
  assert.deepEqual(JSON.parse((await browser.api('GET', '/universe/embed/profile')).body), { state: 'signed_out' });
  assert.deepEqual(h.profileReads, []);
});

test('E2 sign-out ends only the binding of the session it signs out', async () => {
  const h = await harness();
  h.store.subjects.set(`person-1\u0000${h.rig.config.issuer}`, [SUBJECT]);
  const { browser } = await signIn(h);
  await verifyHost(h, browser);
  const older = browser.jar.get('__Host-studenthub_session')!;
  // A second sign-in on the same instance replaces the binding.
  await signIn(h, browser);
  assert.equal((await verifyHost(h, browser)).reply.state, 'ready');
  const current = browser.jar.get('__Host-studenthub_session')!;
  assert.notEqual(current, older);
  // A sign-out still carrying the older session leaves the newer binding alone.
  browser.jar.set('__Host-studenthub_session', older);
  assert.equal((await browser.api('POST', '/logout', {})).status, 200);
  browser.jar.set('__Host-studenthub_session', current);
  assert.equal(JSON.parse((await browser.api('GET', '/universe/embed/status')).body).state, 'ready');
  // Signing out the current session does end it.
  assert.equal((await browser.api('POST', '/logout', {})).status, 200);
  assert.deepEqual(JSON.parse((await browser.api('GET', '/universe/embed/status')).body), { state: 'signed_out' });
});

test('E2 a store outage while starting sign-in is an outage, not a start-again', async () => {
  const h = await harness();
  const browser = new Browser(h.server);
  await browser.go('GET', '/universe/embed', { 'sec-fetch-dest': 'iframe' });
  h.store.attachState = async () => { throw new Error('database down'); };
  const connect = await browser.go('POST', '/universe/embed/connect',
    { origin: EMBED, 'content-type': 'application/x-www-form-urlencoded' }, `t=${browser.token()}`);
  assert.equal(connect.status, 503);
  assert.equal(h.rig.provider.authorizationRequests.length, 0);
});

test('E2 a store failure while completing sign-in answers 503 and leaves no session', async () => {
  const h = await harness();
  const browser = new Browser(h.server);
  await browser.go('GET', '/universe/embed', { 'sec-fetch-dest': 'iframe' });
  await browser.go('POST', '/universe/embed/connect', { origin: EMBED, 'content-type': 'application/x-www-form-urlencoded' }, `t=${browser.token()}`);
  const request = h.rig.provider.authorizationRequests.at(-1)!;
  const sessionsBefore = h.rig.sessions.records.size;
  h.store.completeHandoff = async () => { throw new Error('database down'); };
  const callback = await browser.go('GET', `/login/callback?state=${encodeURIComponent(request.state)}&code=${h.rig.provider.authorize()}`);
  assert.equal(callback.status, 503);
  assert.equal(callback.headers['set-cookie'], undefined);
  assert.equal(h.rig.sessions.records.size, sessionsBefore, 'the new session was removed');
});

test('E2 link and data states come from My profile\'s reader with provenance', async () => {
  const field = (value: unknown, kind = 'imported_snapshot') => ({ state: 'available', value, provenance: {}, freshness: { kind, observedAt: '' } });
  const reader = (result: unknown) => embedProfilesFrom({ readOwn: async () => result as never });
  assert.deepEqual(await reader({ kind: 'unavailable' }).read('p'), { state: 'unavailable_or_conflict' });
  assert.deepEqual(await reader({ kind: 'found', profile: { legacyLinkState: 'unlinked', fields: {} } }).read('p'), { state: 'not_linked' });
  assert.deepEqual(await reader({ kind: 'found', profile: { legacyLinkState: 'linked', fields: { displayName: { state: 'unavailable' } } } }).read('p'), { state: 'linked_data_not_ready' });
  const populated = await reader({ kind: 'found', profile: { legacyLinkState: 'linked', fields: { displayName: field('Synthetic'), area: field('Hawalli', 'written_by_person'), civilId: field('secret') } } }).read('p');
  assert.equal(populated.state, 'populated');
  assert.deepEqual(populated.state === 'populated' && populated.fields.filter(f => f.value !== null),
    [{ key: 'displayName', value: 'Synthetic', source: 'imported_snapshot' }, { key: 'area', value: 'Hawalli', source: 'written_by_person' }]);
});

test('E2 script never persists or injects HTML, and checks message origin, source and shape', () => {
  for (const banned of ['localStorage', 'sessionStorage', 'indexedDB', 'innerHTML', 'outerHTML', 'insertAdjacentHTML', 'eval(', 'new Function', 'document.cookie', '"*"']) {
    assert.equal(UNIVERSE_EMBED_E2_SCRIPT.includes(banned), false, banned);
  }
  for (const required of ['event.source !== window.parent', 'hosts.indexOf(event.origin) < 0', '"attestation,type,v"', 'pagehide',
    'document.visibilityState === "hidden"', '60000', '5000', 'textContent']) {
    assert.ok(UNIVERSE_EMBED_E2_SCRIPT.includes(required), required);
  }
});

test('E2 wiring: absent E2 names keep E1 behaviour; partial or unpinned configuration refuses to start', async () => {
  const base = createUniverseEmbedConfigFromEnv({ UNIVERSE_EMBED_ORIGIN: EMBED, UNIVERSE_EMBED_ENABLED: 'true',
    UNIVERSE_EMBED_ANCESTORS: UNIVERSE, UNIVERSE_EMBED_OIDC_CALLBACK_URL: `${EMBED}/login/callback` }, MAIN);
  const reader = { readOwn: async () => ({ kind: 'unavailable' as const }) };
  const same = await wireUniverse({}, base, reader);
  assert.equal(same.config, base);
  assert.equal(same.config?.runtime, undefined);
  await assert.rejects(wireUniverse({ UNIVERSE_EMBED_PUSHER_ISSUER: PUSHER }, base, reader), /Invalid Universe embed E2 configuration/);
  const keys = JSON.stringify({ k1: (await generateEd25519KeyPair()).publicKeyPem });
  const full = { DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1:1/synthetic', OIDC_ISSUER: 'https://identity.test.invalid/',
    OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', OIDC_AUTHORIZATION_URL: 'https://identity.test.invalid/a',
    OIDC_TOKEN_URL: 'https://identity.test.invalid/t', OIDC_JWKS_URL: 'https://identity.test.invalid/j',
    UNIVERSE_EMBED_PUSHER_ISSUER: PUSHER, UNIVERSE_EMBED_PUSHER_KEYS: keys, UNIVERSE_EMBED_IDENTITY_AUDIENCE: AUDIENCE,
    UNIVERSE_EMBED_HOST_SUBJECT_FORMAT: 'user_email', UNIVERSE_EMBED_HOST_MAPPING: 'same_provider_subject',
    UNIVERSE_EMBED_SITE: 'example.test' };
  for (const broken of [{ UNIVERSE_EMBED_SITE: 'other.test' }, { UNIVERSE_EMBED_SITE: 'test' }, { UNIVERSE_EMBED_SITE: 'Example.test' },
    { UNIVERSE_EMBED_SITE: 'embed.example.test' }, { UNIVERSE_EMBED_HOST_MAPPING: 'preferred_email' }, { UNIVERSE_EMBED_IDENTITY_AUDIENCE: 'studenthub-embed/identity@prod' },
    { UNIVERSE_EMBED_PUSHER_KEYS: '{}' }, { UNIVERSE_EMBED_HOST_SUBJECT_FORMAT: 'anything' },
    { UNIVERSE_EMBED_HOST_SUBJECT_FORMAT: 'hashed_user_id' }, { OIDC_AUTHORIZATION_URL: 'http://identity.test.invalid/a' },
    { OIDC_AUTHORIZATION_URL: 'not a url' }, { OIDC_AUTHORIZATION_URL: 'https://identity.test.invalid./a' },
    { UNIVERSE_EMBED_PUSHER_KEYS: JSON.stringify({ k1: (await generateEd25519KeyPair()).privateKeyPem }) }]) {
    await assert.rejects(wireUniverse({ ...full, ...broken }, base, reader), /Invalid Universe embed E2 configuration/);
  }
  const disabled = createUniverseEmbedConfigFromEnv({ UNIVERSE_EMBED_ORIGIN: EMBED, UNIVERSE_EMBED_ENABLED: 'false' }, MAIN);
  await assert.rejects(wireUniverse(full, disabled, reader), /Invalid Universe embed E2 configuration/);
  const wired = await wireUniverse(full, base, reader);
  assert.ok(wired.config?.runtime);
  await wired.close();
});

test('E2 only runs same-site: a cross-site Universe ancestor refuses startup, because Lax cookies would never reach the iframe', async () => {
  // The service tests' cookie jar assumes same-site delivery; this guarantee is what makes that true.
  assert.doesNotThrow(() => assertSameSiteEmbed('example.test', EMBED, [UNIVERSE, 'https://dev.example.test:8443', 'https://example.test']));
  for (const ancestors of [['https://universe.other.test'], [UNIVERSE, 'https://evil-example.test'], ['https://example.test.evil.test'], []]) {
    assert.throws(() => assertSameSiteEmbed('example.test', EMBED, ancestors), /Invalid Universe embed E2 configuration/, ancestors.join(','));
  }
  assert.throws(() => assertSameSiteEmbed('example.test', 'https://embed.other.test', [UNIVERSE]), /Invalid Universe embed E2 configuration/);
  for (const site of ['', 'test', '.example.test', 'example..test', '127.0.0.1', 'EXAMPLE.test', 'example.test.']) {
    assert.throws(() => assertSameSiteEmbed(site, EMBED, [UNIVERSE]), /Invalid Universe embed E2 configuration/, site);
  }
  const reader = { readOwn: async () => ({ kind: 'unavailable' as const }) };
  const cross = createUniverseEmbedConfigFromEnv({ UNIVERSE_EMBED_ORIGIN: EMBED, UNIVERSE_EMBED_ENABLED: 'true',
    UNIVERSE_EMBED_ANCESTORS: 'https://universe.other.test', UNIVERSE_EMBED_OIDC_CALLBACK_URL: `${EMBED}/login/callback` }, MAIN)!;
  const keys = JSON.stringify({ k1: (await generateEd25519KeyPair()).publicKeyPem });
  await assert.rejects(wireUniverse({ DATABASE_URL: 'postgres://synthetic:synthetic@127.0.0.1:1/synthetic', OIDC_ISSUER: 'https://identity.test.invalid/',
    OIDC_CLIENT_ID: 'c', OIDC_CLIENT_SECRET: 's', OIDC_AUTHORIZATION_URL: 'https://identity.test.invalid/a',
    OIDC_TOKEN_URL: 'https://identity.test.invalid/t', OIDC_JWKS_URL: 'https://identity.test.invalid/j',
    UNIVERSE_EMBED_PUSHER_ISSUER: PUSHER, UNIVERSE_EMBED_PUSHER_KEYS: keys, UNIVERSE_EMBED_IDENTITY_AUDIENCE: AUDIENCE,
    UNIVERSE_EMBED_HOST_SUBJECT_FORMAT: 'user_email', UNIVERSE_EMBED_HOST_MAPPING: 'same_provider_subject',
    UNIVERSE_EMBED_SITE: 'example.test' }, cross, reader), /Invalid Universe embed E2 configuration/);
});

/**
 * Runs the real embed script against a minimal DOM with a controllable clock,
 * fetch and parent window, so the client-side lease boundary is exercised.
 */
function scriptRig(options: { visibility?: 'visible' | 'hidden' } = {}) {
  let now = 1_000;
  const timers = new Map<number, { at: number; fn: () => void; every?: number }>();
  let nextId = 1;
  class El {
    hidden = false; children: Array<El | { text: string }> = []; attrs = new Map<string, string>();
    dataset: Record<string, string> = {}; listeners = new Map<string, Array<(e: unknown) => void>>();
    #text = '';
    get textContent(): string { return this.#text + this.children.map(c => c instanceof El ? c.textContent : c.text).join(''); }
    set textContent(value: string) { this.#text = String(value); this.children = []; }
    get firstChild() { return this.children[0] ?? null; }
    appendChild(child: El | { text: string }) { this.children.push(child); return child; }
    removeChild(child: unknown) { this.children = this.children.filter(c => c !== child); return child; }
    setAttribute(name: string, value: string) { this.attrs.set(name, String(value)); }
    getAttribute(name: string) { return this.attrs.get(name) ?? null; }
    addEventListener(type: string, fn: (e: unknown) => void) { this.listeners.set(type, [...(this.listeners.get(type) ?? []), fn]); }
  }
  const ids: Record<string, El> = Object.fromEntries(['status', 'profile', 'connect', 'signout', 'link', 'full'].map(id => [id, new El()]));
  ids.profile!.hidden = true;
  const body = new El();
  body.dataset = { hosts: UNIVERSE, token: 't' };
  const posted: Array<{ message: { challenge: string }; origin: string }> = [];
  const parent = { postMessage(message: { challenge: string }, origin: string) { posted.push({ message, origin }); } };
  const windowListeners = new Map<string, Array<(e: unknown) => void>>();
  const routes = new Map<string, () => Promise<unknown>>();
  const calls: string[] = [];
  const documentListeners = new Map<string, Array<(e: unknown) => void>>();
  const document = {
    body, documentElement: { lang: 'en' }, visibilityState: options.visibility ?? 'visible',
    getElementById: (id: string) => ids[id], createElement: () => new El(), createTextNode: (text: string) => ({ text }),
    addEventListener(type: string, fn: (e: unknown) => void) { documentListeners.set(type, [...(documentListeners.get(type) ?? []), fn]); },
  };
  async function visibility(state: 'visible' | 'hidden') {
    document.visibilityState = state;
    for (const fn of documentListeners.get('visibilitychange') ?? []) fn({});
    await settle();
  }
  const window: Record<string, unknown> = {
    parent,
    addEventListener(type: string, fn: (e: unknown) => void) { windowListeners.set(type, [...(windowListeners.get(type) ?? []), fn]); },
  };
  const schedule = (fn: () => void, ms: number, every?: number) => { const id = nextId++; timers.set(id, { at: now + Math.max(0, ms), fn, ...(every ? { every } : {}) }); return id; };
  const context = {
    window, document, performance: { now: () => now }, AbortController, Promise, JSON, Math, Object, Array, String, Error,
    setTimeout: (fn: () => void, ms: number) => schedule(fn, ms), clearTimeout: (id: number) => { timers.delete(id); },
    setInterval: (fn: () => void, ms: number) => schedule(fn, ms, ms),
    fetch: (path: string, init: { method: string }) => {
      calls.push(`${init.method} ${path}`);
      const route = routes.get(`${init.method} ${path}`);
      const result = route ? route() : new Promise(() => {});
      return result.then(json => ({ ok: true, status: 200, json: async () => json }));
    },
  };
  const flush = () => new Promise<void>(resolve => setImmediate(resolve));
  async function settle() { for (let i = 0; i < 10; i++) await flush(); }
  async function advance(ms: number) {
    const end = now + ms;
    for (;;) {
      const due = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      const [id, t] = due;
      now = t.at;
      if (t.every) t.at += t.every; else timers.delete(id);
      t.fn();
      await settle();
    }
    now = end;
    await settle();
  }
  async function attest() {
    const { challenge } = posted.at(-1)!.message;
    for (const fn of windowListeners.get('message') ?? []) {
      fn({ origin: UNIVERSE, source: parent, data: { type: 'studenthub.embed.identity', v: 1, attestation: `a-${challenge}` } });
    }
    await settle();
  }
  return {
    ids, body, routes, calls, posted, advance, settle, attest, visibility,
    start: async () => { window.window = window; runInNewContext(UNIVERSE_EMBED_E2_SCRIPT, { ...context, window }); await settle(); },
    shown: () => !ids.profile!.hidden && ids.profile!.textContent.includes('Synthetic'),
  };
}

test('E2 script: rendered profile data disappears no later than the lease deadline, even when renewal never answers', async () => {
  const rig = scriptRig();
  let challenges = 0;
  rig.routes.set('GET /universe/embed/status', async () => ({ state: 'needs_universe' }));
  // First challenge answers; every later (renewal) challenge hangs, like a throttled or lost request.
  rig.routes.set('POST /universe/embed/challenge', () => (challenges++ === 0 ? Promise.resolve({ challenge: 'c1' }) : new Promise(() => {})));
  rig.routes.set('POST /universe/embed/identity', async () => ({ state: 'ready', leaseSeconds: 30, renewAfterSeconds: 480 }));
  rig.routes.set('GET /universe/embed/profile', async () => ({ state: 'populated', fields: [{ key: 'displayName', value: 'Synthetic', source: 'imported_snapshot' }] }));
  await rig.start();
  await rig.attest();
  assert.equal(rig.shown(), true, 'the verified profile renders');
  await rig.advance(29_999);
  assert.equal(rig.shown(), true);
  await rig.advance(1);
  assert.equal(rig.shown(), false, 'cleared at the deadline, before any renewal answer');
  assert.equal(rig.ids.profile!.children.length, 0);
  assert.equal(rig.body.getAttribute('data-state'), 'needs_universe');
  assert.equal(challenges, 2, 'renewal was attempted after clearing');
});

test('E2 script: renewal clears first, and a profile reply arriving after the deadline is not rendered', async () => {
  const rig = scriptRig();
  let challenge = 0;
  rig.routes.set('GET /universe/embed/status', async () => ({ state: 'needs_universe' }));
  rig.routes.set('POST /universe/embed/challenge', async () => ({ challenge: `c${++challenge}` }));
  rig.routes.set('POST /universe/embed/identity', async () => ({ state: 'ready', leaseSeconds: 595, renewAfterSeconds: 480 }));
  rig.routes.set('GET /universe/embed/profile', async () => ({ state: 'populated', fields: [{ key: 'displayName', value: 'Synthetic', source: 'imported_snapshot' }] }));
  await rig.start();
  await rig.attest();
  assert.equal(rig.shown(), true);
  // Renewal: the profile is cleared before the new challenge is even answered.
  rig.routes.set('POST /universe/embed/challenge', () => new Promise(() => {}));
  await rig.advance(480_000);
  assert.equal(rig.shown(), false);
  assert.equal(rig.body.getAttribute('data-state'), 'needs_universe');

  // A slow profile response that lands after the client deadline never renders.
  const late = scriptRig();
  let release!: (value: unknown) => void;
  late.routes.set('GET /universe/embed/status', async () => ({ state: 'needs_universe' }));
  late.routes.set('POST /universe/embed/challenge', async () => ({ challenge: 'c1' }));
  late.routes.set('POST /universe/embed/identity', async () => ({ state: 'ready', leaseSeconds: 10, renewAfterSeconds: 10 }));
  late.routes.set('GET /universe/embed/profile', () => new Promise(resolve => { release = resolve; }));
  await late.start();
  await late.attest();
  late.routes.set('POST /universe/embed/challenge', () => new Promise(() => {}));
  late.routes.set('GET /universe/embed/profile', () => new Promise(() => {}));
  await late.advance(11_000);
  release({ state: 'populated', fields: [{ key: 'displayName', value: 'Synthetic', source: 'imported_snapshot' }] });
  await late.settle();
  assert.equal(late.shown(), false);
});

test('E2 script: a ready status without a live client lease re-verifies instead of showing data', async () => {
  const rig = scriptRig();
  rig.routes.set('GET /universe/embed/status', async () => ({ state: 'ready' }));
  rig.routes.set('POST /universe/embed/challenge', async () => ({ challenge: 'c1' }));
  rig.routes.set('GET /universe/embed/profile', async () => ({ state: 'populated', fields: [{ key: 'displayName', value: 'Synthetic', source: 'imported_snapshot' }] }));
  await rig.start();
  assert.equal(rig.shown(), false);
  assert.deepEqual(rig.calls, ['GET /universe/embed/status', 'POST /universe/embed/challenge']);
  assert.equal(rig.posted.length, 1);
});

test('E2 profile: a read that outlasts the lease releases no fields', async () => {
  let h!: Awaited<ReturnType<typeof harness>>;
  h = await harness({ duringRead: () => { const b = [...h.store.bindings.values()][0]!; h.store.now = b.leaseExpires! + 1; } });
  h.store.subjects.set(`person-1\u0000${h.rig.config.issuer}`, [SUBJECT]);
  const { browser } = await signIn(h);
  assert.equal((await verifyHost(h, browser)).reply.state, 'ready');
  const reply = JSON.parse((await browser.api('GET', '/universe/embed/profile')).body);
  assert.deepEqual(reply, { state: 'needs_universe' });
  assert.equal(h.profileReads.length, 1, 'the read happened, but its fields were not sent');
});

test('E2 profile: a lease that expires during the final session lookup releases no fields', async () => {
  let h!: Awaited<ReturnType<typeof harness>>;
  // Expire the lease while the re-check after the read waits on the session store.
  h = await harness({ duringSessionGet: () => {
    if (h.profileReads.length === 0) return;
    const b = [...h.store.bindings.values()][0]!; h.store.now = b.leaseExpires! + 1;
  } });
  h.store.subjects.set(`person-1\u0000${h.rig.config.issuer}`, [SUBJECT]);
  const { browser } = await signIn(h);
  assert.equal((await verifyHost(h, browser)).reply.state, 'ready');
  const reply = JSON.parse((await browser.api('GET', '/universe/embed/profile')).body);
  assert.deepEqual(reply, { state: 'needs_universe' });
  assert.equal(h.profileReads.length, 1);
});

for (const when of ['before', 'after'] as const) {
  test(`E2 profile: a logout landing just after the session lookup ${when} the read releases no fields`, async () => {
    let h!: Awaited<ReturnType<typeof harness>>;
    let armed = false;
    let sessionId = '';
    // Revoke the session right after sessions.get() has returned it, before the binding read.
    h = await harness({ duringSessionGet: () => {
      if (!armed || (when === 'after') !== (h.profileReads.length > 0)) return;
      armed = false;
      h.rig.sessions.records.delete(sessionId);
    } });
    h.store.subjects.set(`person-1\u0000${h.rig.config.issuer}`, [SUBJECT]);
    const { browser } = await signIn(h);
    assert.equal((await verifyHost(h, browser)).reply.state, 'ready');
    sessionId = browser.jar.get('__Host-studenthub_session')!;
    armed = true;
    const reply = JSON.parse((await browser.api('GET', '/universe/embed/profile')).body);
    assert.equal(armed, false, 'the revocation ran');
    assert.deepEqual(reply, { state: 'signed_out' });
  });
}

test('E2 a stale refusal never deletes a renewed or replaced binding', async () => {
  const h = await harness();
  h.store.subjects.set(`person-1\u0000${h.rig.config.issuer}`, [SUBJECT]);
  const { browser } = await signIn(h);
  assert.equal((await verifyHost(h, browser)).reply.state, 'ready');
  // Two tabs of the same frame ask for challenges in the same generation.
  const a = JSON.parse((await browser.api('POST', '/universe/embed/challenge', {})).body).challenge as string;
  const b = JSON.parse((await browser.api('POST', '/universe/embed/challenge', {})).body).challenge as string;
  const first = JSON.parse((await browser.api('POST', '/universe/embed/identity', { attestation: await h.attest(a) })).body);
  assert.equal(first.state, 'ready');
  // The other tab's challenge is now stale; its refusal must not remove the renewed binding.
  const second = JSON.parse((await browser.api('POST', '/universe/embed/identity', { attestation: await h.attest(b) })).body);
  assert.deepEqual(second, { state: 'start_again' });
  assert.deepEqual(JSON.parse((await browser.api('GET', '/universe/embed/status')).body), { state: 'ready' });
  // A failure against the current version still invalidates it.
  const c = JSON.parse((await browser.api('POST', '/universe/embed/challenge', {})).body).challenge as string;
  const bad = JSON.parse((await browser.api('POST', '/universe/embed/identity', { attestation: await h.attest(c, { aud: 'wrong' }) })).body);
  assert.deepEqual(bad, { state: 'start_again' });
  assert.deepEqual(JSON.parse((await browser.api('GET', '/universe/embed/status')).body), { state: 'signed_out' });
  // Generations never repeat across rebinds, so an old version cannot match a new binding.
  const instance = [...h.store.bindings.keys()][0];
  assert.equal(instance, undefined);
});

test('E2 a new connect after the callback but before /done supersedes cleanly', async () => {
  const h = await harness();
  const browser = new Browser(h.server);
  await browser.go('GET', '/universe/embed', { 'sec-fetch-dest': 'iframe' });
  const post = () => browser.go('POST', '/universe/embed/connect', { origin: EMBED, 'content-type': 'application/x-www-form-urlencoded' }, `t=${browser.token()}`);
  assert.equal((await post()).status, 302);
  const request = h.rig.provider.authorizationRequests.at(-1)!;
  const callback = await browser.go('GET', `/login/callback?state=${encodeURIComponent(request.state)}&code=${h.rig.provider.authorize()}`);
  assert.equal(callback.status, 302);
  assert.equal((await post()).status, 302, 'superseding a completed handoff starts a new sign-in');
  const old = [...h.store.handoffs.values()].find(x => x.status === 'superseded')!;
  assert.equal(old.session, undefined);
  assert.equal(old.person, undefined);
  assert.equal((await browser.go('GET', '/universe/embed/done')).status, 400, 'the superseded completion cannot be used');
});

test('E2 script: while waiting for the sign-in tab, the frame notices the completed sign-in', async () => {
  const rig = scriptRig();
  let status = 'signed_out';
  rig.routes.set('GET /universe/embed/status', async () => ({ state: status }));
  rig.routes.set('POST /universe/embed/challenge', async () => ({ challenge: 'c1' }));
  await rig.start();
  assert.equal(rig.body.getAttribute('data-state'), 'signed_out');
  for (const fn of rig.ids.connect!.listeners.get('submit') ?? []) fn({});
  assert.equal(rig.body.getAttribute('data-state'), 'waiting');
  await rig.advance(3_000);
  assert.equal(rig.body.getAttribute('data-state'), 'waiting', 'still signing in: the waiting message stays');
  status = 'needs_universe';
  await rig.advance(3_000);
  assert.equal(rig.body.getAttribute('data-state'), 'needs_universe');
  assert.equal(rig.posted.length, 1, 'verification started without any visibility change');
});

test('E2 script: a visibility change while signing in keeps the waiting message and its quick poll', async () => {
  const rig = scriptRig();
  let status = 'signed_out';
  rig.routes.set('GET /universe/embed/status', async () => ({ state: status }));
  rig.routes.set('POST /universe/embed/challenge', async () => ({ challenge: 'c1' }));
  await rig.start();
  for (const fn of rig.ids.connect!.listeners.get('submit') ?? []) fn({});
  // The person switches to the sign-in tab and back before finishing.
  await rig.visibility('hidden');
  await rig.visibility('visible');
  assert.equal(rig.body.getAttribute('data-state'), 'waiting');
  status = 'needs_universe';
  await rig.advance(3_000);
  assert.equal(rig.body.getAttribute('data-state'), 'needs_universe', 'noticed within the quick poll, not the 60 s one');
});

test('E2 hosts: the embed never shares a hostname with the main app, and the site is never a public suffix', () => {
  assert.doesNotThrow(() => assertSeparateHosts(MAIN, EMBED));
  assert.throws(() => assertSeparateHosts('https://app.example.test', 'https://app.example.test:8443'), /Invalid Universe embed E2 configuration/);
  for (const site of ['co.uk', 'com.kw', 'edu.kw', 'org.uk', 'github.io', 'pages.dev', 'vercel.app']) {
    assert.throws(() => assertSameSiteEmbed(site, `https://embed.${site}`, [`https://universe.${site}`]), /Invalid Universe embed E2 configuration/, site);
  }
  assert.doesNotThrow(() => assertSameSiteEmbed('bawes.co.uk', 'https://embed.bawes.co.uk', ['https://universe.bawes.co.uk']));
  assert.doesNotThrow(() => assertSameSiteEmbed('bawes.net', 'https://studenthub.bawes.net', ['https://universe.bawes.net']));
});

test('E2 the host challenge reaches the shared replay store only as its digest', async () => {
  const seen: string[] = [];
  const inner = new MemoryReplayStore();
  const replay = { consume: (iss: string, jti: string, exp: number, now: number) => { seen.push(jti); return inner.consume(iss, jti, exp, now); } };
  const key = await generateEd25519KeyPair();
  const config = { pusherIssuer: PUSHER, audience: AUDIENCE, subjectPolicy: { humanSubjectPattern: /^universe:student:[a-z0-9-]+$/ },
    keys: async () => key.publicKeyPem, replay };
  const challenge = 'c'.repeat(43);
  const now = Math.floor(Date.now() / 1000);
  const token = await signAssertion({ v: 1, iss: PUSHER, kid: 'k1', aud: AUDIENCE, sub: SUBJECT, iat: now, exp: now + 60, jti: challenge }, key.privateKeyPem);
  const result = await verifyHostAttestation(token, config);
  assert.equal(result.ok && result.challenge, challenge);
  assert.deepEqual(seen, [digest(challenge)]);
  assert.equal((await verifyHostAttestation(token, config)).ok, false, 'replay is still detected');
});

// The rest of the body is never sent: a missing refusal fails at the deadline instead of hanging the run.
test('E2 an oversized connect body gets its refusal over a real connection', { timeout: 5_000 }, async () => {
  const h = await harness();
  const browser = new Browser(h.server);
  await browser.go('GET', '/universe/embed', { 'sec-fetch-dest': 'iframe' });
  await new Promise<void>(resolve => h.server.listen(0, '127.0.0.1', resolve));
  const { port } = h.server.address() as AddressInfo;
  try {
    const reply = await new Promise<{ status: number; connection: string | undefined }>((resolve, reject) => {
      const req = httpRequest({ host: '127.0.0.1', port, method: 'POST', path: '/universe/embed/connect', headers: {
        host: 'embed.example.test', origin: EMBED, cookie: browser.cookie(), 'content-type': 'application/x-www-form-urlencoded',
        'content-length': String(64 * 1024) } }, (res) => { res.resume(); resolve({ status: res.statusCode!, connection: res.headers.connection }); });
      req.on('error', reject);
      req.write('t=' + 'a'.repeat(16 * 1024)); // still arriving: the rest is never sent
    });
    assert.equal(reply.status, 400);
    assert.equal(reply.connection, 'close');
  } finally {
    h.server.closeAllConnections?.();
    await new Promise<void>(resolve => h.server.close(() => resolve()));
  }
});

test('E2 script: a frame loaded in a background tab neither checks nor renders until it is visible', async () => {
  const rig = scriptRig({ visibility: 'hidden' });
  rig.routes.set('GET /universe/embed/status', async () => ({ state: 'ready' }));
  await rig.start();
  assert.deepEqual(rig.calls, []);
  assert.equal(rig.shown(), false);
});

test('E2 script: a profile reply started under an earlier lease is ignored after renewal', async () => {
  const rig = scriptRig();
  let challenge = 0;
  const releases: Array<(value: unknown) => void> = [];
  rig.routes.set('GET /universe/embed/status', async () => ({ state: 'needs_universe' }));
  rig.routes.set('POST /universe/embed/challenge', async () => ({ challenge: `c${++challenge}` }));
  rig.routes.set('POST /universe/embed/identity', async () => ({ state: 'ready', leaseSeconds: 100, renewAfterSeconds: 40 }));
  rig.routes.set('GET /universe/embed/profile', () => new Promise(resolve => { releases.push(resolve); }));
  await rig.start();
  await rig.attest();
  assert.equal(releases.length, 1, 'first lease asked for the profile');
  await rig.advance(40_000); // renewal: clears, asks the host again
  await rig.attest();
  assert.equal(releases.length, 2);
  releases[0]!({ state: 'not_linked' }); // the stale reply must not change the view
  await rig.settle();
  assert.equal(rig.body.getAttribute('data-state'), 'needs_universe');
  releases[1]!({ state: 'populated', fields: [{ key: 'displayName', value: 'Synthetic', source: 'imported_snapshot' }] });
  await rig.settle();
  assert.equal(rig.shown(), true);
});
