/**
 * Server-side active-context resolution.
 *
 * Core rule (SHU-49): the effective org+role context of a request is ALWAYS
 * re-derived from the grants store on every request. A client-supplied token,
 * header or claim is never treated as proof of role — at most it is a
 * *selection preference* ("I want to act as finance for org X right now"),
 * and that preference is granted only when a matching grant exists.
 *
 * The resolver is deny-by-default:
 * - unknown principal                     -> denied
 * - no grant at the target org            -> denied
 * - claimed role not granted at the org   -> denied
 * - several roles possible, none claimed  -> denied (client must select)
 * - several orgs possible, none targeted  -> denied (client must select)
 */
import { isRole, ROLES, type Role } from "./roles.js";
import {
  ancestorOrgIdsIncludingSelf,
  descendantOrgIdsIncludingSelf,
  type Organization,
} from "./organization.js";
import type { GrantScope } from "./grants.js";
import type { AuthzStore } from "./store.js";

/** What a verified authn layer established about the caller. */
export type RequestIdentity =
  | { readonly kind: "principal"; readonly principalId: string }
  | { readonly kind: "pbuuid"; readonly pbuuid: string };

/**
 * The client-side part of a context switch request. Both fields are OPTIONAL
 * preferences and are validated against grants — never trusted.
 */
export interface ContextSelection {
  /** Org the request targets (usually also derivable from the route/resource). */
  readonly orgId?: string;
  /** Role the client wants to act under for this request. */
  readonly role?: string;
}

export interface EffectiveGrant {
  readonly orgId: string;
  readonly role: Role;
  readonly scope: GrantScope;
  /** Org the grant row is attached to (may be an ancestor of orgId). */
  readonly grantedByOrgId: string;
  /** True when the grant is attached directly to orgId. */
  readonly direct: boolean;
}

/** The single effective org+role the request is authorized to act as. */
export interface ActiveContext {
  readonly principalId: string;
  readonly orgId: string;
  readonly role: Role;
  readonly scope: GrantScope;
  readonly grantedByOrgId: string;
  readonly direct: boolean;
}

export type DenialReason =
  | "unknown_principal"
  | "no_context_at_org"
  | "role_not_granted"
  | "role_required"
  | "ambiguous_context";

export type ContextResolution =
  | {
      readonly kind: "authorized";
      readonly context: ActiveContext;
      /** Every role the principal may act as at the resolved org. */
      readonly effectiveRoles: readonly Role[];
    }
  | { readonly kind: "denied"; readonly reason: DenialReason };

/** Map a verified identity to a principal id, or null when unknown. */
export async function resolvePrincipalId(
  identity: RequestIdentity,
  store: AuthzStore,
): Promise<string | null> {
  if (identity.kind === "principal") {
    const principal = await store.getPrincipal(identity.principalId);
    return principal === undefined ? null : principal.id;
  }
  const principal = await store.findPrincipalByPbuuid(identity.pbuuid);
  return principal === undefined ? null : principal.id;
}

/**
 * The grants that make (orgId, role) pairs effective for a principal.
 * A grant applies at orgId when it is attached directly to orgId (any scope)
 * or when it is attached to an ancestor with scope "subtree".
 */
export async function effectiveGrantsForOrg(
  principalId: string,
  orgId: string,
  store: AuthzStore,
): Promise<readonly EffectiveGrant[]> {
  const [grants, organizations] = await Promise.all([
    store.listGrantsForPrincipal(principalId),
    store.listOrganizations(),
  ]);
  const targets = ancestorOrgIdsIncludingSelf(organizations, orgId);
  const targetsWithSelf = new Set([orgId, ...targets]);

  const direct: EffectiveGrant[] = [];
  const inherited: EffectiveGrant[] = [];
  for (const grant of grants) {
    const attachedToTarget = grant.orgId === orgId;
    const inheritedFrom = grant.scope === "subtree" && targetsWithSelf.has(grant.orgId);
    if (attachedToTarget) {
      direct.push({ orgId, role: grant.role, scope: grant.scope, grantedByOrgId: grant.orgId, direct: true });
    } else if (inheritedFrom) {
      inherited.push({ orgId, role: grant.role, scope: grant.scope, grantedByOrgId: grant.orgId, direct: false });
    }
  }
  // Direct rows always win. Among inherited subtree rows the NEAREST ancestor
  // wins (smallest distance between target org and the granting org).
  const chain = [...targets];
  inherited.sort(
    (a, b) =>
      chain.indexOf(a.grantedByOrgId) - chain.indexOf(b.grantedByOrgId),
  );
  return Object.freeze([...direct, ...inherited]);
}

/** Expand every grant into the (org, role) contexts it makes effective. */
export async function listEffectiveContexts(
  identity: RequestIdentity,
  store: AuthzStore,
): Promise<readonly EffectiveGrant[]> {
  const principalId = await resolvePrincipalId(identity, store);
  if (principalId === null) return Object.freeze([]);

  const [grants, organizations] = await Promise.all([
    store.listGrantsForPrincipal(principalId),
    store.listOrganizations(),
  ]);
  const orgIds = new Set(organizations.map((o: Organization) => o.id));

  const seen = new Set<string>();
  const contexts: EffectiveGrant[] = [];
  const attach = (grant: EffectiveGrant): void => {
    const key = `${grant.orgId}\u0000${grant.role}`;
    if (seen.has(key)) return;
    seen.add(key);
    contexts.push(grant);
  };

  // Pass 1: grants attached directly to their own org. Direct rows always win
  // over inherited rows for the same (org, role), regardless of grant order.
  for (const grant of grants) {
    if (!orgIds.has(grant.orgId)) continue; // grant dangling: ignore until data is repaired
    attach({
      orgId: grant.orgId,
      role: grant.role,
      scope: grant.scope,
      grantedByOrgId: grant.orgId,
      direct: true,
    });
  }

  // Pass 2: subtree grants fan out to descendants. When several ancestor
  // grants cover the same (org, role), the NEAREST ancestor wins — sort the
  // candidates by ancestry depth so the choice is deterministic and specific.
  const inherited: EffectiveGrant[] = [];
  for (const grant of grants) {
    if (grant.scope !== "subtree" || !orgIds.has(grant.orgId)) continue;
    for (const orgId of descendantOrgIdsIncludingSelf(organizations, grant.orgId)) {
      if (orgId === grant.orgId) continue; // already attached in pass 1
      inherited.push({
        orgId,
        role: grant.role,
        scope: grant.scope,
        grantedByOrgId: grant.orgId,
        direct: false,
      });
    }
  }
  inherited.sort(
    (a, b) =>
      ancestorOrgIdsIncludingSelf(organizations, a.orgId).indexOf(a.grantedByOrgId) -
      ancestorOrgIdsIncludingSelf(organizations, b.orgId).indexOf(b.grantedByOrgId),
  );
  for (const grant of inherited) attach(grant);
  return Object.freeze(contexts);
}

function pickRole(
  effective: readonly EffectiveGrant[],
  claimed: string | undefined,
):
  | { readonly ok: true; readonly role: Role; readonly roles: readonly Role[] }
  | { readonly ok: false; readonly reason: DenialReason } {
  const present = new Set(effective.map((e) => e.role));
  const roles = ROLES.filter((role) => present.has(role));

  if (claimed !== undefined) {
    if (!isRole(claimed) || !present.has(claimed)) return { ok: false, reason: "role_not_granted" };
    return { ok: true, role: claimed, roles };
  }
  if (roles.length === 1) return { ok: true, role: roles[0], roles };
  if (roles.length === 0) return { ok: false, reason: "no_context_at_org" };
  return { ok: false, reason: "role_required" };
}

/**
 * Resolve the active context for one request, re-reading grants from the
 * store every time. Never cache the result across requests.
 */
export async function resolveActiveContext(
  identity: RequestIdentity,
  selection: ContextSelection | undefined,
  store: AuthzStore,
): Promise<ContextResolution> {
  const principalId = await resolvePrincipalId(identity, store);
  if (principalId === null) return frozenDenied("unknown_principal");

  if (selection?.orgId !== undefined) {
    const org = await store.getOrganization(selection.orgId);
    if (org === undefined) return frozenDenied("no_context_at_org");
    const effective = await effectiveGrantsForOrg(principalId, selection.orgId, store);
    if (effective.length === 0) return frozenDenied("no_context_at_org");

    const picked = pickRole(effective, selection.role);
    if (!picked.ok) return frozenDenied(picked.reason);

    const matching = effective.find(
      (e) => e.role === picked.role && e.direct,
    ) ?? effective.find((e) => e.role === picked.role);
    if (matching === undefined) return frozenDenied("role_not_granted");

    return Object.freeze({
      kind: "authorized",
      context: {
        principalId,
        orgId: selection.orgId,
        role: picked.role,
        scope: matching.scope,
        grantedByOrgId: matching.grantedByOrgId,
        direct: matching.direct,
      },
      effectiveRoles: picked.roles,
    });
  }

  // No org targeted: authorize only when the principal has exactly one
  // effective (org, role) context — anything wider is ambiguous.
  const contexts = await listEffectiveContexts(identity, store);
  if (contexts.length === 0) return frozenDenied("unknown_principal");
  if (contexts.length > 1) return frozenDenied("ambiguous_context");

  const only = contexts[0];
  return Object.freeze({
    kind: "authorized",
    context: {
      principalId,
      orgId: only.orgId,
      role: only.role,
      scope: only.scope,
      grantedByOrgId: only.grantedByOrgId,
      direct: only.direct,
    },
    effectiveRoles: Object.freeze([only.role]),
  });
}

function frozenDenied(reason: DenialReason): ContextResolution {
  return Object.freeze({ kind: "denied", reason });
}
