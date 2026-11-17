import { randomBytes } from "node:crypto";
import { UNIVERSE_SUBJECT_POLICY } from "@bawes/actor-assertion";
import type {
  AuthorizationRequest,
  JwksResolver,
  OidcTransport,
  TestJsonWebKey,
  TokenRequest,
  TokenResponse,
  UpstreamActivity,
  UpstreamEndResult,
  UpstreamSessions,
} from "@studenthub/login-contract";
import {
  UnconfiguredApprovedProfileAdapter,
  type ApprovedProfileAdapter,
} from "@studenthub/profile";

import { confirmingSessions, createLoginApplication, upstreamCheckSeconds, upstreamLogger } from "./login-application.js";
import type { BrowserLoginApplication } from "./web-ui.js";
import { wireAccess } from "./wiring/access.js";
import { wireAccessLane } from "./wiring/access-lane.js";
import { wireProfile } from "./wiring/profile.js";
import { wireOrganizations } from "./wiring/organizations.js";
import { wirePayContracts } from "./wiring/pay-contracts.js";
import { wireOps } from "./wiring/ops.js";
import {PostgresNotificationsStore} from "@studenthub/db/notifications";
import {NotificationsService} from "../../../packages/notifications/src/notifications.js";
import {createNotificationsHttp} from "./notifications-http.js";

interface JwksDocument {
  readonly keys?: readonly TestJsonWebKey[];
}

const DEFAULT_OIDC_HTTP_TIMEOUT_MS = 10_000;

export class HttpOidcTransport implements OidcTransport {
  readonly #issuer: string;
  readonly #authorizationEndpoint: string;
  readonly #tokenEndpoint: string;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(
    issuer: string,
    authorizationEndpoint: string,
    tokenEndpoint: string,
    requestTimeoutMs = DEFAULT_OIDC_HTTP_TIMEOUT_MS,
    fetchImplementation: typeof fetch = fetch,
  ) {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new RangeError("OIDC request timeout must be a positive safe integer");
    }
    this.#issuer = issuer;
    this.#authorizationEndpoint = authorizationEndpoint;
    this.#tokenEndpoint = tokenEndpoint;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#fetch = fetchImplementation;
  }

  authorizationUrl(request: AuthorizationRequest): string {
    if (request.issuer !== this.#issuer) throw new Error("authorization issuer mismatch");
    const url = new URL(this.#authorizationEndpoint);
    url.search = new URLSearchParams({
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
      response_type: "code",
      scope: "openid profile email",
      state: request.state,
      nonce: request.nonce,
      code_challenge: request.codeChallenge,
      code_challenge_method: request.codeChallengeMethod,
    }).toString();
    return url.toString();
  }

  async exchange(request: TokenRequest): Promise<TokenResponse> {
    const response = await this.#fetch(this.#tokenEndpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code: request.code,
        client_id: request.clientId,
        client_secret: request.clientSecret,
        redirect_uri: request.redirectUri,
        code_verifier: request.codeVerifier,
      }),
      redirect: "error",
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("OIDC token exchange failed");
    }
    const payload = await response.json() as { readonly access_token?: unknown; readonly id_token?: unknown };
    if (typeof payload.access_token !== "string" || typeof payload.id_token !== "string") {
      throw new Error("OIDC token response is malformed");
    }
    return { accessToken: payload.access_token, idToken: payload.id_token };
  }
}

export class RefreshingJwksResolver implements JwksResolver {
  readonly #keys = new Map<string, { readonly jwk: TestJsonWebKey; readonly expiresAt: number }>();
  readonly #issuer: string;
  readonly #jwksUrl: string;
  readonly #ttlSeconds: number;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;

  constructor(
    issuer: string,
    jwksUrl: string,
    ttlSeconds = 300,
    requestTimeoutMs = DEFAULT_OIDC_HTTP_TIMEOUT_MS,
    fetchImplementation: typeof fetch = fetch,
  ) {
    if (!Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs <= 0) {
      throw new RangeError("OIDC request timeout must be a positive safe integer");
    }
    this.#issuer = issuer;
    this.#jwksUrl = jwksUrl;
    this.#ttlSeconds = ttlSeconds;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#fetch = fetchImplementation;
  }

  async resolve(issuer: string, kid: string): Promise<TestJsonWebKey | undefined> {
    if (issuer !== this.#issuer) return undefined;
    const cacheKey = `${issuer}\u0000${kid}`;
    const cached = this.#keys.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() / 1000) return cached.jwk;

    // Refresh on expiry and every unknown kid. Keys absent from the latest
    // issuer document are evicted, so rotation cannot fall back to a retired
    // key indefinitely.
    const response = await this.#fetch(this.#jwksUrl, {
      redirect: "error",
      signal: AbortSignal.timeout(this.#requestTimeoutMs),
    });
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new Error("OIDC JWKS refresh failed");
    }
    const document = await response.json() as JwksDocument;
    if (!Array.isArray(document.keys)) throw new Error("OIDC JWKS is malformed");
    this.#keys.clear();
    const expiresAt = Date.now() / 1000 + this.#ttlSeconds;
    for (const jwk of document.keys) {
      if (typeof jwk.kid === "string" && typeof jwk.kty === "string") {
        this.#keys.set(`${issuer}\u0000${jwk.kid}`, { jwk, expiresAt });
      }
    }
    return this.#keys.get(cacheKey)?.jwk;
  }
}

interface DiscoveryDocument {
  readonly issuer?: unknown;
  readonly end_session_endpoint?: unknown;
}

/**
 * SHU-457: the issuer's own session behind the UpstreamSessions port, built
 * from the issuer's discovery document. No token is stored and nothing secret
 * goes in a URL: sign-out POSTs the client identifier and the session
 * reference to the end-session endpoint as a form body.
 *
 * Liveness: OIDC discovery offers no per-session query that works without a
 * stored token. Introspection needs an access token (we keep none) and
 * back-channel logout needs a receiving endpoint (not built here), so
 * isActive answers unknown and the bound fails the session closed 2*T after
 * sign-in.
 */
export class DiscoveryUpstreamSessions implements UpstreamSessions {
  readonly #issuer: string;
  readonly #clientId: string;
  readonly #requestTimeoutMs: number;
  readonly #fetch: typeof fetch;
  #endpoint: Promise<string | undefined> | undefined;

  constructor(issuer: string, clientId: string, requestTimeoutMs = 3_000, fetchImplementation: typeof fetch = fetch) {
    this.#issuer = issuer;
    this.#clientId = clientId;
    this.#requestTimeoutMs = requestTimeoutMs;
    this.#fetch = fetchImplementation;
  }

  #endSessionEndpoint(): Promise<string | undefined> {
    this.#endpoint ??= (async () => {
      const response = await this.#fetch(`${this.#issuer.replace(/\/$/, "")}/.well-known/openid-configuration`, {
        redirect: "error", signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        throw new Error("OIDC discovery failed");
      }
      const document = await response.json() as DiscoveryDocument;
      if (document.issuer !== this.#issuer) throw new Error("OIDC discovery issuer mismatch");
      const endpoint = document.end_session_endpoint;
      if (typeof endpoint !== "string") return undefined;
      const url = new URL(endpoint);
      if (url.protocol !== "https:" || url.username || url.password) return undefined;
      return endpoint;
    })().catch((error: unknown) => { this.#endpoint = undefined; throw error; });
    return this.#endpoint;
  }

  async end(reference: string): Promise<UpstreamEndResult> {
    try {
      const endpoint = await this.#endSessionEndpoint();
      if (!endpoint) return "unreachable";
      const response = await this.#fetch(endpoint, {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({ client_id: this.#clientId, sid: reference }),
        redirect: "manual",
        signal: AbortSignal.timeout(this.#requestTimeoutMs),
      });
      await response.body?.cancel().catch(() => undefined);
      return response.status < 400 ? "ended" : "unreachable";
    } catch {
      return "unreachable";
    }
  }

  async isActive(_reference: string): Promise<UpstreamActivity> {
    return "unknown";
  }
}

/** LOGIN_UPSTREAM_SESSIONS=on turns the port on; LOGIN_UPSTREAM_CHECK_SECONDS is T (default 900, 60 to 3600). */
export function upstreamSessionsFromEnv(env: NodeJS.ProcessEnv, issuer: string, clientId: string):
  { readonly port: UpstreamSessions; readonly checkSeconds: number } | undefined {
  const mode = env.LOGIN_UPSTREAM_SESSIONS;
  if (mode === undefined || mode === "off") {
    if (env.LOGIN_UPSTREAM_CHECK_SECONDS !== undefined) throw new Error("LOGIN_UPSTREAM_CHECK_SECONDS needs LOGIN_UPSTREAM_SESSIONS=on");
    return undefined;
  }
  if (mode !== "on") throw new Error("LOGIN_UPSTREAM_SESSIONS must be on or off");
  const raw = env.LOGIN_UPSTREAM_CHECK_SECONDS;
  if (raw !== undefined && !/^[0-9]{1,5}$/.test(raw)) throw new Error("LOGIN_UPSTREAM_CHECK_SECONDS must be an integer from 60 to 3600");
  return { port: new DiscoveryUpstreamSessions(issuer, clientId), checkSeconds: upstreamCheckSeconds(raw === undefined ? undefined : Number(raw)) };
}

export interface RuntimeLogin {
  readonly application: BrowserLoginApplication;
  close(): Promise<void>;
}

/** Build the real login stack only when the complete explicit env contract is present. */
export function createRuntimeLoginFromEnv(
  env: NodeJS.ProcessEnv = process.env,
  approvedProfiles: ApprovedProfileAdapter = new UnconfiguredApprovedProfileAdapter(),
): RuntimeLogin | undefined {
  const names = [
    "DATABASE_URL",
    "OIDC_ISSUER",
    "OIDC_CLIENT_ID",
    "OIDC_CLIENT_SECRET",
    "OIDC_CALLBACK_URL",
    "OIDC_AUTHORIZATION_URL",
    "OIDC_TOKEN_URL",
    "OIDC_JWKS_URL",
    "LOGIN_ALLOWED_RETURN_URLS",
  ] as const;
  const present = names.filter((name) => env[name] !== undefined);
  if (present.length === 0) return undefined;
  if (present.length !== names.length) {
    throw new Error(`incomplete login configuration: missing ${names.filter((name) => !env[name]).join(", ")}`);
  }

  const value = (name: typeof names[number]): string => env[name]!;
  for (const name of ["DATABASE_URL", "OIDC_CLIENT_ID", "OIDC_CLIENT_SECRET"] as const) {
    if (value(name).trim().length === 0) throw new Error(`${name} must be non-empty`);
  }
  const issuer = exactHttpsUrl(value("OIDC_ISSUER"), "OIDC_ISSUER");
  const callbackUrl = exactHttpsUrl(value("OIDC_CALLBACK_URL"), "OIDC_CALLBACK_URL");
  if (new URL(callbackUrl).pathname !== "/login/callback") {
    throw new Error("OIDC_CALLBACK_URL must target the gateway /login/callback route");
  }
  const authorizationUrl = exactHttpsUrl(value("OIDC_AUTHORIZATION_URL"), "OIDC_AUTHORIZATION_URL");
  const tokenUrl = exactHttpsUrl(value("OIDC_TOKEN_URL"), "OIDC_TOKEN_URL");
  const jwksUrl = exactHttpsUrl(value("OIDC_JWKS_URL"), "OIDC_JWKS_URL");
  if (value("LOGIN_ALLOWED_RETURN_URLS").trim().length === 0) {
    throw new Error("LOGIN_ALLOWED_RETURN_URLS must not be empty");
  }
  const allowedReturnUrls = value("LOGIN_ALLOWED_RETURN_URLS").split(",").map((item) =>
    exactHttpsUrl(item.trim(), "LOGIN_ALLOWED_RETURN_URLS"));

  // SHU-84: the first safe write is off unless its own signing key is set. The
  // deployment does not pass this variable, so no deployed gateway writes.
  const safeWriteKey = safeWriteSigningKey(env.SAFE_WRITE_SIGNING_KEY);
  const settings = { databaseUrl: value("DATABASE_URL"), safeWriteKey, callbackUrl };
  const access = wireAccess(settings);
  const profile = wireProfile(settings, access.services, approvedProfiles);
  const organizationArea = wireOrganizations(settings, access.services);
  const payContractArea = wirePayContracts(settings, access.services);
  const ops = wireOps(settings, access.services, organizationArea.services);
  const accessLane = wireAccessLane(settings, access.services, env);
  // SHU-457: every reader of the login store's sessions gets the bound T check.
  const upstream = upstreamSessionsFromEnv(env, issuer, value("OIDC_CLIENT_ID"));
  if (upstream) {
    const log = upstreamLogger();
    access.services.loginStore.checkSessionsWith((plain) => confirmingSessions(plain, {
      upstream: upstream.port, clock: { nowEpochSeconds: () => Math.floor(Date.now() / 1000) }, boundSeconds: upstream.checkSeconds, log,
    }));
  }
  const application = createLoginApplication({
    oidc: new HttpOidcTransport(issuer, authorizationUrl, tokenUrl),
    clock: { nowEpochSeconds: () => Math.floor(Date.now() / 1000) },
    entropy: { bytes: (length) => randomBytes(length) },
    states: access.services.loginStore.states,
    sessions: upstream ? access.services.loginStore.sessions : profile.services.sessions,
    identities: access.services.loginStore.identities,
    authorization: {
      async principalFor(personId) {
        const principal = await access.services.authzStore.getPrincipal(personId);
        if (!principal) throw new Error("unknown principal");
        return { role: "self", ...(typeof principal.email === "string" && principal.email.trim().length > 0 ? { email: principal.email } : {}) };
      },
      async roleFor(personId) {
        // Session ownership proves access to this one profile. The principal
        // must still exist in the persistent authz store on every request.
        if (!await access.services.authzStore.getPrincipal(personId)) throw new Error("unknown principal");
        return "self";
      },
    },
    jwks: new RefreshingJwksResolver(issuer, jwksUrl),
    ...(upstream ? { upstreamSessions: upstream.port } : {}),
    accessPause: { isPaused: async (personId) => (await accessLane.services.pauses.paused([personId])).has(personId) },
  }, {
    issuer,
    clientId: value("OIDC_CLIENT_ID"),
    clientSecret: value("OIDC_CLIENT_SECRET"),
    callbackUrl,
    allowedReturnUrls,
    clockSkewSeconds: 60,
    subjectPolicy: (subject) => UNIVERSE_SUBJECT_POLICY.humanSubjectPattern.test(subject),
    ...(upstream ? { upstreamCheckSeconds: upstream.checkSeconds } : {}),
  });
  const notificationStore=PostgresNotificationsStore.connect({connectionString:value("DATABASE_URL")});
  const notifications=createNotificationsHttp(application,new NotificationsService(notificationStore,notificationStore,access.services.authzStore));
  const runtimeApplication={
      ...application,
      ...organizationArea.services.application,
      ...ops.services,
      ...profile.services.application,
      ...payContractArea.services,
      ...accessLane.services.application,
      web: {
        origin: new URL(callbackUrl).origin,
        returnTo: allowedReturnUrls.includes(new URL("/profile", callbackUrl).href)
          ? new URL("/profile", callbackUrl).href : undefined,
        profiles: profile.services.web.profiles,
        ...(profile.services.web.profileCompleteness ? { profileCompleteness: profile.services.web.profileCompleteness } : {}),
      },
    } as BrowserLoginApplication;
  Object.defineProperty(runtimeApplication,"notifications",{value:notifications,enumerable:false});
  return {
    application: runtimeApplication,
    async close() {
      await Promise.all([access.close(), profile.close(), organizationArea.close(), payContractArea.close(), ops.close(),accessLane.close(),notificationStore.close()]);
    },
  };
}

/** Base64 of at least 32 random bytes, exactly as encoded; anything else refuses to start. */
function safeWriteSigningKey(raw: string | undefined): Buffer | undefined {
  if (raw === undefined) return undefined;
  const key = Buffer.from(raw, "base64");
  if (key.toString("base64") !== raw || key.length < 32) {
    throw new Error("SAFE_WRITE_SIGNING_KEY must be base64 of at least 32 bytes");
  }
  return key;
}

function exactHttpsUrl(raw: string, name: string): string {
  if (raw !== raw.trim()) throw new Error(`${name} must be an exact URL without surrounding whitespace`);
  const url = new URL(raw);
  if (url.protocol !== "https:") throw new Error(`${name} must use https`);
  if (url.username || url.password || url.hash) throw new Error(`${name} must not contain credentials or a fragment`);
  // Preserve the configured wire value. In particular, adding a trailing
  // slash would break OIDC's exact `iss` comparison.
  return raw;
}
