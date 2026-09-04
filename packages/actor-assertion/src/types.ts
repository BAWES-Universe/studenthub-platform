export const ENVELOPE_PREFIX = "bawes-aa.v1";

/**
 * Positive authenticated-subject rule (Opus standard amendment 2).
 *
 * There is deliberately NO denylist of "guest"/"anonymous" strings. A denylist
 * fails open by construction: a different IdP config, or an upgrade, can emit
 * `anon`, `system`, `service-account-*` or a machine subject, none of which are
 * enumerated and all of which would pass.
 *
 * Instead every issuer declares the format a HUMAN principal's `sub` takes, and
 * an assertion is usable only when its subject matches. There is no default:
 * an unconfigured verifier rejects every assertion rather than guessing.
 */
export interface SubjectPolicy {
  /** Pattern a human principal's `sub` must match for this issuer. */
  readonly humanSubjectPattern: RegExp;
}

/**
 * Reference policy for Authentik, whose `sub` is a 32-char hex user id or a
 * UUID. Deployments on another IdP must supply their own — this constant is a
 * starting point, never an implicit default.
 */
export const AUTHENTIK_SUBJECT_POLICY: SubjectPolicy = Object.freeze({
  humanSubjectPattern:
    /^(?:[0-9a-f]{32}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/,
});

export enum AssertionErrorCode {
  MALFORMED = "MALFORMED",
  BAD_SIGNATURE = "BAD_SIGNATURE",
  UNKNOWN_ISSUER = "UNKNOWN_ISSUER",
  EXPIRED = "EXPIRED",
  FUTURE_IAT = "FUTURE_IAT",
  AUD_MISMATCH = "AUD_MISMATCH",
  SUBJECT_FORMAT = "SUBJECT_FORMAT",
  WRONG_SUBJECT = "WRONG_SUBJECT",
  REPLAYED = "REPLAYED",
}

/**
 * Optional acting-context claim (Opus standard amendment 1, RFC 8693-style).
 *
 * A SELECTION PREFERENCE, never proof. The relying party re-derives the
 * effective org+role from its own grant store and honours `act` only when a
 * matching grant exists. Optional end-to-end, so v1 assertions minted before
 * this claim existed stay wire-compatible: they simply omit it.
 */
export interface ActorAssertionAct {
  /** Org/tenant the actor wants to act under for this request. */
  org?: string;
  /** Role the actor wants to act under for this request. */
  role?: string;
}

export interface ActorAssertionClaims {
  /** format version */
  v: 1;
  /** issuer identifier; public key resolved by this */
  iss: string;
  /**
   * Optional signing-key id. Present so the issuer-key registry can select a
   * specific key during rotation instead of guessing; optional keeps v1
   * wire-compatible with assertions minted before the registry existed.
   */
  kid?: string;
  /** exact destination scope: "<service>/<action>" */
  aud: string;
  /** verified actor subject (Authentik userinfo.sub); never guest/anonymous */
  sub: string;
  /** epoch seconds */
  iat: number;
  /** epoch seconds */
  exp: number;
  /** one-use id for replay protection */
  jti: string;
  /** optional acting context; a preference validated against grants, never trusted */
  act?: ActorAssertionAct;
}

export interface VerifyOptions {
  /** exact destination the assertion must be bound to */
  expectedAudience: string;
  /**
   * REQUIRED. The issuer's human-subject format. Fail-closed: without it the
   * verifier cannot assert the subject positively, so it rejects everything.
   */
  subjectPolicy: SubjectPolicy;
  /** optional; when set, sub must equal this */
  expectedSubject?: string;
  /** injectable clock (epoch seconds), defaults to Date.now()/1000 */
  now?: number;
  /** max clock skew allowance for iat (seconds) */
  maxIatSkewSeconds?: number;
}

/**
 * Resolve an issuer's public key. `keyId` is the assertion's optional `kid`;
 * a registry-backed resolver uses it to select the exact key and MUST return
 * undefined for unknown or retired keys (a hard deny — never a fallback).
 */
export type KeyResolver = (
  issuer: string,
  keyId?: string,
) => Promise<string | undefined>;

export type VerifyResult =
  | { ok: true; claims: ActorAssertionClaims }
  | { ok: false; code: AssertionErrorCode; reason: string };

export interface ReplayStore {
  /**
   * Records jti with its expiry; returns true if the jti was already seen
   * (replay), false if it is new and now recorded. Entries past expiry are
   * treated as absent and may be pruned.
   */
  consume(jti: string, expiresAt: number, now: number): boolean | Promise<boolean>;
}
