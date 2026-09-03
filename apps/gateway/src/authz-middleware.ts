/**
 * Gateway authorization middleware — SHU-49 skeleton.
 *
 * Deny by default. An unconfigured middleware denies EVERY request; the
 * allow path only opens after every stage passes:
 *
 *   1. a POSITIVE actor assertion is present (no guest/anonymous denylist —
 *      missing or empty means deny, full stop);
 *   2. the assertion parses and speaks the supported format version;
 *   3. its (issuer, keyId) exists in the issuer-key registry and is ACTIVE
 *      (unknown kid and retired keys are hard denies — rotation never falls
 *      back to "accept anything");
 *   4. the injected signature check passes (the skeleton's default verifier
 *      returns false; real cryptographic verification lands with authn,
 *      SHU-0020 — until then every protected route stays closed);
 *   5. the active org+role context resolves SERVER-SIDE from the grants
 *      store. The assertion's optional `act` claim is only a selection
 *      preference and is re-validated against grants — a client-supplied
 *      role that no grant backs is denied, never trusted.
 *
 * Stage-5 denials are authorization failures (403). Stages 1-4 are
 * authentication failures (401).
 */
import {
  assertionActToContextSelection,
  assertionToRequestIdentity,
  decodeActorAssertion,
  resolveActiveContext,
  type ActorAssertion,
  type AuthzStore,
  type DenialReason,
  type IssuerKeyDescriptor,
  type IssuerKeyRegistry,
} from "@studenthub/contracts";

export type AssertionDenialReason =
  | "missing_assertion"
  | "invalid_assertion"
  | "unknown_issuer_key"
  | "issuer_key_retired"
  | "signature_not_verified";

export type AuthzDenialReason = AssertionDenialReason | DenialReason;

export interface AuthzMiddleware {
  readonly store: AuthzStore;
  readonly registry: IssuerKeyRegistry;
  /**
   * Verifies the assertion's signature against the registered key. The
   * skeleton ships a deny-by-default stub (always false); real verification
   * is injected once authn (SHU-0020) lands.
   */
  readonly verifyAssertionSignature: (
    assertion: ActorAssertion,
    key: IssuerKeyDescriptor,
  ) => Promise<boolean>;
}

export function createAuthzMiddleware(deps: {
  readonly store: AuthzStore;
  readonly registry: IssuerKeyRegistry;
  readonly verifyAssertionSignature?: AuthzMiddleware["verifyAssertionSignature"];
}): AuthzMiddleware {
  return {
    store: deps.store,
    registry: deps.registry,
    // Deny by default: until a real verifier is injected every request fails
    // closed at stage 4, which is exactly what an authz skeleton must do.
    verifyAssertionSignature: deps.verifyAssertionSignature ?? (async () => false),
  };
}

export type AuthzRequestDecision =
  | { readonly kind: "allow" }
  | { readonly kind: "deny"; readonly status: 401 | 403; readonly reason: AuthzDenialReason };

function deny(status: 401 | 403, reason: AuthzDenialReason): AuthzRequestDecision {
  return { kind: "deny", status, reason };
}

/**
 * Gate one request through the full deny-by-default pipeline. `assertionWire`
 * is the raw `x-actor-assertion` header value (base64url JSON), if any.
 */
export async function authorizeRequest(
  assertionWire: string | undefined,
  middleware: AuthzMiddleware,
): Promise<AuthzRequestDecision> {
  if (assertionWire === undefined) {
    return deny(401, "missing_assertion");
  }
  if (assertionWire.trim() === "") {
    // Header present but empty is an INVALID assertion, not a missing one.
    return deny(401, "invalid_assertion");
  }

  let assertion: ActorAssertion;
  try {
    assertion = decodeActorAssertion(assertionWire);
  } catch {
    return deny(401, "invalid_assertion");
  }

  const key = await middleware.registry.getIssuerKey(assertion.issuer, assertion.keyId);
  if (key === undefined) return deny(401, "unknown_issuer_key");
  if (key.status !== "active") return deny(401, "issuer_key_retired");

  const verified = await middleware.verifyAssertionSignature(assertion, key);
  if (!verified) return deny(401, "signature_not_verified");

  // Server-side re-derivation: grants in the store decide, never claims.
  const resolution = await resolveActiveContext(
    assertionToRequestIdentity(assertion),
    assertionActToContextSelection(assertion),
    middleware.store,
  );
  if (resolution.kind === "denied") return deny(403, resolution.reason);
  return { kind: "allow" };
}
