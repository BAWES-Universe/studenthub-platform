import {
  listEffectiveContexts, resolveActiveContext, type AuthzStore, type Role,
} from "@studenthub/contracts";
import type { SessionStore } from "@studenthub/login-contract";
import type { OrganizationAccountManagerEventRow, OrganizationCounts, OrganizationDeletionRecords, OrganizationReader, OrganizationStatusEventRow, OrganizationView, SubOrganizationSummary } from "@studenthub/organizations";

/** Only public display fields for contexts belonging to the signed-in person. */
export interface WorkspaceContext {
  readonly orgId: string;
  readonly role: Role;
  readonly organizationName: string;
}

/** The selected organization as the active role may see it. */
export type ActiveOrganization =
  | { readonly kind: "found"; readonly view: OrganizationView }
  | { readonly kind: "not_applicable" }
  | { readonly kind: "unavailable" };

export type SubOrganizationsPanel =
  | { readonly kind: "found"; readonly subOrganizations: readonly SubOrganizationSummary[] }
  | { readonly kind: "unavailable" };

export type OrganizationCountsPanel =
  | { readonly kind: "found"; readonly counts: OrganizationCounts }
  | { readonly kind: "unavailable" };
export type OrganizationAccountManagerPanel={readonly displayName:string|null}|null|{readonly kind:"unavailable"};
export interface OrganizationAccountManagerReader{manager(principalId:string,orgId:string):Promise<{manager:{principalId:string;displayName:string|null}|null}|null>;history?(principalId:string,orgId:string):Promise<readonly OrganizationAccountManagerEventRow[]|null>}
export type OrganizationAccountManagerHistoryPanel=readonly OrganizationAccountManagerEventRow[]|{readonly kind:"unavailable";readonly length?:never};
export type OrganizationStatusHistoryPanel=readonly OrganizationStatusEventRow[]|{readonly kind:"unavailable";readonly length?:never};
export interface OrganizationStatusHistoryReader{history(principalId:string,orgId:string):Promise<readonly OrganizationStatusEventRow[]|null>}
export type OrganizationReaderWithAccountManagers=OrganizationReader&{readonly accountManagers?:OrganizationAccountManagerReader};

export type NavigationResult =
  | { readonly status: 200; readonly body: {
    readonly contexts: readonly WorkspaceContext[];
    readonly active: WorkspaceContext | null;
    readonly organization?: ActiveOrganization;
    readonly counts?: OrganizationCountsPanel;
    readonly subOrganizations?: SubOrganizationsPanel;
    readonly accountManager?: OrganizationAccountManagerPanel;
    readonly accountManagerHistory?: OrganizationAccountManagerHistoryPanel;
    readonly statusHistory?: OrganizationStatusHistoryPanel;
  } }
  | { readonly status: 400 | 401 | 403 | 503; readonly body: { readonly error: string } };

export interface ContextNavigation {
  open(sessionId: string | undefined, selection: URLSearchParams): Promise<NavigationResult>;
}

/** URL selections are preferences, never authority or a persistent role claim. */
export function createContextNavigation(
  sessions: Pick<SessionStore, "get">,
  store: AuthzStore,
  organizationReader?: OrganizationReaderWithAccountManagers,
  deletions?: OrganizationDeletionRecords,
  statusHistoryReader?: OrganizationStatusHistoryReader,
): ContextNavigation {
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
          if (deletions && await deletions.isDeleted(org.id)) {
            return { status: 403, body: { error: "context_forbidden" } };
          }
          active = { orgId: org.id, role: resolution.context.role, organizationName: org.name };
        }
        const effective = await listEffectiveContexts(identity, store);
        const organizations = new Map((await store.listOrganizations()).map((org) => [org.id, org]));
        const contexts: WorkspaceContext[] = [];
        for (const context of effective) {
          const org = organizations.get(context.orgId);
          if (org) contexts.push({ orgId: org.id, role: context.role, organizationName: org.name });
        }
        if (deletions && contexts.length > 0) {
          const deleted = await deletions.deletedAmong([...new Set(contexts.map((context) => context.orgId))]);
          for (let index = contexts.length - 1; index >= 0; index--) {
            if (deleted.has(contexts[index]!.orgId)) contexts.splice(index, 1);
          }
        }
        // Also reject a revocation observed while this request was being built.
        if (active && !contexts.some((c) => c.orgId === active.orgId && c.role === active.role)) {
          return { status: 403, body: { error: "context_forbidden" } };
        }
        contexts.sort((a, b) => a.organizationName.localeCompare(b.organizationName)
          || a.orgId.localeCompare(b.orgId) || a.role.localeCompare(b.role));
        if (!organizationReader || !active) return { status: 200, body: { contexts, active } };
        // The read model re-resolves the grant itself; the selection is never its authority.
        const read = await organizationReader.read({ principalId: session.personId, orgId: active.orgId, role: active.role });
        const organization: ActiveOrganization = read.kind === "found"
          ? { kind: "found", view: read.organization }
          : read.kind === "not_found" ? { kind: "not_applicable" } : { kind: "unavailable" };
        let counts: OrganizationCountsPanel | undefined;
        if (read.kind === "found" && active.role === "admin" && organizationReader.readCounts) {
          const tally = await organizationReader.readCounts({ principalId: session.personId, orgId: active.orgId, role: active.role });
          counts = tally.kind === "found"
            ? { kind: "found", counts: tally.counts }
            : tally.kind === "unavailable" ? { kind: "unavailable" } : undefined;
        }
        let panel: SubOrganizationsPanel | undefined;
        if (read.kind === "found" && read.organization.parentOrgId === null) {
          const children = await organizationReader.listSubOrganizations({
            principalId: session.personId, orgId: active.orgId, role: active.role,
          });
          panel = children.kind === "found"
            ? { kind: "found", subOrganizations: children.subOrganizations }
            : children.kind === "unavailable" ? { kind: "unavailable" } : undefined;
        }
        let accountManager:OrganizationAccountManagerPanel|undefined,accountManagerHistory:OrganizationAccountManagerHistoryPanel|undefined;
        const accountManagers=organizationReader.accountManagers;
        if(read.kind==="found"&&(active.role==="staff"||active.role==="admin")&&accountManagers){
          try { const result=await accountManagers.manager(session.personId,active.orgId); if(result)accountManager=result.manager?{displayName:result.manager.displayName}:null; }
          catch { accountManager={kind:"unavailable"}; }
          if(accountManagers.history)try { const history=await accountManagers.history(session.personId,active.orgId); if(history)accountManagerHistory=history.slice(0,5); }
          catch { accountManagerHistory={kind:"unavailable"}; }
        }
        let statusHistory:OrganizationStatusHistoryPanel|undefined;
        if(read.kind==="found"&&(active.role==="staff"||active.role==="admin")&&statusHistoryReader){
          try { const history=await statusHistoryReader.history(session.personId,active.orgId); if(history)statusHistory=history.slice(0,5); }
          catch { statusHistory={kind:"unavailable"}; }
        }
        const shownOrganization=accountManager!==undefined||accountManagerHistory!==undefined||statusHistory!==undefined?{...organization,...(accountManager!==undefined?{accountManager}:{}),...(accountManagerHistory!==undefined?{accountManagerHistory}:{}),...(statusHistory!==undefined?{statusHistory}:{})}:organization;
        return { status: 200, body: { contexts, active, organization:shownOrganization, ...(counts ? { counts } : {}), ...(panel ? { subOrganizations: panel } : {}),...(accountManager!==undefined?{accountManager}:{}),...(accountManagerHistory!==undefined?{accountManagerHistory}:{}),...(statusHistory!==undefined?{statusHistory}:{}) } };
      } catch {
        return { status: 503, body: { error: "context_unavailable" } };
      }
    },
  };
}
