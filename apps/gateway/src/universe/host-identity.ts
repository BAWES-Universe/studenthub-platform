import { createHash } from "node:crypto";
import { verifyAssertion, type KeyResolver, type ReplayStore, type SubjectPolicy } from "@bawes/actor-assertion";

/** E2 host attestation bounds (universe-bot-bridge.md: new callers 60 s lifetime, 5 s skew). */
export const ATTESTATION_LIFETIME_SECONDS = 60;
export const ATTESTATION_SKEW_SECONDS = 5;

export interface HostIdentityConfig {
  /** The Universe pusher issuer, e.g. `universe-pusher@production` (its own key). */
  readonly pusherIssuer: string;
  /** `studenthub-embed/identity@<environment>`. */
  readonly audience: string;
  /** Format of the Universe provider's verified subject (E0). */
  readonly subjectPolicy: SubjectPolicy;
  /** Issuer-key registry: undefined for an unknown or retired key (hard deny). */
  readonly keys: KeyResolver;
  /** B1 replay store; the challenge is the `jti`. */
  readonly replay: ReplayStore;
}

/**
 * E0's single pinned mapping rule between the pusher's verified provider
 * subject and the platform person's `(issuer, subject)`. Never the preferred
 * email, the game JWT identifier, or other player metadata.
 */
export interface HostIdentityMapping {
  matches(hostSubject: string, personId: string): Promise<boolean>;
}

/**
 * The rule used when E0 pins "same provider": the attested subject must equal a
 * platform external identity subject recorded for this person at the pinned
 * platform issuer. Any other rule is a new implementation of the interface.
 */
export function sameProviderSubjectMapping(
  platformIssuer: string,
  subjects: (personId: string, issuer: string) => Promise<readonly string[]>,
): HostIdentityMapping {
  if (!platformIssuer) throw new Error("platform issuer is required");
  return {
    async matches(hostSubject, personId) {
      return (await subjects(personId, platformIssuer)).includes(hostSubject);
    },
  };
}

export type AttestationResult =
  | { readonly ok: true; readonly subject: string; readonly issuedAt: number; readonly challenge: string }
  | { readonly ok: false };

/** Verifies a `bawes-aa.v1` host attestation. Every failure is a plain refusal. */
export async function verifyHostAttestation(token: unknown, config: HostIdentityConfig): Promise<AttestationResult> {
  if (typeof token !== "string" || token.length === 0 || token.length > 4096) return { ok: false };
  // The challenge is a bearer reference: the shared replay table only ever sees its digest.
  const replay: ReplayStore = {
    consume: (issuer, jti, expiresAt, now, constraints) =>
      config.replay.consume(issuer, createHash("sha256").update(jti).digest("base64url"), expiresAt, now, constraints),
  };
  const result = await verifyAssertion(token, config.keys, replay, {
    expectedAudience: config.audience,
    subjectPolicy: config.subjectPolicy,
    maxLifetimeSeconds: ATTESTATION_LIFETIME_SECONDS,
    maxIatSkewSeconds: ATTESTATION_SKEW_SECONDS,
  });
  if (!result.ok) return { ok: false };
  const claims = result.claims;
  // A person's OIDC issuer (or any other registered issuer) is never a host attestor.
  if (claims.iss !== config.pusherIssuer || claims.act !== undefined) return { ok: false };
  return { ok: true, subject: claims.sub, issuedAt: claims.iat, challenge: claims.jti };
}
