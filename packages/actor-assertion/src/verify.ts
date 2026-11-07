import { createPublicKey, verify } from "node:crypto";
import {
  ActorAssertionClaims,
  AssertionErrorCode,
  ActorAssertionAct,
  ENVELOPE_PREFIX,
  KeyResolver,
  ReplayStore,
  ReplayOutcome,
  VerifyOptions,
  VerifyResult,
} from "./types.js";

const DEFAULT_MAX_IAT_SKEW_SECONDS = 300;

function fail(code: AssertionErrorCode, reason: string): VerifyResult {
  return { ok: false, code, reason };
}

function decodeClaims(payloadB64: string): ActorAssertionClaims | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(payloadB64, "base64url").toString("utf8"));
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const c = parsed as Record<string, unknown>;
    if (c.v !== 1) return undefined;
    if (typeof c.iss !== "string" || c.iss.length === 0) return undefined;
    if (typeof c.aud !== "string" || c.aud.length === 0) return undefined;
    if (typeof c.sub !== "string") return undefined;
    if (typeof c.iat !== "number" || !Number.isFinite(c.iat)) return undefined;
    if (typeof c.exp !== "number" || !Number.isFinite(c.exp)) return undefined;
    if (typeof c.jti !== "string" || c.jti.length === 0) return undefined;
    if (c.kid !== undefined && (typeof c.kid !== "string" || c.kid.length === 0)) return undefined;

    // Optional `act`: absent is valid; present must be a well-formed object with
    // non-empty string members. Unknown members are dropped, but the signature
    // covers the raw payload bytes, so dropping them here never invalidates it.
    let act: ActorAssertionAct | undefined;
    if (c.act !== undefined) {
      if (typeof c.act !== "object" || c.act === null || Array.isArray(c.act)) return undefined;
      const a = c.act as Record<string, unknown>;
      if (a.org !== undefined && (typeof a.org !== "string" || a.org.length === 0)) return undefined;
      if (a.role !== undefined && (typeof a.role !== "string" || a.role.length === 0)) return undefined;
      act = {
        ...(typeof a.org === "string" ? { org: a.org } : {}),
        ...(typeof a.role === "string" ? { role: a.role } : {}),
      };
    }

    const claims: ActorAssertionClaims = {
      v: 1, iss: c.iss, aud: c.aud, sub: c.sub, iat: c.iat, exp: c.exp, jti: c.jti,
      ...(typeof c.kid === "string" ? { kid: c.kid } : {}),
    };
    return act === undefined ? claims : { ...claims, act };
  } catch {
    return undefined;
  }
}

/**
 * Verify a destination-bound actor assertion. Every failure path returns a
 * typed non-ok result — nothing here throws on untrusted input.
 */
export async function verifyAssertion(
  token: string,
  resolvePublicKey: KeyResolver,
  replayStore: ReplayStore,
  options: VerifyOptions,
): Promise<VerifyResult> {
  const strict = options.maxLifetimeSeconds !== undefined;
  const skew = strict && options.maxIatSkewSeconds !== undefined
    ? options.maxIatSkewSeconds : options.maxIatSkewSeconds ?? DEFAULT_MAX_IAT_SKEW_SECONDS;
  if (strict && (
    !Number.isInteger(options.maxLifetimeSeconds) || options.maxLifetimeSeconds! < 1 ||
    options.maxLifetimeSeconds! > 3600 || !Number.isInteger(skew) || skew < 0 || skew > 300 ||
    (options.wallClock !== undefined && typeof options.wallClock !== "function") ||
    (options.monotonicClock !== undefined && typeof options.monotonicClock !== "function")
  )) return fail(AssertionErrorCode.CONFIG, "invalid strict freshness configuration");

  const wallClock = options.wallClock ?? (() => Date.now() / 1000);
  const monotonicClock = options.monotonicClock ?? (() => performance.now() / 1000);
  let started = 0;
  let previousElapsed = 0;
  let previousWall = -Infinity;
  let now: number;
  try {
    now = strict ? wallClock() : Math.floor(options.now ?? Date.now() / 1000);
    if (strict) {
      started = monotonicClock();
      if (!Number.isFinite(now) || !Number.isFinite(started)) throw new Error("invalid clock");
      previousWall = now;
    }
  } catch {
    return fail(AssertionErrorCode.UNAVAILABLE, "freshness clock unavailable");
  }
  // Recheck both clocks after asynchronous dependencies, including replay consumption.
  // A refused authentic assertion may remain consumed: this is deliberately fail-closed.
  function fresh(claims: ActorAssertionClaims): VerifyResult | undefined {
    if (!strict) return undefined;
    try {
      const current = wallClock();
      const elapsed = monotonicClock() - started;
      if (!Number.isFinite(current) || !Number.isFinite(elapsed) || current < previousWall ||
          elapsed < previousElapsed || elapsed > 10) throw new Error("invalid or stale clock");
      previousWall = current;
      previousElapsed = elapsed;
      now = current;
      if (claims.exp <= now) return fail(AssertionErrorCode.EXPIRED, `expired at ${claims.exp}`);
      if (claims.iat > now + skew) return fail(AssertionErrorCode.FUTURE_IAT, "iat in the future");
    } catch {
      return fail(AssertionErrorCode.UNAVAILABLE, "verification freshness unavailable or deadline exceeded");
    }
    return undefined;
  }

  if (typeof token !== "string") return fail(AssertionErrorCode.MALFORMED, "token is not a string");

  const parts = token.split(".");
  if (parts.length !== 4) return fail(AssertionErrorCode.MALFORMED, "envelope must have 4 parts");
  const [prefix, version, payloadB64, sigB64] = parts;
  if (prefix !== "bawes-aa" || version !== "v1")
    return fail(AssertionErrorCode.MALFORMED, "unknown envelope prefix/version");

  const claims = decodeClaims(payloadB64!);
  if (!claims) return fail(AssertionErrorCode.MALFORMED, "claims failed schema validation");

  if (strict && (claims.exp <= claims.iat || claims.exp - claims.iat > options.maxLifetimeSeconds!))
    return fail(AssertionErrorCode.LIFETIME, "assertion lifetime exceeds strict policy");

  if (claims.exp <= now) return fail(AssertionErrorCode.EXPIRED, `expired at ${claims.exp}`);
  if (claims.iat > now + skew) return fail(AssertionErrorCode.FUTURE_IAT, `iat ${claims.iat} in the future`);

  // A rejecting dependency must become a typed denial, never an exception: this
  // function is awaited inside an async http listener, where an escaping
  // rejection sends no response and can terminate the process.
  let publicKeyPem: string | undefined;
  try {
    publicKeyPem = await resolvePublicKey(claims.iss, claims.kid);
  } catch {
    return fail(AssertionErrorCode.UNAVAILABLE, "issuer key resolution failed");
  }
  const afterKey = fresh(claims);
  if (afterKey) return afterKey;
  if (!publicKeyPem) return fail(AssertionErrorCode.UNKNOWN_ISSUER, `no key for issuer ${claims.iss}`);

  const signingInput = `${ENVELOPE_PREFIX}.${payloadB64}`;
  let valid: boolean;
  try {
    const publicKey = createPublicKey(publicKeyPem);
    valid = verify(null, Buffer.from(signingInput, "utf8"), publicKey, Buffer.from(sigB64!, "base64url"));
  } catch {
    return fail(AssertionErrorCode.BAD_SIGNATURE, "signature verification failed");
  }
  if (!valid) return fail(AssertionErrorCode.BAD_SIGNATURE, "signature did not verify");

  const afterSignature = fresh(claims);
  if (afterSignature) return afterSignature;

  if (claims.aud !== options.expectedAudience)
    return fail(
      AssertionErrorCode.AUD_MISMATCH,
      `audience ${claims.aud} does not match expected ${options.expectedAudience}`,
    );

  // Positive subject assertion, AFTER authenticity is established: the subject
  // must MATCH the issuer's registered human-subject format. No denylist — an
  // unrecognised subject shape is rejected whether or not anyone enumerated it.
  // Running it post-signature keeps policy off unauthenticated input and stops
  // an attacker probing subject shapes without a valid signature.
  if (!options.subjectPolicy.humanSubjectPattern.test(claims.sub))
    return fail(
      AssertionErrorCode.SUBJECT_FORMAT,
      "subject does not match the issuer's registered human-subject format",
    );

  if (options.expectedSubject !== undefined && claims.sub !== options.expectedSubject)
    return fail(
      AssertionErrorCode.WRONG_SUBJECT,
      `subject ${claims.sub} does not match expected ${options.expectedSubject}`,
    );

  // Replay state is scoped by issuer; see ReplayStore. A store failure denies —
  // accepting an unrecorded jti would silently disable replay protection.
  let replayed: boolean | ReplayOutcome;
  try {
    replayed = await replayStore.consume(claims.iss, claims.jti, claims.exp, now,
      ...(strict ? [{ issuedAt: claims.iat, maxIatSkewSeconds: skew }] : []));
  } catch {
    return fail(AssertionErrorCode.UNAVAILABLE, "replay store unavailable");
  }
  // Preserve explicit authoritative denials. Only successful consumption needs
  // the final acceptance freshness gate; a slow store must never turn expired
  // into a generic dependency error.
  switch (replayed) {
    case true:
    case "replayed": return fail(AssertionErrorCode.REPLAYED, `jti ${claims.jti} already used`);
    case "expired": return fail(AssertionErrorCode.EXPIRED, `expired at ${claims.exp}`);
    case "future_iat": return fail(AssertionErrorCode.FUTURE_IAT, "iat in the future");
    case false:
    case "consumed": break;
    default: return fail(AssertionErrorCode.UNAVAILABLE, "invalid replay store outcome");
  }

  const afterReplay = fresh(claims);
  if (afterReplay) return afterReplay;
  return { ok: true, claims };
}

/** In-memory jti replay store with lazy pruning. Injectable — swap for Redis in production. */
export class MemoryReplayStore implements ReplayStore {
  private readonly seen = new Map<string, number>();

  /** NUL separator: it cannot appear in an issuer name, so keys never collide. */
  static key(issuer: string, jti: string): string {
    return `${issuer}\u0000${jti}`;
  }

  consume(issuer: string, jti: string, expiresAt: number, now: number): boolean {
    for (const [seenKey, seenExp] of this.seen) {
      if (seenExp <= now) this.seen.delete(seenKey);
    }
    const key = MemoryReplayStore.key(issuer, jti);
    if (this.seen.has(key)) return true;
    this.seen.set(key, expiresAt);
    return false;
  }
}
