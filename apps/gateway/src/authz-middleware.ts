/**
 * Gateway authorization middleware — SHU-49.
 *
 * Deny by default at BOTH layers. There is no configuration in which a request
 * reaches a route without passing every stage:
 *
 *   1. an assertion is present (missing or empty is a hard deny — there is no
 *      guest/anonymous denylist, and no anonymous path);
 *   2. `verifyAssertion` (@bawes/actor-assertion, `bawes-aa.v1`) checks the
 *      Ed25519 signature over the RAW wire bytes, the destination binding
 *      (`aud`), expiry (`exp`), iat skew, the issuer's positive human-subject
 *      format, and consumes the one-use `jti` for replay protection;
 *   3. the issuer key is resolved THROUGH the registry, which returns a key
 *      only for a known (issuer, kid) whose status is active — unknown and
 *      retired keys resolve to undefined and fail as UNKNOWN_ISSUER;
 *   4. the active org+role context resolves SERVER-SIDE from the grants store.
 *      The assertion's optional `act` claim is only a selection preference and
 *      is re-validated against grants — a client-supplied role that no grant
 *      backs is denied, never trusted.
 *
 * Stages 1-3 are authentication failures (401); stage 4 is authorization (403).
 */
import {
  AUTHENTIK_SUBJECT_POLICY,
  AssertionErrorCode,
  MemoryReplayStore,
  verifyAssertion,
  type KeyResolver,
  type ReplayStore,
  type SubjectPolicy,
} from "@bawes/actor-assertion";
import {
  InMemoryAuthzStore,
  InMemoryIssuerKeyRegistry,
  claimsActToContextSelection,
  claimsToRequestIdentity,
  resolveActiveContext,
  type AuthzStore,
  type DenialReason,
  type IssuerKeyRegistry,
} from "@studenthub/contracts";

export type AuthzDenialReason = AssertionErrorCode | "missing_assertion" | DenialReason;

export interface AuthzMiddleware {
  readonly store: AuthzStore;
  readonly registry: IssuerKeyRegistry;
  readonly replayStore: ReplayStore;
  /** The issuer's human-subject format. Required — see SubjectPolicy. */
  readonly subjectPolicy: SubjectPolicy;
  /** Exact destination this gateway accepts assertions for. */
  readonly expectedAudience: string;
  readonly resolveKey: KeyResolver;
}

/**
 * Build a KeyResolver backed by the issuer-key registry. Only an ACTIVE key for
 * a known (issuer, kid) resolves; everything else returns undefined, which the
 * verifier reports as UNKNOWN_ISSUER. Rotation therefore never falls back to
 * "accept anything".
 *
 * An assertion with no `kid` resolves only when the issuer has exactly ONE
 * active key — ambiguity is a deny, not a guess.
 */
export function registryKeyResolver(registry: IssuerKeyRegistry): KeyResolver {
  return async (issuer: string, keyId?: string): Promise<string | undefined> => {
    if (keyId !== undefined) {
      const key = await registry.getIssuerKey(issuer, keyId);
      return key !== undefined && key.status === "active" ? key.publicKey : undefined;
    }
    const active = (await registry.listIssuerKeys(issuer)).filter((k) => k.status === "active");
    return active.length === 1 ? active[0]!.publicKey : undefined;
  };
}

export function createAuthzMiddleware(deps: {
  readonly store: AuthzStore;
  readonly registry: IssuerKeyRegistry;
  readonly replayStore: ReplayStore;
  readonly subjectPolicy: SubjectPolicy;
  readonly expectedAudience: string;
}): AuthzMiddleware {
  if (deps.expectedAudience.trim().length === 0) {
    throw new TypeError("expectedAudience must be a non-empty destination string");
  }
  return { ...deps, resolveKey: registryKeyResolver(deps.registry) };
}

export type AuthzRequestDecision =
  | { readonly kind: "allow"; readonly subject: string; readonly orgId: string; readonly role: string }
  | { readonly kind: "deny"; readonly status: 401 | 403; readonly reason: AuthzDenialReason };

function deny(status: 401 | 403, reason: AuthzDenialReason): AuthzRequestDecision {
  return { kind: "deny", status, reason };
}

/**
 * Gate one request. `assertionWire` is the raw `x-actor-assertion` header — the
 * exact bytes the signature covers. It is passed to the verifier untouched;
 * nothing here re-serializes claims, so signatures stay deterministic.
 */
export async function authorizeRequest(
  assertionWire: string | undefined,
  middleware: AuthzMiddleware,
): Promise<AuthzRequestDecision> {
  if (assertionWire === undefined || assertionWire.trim() === "") {
    return deny(401, "missing_assertion");
  }

  const verified = await verifyAssertion(
    assertionWire,
    middleware.resolveKey,
    middleware.replayStore,
    {
      expectedAudience: middleware.expectedAudience,
      subjectPolicy: middleware.subjectPolicy,
    },
  );
  if (!verified.ok) return deny(401, verified.code);

  // Server-side re-derivation: grants in the store decide, never claims.
  const resolution = await resolveActiveContext(
    claimsToRequestIdentity(verified.claims),
    claimsActToContextSelection(verified.claims),
    middleware.store,
  );
  if (resolution.kind === "denied") return deny(403, resolution.reason);

  return {
    kind: "allow",
    subject: verified.claims.sub,
    orgId: resolution.context.orgId,
    role: resolution.context.role,
  };
}

/**
 * The default for an unconfigured gateway: an empty key registry and an empty
 * grants store, so every assertion fails at key resolution and every principal
 * is unknown. Nothing reaches a route.
 *
 * This exists so `createGatewayServer()` cannot be called into an open state.
 * Before SHU-49 the gateway took `authz: AuthzMiddleware | undefined = undefined`
 * and skipped the check when it was absent, which meant the process as actually
 * run had authorization disabled — a fail-OPEN default behind a fail-closed
 * middleware (Opus R3 review of PR #13).
 */
export function createDenyAllAuthzMiddleware(): AuthzMiddleware {
  return createAuthzMiddleware({
    store: new InMemoryAuthzStore(),
    registry: new InMemoryIssuerKeyRegistry(),
    replayStore: new MemoryReplayStore(),
    subjectPolicy: AUTHENTIK_SUBJECT_POLICY,
    expectedAudience: "unconfigured://deny-all",
  });
}
