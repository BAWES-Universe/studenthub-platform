/**
 * Authorization decision audit events — SHU-58.
 *
 * This module records WHAT the gateway decided. It never participates in
 * deciding. Three properties hold by construction, and each is pinned by a
 * test that fails when the property is removed:
 *
 *   1. AUDIT NEVER CHANGES A RESULT. Sinks are invoked fire-and-forget after
 *      the decision exists. A sink that throws, rejects, or hangs cannot change
 *      an allow into a deny, a deny into an allow, or delay either.
 *
 *   2. NOTHING ATTACKER-CONTROLLED IS EVER RECORDED. No event carries the
 *      assertion wire, its claims, headers, tokens, keys, or the raw subject.
 *      Denials carry no identity at all: before verification there is no
 *      trustworthy identity, and after a FAILED authorization there is no
 *      resolved platform principal to name. Only an ALLOW — where the platform
 *      re-derived the identity itself from its own grant store — carries
 *      principal, org and role.
 *
 *   3. THE EMAIL-SHAPED SUBJECT NEVER APPEARS. Universe issues `sub` as a user
 *      email (`UNIVERSE_SUBJECT_POLICY`). Correlation uses the platform's own
 *      `principalId`, which the store assigned, never the `sub` the issuer sent.
 *
 * Retention, destination and access control belong to the log pipeline that
 * consumes stdout. This module authorizes no destination and configures no
 * retention.
 */
import { AssertionErrorCode } from "@bawes/actor-assertion";
import type { DenialReason } from "@studenthub/contracts";

/**
 * Every typed reason a request can be refused. Single source of truth —
 * `AuthzDenialReason` in authz-middleware.ts aliases this, so a reason can
 * never exist in the decision type without being expressible in an event.
 */
export type AuthorizationDecisionReason =
  | AssertionErrorCode
  | "missing_assertion"
  | DenialReason;

/** Where in the pipeline the decision was reached. */
export type AuthorizationDecisionStage =
  /** Stages 1-3: assertion presence, signature/binding/replay, issuer key. */
  | "authentication"
  /** Stage 4: server-side org+role re-derivation from grants. */
  | "authorization"
  /** A dependency threw rather than returning a verdict. Fails closed. */
  | "dependency";

interface AuthorizationAuditEventBase {
  readonly type: "authorization_decision";
  /** ISO-8601, UTC. */
  readonly timestamp: string;
  /**
   * Server-generated per authorization. NEVER taken from a request header: an
   * attacker-supplied correlation id would let a caller forge or collide log
   * entries before it has authenticated anything.
   */
  readonly requestId: string;
  readonly stage: AuthorizationDecisionStage;
}

/**
 * An allowed request. This is the ONLY event shape carrying identity, and every
 * field in it was re-derived server-side by `resolveActiveContext` from the
 * grants store — none of it is client-supplied.
 */
export interface AuthorizationAllowEvent extends AuthorizationAuditEventBase {
  readonly decision: "allow";
  readonly stage: "authorization";
  /** The PLATFORM's principal id, not the issuer's email-shaped `sub`. */
  readonly principalId: string;
  readonly orgId: string;
  readonly role: string;
}

/**
 * A refused request. Deliberately identity-free — see property 2 above.
 * `status` mirrors the HTTP status the gateway returns so an operator can join
 * events to access logs without re-deriving the mapping.
 */
export interface AuthorizationDenyEvent extends AuthorizationAuditEventBase {
  readonly decision: "deny";
  readonly stage: "authentication" | "authorization";
  readonly reason: AuthorizationDecisionReason;
  readonly status: 401 | 403;
}

/**
 * A dependency threw instead of returning a verdict (for example the grants
 * store is unreachable). The gateway answers 503 and the request never reaches
 * a route, so this is a refusal and is audited as one.
 *
 * Note the verifier's OWN dependency failures do not arrive here: it fails
 * closed and returns `AssertionErrorCode.UNAVAILABLE`, which is an ordinary
 * typed deny at the authentication stage.
 *
 * The thrown error is NOT recorded. A dependency error can embed the query,
 * connection string or payload that produced it, and this module is not a
 * place where that becomes a log line.
 */
export interface AuthorizationDependencyEvent extends AuthorizationAuditEventBase {
  readonly decision: "deny";
  readonly stage: "dependency";
  readonly reason: "dependency_unavailable";
  readonly status: 503;
}

export type AuthorizationAuditEvent =
  | AuthorizationAllowEvent
  | AuthorizationDenyEvent
  | AuthorizationDependencyEvent;

/**
 * The audit destination. `record` may be synchronous or return a promise; both
 * failure modes are contained by `emitAuthorizationAuditEvent`, so an
 * implementation is free to throw or reject without consulting this contract.
 */
export interface AuthorizationAuditSink {
  record(event: AuthorizationAuditEvent): void | Promise<void>;
}

/**
 * The internal signal raised when a sink could not accept an event.
 *
 * It carries the request id and nothing else. Not the error, not its message,
 * not the event: a sink fails *while handling* an event, so anything it hands
 * back is exactly the payload we were trying to keep out of the failure path.
 * An operator correlates by `requestId`; the audit stream itself is the record.
 */
export interface AuthorizationAuditFailure {
  readonly kind: "audit_sink_failure";
  readonly requestId: string;
}

export type AuthorizationAuditFailureHandler = (failure: AuthorizationAuditFailure) => void;

/**
 * The production default: one JSON object per line on stdout, for the platform
 * log pipeline to collect. Line-delimited so a partially written line can never
 * merge two events into one parseable record.
 */
export function createStdoutAuditSink(
  write: (line: string) => void = (line) => void process.stdout.write(line),
): AuthorizationAuditSink {
  return {
    record(event: AuthorizationAuditEvent): void {
      write(`${JSON.stringify(event)}\n`);
    },
  };
}

/** A sink that accepts and discards. For tests and for opting out explicitly. */
export function createNullAuditSink(): AuthorizationAuditSink {
  return { record: () => undefined };
}

/**
 * Hand one event to the sink WITHOUT letting the sink affect the caller.
 *
 * Fire-and-forget is deliberate: awaiting would let a slow or hanging sink add
 * latency to every authorized request, which is a denial-of-service surface
 * built out of a logging feature. A returned promise gets a rejection handler
 * attached immediately, so a rejecting sink raises the internal failure signal
 * instead of an unhandled rejection — which under Node's default policy would
 * terminate the gateway.
 */
export function emitAuthorizationAuditEvent(
  sink: AuthorizationAuditSink,
  event: AuthorizationAuditEvent,
  onFailure: AuthorizationAuditFailureHandler,
): void {
  const fail = (): void => {
    // The failure handler is itself untrusted code. If it throws, there is
    // nowhere left to report to, and the decision still must not be affected.
    try {
      onFailure({ kind: "audit_sink_failure", requestId: event.requestId });
    } catch {
      /* contained: auditing cannot break authorization */
    }
  };

  let result: void | Promise<void>;
  try {
    result = sink.record(event);
  } catch {
    fail();
    return;
  }

  if (result !== undefined) {
    // Promise assimilation contains more than an ordinary rejection: it also
    // converts a throwing `then` accessor (or a thenable whose `then` throws)
    // into a rejection. Reading `.then` directly would let a hostile or broken
    // sink throw after the authorization decision exists and change it.
    void Promise.resolve(result).then(undefined, fail);
  }
}
