import { createHash, randomUUID } from "node:crypto";
import type { PoolClient } from "pg";

export const AUTHORIZATION_MUTATION_OPERATIONS = [
  "principal.register",
  "grants.grant",
  "grants.revoke",
  "grants.clear",
] as const;

export type AuthorizationMutationOperation =
  (typeof AUTHORIZATION_MUTATION_OPERATIONS)[number];

export interface AuthorizationMutationContext {
  /** Raw correlation id accepted at the API edge and hashed before persistence. */
  readonly requestId?: string;
  /** Raw principal id accepted at the API edge and hashed before persistence. */
  readonly actorPrincipalId?: string;
}

export interface AuthorizationMutationAuditRecord {
  readonly id: string;
  readonly requestRef: string;
  readonly actorPrincipalRef?: string;
  readonly operation: AuthorizationMutationOperation;
  readonly targetPrincipalRef?: string;
  readonly targetOrgRefs: readonly string[];
  readonly occurredAt: string;
  readonly before: Readonly<Record<string, unknown>>;
  readonly after: Readonly<Record<string, unknown>>;
}

export type AuditSummary = Readonly<Record<string, unknown>>;

export interface AuditInsert {
  readonly context: ResolvedAuthorizationMutationContext;
  readonly operation: AuthorizationMutationOperation;
  readonly targetPrincipalId?: string;
  readonly targetOrgIds?: readonly string[];
  readonly before: AuditSummary;
  readonly after: AuditSummary;
}

export interface ResolvedAuthorizationMutationContext {
  readonly requestRef: string;
  readonly actorPrincipalRef: string | null;
}

function auditRef(domain: "principal" | "organization" | "request", value: string): string {
  const maximum = domain === "request" ? 512 : 4_096;
  if (value.trim().length === 0 || value.length > maximum) {
    throw new TypeError(`${domain} audit reference input must be 1-${maximum} characters`);
  }
  return createHash("sha256")
    .update(`studenthub:${domain}-audit-ref:v1\0`, "utf8")
    .update(value, "utf8")
    .digest("hex");
}

export function principalAuditRef(principalId: string): string {
  return auditRef("principal", principalId);
}

export function organizationAuditRef(orgId: string): string {
  return auditRef("organization", orgId);
}

export function requestAuditRef(requestId: string): string {
  return auditRef("request", requestId);
}

export function resolveAuthorizationMutationContext(
  context: AuthorizationMutationContext | undefined,
): ResolvedAuthorizationMutationContext {
  const requestId = context?.requestId ?? `audit_${randomUUID()}`;
  const actor = context?.actorPrincipalId;
  if (actor !== undefined && actor.trim().length === 0) {
    throw new TypeError("audit actorPrincipalId must be non-empty when provided");
  }
  return {
    requestRef: requestAuditRef(requestId),
    actorPrincipalRef: actor === undefined ? null : principalAuditRef(actor),
  };
}

/** Insert using the caller's transaction client; never accepts a pool. */
export async function insertAuthorizationMutationAudit(
  client: PoolClient,
  input: AuditInsert,
): Promise<void> {
  const { requestRef, actorPrincipalRef } = input.context;
  await client.query(
    `INSERT INTO authorization_mutation_audit
       (request_ref, actor_principal_ref, operation, target_principal_ref,
        target_org_refs, before_summary, after_summary)
     VALUES ($1, $2, $3, $4, $5::text[], $6::jsonb, $7::jsonb)`,
    [
      requestRef,
      actorPrincipalRef,
      input.operation,
      input.targetPrincipalId === undefined
        ? null
        : principalAuditRef(input.targetPrincipalId),
      [...new Set(input.targetOrgIds ?? [])].map(organizationAuditRef).sort(),
      JSON.stringify(input.before),
      JSON.stringify(input.after),
    ],
  );
}
