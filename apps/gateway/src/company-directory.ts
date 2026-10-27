import type { AuthzStore } from "@studenthub/contracts";
import type { SessionStore } from "@studenthub/login-contract";
import type {
  OrganizationDirectory, OrganizationDirectoryFilters, OrganizationDirectoryResult, OrganizationStatus,
} from "@studenthub/organizations";
import type { WorkspaceContext } from "./context-navigation.js";
import type { OrganizationAccountManagerDirectoryStore } from "./organization-account-manager.js";

type FoundDirectory = Extract<OrganizationDirectoryResult, { kind: "found" }>["directory"];

export type CompanyDirectoryResult =
  | { readonly status: 200; readonly body: {
    readonly active: WorkspaceContext;
    readonly filters: OrganizationDirectoryFilters;
    readonly accountManagerSelection?: string;
    readonly accountManagerOptions?: readonly { readonly principalId: string; readonly displayName: string | null }[] | null;
    readonly directory: FoundDirectory;
  } }
  | { readonly status: 400 | 401 | 403 | 503; readonly body: { readonly error: string } };

export interface CompanyDirectoryPage {
  open(sessionId: string | undefined, query: URLSearchParams): Promise<CompanyDirectoryResult>;
}

const PARAMETERS = new Set(["org_id", "role", "q", "status", "approved", "currency", "manager", "page"]);
const STATUSES = new Set<string>(["active", "under_review", "inactive"]);

type Parsed =
  | { readonly ok: true; readonly orgId: string; readonly role: string; readonly filters: OrganizationDirectoryFilters; readonly page: number }
  | { readonly ok: false };

/**
 * Closed query vocabulary. The context pair is a preference the repository
 * re-resolves; filters arrive from a GET form, so empty fields mean "any".
 */
export function parseCompanyDirectoryQuery(query: URLSearchParams): Parsed {
  for (const key of new Set(query.keys())) {
    if (!PARAMETERS.has(key) || query.getAll(key).length !== 1) return { ok: false };
  }
  const orgId = query.get("org_id");
  const role = query.get("role");
  if (!orgId || !role) return { ok: false };
  const filters: { query?: string; status?: OrganizationStatus; approvedToHire?: boolean; currencyCode?: string; accountManager?: string } = {};
  const text = query.get("q")?.trim();
  if (text) {
    if (text.length > 100) return { ok: false };
    filters.query = text;
  }
  const status = query.get("status");
  if (status) {
    if (!STATUSES.has(status)) return { ok: false };
    filters.status = status as OrganizationStatus;
  }
  const approved = query.get("approved");
  if (approved) {
    if (approved !== "yes" && approved !== "no") return { ok: false };
    filters.approvedToHire = approved === "yes";
  }
  const currency = query.get("currency");
  if (currency) {
    if (!/^[A-Za-z]{3}$/.test(currency)) return { ok: false };
    filters.currencyCode = currency.toUpperCase();
  }
  const manager = query.get("manager");
  if (manager) {
    if (manager !== "me" && !/^[A-Za-z0-9._:-]{1,128}$/.test(manager)) return { ok: false };
    filters.accountManager = manager;
  }
  const page = query.get("page");
  if (page !== null && !/^[1-9]\d{0,5}$/.test(page)) return { ok: false };
  return { ok: true, orgId, role, filters: Object.freeze(filters), page: page === null ? 1 : Number(page) };
}

export function createCompanyDirectory(
  sessions: Pick<SessionStore, "get">,
  store: AuthzStore,
  directory: OrganizationDirectory,
  accountManagers?: Pick<OrganizationAccountManagerDirectoryStore, "directoryManagers">,
): CompanyDirectoryPage {
  return {
    async open(sessionId, query) {
      try {
        const session = sessionId ? await sessions.get(sessionId) : undefined;
        if (!session || !await store.getPrincipal(session.personId)) {
          return { status: 401, body: { error: "unauthorized" } };
        }
        const parsed = parseCompanyDirectoryQuery(query);
        if (!parsed.ok) return { status: 400, body: { error: "invalid_directory_query" } };
        // "me" always means the caller, so a principal whose id is exactly "me" cannot be named.
        const filters = parsed.filters.accountManager === "me" ? Object.freeze({ ...parsed.filters, accountManager: session.personId }) : parsed.filters;
        // The repository re-resolves the context and the coverage from current grants.
        const result = await directory.listOrganizations({
          principalId: session.personId, orgId: parsed.orgId, role: parsed.role, filters, page: parsed.page,
        });
        if (result.kind === "not_found") return { status: 403, body: { error: "context_forbidden" } };
        if (result.kind === "invalid") return { status: 400, body: { error: "invalid_directory_query" } };
        if (result.kind === "unavailable") return { status: 503, body: { error: "directory_unavailable" } };
        const org = await store.getOrganization(parsed.orgId);
        if (!org) return { status: 403, body: { error: "context_forbidden" } };
        let accountManagerOptions: readonly { readonly principalId:string;readonly displayName:string|null }[] | null | undefined;
        if (parsed.role === "staff" || parsed.role === "admin") {
          accountManagerOptions = null;
          if (accountManagers) try { accountManagerOptions = await accountManagers.directoryManagers(session.personId, parsed.orgId); }
          catch { accountManagerOptions = null; }
        }
        return { status: 200, body: {
          active: { orgId: org.id, role: parsed.role as WorkspaceContext["role"], organizationName: org.name },
          filters,
          ...(parsed.filters.accountManager ? { accountManagerSelection: parsed.filters.accountManager } : {}),
          ...(accountManagerOptions === undefined ? {} : { accountManagerOptions }),
          directory: result.directory,
        } };
      } catch {
        return { status: 503, body: { error: "directory_unavailable" } };
      }
    },
  };
}
