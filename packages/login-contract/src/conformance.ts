import assert from "node:assert/strict";
import { createHash, generateKeyPairSync, sign } from "node:crypto";

import type {
  AuthorizationRequest,
  AuthorizationStore,
  BrowserResponse,
  ClaimedProfile,
  Clock,
  EntropySource,
  ExternalIdentity,
  IdentityStore,
  JwksResolver,
  LoginApplication,
  LoginApplicationFactory,
  LoginConfig,
  LoginDependencies,
  LoginSession,
  LoginState,
  LoginStateStore,
  OidcTransport,
  SessionStore,
  TokenRequest,
  TokenResponse,
  TestJsonWebKey,
} from "./types.js";

const ISSUER = "https://identity.login.invalid";
const CLIENT_ID = "studenthub-test-client";
const CLIENT_SECRET = "synthetic-secret-never-for-a-browser";
const CALLBACK_URL = "https://studenthub.test.invalid/login/callback";
const RETURN_URL = "https://studenthub.test.invalid/home";
const NOW = 1_800_000_000;

export interface ConformanceResult {
  readonly name: string;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface ConformanceReport {
  readonly ok: boolean;
  readonly results: readonly ConformanceResult[];
}

interface TokenOverrides {
  readonly issuer?: string;
  readonly audience?: string;
  readonly subject?: string;
  readonly nonce?: string;
  readonly expiresAt?: number;
  readonly issuedAt?: number;
  readonly signatureValid?: boolean;
  readonly profile?: ClaimedProfile;
  readonly role?: string;
}

function encoded(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function browserText(response: BrowserResponse): string {
  return JSON.stringify({ headers: response.headers ?? {}, body: response.body ?? {} });
}

function cookieSession(response: BrowserResponse): string {
  const cookie = response.headers?.["set-cookie"];
  assert.ok(cookie, "successful callback must set a session cookie");
  const match = /^studenthub_session=([^;]+)/.exec(cookie);
  assert.ok(match?.[1], "session cookie must carry an opaque id");
  return match[1];
}

class FakeClock implements Clock {
  constructor(public epoch = NOW) {}
  nowEpochSeconds(): number { return this.epoch; }
}

class DeterministicEntropy implements EntropySource {
  readonly requests: number[] = [];
  #counter = 1;

  bytes(length: number): Uint8Array {
    this.requests.push(length);
    const bytes = new Uint8Array(length);
    for (let index = 0; index < length; index += 1) {
      bytes[index] = (this.#counter + index * 37) % 256;
    }
    this.#counter += 1;
    return bytes;
  }
}

class MemoryStates implements LoginStateStore {
  readonly records = new Map<string, LoginState>();
  async put(record: LoginState): Promise<void> { this.records.set(record.state, structuredClone(record)); }
  async consume(state: string): Promise<LoginState | undefined> {
    const record = this.records.get(state);
    this.records.delete(state);
    return record && structuredClone(record);
  }
}

class MemorySessions implements SessionStore {
  readonly records = new Map<string, LoginSession>();
  async put(record: LoginSession): Promise<void> { this.records.set(record.id, structuredClone(record)); }
  async get(id: string): Promise<LoginSession | undefined> {
    const record = this.records.get(id);
    return record && structuredClone(record);
  }
  async delete(id: string): Promise<void> { this.records.delete(id); }
}

class MemoryIdentities implements IdentityStore {
  readonly records: ExternalIdentity[] = [];
  legacyCalls = 0;
  #nextId = 1;

  async findBySubject(issuer: string, subject: string): Promise<ExternalIdentity | undefined> {
    return this.records.find((record) => record.issuer === issuer && record.subject === subject);
  }

  async createForSubject(issuer: string, subject: string, _claims: ClaimedProfile): Promise<ExternalIdentity> {
    const record = { issuer, subject, personId: `person-${this.#nextId}` };
    this.#nextId += 1;
    this.records.push(record);
    return record;
  }

  async findLegacyMatch(_claims: ClaimedProfile): Promise<ExternalIdentity | undefined> {
    this.legacyCalls += 1;
    return this.records.find((record) => record.personId === "legacy-person");
  }
}

class MemoryAuthorization implements AuthorizationStore {
  readonly roles = new Map<string, string>();
  calls = 0;

  async roleFor(personId: string): Promise<string> {
    this.calls += 1;
    return this.roles.get(personId) ?? (personId === "person-1" ? "candidate" : "member");
  }
}

class FakeProvider implements OidcTransport, JwksResolver {
  readonly authorizationRequests: AuthorizationRequest[] = [];
  readonly tokenRequests: TokenRequest[] = [];
  readonly #codes = new Map<string, { request: AuthorizationRequest; overrides: TokenOverrides }>();
  readonly #privateKey;
  readonly #publicJwk: TestJsonWebKey;
  readonly #wrongPrivateKey;
  #nextCode = 1;

  constructor() {
    const primary = generateKeyPairSync("ed25519");
    const wrong = generateKeyPairSync("ed25519");
    this.#privateKey = primary.privateKey;
    this.#wrongPrivateKey = wrong.privateKey;
    this.#publicJwk = primary.publicKey.export({ format: "jwk" }) as TestJsonWebKey;
  }

  authorizationUrl(request: AuthorizationRequest): string {
    this.authorizationRequests.push(structuredClone(request));
    const url = new URL(`${ISSUER}/authorize`);
    url.search = new URLSearchParams({
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: request.codeChallengeMethod,
      response_type: "code",
    }).toString();
    return url.toString();
  }

  authorize(overrides: TokenOverrides = {}): string {
    const request = this.authorizationRequests.at(-1);
    assert.ok(request, "login start must precede authorization");
    const code = `synthetic-code-${this.#nextCode}`;
    this.#nextCode += 1;
    this.#codes.set(code, { request, overrides });
    return code;
  }

  async exchange(request: TokenRequest): Promise<TokenResponse> {
    this.tokenRequests.push(structuredClone(request));
    const issued = this.#codes.get(request.code);
    assert.ok(issued, "authorization code must be issued by the fake provider");
    this.#codes.delete(request.code);
    assert.equal(request.clientSecret, CLIENT_SECRET, "token exchange must remain server-side");
    assert.equal(request.redirectUri, CALLBACK_URL);
    const challenge = createHash("sha256").update(request.codeVerifier).digest("base64url");
    assert.equal(challenge, issued.request.codeChallenge, "PKCE verifier must match the S256 challenge");

    const claims = {
      iss: issued.overrides.issuer ?? ISSUER,
      aud: issued.overrides.audience ?? CLIENT_ID,
      sub: issued.overrides.subject ?? "universe:student:synthetic-1",
      nonce: issued.overrides.nonce ?? issued.request.nonce,
      exp: issued.overrides.expiresAt ?? NOW + 300,
      iat: issued.overrides.issuedAt ?? NOW,
      email: issued.overrides.profile?.email ?? "person@login.invalid",
      phone: issued.overrides.profile?.phone ?? "+000000000",
      name: issued.overrides.profile?.name ?? "Synthetic Person",
      birthdate: issued.overrides.profile?.dateOfBirth ?? "2000-01-01",
      role: issued.overrides.role ?? "admin",
    };
    const header = encoded({ alg: "EdDSA", kid: "synthetic-key", typ: "JWT" });
    const payload = encoded(claims);
    const signingInput = `${header}.${payload}`;
    const key = issued.overrides.signatureValid === false ? this.#wrongPrivateKey : this.#privateKey;
    const signature = sign(null, Buffer.from(signingInput), key).toString("base64url");
    return { accessToken: "synthetic-access-token", idToken: `${signingInput}.${signature}` };
  }

  async resolve(issuer: string, kid: string): Promise<TestJsonWebKey | undefined> {
    return issuer === ISSUER && kid === "synthetic-key" ? structuredClone(this.#publicJwk) : undefined;
  }
}

export interface SyntheticLoginRig {
  readonly app: LoginApplication;
  readonly config: LoginConfig;
  readonly provider: FakeProvider;
  readonly clock: FakeClock;
  readonly entropy: DeterministicEntropy;
  readonly states: MemoryStates;
  readonly sessions: MemorySessions;
  readonly identities: MemoryIdentities;
  readonly authorization: MemoryAuthorization;
}

export function createSyntheticLoginRig(factory: LoginApplicationFactory): SyntheticLoginRig {
  const provider = new FakeProvider();
  const clock = new FakeClock();
  const entropy = new DeterministicEntropy();
  const states = new MemoryStates();
  const sessions = new MemorySessions();
  const identities = new MemoryIdentities();
  const authorization = new MemoryAuthorization();
  const config: LoginConfig = Object.freeze({
    issuer: ISSUER,
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    callbackUrl: CALLBACK_URL,
    allowedReturnUrls: [RETURN_URL, "https://studenthub.test.invalid/profile"],
    clockSkewSeconds: 30,
    subjectPolicy: (subject: string) => /^universe:student:[a-z0-9-]+$/.test(subject),
  });
  const dependencies: LoginDependencies = {
    oidc: provider,
    jwks: provider,
    clock,
    entropy,
    states,
    sessions,
    identities,
    authorization,
  };
  return { app: factory(dependencies, config), config, provider, clock, entropy, states, sessions, identities, authorization };
}

async function begin(rig: SyntheticLoginRig, returnTo = RETURN_URL, browserSessionId = "browser-a") {
  const response = await rig.app.start({ browserSessionId, returnTo });
  assert.equal(response.status, 302);
  const location = response.headers?.location;
  assert.ok(location, "login start must redirect to the provider");
  return { response, request: rig.provider.authorizationRequests.at(-1)! };
}

async function complete(
  rig: SyntheticLoginRig,
  overrides: TokenOverrides = {},
  browserSessionId = "browser-a",
) {
  const authorization = rig.provider.authorizationRequests.at(-1);
  assert.ok(authorization);
  const code = rig.provider.authorize(overrides);
  const response = await rig.app.callback({ browserSessionId, state: authorization.state, code });
  return { response, code };
}

async function expectRejected(responsePromise: Promise<BrowserResponse>, label: string): Promise<void> {
  const response = await responsePromise;
  assert.ok(response.status >= 400, `${label} must be rejected`);
}

type Scenario = { readonly name: string; readonly run: (factory: LoginApplicationFactory) => Promise<void> };

const SCENARIOS: readonly Scenario[] = [
  {
    name: "server-side exchange, PKCE S256, nonce, and browser secrecy",
    run: async (factory) => {
      const rig = createSyntheticLoginRig(factory);
      const { response: start, request } = await begin(rig);
      assert.equal(request.codeChallengeMethod, "S256");
      assert.equal(request.redirectUri, CALLBACK_URL);
      assert.ok(request.state.length >= 32);
      assert.ok(request.nonce.length >= 32);
      assert.ok(rig.entropy.requests.filter((length) => length >= 24).length >= 3);
      const { response: callback, code } = await complete(rig);
      assert.equal(callback.status, 302);
      assert.equal(callback.headers?.location, RETURN_URL);
      const exposed = `${browserText(start)} ${browserText(callback)}`;
      for (const secret of [code, CLIENT_SECRET, "synthetic-access-token", rig.provider.tokenRequests[0]?.codeVerifier]) {
        assert.ok(secret);
        assert.doesNotMatch(exposed, new RegExp(secret.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
      }
      assert.equal(rig.provider.tokenRequests.length, 1);

      const rejected = createSyntheticLoginRig(factory);
      await begin(rejected);
      const invalid = await complete(rejected, { signatureValid: false });
      assert.ok(invalid.response.status >= 400);
      assert.doesNotMatch(browserText(invalid.response), /synthetic-code|synthetic-secret|synthetic-access-token/);
    },
  },
  {
    name: "state is session-bound, one-time, unpredictable, and mismatch-safe",
    run: async (factory) => {
      const rig = createSyntheticLoginRig(factory);
      const first = await begin(rig);
      const second = await begin(rig);
      assert.notEqual(first.request.state, second.request.state);
      const code = rig.provider.authorize();
      await expectRejected(rig.app.callback({ browserSessionId: "browser-b", state: second.request.state, code }), "cross-session state");
      const fresh = await begin(rig);
      const validCode = rig.provider.authorize();
      const success = await rig.app.callback({ browserSessionId: "browser-a", state: fresh.request.state, code: validCode });
      assert.equal(success.status, 302);
      const replayCode = rig.provider.authorize();
      await expectRejected(
        rig.app.callback({ browserSessionId: "browser-a", state: fresh.request.state, code: replayCode }),
        "state replay",
      );
      await expectRejected(
        rig.app.callback({ browserSessionId: "browser-a", state: "invented-state", code: "invented-code" }),
        "state mismatch",
      );
    },
  },
  {
    name: "return redirects use an exact allowlist",
    run: async (factory) => {
      for (const unsafe of [
        "https://attacker.invalid/",
        "//attacker.invalid/path",
        "\\\\attacker.invalid\\path",
        "https://studenthub.test.invalid.evil.invalid/home",
        "https://studenthub.test.invalid/home/../admin",
      ]) {
        const rig = createSyntheticLoginRig(factory);
        await expectRejected(rig.app.start({ browserSessionId: "browser-a", returnTo: unsafe }), `redirect ${unsafe}`);
        assert.equal(rig.provider.authorizationRequests.length, 0);
      }
    },
  },
  {
    name: "ID token signature, issuer, audience, expiry, issued-at, and nonce are verified",
    run: async (factory) => {
      const badTokens: readonly [string, TokenOverrides][] = [
        ["signature", { signatureValid: false }],
        ["issuer", { issuer: "https://attacker.invalid" }],
        ["audience", { audience: "other-client" }],
        ["expiry", { expiresAt: NOW - 31 }],
        ["issued-at", { issuedAt: NOW + 31 }],
        ["nonce", { nonce: "wrong-nonce" }],
      ];
      for (const [label, overrides] of badTokens) {
        const rig = createSyntheticLoginRig(factory);
        await begin(rig);
        await expectRejected(complete(rig, overrides).then(({ response }) => response), label);
        assert.equal(rig.sessions.records.size, 0, `${label} must not create a session`);
      }
    },
  },
  {
    name: "subject policy and external-account binding never fall back to profile claims",
    run: async (factory) => {
      const rejected = createSyntheticLoginRig(factory);
      rejected.identities.records.push({ issuer: ISSUER, subject: "legacy-subject", personId: "legacy-person" });
      await begin(rejected);
      await expectRejected(complete(rejected, {
        subject: "person@login.invalid",
        profile: { email: "person@login.invalid", phone: "+000000000", name: "Synthetic Person", dateOfBirth: "2000-01-01" },
      }).then(({ response }) => response), "subject policy");
      assert.equal(rejected.identities.legacyCalls, 0);

      const first = createSyntheticLoginRig(factory);
      first.identities.records.push({ issuer: ISSUER, subject: "unrelated", personId: "legacy-person" });
      await begin(first);
      const login = await complete(first, { profile: { email: "matching@login.invalid", phone: "+123", name: "Match", dateOfBirth: "1990-01-01" } });
      assert.equal(login.response.status, 302);
      assert.equal(first.identities.legacyCalls, 0);
      assert.equal(first.identities.records.at(-1)?.personId, "person-1");

      await begin(first);
      const again = await complete(first, {
        subject: "universe:student:synthetic-1",
        profile: { email: "changed@login.invalid" },
      });
      assert.equal(again.response.status, 302);
      assert.equal(first.identities.records.filter((record) => record.subject === "universe:student:synthetic-1").length, 1);
    },
  },
  {
    name: "account binding, server authorization, profile isolation, secure cookie, and logout",
    run: async (factory) => {
      const rig = createSyntheticLoginRig(factory);
      await begin(rig);
      const { response } = await complete(rig, { role: "owner" });
      assert.equal(response.status, 302);
      const cookie = response.headers?.["set-cookie"] ?? "";
      assert.match(cookie, /HttpOnly/i);
      assert.match(cookie, /Secure/i);
      assert.match(cookie, /SameSite=(Lax|Strict)/i);
      assert.match(cookie, /Path=\//i);
      const sessionId = cookieSession(response);
      const own = await rig.app.profile({ sessionId, requestedRole: "owner" });
      assert.equal(own.status, 200);
      assert.equal(own.body?.role, "candidate");
      rig.authorization.roles.set("person-1", "reviewer");
      const rederived = await rig.app.profile({ sessionId });
      assert.equal(rederived.body?.role, "reviewer");
      assert.ok(rig.authorization.calls >= 2, "authorization must be re-derived for every request");
      const other = await rig.app.profile({ sessionId, personId: "person-999", requestedRole: "owner" });
      assert.ok(other.status === 403 || other.status === 404);
      const logout = await rig.app.logout(sessionId);
      assert.equal(logout.status, 204);
      assert.match(logout.headers?.["set-cookie"] ?? "", /Max-Age=0/i);
      await expectRejected(rig.app.profile({ sessionId }), "logged-out session");
    },
  },
];

export async function runLoginConformance(factory: LoginApplicationFactory): Promise<ConformanceReport> {
  const results: ConformanceResult[] = [];
  for (const scenario of SCENARIOS) {
    try {
      await scenario.run(factory);
      results.push({ name: scenario.name, ok: true });
    } catch (error) {
      results.push({ name: scenario.name, ok: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
  return { ok: results.every((result) => result.ok), results };
}

export const LOGIN_CONTRACT_SCENARIOS = Object.freeze(SCENARIOS.map(({ name }) => name));
