/**
 * Actor assertions — the wire format the authn layer will one day sign and
 * the gateway parses. SHU-49 defines the CONTRACT here (claims, validation,
 * positive-subject rule, optional `act` claim); actual key handling lives in
 * the issuer-key registry (./registry.ts) and real signature verification
 * lands with the authn work (SHU-0020). Until then the gateway middleware
 * denies by default, so shipping the skeleton cannot open a hole.
 *
 * Amendments folded in (Opus standard review, SHU-49):
 *
 * (a) OPTIONAL `act` claim — org/tenant/role context the actor asserts as a
 *     *selection preference*. It is never proof: the resolver re-derives the
 *     effective context from grants server-side and only honours `act` when a
 *     matching grant exists. The claim is optional end-to-end, so assertions
 *     minted by v1 clients remain wire-compatible (they simply omit it).
 *
 * (b) POSITIVE authenticated-subject rule — an assertion is only usable when
 *     it carries a non-empty subject (`principalId` or `pbuuid`). There is
 *     deliberately NO denylist of "guest"/"anonymous"-style strings that would
 *     fail open; a literal subject named `guest` gets exactly the same
 *     deny-by-default treatment as any other id that holds no grant.
 *
 * (d) The assertion format is versioned by its own contract slot
 *     (`CONTRACT_VERSIONS.identity`), NOT by a global platform version.
 */
import { CONTRACT_VERSIONS } from "../versions.js";
import type { ContextSelection, RequestIdentity } from "./context.js";

export const ACTOR_ASSERTION_FORMAT_VERSION = CONTRACT_VERSIONS.identity;
export type ActorAssertionFormatVersion = typeof ACTOR_ASSERTION_FORMAT_VERSION;

/** Who the assertion positively claims the caller is. */
export type AssertionSubject =
  | { readonly kind: "principal"; readonly principalId: string }
  | { readonly kind: "pbuuid"; readonly pbuuid: string };

/** Optional delegation/context claim (RFC 8693-style `act`). */
export interface ActorAssertionAct {
  /** Org the actor wants to act under for this request. */
  readonly orgId?: string;
  /** Role the actor wants to act under for this request. */
  readonly role?: string;
}

export interface ActorAssertion {
  /** Format version of this claim set (= CONTRACT_VERSIONS.identity). */
  readonly formatVersion: ActorAssertionFormatVersion;
  /** Stable name of the identity provider that issued/signed this. */
  readonly issuer: string;
  /** Key id in the issuer's registry used to sign this assertion. */
  readonly keyId: string;
  /** POSITIVE subject: required, non-empty. No guest/anonymous denylist exists. */
  readonly subject: AssertionSubject;
  /** ISO-8601 issuance timestamp. */
  readonly issuedAt: string;
  /** Optional context preference; validated against grants, never trusted. */
  readonly act?: ActorAssertionAct;
}

/** Positive-subject check: the subject must exist and be a non-empty id. */
export function isPositiveAssertionSubject(value: unknown): value is AssertionSubject {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (candidate.kind === "principal") {
    return (
      typeof candidate.principalId === "string" && candidate.principalId.trim().length > 0
    );
  }
  if (candidate.kind === "pbuuid") {
    return typeof candidate.pbuuid === "string" && candidate.pbuuid.trim().length > 0;
  }
  return false;
}

function requireNonEmpty(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`actor assertion ${field} must be a non-empty string`);
  }
  return value;
}

/**
 * Parse and validate an untrusted actor assertion. Throws TypeError when the
 * value is malformed, from an unsupported format version, or lacks a positive
 * subject — i.e. anything that must never reach the grant resolver.
 */
export function parseActorAssertion(value: unknown): ActorAssertion {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError("actor assertion must be an object");
  }
  const candidate = value as Record<string, unknown>;

  if (candidate.formatVersion !== ACTOR_ASSERTION_FORMAT_VERSION) {
    throw new TypeError(
      `unsupported actor assertion format version ${JSON.stringify(
        candidate.formatVersion,
      )}; this build speaks identity ${ACTOR_ASSERTION_FORMAT_VERSION}`,
    );
  }
  if (!isPositiveAssertionSubject(candidate.subject)) {
    throw new TypeError("actor assertion requires a positive subject (principal or pbuuid)");
  }

  const base = {
    formatVersion: ACTOR_ASSERTION_FORMAT_VERSION,
    issuer: requireNonEmpty(candidate.issuer, "issuer"),
    keyId: requireNonEmpty(candidate.keyId, "keyId"),
    subject: candidate.subject,
    issuedAt: requireNonEmpty(candidate.issuedAt, "issuedAt"),
  };

  if (candidate.act === undefined) return Object.freeze(base);

  if (typeof candidate.act !== "object" || candidate.act === null) {
    throw new TypeError("actor assertion act must be an object when present");
  }
  const act = candidate.act as Record<string, unknown>;
  const parsedAct: ActorAssertionAct = Object.freeze({
    ...(act.orgId !== undefined ? { orgId: requireNonEmpty(act.orgId, "act.orgId") } : {}),
    ...(act.role !== undefined ? { role: requireNonEmpty(act.role, "act.role") } : {}),
  });
  return Object.freeze({ ...base, act: parsedAct });
}

/**
 * Wire transport: base64url(UTF-8 JSON). Kept deliberately JWT-like so the
 * later move to a signed JWS (authn, SHU-0020) only swaps the middle segment
 * for a real signature — the claim set and this function's contract stay put.
 */
export function encodeActorAssertion(assertion: ActorAssertion): string {
  return Buffer.from(JSON.stringify(assertion), "utf8").toString("base64url");
}

export function decodeActorAssertion(value: string): ActorAssertion {
  let json: string;
  try {
    json = Buffer.from(value, "base64url").toString("utf8");
  } catch {
    throw new TypeError("actor assertion is not valid base64url");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    throw new TypeError("actor assertion is not valid JSON");
  }
  return parseActorAssertion(parsed);
}

/** Map a positively-asserted subject onto the resolver's identity input. */
export function assertionToRequestIdentity(assertion: ActorAssertion): RequestIdentity {
  return assertion.subject.kind === "principal"
    ? { kind: "principal", principalId: assertion.subject.principalId }
    : { kind: "pbuuid", pbuuid: assertion.subject.pbuuid };
}

/**
 * The optional `act` claim becomes a ContextSelection — a preference the
 * resolver validates against grants. Absent or empty `act` yields undefined
 * (single-context principals still resolve automatically).
 */
export function assertionActToContextSelection(
  assertion: ActorAssertion,
): ContextSelection | undefined {
  const act = assertion.act;
  if (act === undefined || (act.orgId === undefined && act.role === undefined)) {
    return undefined;
  }
  return Object.freeze({
    ...(act.orgId !== undefined ? { orgId: act.orgId } : {}),
    ...(act.role !== undefined ? { role: act.role } : {}),
  });
}
