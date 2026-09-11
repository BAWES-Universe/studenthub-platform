import {
  listEffectiveContexts, resolveActiveContext, type AuthzStore, type Role,
} from "@studenthub/contracts";
import type { SessionStore } from "@studenthub/login-contract";

/** Only public display fields for contexts belonging to the signed-in person. */
export interface WorkspaceContext {
  readonly orgId: string;
  readonly role: Role;
  readonly organizationName: string;
}

export type NavigationResult =
  | { readonly status: 200; readonly body: {
    readonly contexts: readonly WorkspaceContext[];
    readonly active: WorkspaceContext | null;
  } }
  | { readonly status: 400 | 401 | 403 | 503; readonly body: { readonly error: string } };

export interface ContextNavigation {
  open(sessionId: string | undefined, selection: URLSearchParams): Promise<NavigationResult>;
}

/** URL selections are preferences, never authority or a persistent role claim. */
export function createContextNavigation(sessions: Pick<SessionStore, "get">, store: AuthzStore): ContextNavigation {
  return {
    async open(sessionId, selection) {
      try {
        const session = sessionId ? await sessions.get(sessionId) : undefined;
        if (!session || !await store.getPrincipal(session.personId)) {
          return { status: 401, body: { error: "unauthorized" } };
        }
        // Require a complete, unambiguous pair. The shared resolver may infer
        // defaults when fields are absent; a browser URL must never silently
        // ignore a requested role or choose a different organization.
        const selected = selection.size > 0;
        if (selected && (selection.size !== 2
          || selection.getAll("org_id").length !== 1 || selection.getAll("role").length !== 1
          || !selection.get("org_id") || !selection.get("role"))) {
          return { status: 400, body: { error: "invalid_context_selection" } };
        }
        const identity = { kind: "principal" as const, principalId: session.personId };
        let active: WorkspaceContext | null = null;
        if (selected) {
          const resolution = await resolveActiveContext(identity, {
            orgId: selection.get("org_id")!, role: selection.get("role")!,
          }, store);
          if (resolution.kind !== "authorized") {
            return { status: 403, body: { error: "context_forbidden" } };
          }
          // These are the resolver's output, not values trusted from the URL.
          const org = await store.getOrganization(resolution.context.orgId);
          if (!org) return { status: 403, body: { error: "context_forbidden" } };
          active = { orgId: org.id, role: resolution.context.role, organizationName: org.name };
        }
        const effective = await listEffectiveContexts(identity, store);
        const organizations = new Map((await store.listOrganizations()).map((org) => [org.id, org]));
        const contexts: WorkspaceContext[] = [];
        for (const context of effective) {
          const org = organizations.get(context.orgId);
          if (org) contexts.push({ orgId: org.id, role: context.role, organizationName: org.name });
        }
        // Also reject a revocation observed while this request was being built.
        if (active && !contexts.some((c) => c.orgId === active.orgId && c.role === active.role)) {
          return { status: 403, body: { error: "context_forbidden" } };
        }
        contexts.sort((a, b) => a.organizationName.localeCompare(b.organizationName)
          || a.orgId.localeCompare(b.orgId) || a.role.localeCompare(b.role));
        return { status: 200, body: { contexts, active } };
      } catch {
        return { status: 503, body: { error: "context_unavailable" } };
      }
    },
  };
}
