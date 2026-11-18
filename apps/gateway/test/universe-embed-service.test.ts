/** Universe E2: handoff, host-verification lease and the own-profile view (gateway, in-memory store). */
import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { IncomingMessage, type Server } from 'node:http';
import { Socket } from 'node:net';
import { generateEd25519KeyPair, MemoryReplayStore, signAssertion, type ActorAssertionClaims } from '@bawes/actor-assertion';
import { createSyntheticLoginRig } from '@studenthub/login-contract';
import type { UniverseEmbedBindingView, UniverseEmbedStore } from '@studenthub/db/universe';
import { createGatewayServer } from '../src/index.js';
import { createLoginApplication } from '../src/login-application.js';
import { createUniverseEmbedConfigFromEnv, type UniverseEmbedConfig } from '../src/universe/embed-policy.js';
import { requestToken } from '../src/universe/embed-cookies.js';
import { handoffBoundStates } from '../src/universe/embed-login-states.js';
import { LEASE_SECONDS, type EmbedProfileView, type UniverseEmbedRuntime } from '../src/universe/embed-service.js';
import { UNIVERSE_EMBED_E2_SCRIPT } from '../src/universe/embed-script.js';
import { sameProviderSubjectMapping } from '../src/universe/host-identity.js';
import { assertSameSiteEmbed, embedProfilesFrom, wireUniverse } from '../src/wiring/universe.js';

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
  leaseWrites: Array<{ iat: number }> = [];
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
    for (const h of this.handoffs.values()) if (h.instance === instance && (h.status === 'pending' || h.status === 'completed')) h.status = 'superseded';
    const id = randomUUID();
    this.handoffs.set(id, { instance, browser: digest(browser), status: 'pending', expires: this.now + ttl });
    return id;
  }
  async attachState(id: string, state: string) {
    const h = this.handoffs.get(id);
    if (!h || h.status !== 'pending' || h.state || h.expires <= this.now) return false;
    h.state = digest(state); return true;
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
    this.bindings.set(instance, { browser: digest(browser), session: digest(session), person: h.person!, generation: 0 });
    for (const [k, c] of this.challenges) if (c.instance === instance) this.challenges.delete(k);
    return h.person;
  }
  async readBinding(instance: string, browser: string, session: string): Promise<UniverseEmbedBindingView | undefined> {
    const b = this.bindings.get(instance);
    if (!b || b.browser !== digest(browser) || b.session !== digest(session)) return undefined;
    const live = b.leaseExpires !== undefined && b.leaseExpires > this.now;
    return { personId: b.person, generation: b.generation, locked: this.locked.has(b.person),
      ...(live ? { lease: { hostSubjectDigest: b.leaseSubject!, expiresAt: new Date(b.leaseExpires! * 1000) } } : {}) };
  }
  async invalidateBinding(instance: string) {
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
    Object.assign(b, { generation: generation + 1, leaseSubject: digest(subject), leaseExpires: expires });
    return new Date(expires * 1000);
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

async function harness(options: { profile?: EmbedProfileView } = {}) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  const store = new MemoryEmbedStore();
  const pusher = await generateEd25519KeyPair();
  const other = await generateEd25519KeyPair();
  const base = createUniverseEmbedConfigFromEnv({ UNIVERSE_EMBED_ORIGIN: EMBED, UNIVERSE_EMBED_ENABLED: 'true',
    UNIVERSE_EMBED_ANCESTORS: UNIVERSE, UNIVERSE_EMBED_OIDC_CALLBACK_URL: `${EMBED}/login/callback` }, MAIN)!;
  const profileReads: string[] = [];
  const runtime: UniverseEmbedRuntime = {
    store,
    sessions: rig.sessions,
    login: { dependencies: { oidc: rig.provider, jwks: rig.provider, clock: rig.clock, entropy: rig.entropy, states: rig.states,
      sessions: rig.sessions, identities: rig.identities, authorization: rig.authorization },
      config: { ...rig.config, allowedReturnUrls: [`${EMBED}/universe/embed/done`] } },
    hostIdentity: { pusherIssuer: PUSHER, audience: AUDIENCE, subjectPolicy: { humanSubjectPattern: /^universe:student:[a-z0-9-]+$/ },
      keys: async (issuer, kid) => issuer === PUSHER && (kid === undefined || kid === 'k1') ? pusher.publicKeyPem
        : issuer === 'someone-else' ? other.publicKeyPem : undefined,
      replay: new MemoryReplayStore() },
    mapping: sameProviderSubjectMapping(rig.config.issuer, (person, issuer) => store.identitySubjects(person, issuer)),
    profiles: { async read(person) { profileReads.push(person); return options.profile ?? { state: 'populated', fields: [{ key: 'displayName', value: 'Synthetic Person', source: 'imported_snapshot' }] }; } },
  };
  const config: UniverseEmbedConfig = Object.freeze({ ...base, runtime });
  const server = createGatewayServer(undefined, undefined, undefined, undefined, null, undefined,
    undefined, undefined, undefined, undefined, config);
  const attest = async (challenge: string, over: Partial<ActorAssertionClaims> = {}, key = pusher.privateKeyPem) => {
    const now = Math.floor(Date.now() / 1000);
    return signAssertion({ v: 1, iss: PUSHER, kid: 'k1', aud: AUDIENCE, sub: SUBJECT, iat: now, exp: now + 60, jti: challenge, ...over }, key);
  };
  return { rig, store, server, attest, profileReads, other };
}

/** Load the frame, sign in through the handoff, return to /done. */
async function signIn(h: Awaited<ReturnType<typeof harness>>, browser = new Browser(h.server)) {
  const frame = await browser.go('GET', '/universe/embed', { 'sec-fetch-dest': 'iframe' });
  assert.equal(frame.status, 200);
  const connect = await browser.go('POST', '/universe/embed/connect',
    { origin: EMBED, 'content-type': 'application/x-www-form-urlencoded' }, `t=${browser.token()}`);
  assert.equal(connect.status, 302);
  const request = h.rig.provider.authorizationRequests.at(-1)!;
  const code = h.rig.provider.authorize();
  const callback = await browser.go('GET', `/login/callback?state=${encodeURIComponent(request.state)}&code=${code}`);
  assert.equal(callback.status, 302);
  assert.equal(callback.headers.location, `${EMBED}/universe/embed/done`);
  const done = await browser.go('GET', '/universe/embed/done');
  return { browser, done };
}

async function verifyHost(h: Awaited<ReturnType<typeof harness>>, browser: Browser, over: Partial<ActorAssertionClaims> = {}) {
  const challenge = JSON.parse((await browser.api('POST', '/universe/embed/challenge', {})).body).challenge as string;
  assert.match(challenge, /^[A-Za-z0-9_-]{43}$/);
  return { challenge, reply: JSON.parse((await browser.api('POST', '/universe/embed/identity', { attestation: await h.attest(challenge, over) })).body) };
}

test('E2 display: browser binding first, one instance kept on reload, frameable only as the embed shell', async () => {
  const h = await harness();
  const browser = new Browser(h.server);
  const first = await browser.go('GET', '/universe/embed', { 'sec-fetch-dest': 'iframe' });
  const cookies = first.headers['set-cookie'] as string[];
  assert.deepEqual(cookies.map(c => c.split('=')[0]), ['__Host-studenthub_browser', '__Host-studenthub_embed']);
  for (const c of cookies) assert.match(c, /; Path=\/; HttpOnly; Secure; SameSite=Lax$/);
  assert.match(String(first.headers['content-security-policy']), new RegExp(`frame-ancestors ${UNIVERSE};`));
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
  const { browser } = await signIn(h);
  await verifyHost(h, browser);
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
  assert.deepEqual(reply, { state: 'ready', renewAfterSeconds: 480 });
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
    const { reply } = await verifyHost(h, browser, over);
    assert.deepEqual(reply, { state });
    assert.deepEqual(JSON.parse((await browser.api('GET', '/universe/embed/profile')).body), { state: 'signed_out' });
  }
  // Old challenge reuse after a successful verification cannot renew.
  const { browser } = await signIn(h);
  const { challenge } = await verifyHost(h, browser);
  const replay = JSON.parse((await browser.api('POST', '/universe/embed/identity', { attestation: await h.attest(challenge) })).body);
  assert.deepEqual(replay, { state: 'start_again' });
  assert.deepEqual(h.profileReads, []);
});

test('E2 lease ends at attestation iat + 600 s, never at receipt time; expiry clears; renewal keeps the same person', async () => {
  const h = await harness();
  h.store.subjects.set(`person-1\u0000${h.rig.config.issuer}`, [SUBJECT]);
  const { browser } = await signIn(h);
  const now = Math.floor(Date.now() / 1000);
  const { reply } = await verifyHost(h, browser, { iat: now - 50, exp: now + 10 });
  assert.equal(reply.state, 'ready');
  assert.equal(h.store.leaseWrites.at(-1)!.iat, now - 50, 'the lease is computed from the attested iat');
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
    { UNIVERSE_EMBED_PUSHER_KEYS: '{}' }, { UNIVERSE_EMBED_HOST_SUBJECT_FORMAT: 'anything' }]) {
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
