import { currentTraceId } from '../../../packages/observability/src/index.js';
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
  UNIVERSE_SUBJECT_POLICY,
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
  type IssuerKeyRegistry,
} from "@studenthub/contracts";
import { randomUUID } from "node:crypto";

import {
  createStdoutAuditSink,
  emitAuthorizationAuditEvent,
  type AuthorizationAuditEvent,
  type AuthorizationAuditFailureHandler,
  type AuthorizationAuditSink,
  type AuthorizationDecisionReason,
} from "./authz-audit.js";

/**
 * Aliased to the audit module's union so a reason can never exist in a decision
 * without being expressible in an audit event. Adding a denial reason there is
 * the only way to add one here.
 */
export type AuthzDenialReason = AuthorizationDecisionReason;

export interface AuthzMiddleware {
  readonly store: AuthzStore;
  readonly registry: IssuerKeyRegistry;
  readonly replayStore: ReplayStore;
  /** The issuer's human-subject format. Required — see SubjectPolicy. */
  readonly subjectPolicy: SubjectPolicy;
  /** Exact destination this gateway accepts assertions for. */
  readonly expectedAudience: string;
  readonly resolveKey: KeyResolver;
  /** Where decision events go. Defaults to one JSON object per line on stdout. */
  readonly auditSink: AuthorizationAuditSink;
  /** Raised when the sink refuses an event. Carries a request id and nothing else. */
  readonly onAuditFailure: AuthorizationAuditFailureHandler;
  /** Injectable clock, so tests assert an exact timestamp rather than a shape. */
  readonly now: () => Date;
  /** Server-generated correlation id. Never sourced from a request header. */
  readonly newRequestId: () => string;
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
  readonly auditSink?: AuthorizationAuditSink;
  readonly onAuditFailure?: AuthorizationAuditFailureHandler;
  readonly now?: () => Date;
  readonly newRequestId?: () => string;
}): AuthzMiddleware {
  if (deps.expectedAudience.trim().length === 0) {
    throw new TypeError("expectedAudience must be a non-empty destination string");
  }
  return {
    ...deps,
    resolveKey: registryKeyResolver(deps.registry),
    // Auditing is ON by default. An unconfigured gateway that silently stopped
    // recording decisions would be the observability equivalent of the
    // fail-OPEN default this middleware exists to prevent.
    auditSink: deps.auditSink ?? createStdoutAuditSink(),
    onAuditFailure: deps.onAuditFailure ?? (() => undefined),
    now: deps.now ?? (() => new Date()),
    newRequestId: deps.newRequestId ?? (() => randomUUID()),
  };
}

export type AuthzRequestDecision =
  | { readonly kind: "allow"; readonly subject: string; readonly orgId: string; readonly role: string }
  | { readonly kind: "deny"; readonly status: 401 | 403; readonly reason: AuthzDenialReason };

type AuthzAllowDecision = Extract<AuthzRequestDecision, { kind: "allow" }>;
type AuthzDenyDecision = Extract<AuthzRequestDecision, { kind: "deny" }>;

function deny(status: 401 | 403, reason: AuthzDenialReason): AuthzDenyDecision {
  return { kind: "deny", status, reason };
}

/**
 * The decision plus what the audit event needs that callers do not get.
 *
 * `principalId` is the PLATFORM's id from the grants store. It is carried here
 * rather than on `AuthzRequestDecision` so the audit event can correlate by it
 * without widening the public decision type.
 */
type AuditableDecision =
  | {
      readonly kind: "allow";
      readonly decision: AuthzAllowDecision;
      /** Always present on an allow — the type, not a runtime fallback, guarantees it. */
      readonly principalId: string;
    }
  | {
      readonly kind: "deny";
      readonly decision: AuthzDenyDecision;
      readonly stage: "authentication" | "authorization";
    };

/**
 * The decision itself. Unchanged from SHU-49 apart from reporting which stage
 * produced the verdict — this function records nothing and must stay that way,
 * so that `authorizeRequest` below remains the single place an event is
 * emitted.
 */
async function decideRequest(
  assertionWire: string | undefined,
  middleware: AuthzMiddleware,
): Promise<AuditableDecision> {
  if (assertionWire === undefined || assertionWire.trim() === "") {
    return { kind: "deny", decision: deny(401, "missing_assertion"), stage: "authentication" };
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
  if (!verified.ok) {
    return { kind: "deny", decision: deny(401, verified.code), stage: "authentication" };
  }

  // Server-side re-derivation: grants in the store decide, never claims.
  const resolution = await resolveActiveContext(
    claimsToRequestIdentity(verified.claims),
    claimsActToContextSelection(verified.claims),
    middleware.store,
  );
  if (resolution.kind === "denied") {
    return { kind: "deny", decision: deny(403, resolution.reason), stage: "authorization" };
  }

  return {
    kind: "allow",
    decision: {
      kind: "allow",
      subject: verified.claims.sub,
      orgId: resolution.context.orgId,
      role: resolution.context.role,
    },
    principalId: resolution.context.principalId,
  };
}

/** Build the event for a settled decision. Never sees the wire or the claims. */
function auditEventFor(
  outcome: AuditableDecision,
  requestId: string,
  timestamp: string,
): AuthorizationAuditEvent {
  if (outcome.kind === "allow") {
    return {
      type: "authorization_decision",
      timestamp,
      requestId,
      stage: "authorization",
      decision: "allow",
      // Never `decision.subject`: that is the issuer's email-shaped `sub`.
      principalId: outcome.principalId,
      orgId: outcome.decision.orgId,
      role: outcome.decision.role,
    };
  }
  return {
    type: "authorization_decision",
    timestamp,
    requestId,
    stage: outcome.stage,
    decision: "deny",
    reason: outcome.decision.reason,
    status: outcome.decision.status,
  };
}

/**
 * Gate one request. `assertionWire` is the raw `x-actor-assertion` header — the
 * exact bytes the signature covers. It is passed to the verifier untouched;
 * nothing here re-serializes claims, so signatures stay deterministic.
 *
 * EXACTLY ONE audit event is emitted per call, from the single emission point
 * below. The decision logic lives in `decideRequest` and records nothing, so a
 * denial path added later cannot forget to audit itself — the structure emits
 * for it. Scattering `record()` calls through each branch is how a control
 * silently stops covering the branch someone adds next.
 *
 * Emission happens AFTER the decision exists and never awaits the sink, so no
 * sink can change or delay the verdict.
 */
export async function authorizeRequest(
  assertionWire: string | undefined,
  middleware: AuthzMiddleware,
): Promise<AuthzRequestDecision> {
  const requestId = currentTraceId() ?? middleware.newRequestId();

  let outcome: AuditableDecision;
  try {
    outcome = await decideRequest(assertionWire, middleware);
  } catch (error) {
    // A dependency threw instead of returning a verdict. Audit the refusal and
    // rethrow unchanged: the gateway's existing 503 path stays exactly as it
    // was, because auditing must not alter behaviour it observes.
    emitAuthorizationAuditEvent(
      middleware.auditSink,
      {
        type: "authorization_decision",
        timestamp: middleware.now().toISOString(),
        requestId,
        stage: "dependency",
        decision: "deny",
        reason: "dependency_unavailable",
        status: 503,
      },
      middleware.onAuditFailure,
    );
    throw error;
  }

  emitAuthorizationAuditEvent(
    middleware.auditSink,
    auditEventFor(outcome, requestId, middleware.now().toISOString()),
    middleware.onAuditFailure,
  );
  return outcome.decision;
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
    subjectPolicy: UNIVERSE_SUBJECT_POLICY,
    expectedAudience: "unconfigured://deny-all",
  });
}
