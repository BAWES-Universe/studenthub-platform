/**
 * Adapter from a VERIFIED actor assertion onto the authz resolver's inputs.
 *
 * SHU-49 originally defined a second, parallel assertion format here. That was
 * a fork of the standard, not an amendment to it (Opus R3 review of PR #13), so
 * it is gone: `bawes-aa.v1` in `@bawes/actor-assertion` is the ONE actor
 * assertion format, and it is where the `act` claim, the positive-subject rule,
 * destination binding (`aud`), expiry (`exp`), replay protection (`jti`) and the
 * Ed25519 signature all live.
 *
 * This module deliberately holds no envelope, no parser and no crypto: contracts
 * stays dependency-free and describes only the shape it consumes. The gateway
 * verifies with `@bawes/actor-assertion`, then hands the verified claims here.
 */
import type { ContextSelection, RequestIdentity } from "./context.js";

/**
 * Structural mirror of the fields `bawes-aa.v1` carries that authorization
 * cares about. Anything reaching these helpers must ALREADY have passed
 * signature, audience, expiry and replay verification — this is an adapter,
 * not a validator, and it performs no security check of its own.
 */
export interface VerifiedActorClaims {
  /** Verified actor subject (Authentik `userinfo.sub`). */
  readonly sub: string;
  /** Optional acting-context preference, re-validated against grants below. */
  readonly act?: {
    readonly org?: string;
    readonly role?: string;
  };
}

/** Map a verified subject onto the resolver's identity input. */
export function claimsToRequestIdentity(claims: VerifiedActorClaims): RequestIdentity {
  return { kind: "pbuuid", pbuuid: claims.sub };
}

/**
 * The optional `act` claim becomes a ContextSelection — a PREFERENCE the
 * resolver validates against grants, never an authorization in itself. Absent
 * or empty `act` yields undefined, and single-context principals still resolve
 * automatically.
 */
export function claimsActToContextSelection(
  claims: VerifiedActorClaims,
): ContextSelection | undefined {
  const act = claims.act;
  if (act === undefined || (act.org === undefined && act.role === undefined)) {
    return undefined;
  }
  return Object.freeze({
    ...(act.org !== undefined ? { orgId: act.org } : {}),
    ...(act.role !== undefined ? { role: act.role } : {}),
  });
}
