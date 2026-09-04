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
 * Subject policies per Authentik `sub_mode`.
 *
 * `sub_mode` is configured PER PROVIDER in Authentik, not per instance, so two
 * apps behind the same Authentik emit differently-shaped subjects. A relying
 * party must pick the policy matching the provider it is registered against —
 * there is no single correct pattern, and no default.
 *
 * Verified on live Authentik (Khalid, 2026-09-04):
 *   Universe apps -> sub_mode = user_email      (sub IS the email address)
 *   Coolify       -> sub_mode = hashed_user_id  (sub is an opaque hex digest)
 *
 * An earlier revision of this file shipped a 32-hex/UUID pattern as the
 * "Authentik reference". It matched NEITHER live mode and would have denied
 * every real subject the moment a genuine assertion arrived.
 */

/**
 * `sub_mode = user_email`. The subject is an email address.
 *
 * SECURITY NOTE — read before adopting this for the identity spine. An email
 * is a mutable, reassignable attribute, so under this mode `sub` is not a
 * stable identifier: changing a user's email in Authentik changes their
 * subject, and reassigning an address to another person hands them the prior
 * holder's grants. Prefer `hashed_user_id` (or any opaque, immutable subject)
 * for anything that binds to money, roles or personal records. Tracked as a
 * platform decision; this constant exists so the verifier matches what
 * Universe emits TODAY, not because email-as-subject is the right end state.
 *
 * Shape check only — deliberately permissive about local-part characters. It
 * asserts "this is an email-shaped subject", never that the address is valid,
 * deliverable, or owned by the caller.
 */
export const USER_EMAIL_SUBJECT_POLICY: SubjectPolicy = Object.freeze({
  humanSubjectPattern: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
});

/** `sub_mode = hashed_user_id`. Opaque lowercase hex digest (Coolify today). */
export const HASHED_USER_ID_SUBJECT_POLICY: SubjectPolicy = Object.freeze({
  humanSubjectPattern: /^[0-9a-f]{32,128}$/,
});

/**
 * What the Universe providers emit today. Aliased rather than inlined so a
 * future `sub_mode` change is a one-line edit with a single place to review.
 */
export const UNIVERSE_SUBJECT_POLICY: SubjectPolicy = USER_EMAIL_SUBJECT_POLICY;

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
