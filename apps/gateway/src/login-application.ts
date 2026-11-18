import { createHash, createPublicKey, verify } from "node:crypto";

import type {
  BrowserResponse,
  ClaimedProfile,
  LoginApplication,
  LoginApplicationFactory,
  LoginConfig,
  LoginDependencies,
  LoginSession,
  SessionStore,
  TestJsonWebKey,
  Clock,
  UpstreamSessionEvent,
  UpstreamSessions,
} from "@studenthub/login-contract";

interface IdTokenClaims {
  readonly iss: string;
  readonly aud: string | readonly string[];
  readonly sub: string;
  readonly nonce: string;
  readonly exp: number;
  readonly iat: number;
  readonly email?: string;
  readonly phone?: string;
  readonly name?: string;
  readonly birthdate?: string;
  readonly hashed_user_id?: unknown;
  readonly uid?: unknown;
  readonly sid?: unknown;
}

/** SHU-457: the issuer's session reference, kept only when it is a plain bounded value. */
function upstreamReferenceFrom(claims: IdTokenClaims): string | undefined {
  const sid = claims.sid;
  return typeof sid === "string" && /^[\x21-\x7e]{1,255}$/.test(sid) ? sid : undefined;
}

export const DEFAULT_UPSTREAM_CHECK_SECONDS = 900;
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 3_000;
/** How long past the issuer timeout a reader waits for another process's check before failing closed. */
const UPSTREAM_SETTLE_GRACE_SECONDS = 2;
const UPSTREAM_SETTLE_POLL_MS = 50;

/** Bound T: an integer from 60 to 3600 seconds, default 900. */
export function upstreamCheckSeconds(value: number | undefined): number {
  const seconds = value ?? DEFAULT_UPSTREAM_CHECK_SECONDS;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > 3600) {
    throw new RangeError("the upstream session check bound must be an integer from 60 to 3600 seconds");
  }
  return seconds;
}

const TIMED_OUT = Symbol("timed out");

/** Races one upstream call against the bound. */
async function bounded<T>(call: () => Promise<T>, timeoutMs: number): Promise<T | typeof TIMED_OUT> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof TIMED_OUT>((resolve) => {
    timer = setTimeout(() => resolve(TIMED_OUT), timeoutMs);
  });
  try {
    return await Promise.race([call(), timeout]);
  } finally {
    clearTimeout(timer);
  }
}

/** Counts upstream calls that did not answer; the log line carries a count and a reason class only. */
export function upstreamLogger(sink: (event: UpstreamSessionEvent) => void = (event) => console.warn(JSON.stringify(event))) {
  const counts = { upstream_end_unreachable: 0, upstream_check_unknown: 0 };
  return (event: UpstreamSessionEvent["event"], reason: UpstreamSessionEvent["reason"]) => {
    counts[event] += 1;
    // A failing log sink must never change a session's outcome or reject a detached sign-out.
    try { sink({ event, reason, count: counts[event] }); } catch { /* logging is best effort */ }
  };
}

const CONFIRMING = Symbol.for("studenthub.login.upstream-confirming");

export interface UpstreamConfirmationOptions {
  readonly upstream: UpstreamSessions;
  readonly clock: Clock;
  readonly boundSeconds: number;
  readonly timeoutMs?: number;
  readonly log: (event: UpstreamSessionEvent["event"], reason: UpstreamSessionEvent["reason"]) => void;
}

/**
 * SHU-457 bound T on a session store: a session with an upstream reference is
 * checked upstream at most once per T, measured from last_checked_at, which
 * the store's conditional claim sets whatever the answer. `ended` deletes the
 * session; `active` sets last_confirmed_at; `unknown` (or a failed or slow
 * call) leaves it, and the session ends 2*T after its last confirmation.
 */
export function confirmingSessions(store: SessionStore, options: UpstreamConfirmationOptions): SessionStore {
  if ((store as { readonly [CONFIRMING]?: true })[CONFIRMING]) return store;
  const bound = upstreamCheckSeconds(options.boundSeconds);
  if (!store.claimUpstreamCheck || !store.confirmUpstream || !store.settleUpstreamCheck) {
    throw new TypeError("upstream session checks need a session store with claimUpstreamCheck, confirmUpstream and settleUpstreamCheck");
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const wrapped: SessionStore & { readonly [CONFIRMING]: true } = {
    [CONFIRMING]: true,
    put: (record) => store.put(record),
    delete: (id) => store.delete(id),
    ...(store.take ? { take: (id: string) => store.take!(id) } : {}),
    ...(store.claimUpstreamCheck ? { claimUpstreamCheck: (id: string, before: number, now: number) => store.claimUpstreamCheck!(id, before, now) } : {}),
    ...(store.confirmUpstream ? { confirmUpstream: (id: string, now: number) => store.confirmUpstream!(id, now) } : {}),
    ...(store.settleUpstreamCheck ? { settleUpstreamCheck: (id: string, checkedAt: number) => store.settleUpstreamCheck!(id, checkedAt) } : {}),
    get: (id) => read(id),
  };
  // One check per session at a time in this process: every reader awaits it.
  const inflight = new Map<string, Promise<LoginSession | undefined>>();
  const waitSeconds = timeoutMs / 1000 + UPSTREAM_SETTLE_GRACE_SECONDS;
  const expired = (session: LoginSession, now: number) => now - (session.lastConfirmedAt ?? Number.NEGATIVE_INFINITY) >= 2 * bound;
  const unsettled = (session: LoginSession) => session.lastCheckedAt !== undefined
    && session.lastCheckedAt > Math.max(session.lastSettledAt ?? Number.NEGATIVE_INFINITY, session.lastConfirmedAt ?? Number.NEGATIVE_INFINITY);

  async function read(id: string): Promise<LoginSession | undefined> {
    const session = await store.get(id);
    const reference = session?.upstreamReference;
    if (!session || !reference) return session;
    const now = options.clock.nowEpochSeconds();
    if (expired(session, now)) {
      await store.delete(id);
      return undefined;
    }
    const shared = inflight.get(id);
    if (shared) return shared;
    // A check claimed elsewhere and not yet answered: its answer may be
    // `ended`, so this request never rides on the row as it was before it.
    if (unsettled(session) && now - session.lastCheckedAt! < waitSeconds) return settled(id);
    if (session.lastCheckedAt !== undefined && now - session.lastCheckedAt < bound) return session;
    const run = check(id, reference, now);
    inflight.set(id, run);
    try {
      return await run;
    } finally {
      if (inflight.get(id) === run) inflight.delete(id);
    }
  }

  /** Waits for another process's check to settle; fails closed (without deleting) if it doesn't in time. */
  async function settled(id: string): Promise<LoginSession | undefined> {
    const deadline = Date.now() + waitSeconds * 1000;
    for (;;) {
      const current = await store.get(id);
      if (!current) return undefined;
      if (expired(current, options.clock.nowEpochSeconds())) {
        await store.delete(id);
        return undefined;
      }
      if (!unsettled(current)) return current;
      if (Date.now() >= deadline) return undefined;
      await new Promise((resolve) => setTimeout(resolve, UPSTREAM_SETTLE_POLL_MS));
    }
  }

  async function check(id: string, reference: string, now: number): Promise<LoginSession | undefined> {
    // Another process won the claim, or the row is gone: wait for that answer.
    if (!await store.claimUpstreamCheck!(id, now - bound, now)) return settled(id);
    let activity: Awaited<ReturnType<UpstreamSessions["isActive"]>> | typeof TIMED_OUT | "error";
    try {
      activity = await bounded(() => options.upstream.isActive(reference), timeoutMs);
    } catch {
      activity = "error";
    }
    if (activity === "ended") {
      await store.delete(id);
      return undefined;
    }
    if (activity === "active") await store.confirmUpstream!(id, now);
    else {
      await store.settleUpstreamCheck!(id, now);
      options.log("upstream_check_unknown", activity === TIMED_OUT ? "timeout" : activity === "error" ? "error" : "unknown");
    }
    // Read the row again after the wait: a sign-out meanwhile removed it, and
    // the 2*T deadline may have passed while the issuer was being asked.
    const current = await store.get(id);
    if (!current) return undefined;
    if (expired(current, options.clock.nowEpochSeconds())) {
      await store.delete(id);
      return undefined;
    }
    return current;
  }
  return wrapped;
}

async function takeSession(store: SessionStore, id: string): Promise<LoginSession | undefined> {
  if (store.take) return store.take(id);
  const session = await store.get(id);
  await store.delete(id);
  return session;
}

function stableUserIdFrom(claims: IdTokenClaims): string | undefined {
  const hashed = claims.hashed_user_id;
  const uid = claims.uid;
  const valid = (value: unknown): value is string =>
    typeof value === "string" && /^[A-Za-z0-9_-]{8,128}$/.test(value);
  if (hashed !== undefined && !valid(hashed)) throw new Error("invalid stable user id");
  if (uid !== undefined && !valid(uid)) throw new Error("invalid stable user id");
  if (hashed !== undefined && uid !== undefined && hashed !== uid) {
    throw new Error("conflicting stable user ids");
  }
  return hashed ?? uid;
}

function opaqueToken(dependencies: LoginDependencies): string {
  return Buffer.from(dependencies.entropy.bytes(32)).toString("base64url");
}

function rejected(status = 400): BrowserResponse {
  return { status, body: { error: "login_rejected" } };
}

function decodePart<T>(part: string): T {
  return JSON.parse(Buffer.from(part, "base64url").toString("utf8")) as T;
}

function verifySignature(
  algorithm: string,
  signingInput: string,
  signature: Buffer,
  jwk: TestJsonWebKey,
): boolean {
  const key = createPublicKey({ key: jwk, format: "jwk" });
  if (algorithm === "EdDSA") return verify(null, Buffer.from(signingInput), key, signature);
  if (algorithm === "RS256") return verify("RSA-SHA256", Buffer.from(signingInput), key, signature);
  if (algorithm === "ES256") {
    return verify(
      "sha256",
      Buffer.from(signingInput),
      { key, dsaEncoding: "ieee-p1363" },
      signature,
    );
  }
  return false;
}

async function validateIdToken(
  idToken: string,
  expectedNonce: string,
  dependencies: LoginDependencies,
  config: LoginConfig,
): Promise<IdTokenClaims> {
  const parts = idToken.split(".");
  if (parts.length !== 3) throw new Error("malformed id token");
  const [headerWire, claimsWire, signatureWire] = parts as [string, string, string];
  const header = decodePart<{ readonly alg?: string; readonly kid?: string }>(headerWire);
  if (typeof header.alg !== "string" || typeof header.kid !== "string") {
    throw new Error("unsupported id token");
  }
  const claims = decodePart<IdTokenClaims>(claimsWire);
  const jwk = await dependencies.jwks.resolve(config.issuer, header.kid);
  if (
    !jwk
    || (jwk.alg !== undefined && jwk.alg !== header.alg)
    || (jwk.use !== undefined && jwk.use !== "sig")
    || !verifySignature(
    header.alg,
    `${headerWire}.${claimsWire}`,
    Buffer.from(signatureWire, "base64url"),
    jwk,
    )
  ) {
    throw new Error("invalid id token signature");
  }

  const now = dependencies.clock.nowEpochSeconds();
  const audienceValid = claims.aud === config.clientId
    || (Array.isArray(claims.aud) && claims.aud.length === 1 && claims.aud[0] === config.clientId);
  if (claims.iss !== config.issuer) throw new Error("invalid issuer");
  if (!audienceValid) throw new Error("invalid audience");
  if (!Number.isFinite(claims.exp) || claims.exp < now - config.clockSkewSeconds) {
    throw new Error("expired id token");
  }
  if (!Number.isFinite(claims.iat) || claims.iat > now + config.clockSkewSeconds) {
    throw new Error("future id token");
  }
  if (claims.nonce !== expectedNonce) throw new Error("invalid nonce");
  if (typeof claims.sub !== "string" || claims.sub.length === 0) throw new Error("missing subject");
  return claims;
}

export const createLoginApplication: LoginApplicationFactory = (
  dependencies,
  config,
): LoginApplication => {
  const upstream = dependencies.upstreamSessions;
  const timeoutMs = config.upstreamTimeoutMs ?? DEFAULT_UPSTREAM_TIMEOUT_MS;
  const log = upstreamLogger(dependencies.upstreamLog);
  const sessions = upstream
    ? confirmingSessions(dependencies.sessions, {
      upstream, clock: dependencies.clock, boundSeconds: upstreamCheckSeconds(config.upstreamCheckSeconds), timeoutMs, log,
    })
    : dependencies.sessions;
  // Local sign-out never waits on the issuer: the session is already gone.
  const endUpstream = (reference: string): void => {
    void bounded(() => upstream!.end(reference), timeoutMs).then(
      (answer) => { if (answer !== "ended") log("upstream_end_unreachable", answer === TIMED_OUT ? "timeout" : "unreachable"); },
      () => log("upstream_end_unreachable", "error"),
    );
  };
  return {
  async start(request) {
    if (!config.allowedReturnUrls.includes(request.returnTo)) return rejected();
    const state = opaqueToken(dependencies);
    const nonce = opaqueToken(dependencies);
    const codeVerifier = opaqueToken(dependencies);
    const codeChallenge = createHash("sha256").update(codeVerifier).digest("base64url");
    await dependencies.states.put({
      browserSessionId: request.browserSessionId,
      state,
      nonce,
      codeVerifier,
      returnTo: request.returnTo,
    });
    return {
      status: 302,
      headers: {
        location: dependencies.oidc.authorizationUrl({
          issuer: config.issuer,
          clientId: config.clientId,
          redirectUri: config.callbackUrl,
          state,
          nonce,
          codeChallenge,
          codeChallengeMethod: "S256",
        }),
      },
    };
  },

  async callback(request) {
    try {
      // consume() is deliberately atomic and precedes browser binding. A stolen
      // callback burns the state instead of leaving a replay window open.
      const loginState = await dependencies.states.consume(request.state);
      if (!loginState || loginState.browserSessionId !== request.browserSessionId) return rejected();
      const tokens = await dependencies.oidc.exchange({
        code: request.code,
        clientId: config.clientId,
        clientSecret: config.clientSecret,
        redirectUri: config.callbackUrl,
        codeVerifier: loginState.codeVerifier,
      });
      const claims = await validateIdToken(tokens.idToken, loginState.nonce, dependencies, config);
      if (!config.subjectPolicy(claims.sub)) return rejected();
      const stableUserId = stableUserIdFrom(claims);
      const profile: ClaimedProfile = {
        email: claims.email,
        phone: claims.phone,
        name: claims.name,
        dateOfBirth: claims.birthdate,
        ...(stableUserId !== undefined ? { stableUserId } : {}),
      };
      const identity = await dependencies.identities.findBySubject(config.issuer, claims.sub)
        ?? await dependencies.identities.createForSubject(config.issuer, claims.sub, profile);
      if (stableUserId !== undefined && dependencies.identities.bindStableId) {
        const binding = await dependencies.identities.bindStableId(
          config.issuer,
          claims.sub,
          stableUserId,
        );
        if (binding === "mismatch" || binding === "locked") return rejected();
      }
      if (await dependencies.accessPause?.isPaused(identity.personId)) {
        return { status: 403, body: { error: "access_paused" } };
      }
      const sessionId = opaqueToken(dependencies);
      const reference = upstream ? upstreamReferenceFrom(claims) : undefined;
      if (reference) {
        const now = dependencies.clock.nowEpochSeconds();
        await sessions.put({ id: sessionId, personId: identity.personId, upstreamReference: reference, lastCheckedAt: now, lastConfirmedAt: now });
      } else {
        await sessions.put({ id: sessionId, personId: identity.personId });
      }
      return {
        status: 302,
        headers: {
          location: loginState.returnTo,
          "set-cookie": `__Host-studenthub_session=${sessionId}; Path=/; HttpOnly; Secure; SameSite=Lax`,
        },
      };
    } catch (error) {
      // A pause that committed after the check above: the session insert is refused (42501).
      if ((error as { code?: string }).code === "42501") return { status: 403, body: { error: "access_paused" } };
      return rejected();
    }
  },

  async profile(request) {
    try {
      if (!request.sessionId) return rejected(401);
      const session = await sessions.get(request.sessionId);
      if (!session) return rejected(401);
      if (request.personId && request.personId !== session.personId) return rejected(404);
      if (dependencies.authorization.principalFor) {
        const principal = await dependencies.authorization.principalFor(session.personId);
        const email = typeof principal.email === "string" && principal.email.trim().length > 0 ? principal.email : undefined;
        return { status: 200, body: { personId: session.personId, role: principal.role, ...(email ? { email } : {}) } };
      }
      const role = await dependencies.authorization.roleFor(session.personId);
      return { status: 200, body: { personId: session.personId, role } };
    } catch {
      return { status: 503, body: { error: "login_unavailable" } };
    }
  },

  async logout(sessionId) {
    try {
      if (sessionId && upstream) {
        const reference = (await takeSession(sessions, sessionId))?.upstreamReference;
        if (reference) endUpstream(reference);
      } else if (sessionId) {
        await sessions.delete(sessionId);
      }
      return {
        status: 204,
        headers: {
          "set-cookie": "__Host-studenthub_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
        },
      };
    } catch {
      return { status: 503, body: { error: "login_unavailable" } };
    }
  },
};
};
