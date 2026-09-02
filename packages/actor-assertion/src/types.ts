export const ENVELOPE_PREFIX = "bawes-aa.v1";

export const GUEST_SUBJECTS: ReadonlySet<string> = new Set([
  "",
  "guest",
  "anonymous",
]);

export enum AssertionErrorCode {
  MALFORMED = "MALFORMED",
  BAD_SIGNATURE = "BAD_SIGNATURE",
  UNKNOWN_ISSUER = "UNKNOWN_ISSUER",
  EXPIRED = "EXPIRED",
  FUTURE_IAT = "FUTURE_IAT",
  AUD_MISMATCH = "AUD_MISMATCH",
  GUEST_SUBJECT = "GUEST_SUBJECT",
  WRONG_SUBJECT = "WRONG_SUBJECT",
  REPLAYED = "REPLAYED",
}

export interface ActorAssertionClaims {
  /** format version */
  v: 1;
  /** issuer identifier; public key resolved by this */
  iss: string;
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
}

export interface VerifyOptions {
  /** exact destination the assertion must be bound to */
  expectedAudience: string;
  /** optional; when set, sub must equal this */
  expectedSubject?: string;
  /** injectable clock (epoch seconds), defaults to Date.now()/1000 */
  now?: number;
  /** max clock skew allowance for iat (seconds) */
  maxIatSkewSeconds?: number;
}

export type KeyResolver = (issuer: string) => Promise<string | undefined>;

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
