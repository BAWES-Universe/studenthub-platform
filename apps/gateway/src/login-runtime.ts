import { randomBytes } from "node:crypto";

import { UNIVERSE_SUBJECT_POLICY } from "@bawes/actor-assertion";
import { PostgresAuthzStore, PostgresLoginStore } from "@studenthub/db";
import type {
  AuthorizationRequest,
  JwksResolver,
  LoginApplication,
  OidcTransport,
  TestJsonWebKey,
  TokenRequest,
  TokenResponse,
} from "@studenthub/login-contract";

import { createLoginApplication } from "./login-application.js";

interface JwksDocument {
  readonly keys?: readonly TestJsonWebKey[];
}

class HttpOidcTransport implements OidcTransport {
  readonly #issuer: string;
  readonly #authorizationEndpoint: string;
  readonly #tokenEndpoint: string;

  constructor(
    issuer: string,
    authorizationEndpoint: string,
    tokenEndpoint: string,
  ) {
    this.#issuer = issuer;
    this.#authorizationEndpoint = authorizationEndpoint;
    this.#tokenEndpoint = tokenEndpoint;
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
    const response = await fetch(this.#tokenEndpoint, {
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

class RefreshingJwksResolver implements JwksResolver {
  readonly #keys = new Map<string, { readonly jwk: TestJsonWebKey; readonly expiresAt: number }>();
  readonly #issuer: string;
  readonly #jwksUrl: string;
  readonly #ttlSeconds: number;

  constructor(
    issuer: string,
    jwksUrl: string,
    ttlSeconds = 300,
  ) {
    this.#issuer = issuer;
    this.#jwksUrl = jwksUrl;
    this.#ttlSeconds = ttlSeconds;
  }

  async resolve(issuer: string, kid: string): Promise<TestJsonWebKey | undefined> {
    if (issuer !== this.#issuer) return undefined;
    const cacheKey = `${issuer}\u0000${kid}`;
    const cached = this.#keys.get(cacheKey);
    if (cached && cached.expiresAt > Date.now() / 1000) return cached.jwk;

    // Refresh on expiry and every unknown kid. Keys absent from the latest
    // issuer document are evicted, so rotation cannot fall back to a retired
    // key indefinitely.
    const response = await fetch(this.#jwksUrl, { redirect: "error" });
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

export interface RuntimeLogin {
  readonly application: LoginApplication;
  close(): Promise<void>;
}

/** Build the real login stack only when the complete explicit env contract is present. */
export function createRuntimeLoginFromEnv(env: NodeJS.ProcessEnv = process.env): RuntimeLogin | undefined {
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
  const allowedReturnUrls = value("LOGIN_ALLOWED_RETURN_URLS").split(",").map((item) =>
    exactHttpsUrl(item.trim(), "LOGIN_ALLOWED_RETURN_URLS"));
  if (allowedReturnUrls.length === 0) throw new Error("LOGIN_ALLOWED_RETURN_URLS must not be empty");

  const loginStore = new PostgresLoginStore({ connectionString: value("DATABASE_URL") });
  const authzStore = new PostgresAuthzStore({ connectionString: value("DATABASE_URL") });
  const application = createLoginApplication({
    oidc: new HttpOidcTransport(issuer, authorizationUrl, tokenUrl),
    clock: { nowEpochSeconds: () => Math.floor(Date.now() / 1000) },
    entropy: { bytes: (length) => randomBytes(length) },
    states: loginStore.states,
    sessions: loginStore.sessions,
    identities: loginStore.identities,
    authorization: {
      async roleFor(personId) {
        // Session ownership proves access to this one profile. The principal
        // must still exist in the persistent authz store on every request.
        if (!await authzStore.getPrincipal(personId)) throw new Error("unknown principal");
        return "self";
      },
    },
    jwks: new RefreshingJwksResolver(issuer, jwksUrl),
  }, {
    issuer,
    clientId: value("OIDC_CLIENT_ID"),
    clientSecret: value("OIDC_CLIENT_SECRET"),
    callbackUrl,
    allowedReturnUrls,
    clockSkewSeconds: 60,
    subjectPolicy: (subject) => UNIVERSE_SUBJECT_POLICY.humanSubjectPattern.test(subject),
  });
  return {
    application,
    async close() {
      await Promise.all([loginStore.close(), authzStore.close()]);
    },
  };
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
