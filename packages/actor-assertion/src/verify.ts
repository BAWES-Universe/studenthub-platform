import { createPublicKey, verify } from "node:crypto";
import {
  ActorAssertionClaims,
  AssertionErrorCode,
  ENVELOPE_PREFIX,
  GUEST_SUBJECTS,
  KeyResolver,
  ReplayStore,
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
    return { v: 1, iss: c.iss, aud: c.aud, sub: c.sub, iat: c.iat, exp: c.exp, jti: c.jti };
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
  if (typeof token !== "string") return fail(AssertionErrorCode.MALFORMED, "token is not a string");

  const parts = token.split(".");
  if (parts.length !== 4) return fail(AssertionErrorCode.MALFORMED, "envelope must have 4 parts");
  const [prefix, version, payloadB64, sigB64] = parts;
  if (prefix !== "bawes-aa" || version !== "v1")
    return fail(AssertionErrorCode.MALFORMED, "unknown envelope prefix/version");

  const claims = decodeClaims(payloadB64!);
  if (!claims) return fail(AssertionErrorCode.MALFORMED, "claims failed schema validation");

  const now = Math.floor(options.now ?? Date.now() / 1000);

  if (claims.exp <= now) return fail(AssertionErrorCode.EXPIRED, `expired at ${claims.exp}`);
  const skew = options.maxIatSkewSeconds ?? DEFAULT_MAX_IAT_SKEW_SECONDS;
  if (claims.iat > now + skew) return fail(AssertionErrorCode.FUTURE_IAT, `iat ${claims.iat} in the future`);

  if (GUEST_SUBJECTS.has(claims.sub) || claims.sub.length === 0)
    return fail(AssertionErrorCode.GUEST_SUBJECT, "guest/anonymous subject is not an actor");

  const publicKeyPem = await resolvePublicKey(claims.iss);
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

  if (claims.aud !== options.expectedAudience)
    return fail(
      AssertionErrorCode.AUD_MISMATCH,
      `audience ${claims.aud} does not match expected ${options.expectedAudience}`,
    );

  if (options.expectedSubject !== undefined && claims.sub !== options.expectedSubject)
    return fail(
      AssertionErrorCode.WRONG_SUBJECT,
      `subject ${claims.sub} does not match expected ${options.expectedSubject}`,
    );

  const replayed = await replayStore.consume(claims.jti, claims.exp, now);
  if (replayed) return fail(AssertionErrorCode.REPLAYED, `jti ${claims.jti} already used`);

  return { ok: true, claims };
}

/** In-memory jti replay store with lazy pruning. Injectable — swap for Redis in production. */
export class MemoryReplayStore implements ReplayStore {
  private readonly seen = new Map<string, number>();

  consume(jti: string, expiresAt: number, now: number): boolean {
    for (const [seenJti, seenExp] of this.seen) {
      if (seenExp <= now) this.seen.delete(seenJti);
    }
    if (this.seen.has(jti)) return true;
    this.seen.set(jti, expiresAt);
    return false;
  }
}
