import type { ServerResponse } from "node:http";
import type { BrowserResponse, LoginApplication } from "@studenthub/login-contract";
import type { ContextNavigation, NavigationResult, OrganizationAccountManagerHistoryPanel, OrganizationAccountManagerOptionsPanel, OrganizationAccountManagerPanel, OrganizationCountsPanel, OrganizationStatusHistoryPanel, SubOrganizationsPanel, WorkspaceContext } from "./context-navigation.js";
import type { LanguagePreference } from "./language-preference.js";
import type { ProfileBrowserEdit, VerifiedProfileNotice } from "./profile-browser-edit-http.js";
import { PROFILE_COPY, type ProfileLanguage, type ProfileCopyKey } from "./ui/profile-copy.js";
import { profileNotice } from "./ui/profile-kit.js";
import type { ProfileEdit } from "./profile-edit-http.js";
import type { BankDetailsService } from "./bank-details.js";
import {
  OWN_PROFILE_FIELD_CONTRACT,
  OWN_PROFILE_FIELD_NAMES,
  OWN_PROFILE_VERSION,
  type OwnProfileFieldName,
  type OwnProfileProjection,
  type OwnProfileReader,
} from "@studenthub/profile";
import {
  ORGANIZATION_FIELD_CONTRACT,
  ORGANIZATION_FIELDS_BY_AUDIENCE,
  type OrganizationField,
  type OrganizationFieldName,
} from "@studenthub/organizations";
import type { ActiveOrganization } from "./context-navigation.js";
import type { CompanyDirectoryPage, CompanyDirectoryResult } from "./company-directory.js";
import type { AssignedCompaniesResult, OrganizationAccountManager } from "./organization-account-manager.js";
import type { ExportsHttp } from "./exports-http.js";
import { CONTRIBUTIONS, type Contributions } from "./contributions/index.js";
import type {NotificationPage} from "../../../packages/notifications/src/notifications.js";

/** Browser-only projection; the JSON login contract stays unchanged. */
export interface BrowserLoginApplication extends LoginApplication {
  readonly notifications?: import("./notifications-http.js").NotificationsHttp;
  readonly navigation?: ContextNavigation;
  readonly companies?: CompanyDirectoryPage;
  readonly exports?: ExportsHttp;
  readonly organizationAccountManager?: OrganizationAccountManager;
  /** SHU-84 safe write; absent unless a signing key is configured. */
  readonly preferences?: LanguagePreference;
  readonly profileEdit?: ProfileEdit;
  readonly browserEdit?: ProfileBrowserEdit;
  readonly bankDetails?: BankDetailsService;
  readonly web?: {
    readonly origin: string;
    readonly returnTo?: string;
    readonly profiles: OwnProfileReader;
  };
}

export function notificationBell(unread:number):string{return `<a class="nav-item" href="/notifications" aria-label="Notifications${unread?` (${unread} unread)`:""}">Notifications${unread?` <span class="badge">${unread}</span>`:""}</a>`}
export function renderNotifications(page:NotificationPage):string{const items=page.items.map(item=>`<li class="profile-card"><a href="${escapeHtml(item.href)}">${escapeHtml(item.text)}</a>${item.read?"":`<form method="post" action="/notifications/${escapeHtml(item.id)}/read"><button type="submit">Mark read</button></form>`}</li>`).join("");return workspaceDocument("Notifications",`<header class="topbar">${brand}${notificationBell(page.unreadCount)}<form action="/logout" method="post"><button class="sign-out" type="submit">Sign out</button></form></header><main id="main" class="profile-main"><h1>Notifications<span class="accent">.</span></h1><form method="post" action="/notifications/read-all"><button type="submit">Mark all read</button></form><ol>${items}</ol></main>`)}

/** HTML is opt-in. Missing, wildcard and JSON-preferred Accept keep the API. */
export function wantsHtml(accept: string | undefined): boolean {
  const qualities = new Map<string, number>();
  for (const part of accept?.toLowerCase().split(",") ?? []) {
    const [mime, ...parameters] = part.trim().split(";");
    const q = parameters.map((p) => p.trim()).find((p) => p.startsWith("q="));
    const quality = q === undefined ? 1 : Number(q.slice(2));
    if (mime && Number.isFinite(quality) && quality >= 0 && quality <= 1) {
      qualities.set(mime.trim(), Math.max(qualities.get(mime.trim()) ?? 0, quality));
    }
  }
  const html = qualities.get("text/html") ?? 0;
  return html > 0 && html > (qualities.get("application/json") ?? 0);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

const securityHeaders = {
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'",
  // `same-origin`, not `no-referrer`: under `no-referrer` browsers serialize the
  // Origin header of a same-origin form POST as the literal `null` (Fetch,
  // "append a request Origin header"), so the sign-out form could never satisfy
  // the /logout origin check. `same-origin` still sends no Referer when the
  // browser leaves for Universe, which is the property the header was for.
  "referrer-policy": "same-origin",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  "vary": "Accept",
};

export function writeHtml(response: ServerResponse, status: number, html: string,
  headers: Readonly<Record<string, string>> = {}, workspaceHistory = false): void {
  response.writeHead(status, { ...headers, ...securityHeaders,
    ...(workspaceHistory ? { "content-security-policy": `${securityHeaders["content-security-policy"]}; script-src 'self'` } : {}),
    "content-type": "text/html; charset=utf-8" });
  response.end(html);
}

const brand = `<a class="brand" href="/" aria-label="StudentHub home"><span class="brand-mark" aria-hidden="true">s</span>studenthub<span class="brand-dot" aria-hidden="true">.</span></a>`;

export function pageDocument(title: string, content: string, language?: ProfileLanguage, historyGuard = false): string {
  return document(title, content, historyGuard, language);
}

function document(title: string, content: string, workspaceHistory = false, language?: ProfileLanguage): string {
  const locale = language === undefined ? 'lang="en"' : `lang="${language}" dir="${language === "ar" ? "rtl" : "ltr"}"`;
  const skip = language === undefined ? "Skip to content" : PROFILE_COPY[language]["nav.skip"];
  return `<!doctype html><html ${locale}><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>${escapeHtml(title)} · StudentHub</title><link rel="stylesheet" href="/assets/studenthub.css">${workspaceHistory ? '<script src="/assets/workspace-history.js" defer></script>' : ""}</head><body><a class="skip" href="#main">${escapeHtml(skip)}</a>${content}</body></html>`;
}

// A back/forward-cache restoration may not issue a request even with no-store.
// Conceal the outgoing snapshot, then re-resolve grants before showing it again.
// This script never stores grants, chooses a context or authorizes an operation.
export const WORKSPACE_HISTORY_JS = `
addEventListener('pagehide', () => { document.documentElement.hidden = true; });
addEventListener('pageshow', event => {
  if (event.persisted) location.reload();
  else document.documentElement.hidden = false;
});
`;

function signIn(login?: BrowserLoginApplication): string {
  const returnTo = login?.web?.returnTo;
  if (!returnTo) return `<div class="notice" role="status"><strong>Sign-in is temporarily unavailable</strong><p>Please try again later.</p></div>`;
  // This URL is supplied by validated runtime configuration, never Host or a query.
  return `<a class="button primary" href="/login/universe?return_to=${escapeHtml(encodeURIComponent(returnTo))}">Continue with Universe <span aria-hidden="true">↗</span></a>`;
}

const roleNames: Record<WorkspaceContext["role"], string> = {
  candidate: "Candidate", staff: "Staff", admin: "Administrator",
  "org-owner": "Organization owner", recruiter: "Recruiter", finance: "Finance",
};

const workspaceDocument = (title: string, content: string) => document(title, content, true);

const organizationFormatters: Readonly<Partial<Record<OrganizationFieldName, (value: unknown) => string>>> = {
  status: (value) => ({ active: "Active", under_review: "Under review", inactive: "Inactive" })[String(value)] ?? String(value),
  statusOverride: (value) => ({ active: "Active", under_review: "Under review", inactive: "Inactive" })[String(value)] ?? String(value),
  approvedToHire: (value) => value ? "Yes" : "No",
  bonusCommission: (value) => `${String(value)}%`,
};

function organizationFieldText(name: OrganizationFieldName, field: OrganizationField<unknown>): string {
  if (field.state === "unavailable") return '<span class="missing" data-state="unavailable">Unavailable</span>';
  return escapeHtml((organizationFormatters[name] ?? String)(field.value));
}

/** Read-only company card for the selected workspace; fields come from the role's closed projection. */
function renderOrganization(organization: ActiveOrganization | undefined, accountManager?:OrganizationAccountManagerPanel, accountManagerHistory?:OrganizationAccountManagerHistoryPanel, statusHistory?:OrganizationStatusHistoryPanel, accountManagerOptions?:OrganizationAccountManagerOptionsPanel, orgId?:string): string {
  if (!organization || organization.kind === "not_applicable") return "";
  if (organization.kind === "unavailable") {
    return `<section class="notice org-notice" role="status"><strong>Company details couldn’t be loaded.</strong><p>Your workspace is still selected. Please try again in a moment.</p></section>`;
  }
  accountManager??=(organization as ActiveOrganization&{accountManager?:OrganizationAccountManagerPanel}).accountManager;
  accountManagerHistory??=(organization as ActiveOrganization&{accountManagerHistory?:OrganizationAccountManagerHistoryPanel}).accountManagerHistory;
  statusHistory??=(organization as ActiveOrganization&{statusHistory?:OrganizationStatusHistoryPanel}).statusHistory;
  const view = organization.view;
  const fields = view.fields as unknown as Readonly<Record<OrganizationFieldName, OrganizationField<unknown>>>;
  const legalName = fields.legalName;
  const heading = legalName.state === "available" ? String(legalName.value) : view.registryName;
  const managerRow=accountManager===undefined?"":`<div><dt>Account manager</dt><dd>${accountManager===null?"None":"kind" in accountManager?'<span class="missing" data-state="unavailable">Unavailable</span>':escapeHtml(accountManager.displayName??"Unnamed staff member")}</dd></div>`;
  const currentManager=accountManager&&!("kind" in accountManager)?accountManager:undefined;
  const selected=(value:string,current:string|undefined)=>value===current?' selected':'';
  const managerForm=accountManagerOptions===undefined?"":"kind" in accountManagerOptions?`<section class="notice org-notice" role="status"><strong>Account manager choices couldn’t be loaded.</strong><p>Please try again in a moment.</p></section>`:`<section aria-labelledby="assign-manager-title"><h3 id="assign-manager-title">Assign account manager</h3><form method="post" action="/workspace/account-manager/preview"><input type="hidden" name="orgId" value="${escapeHtml(orgId??"")}"><label>Account manager<select name="value"><option value="none"${selected("none",accountManager===null?"none":currentManager?.principalId)}>No account manager</option>${accountManagerOptions.map(person=>`<option value="${escapeHtml(person.principalId)}"${selected(person.principalId,currentManager?.principalId)}>${escapeHtml(person.displayName??"Unnamed staff member")}</option>`).join("")}</select></label><button class="button primary" type="submit">Review change</button></form></section>`;
  const historyPerson=(id:string|null,name:string|null,present:boolean)=>id===null?"None":present?(name??"Unnamed staff member"):"Removed staff member";
  const managerHistory=accountManagerHistory===undefined?"":"kind" in accountManagerHistory?`<section class="notice org-notice" role="status"><strong>Account manager history couldn’t be loaded.</strong><p>Please try again in a moment.</p></section>`:`<section aria-labelledby="manager-history-title"><h3 id="manager-history-title">Account manager history</h3>${accountManagerHistory.length?`<ol>${accountManagerHistory.slice(0,5).map(event=>`<li>${escapeHtml(historyPerson(event.from_principal_id,event.from_display_name,event.from_principal_exists))} → ${escapeHtml(historyPerson(event.to_principal_id,event.to_display_name,event.to_principal_exists))} <time datetime="${escapeHtml(new Date(event.occurred_at).toISOString())}">${escapeHtml(new Date(event.occurred_at).toISOString().slice(0,10))}</time></li>`).join("")}</ol>`:"<p>No account manager changes recorded.</p>"}</section>`;
  const statusText=(value:string|null)=>value===null?"Not set":organizationFormatters.status!(value);
  const statusChanges=statusHistory===undefined?"":"kind" in statusHistory?`<section class="notice org-notice" role="status"><strong>Status history couldn’t be loaded.</strong><p>Please try again in a moment.</p></section>`:`<section aria-labelledby="status-history-title"><h3 id="status-history-title">Status history</h3>${statusHistory.length?`<ol>${statusHistory.slice(0,5).map(event=>{const occurred=new Date(event.occurred_at).toISOString();return `<li>${escapeHtml(statusText(event.from_status))} → ${escapeHtml(statusText(event.to_status))} <time datetime="${escapeHtml(occurred)}">${escapeHtml(occurred.slice(0,10))}</time></li>`}).join("")}</ol>`:"<p>No status changes recorded.</p>"}</section>`;
  const rows = ORGANIZATION_FIELDS_BY_AUDIENCE[view.audience].map((name) =>
    `<div><dt>${escapeHtml(ORGANIZATION_FIELD_CONTRACT[name].label)}</dt><dd>${organizationFieldText(name, fields[name])}</dd></div>`).join("")+managerRow;
  const source = view.snapshot.kind === "imported"
    ? `StudentHub company snapshot · ${escapeHtml(view.snapshot.observedAt.slice(0, 10))}`
    : "Company details haven’t been imported yet, so they show as unavailable.";
  const kind = view.parentOrgId === null ? "ORGANIZATION" : "SUB-ORGANIZATION";
  return `<section class="profile-card org-card" aria-labelledby="org-title"><div class="identity"><div class="avatar" aria-hidden="true">${escapeHtml(Array.from(heading.trim())[0]?.toUpperCase() ?? "S")}</div><div><h2 id="org-title">${escapeHtml(heading)}</h2><p>${source}</p></div><span class="identity-label">${kind}</span></div><dl class="profile-fields">${rows}</dl>${managerForm}${managerHistory}${statusChanges}<div class="privacy-note"><span class="privacy-symbol" aria-hidden="true">↳</span><p>You see the company details your role allows. Licences, logos, sign-in data and internal notes are never shown here.</p></div></section>`;
}

function renderOrganizationCounts(panel: OrganizationCountsPanel | undefined): string {
  if (!panel) return "";
  if (panel.kind === "unavailable") {
    return `<section class="notice org-notice" role="status"><strong>Company counts couldn’t be loaded.</strong><p>Please try again in a moment.</p></section>`;
  }
  const stores = panel.counts.stores === null ? '<span class="missing" data-state="unavailable">Unavailable</span>' : String(panel.counts.stores);
  return `<section aria-labelledby="counts-title"><h2 id="counts-title">At a glance</h2><dl class="profile-fields"><div><dt>Stores</dt><dd>${stores}</dd></div><div><dt>Sub-companies</dt><dd>${panel.counts.subOrganizations}</dd></div></dl></section>`;
}

/** Native links preserve selections across refresh/back without storing authority. */
const DIRECTORY_ROLES: ReadonlySet<WorkspaceContext["role"]> = new Set(["staff", "admin"]);

/** Shown for a staff or admin context; the directory still re-resolves the grant on every request. */
function companiesLink(active: WorkspaceContext | null, login: BrowserLoginApplication, current = false): string {
  const assigned = myCompaniesLink(active, login);
  if (!active || !login.companies || !DIRECTORY_ROLES.has(active.role)) return assigned;
  const href = `/workspace/companies?${new URLSearchParams({ org_id: active.orgId, role: active.role })}`;
  return `<a class="nav-item${current ? " active" : ""}" href="${escapeHtml(href)}"${current ? ' aria-current="page"' : ""}>Companies</a>${assigned}`;
}

function myCompaniesLink(active: WorkspaceContext | BrowserLoginApplication | null, login?: BrowserLoginApplication, current = false): string {
  if (active && !("role" in active)) return "";
  if (!active || !login?.organizationAccountManager || !DIRECTORY_ROLES.has(active.role)) return "";
  const href = `/workspace/my-companies?${new URLSearchParams({ org_id: active.orgId, role: active.role })}`;
  return `<a class="nav-item${current ? " active" : ""}" href="${escapeHtml(href)}"${current ? ' aria-current="page"' : ""}>My companies</a>`;
}

/** Read-only projection of the account-manager route: names and company links only. */
export function renderAssignedCompanies(result: AssignedCompaniesResult, login: BrowserLoginApplication, active: WorkspaceContext): string {
  const context = String(new URLSearchParams({ org_id: active.orgId, role: active.role }));
  if (result.status === 401) return renderError(401, login);
  if (result.status !== 200) return workspaceDocument("My companies unavailable", `<header class="topbar">${brand}<a href="/workspace?${escapeHtml(context)}">Workspaces</a></header><main id="main" class="error-page"><h1>My companies couldn’t be loaded.</h1><p>Please try again in a moment.</p><a class="button primary" href="/workspace/my-companies?${escapeHtml(context)}">Try again</a></main>`);
  const links = result.body.companies.map(company => `<a class="context-option" href="/workspace?${escapeHtml(String(new URLSearchParams({org_id:company.orgId,role:active.role})))}"><span>${escapeHtml(company.name)}</span><span aria-hidden="true">→</span></a>`).join("");
  return workspaceDocument("My companies", `<header class="topbar">${brand}<form action="/logout" method="post"><button class="sign-out" type="submit">Sign out <span aria-hidden="true">↗</span></button></form></header><div class="workspace"><aside class="sidebar"><div class="eyebrow">YOUR WORKSPACE</div><nav aria-label="Workspace"><a class="nav-item" href="/profile">My profile</a><a class="nav-item" href="/workspace?${escapeHtml(context)}">Workspaces</a>${myCompaniesLink(active,login,true)}</nav><p class="sidebar-note">Read-only for now.</p></aside><main id="main" class="profile-main"><div class="profile-heading"><div><div class="eyebrow">ACCOUNT MANAGEMENT</div><h1>My companies<span class="accent">.</span></h1><p>Companies where you are the assigned account manager.</p></div><span class="badge">Read-only</span></div><section aria-labelledby="companies-title"><h2 id="companies-title">Assigned companies</h2>${links ? `<nav class="context-list" aria-label="Assigned companies">${links}</nav>` : '<p class="empty-contexts">No companies assigned.</p>'}</section><footer class="profile-footer">StudentHub · Connected by Universe</footer></main></div>`);
}

const statusNames: Readonly<Record<string, string>> = { active: "Active", under_review: "Under review", inactive: "Inactive" };

function renderSubOrganizations(panel: SubOrganizationsPanel | undefined, active: WorkspaceContext): string {
  if (!panel) return "";
  if (panel.kind === "unavailable") {
    return `<section class="notice org-notice" role="status"><strong>Sub-companies couldn’t be loaded.</strong><p>Please try again in a moment.</p></section>`;
  }
  const links = panel.subOrganizations.map((child) => {
    const href = `/workspace?${new URLSearchParams({ org_id: child.orgId, role: active.role })}`;
    const status = child.status.state === "available"
      ? escapeHtml(statusNames[child.status.value] ?? child.status.value)
      : '<span class="missing" data-state="unavailable">Unavailable</span>';
    return `<a class="context-option" href="${escapeHtml(href)}"><span>${escapeHtml(child.registryName)}</span><strong>${status}</strong></a>`;
  }).join("");
  return `<section aria-labelledby="sub-title"><h2 id="sub-title">Sub-companies</h2>${links
    ? `<nav class="context-list">${links}</nav>`
    : '<p class="empty-contexts">No sub-companies you can open.</p>'}</section>`;
}

/** Staff and admin company list. Every value comes from the directory's closed entry. */
export function renderCompanyDirectory(result: CompanyDirectoryResult, login: BrowserLoginApplication): string {
  if (result.status !== 200) {
    if (result.status === 401 || result.status === 503) return renderError(result.status, login);
    const message = result.status === 400
      ? "That search isn’t valid. Clear the filters and try again."
      : "Your access may have changed. Choose one of your current workspaces to continue.";
    return workspaceDocument("Companies unavailable", `<header class="topbar">${brand}<a href="/workspace">Workspaces</a></header><main id="main" class="error-page"><h1>This company list isn’t available.</h1><p>${message}</p><a class="button primary" href="/workspace">Choose a workspace</a></main>`);
  }
  const { active, filters, directory, accountManagerSelection, accountManagerOptions } = result.body;
  const context = { org_id: active.orgId, role: active.role };
  const query: Record<string, string> = { ...context,
    ...(filters.query ? { q: filters.query } : {}),
    ...(filters.status ? { status: filters.status } : {}),
    ...(filters.approvedToHire === undefined ? {} : { approved: filters.approvedToHire ? "yes" : "no" }),
    ...(filters.currencyCode ? { currency: filters.currencyCode } : {}),
    ...(accountManagerSelection ? { manager: accountManagerSelection } : {}) };
  const cell = (field: { readonly state: string; readonly value?: unknown }, format: (value: unknown) => string = String) =>
    field.state === "available" ? escapeHtml(format(field.value)) : '<span class="missing" data-state="unavailable">Unavailable</span>';
  const rows = directory.entries.map((entry) => {
    const name = entry.legalName.state === "available" ? entry.legalName.value : entry.registryName;
    const common = entry.commonNameEn.state === "available" && entry.commonNameEn.value !== name
      ? `<span class="field-meta">${escapeHtml(entry.commonNameEn.value)}</span>` : "";
    const href = `/workspace?${new URLSearchParams({ org_id: entry.orgId, role: active.role })}`;
    const manager=(entry as typeof entry&{accountManager?:{displayName:string|null}|null}).accountManager;
    const managerName=manager===undefined?"Unavailable":manager===null?"None":manager.displayName??"Unnamed staff member";
    return `<tr><th scope="row"><a href="${escapeHtml(href)}">${escapeHtml(name)}</a>${common}</th><td>${cell(entry.status, (value) => statusNames[String(value)] ?? String(value))}</td><td>${cell(entry.approvedToHire, (value) => value ? "Yes" : "No")}</td><td>${cell(entry.currencyCode)}</td><td>${entry.subOrganizationCount}</td><td>${entry.storeCount === null ? '<span class="missing" data-state="unavailable">Unavailable</span>' : entry.storeCount}</td><td>${escapeHtml(managerName)}</td></tr>`;
  }).join("");
  const first = directory.total === 0 ? 0 : (directory.page - 1) * directory.pageSize + 1;
  const last = (directory.page - 1) * directory.pageSize + directory.entries.length;
  const pageLink = (page: number, label: string, rel: string) =>
    `<a class="text-link" rel="${rel}" href="/workspace/companies?${escapeHtml(String(new URLSearchParams({ ...query, page: String(page) })))}">${label}</a>`;
  const pager = [
    directory.page > 1 ? pageLink(directory.page - 1, "← Previous", "prev") : "",
    last < directory.total ? pageLink(directory.page + 1, "Next →", "next") : "",
  ].join("");
  const option = (value: string, label: string, selected: string | undefined) =>
    `<option value="${escapeHtml(value)}"${selected === value ? " selected" : ""}>${escapeHtml(label)}</option>`;
  const approved = filters.approvedToHire === undefined ? undefined : filters.approvedToHire ? "yes" : "no";
  const managerFilter=accountManagerOptions===undefined?"":`<label>Account manager<select name="manager">${option("","Any",accountManagerSelection)}${option("me","Me",accountManagerSelection)}${accountManagerOptions?.map(person=>option(person.principalId,person.displayName??"Unnamed staff member",accountManagerSelection)).join("")??""}${accountManagerSelection&&accountManagerSelection!=="me"&&!accountManagerOptions?.some(person=>person.principalId===accountManagerSelection)?option(accountManagerSelection,"Selected account manager",accountManagerSelection):""}</select></label>`;
  const form = `<form class="directory-filters" method="get" action="/workspace/companies" role="search"><input type="hidden" name="org_id" value="${escapeHtml(active.orgId)}"><input type="hidden" name="role" value="${escapeHtml(active.role)}"><label>Search<input type="search" name="q" maxlength="100" value="${escapeHtml(filters.query ?? "")}" placeholder="Name in English or Arabic"></label><label>Status<select name="status">${option("", "Any status", filters.status ?? "")}${option("active", "Active", filters.status)}${option("under_review", "Under review", filters.status)}${option("inactive", "Inactive", filters.status)}</select></label><label>Approved to hire<select name="approved">${option("", "Any", approved ?? "")}${option("yes", "Yes", approved)}${option("no", "No", approved)}</select></label><label>Currency<input name="currency" maxlength="3" pattern="[A-Z]{3}" value="${escapeHtml(filters.currencyCode ?? "")}" placeholder="Any" size="5"></label>${managerFilter}<button class="sign-out" type="submit">Search</button></form><form method="post" action="/exports/company-directory?${escapeHtml(String(new URLSearchParams(query)))}"><button class="button" type="submit">Export</button></form>`;
  const table = directory.entries.length
    ? `<div class="directory-table"><table><caption>Companies ${first}–${last} of ${directory.total}</caption><thead><tr><th scope="col">Company</th><th scope="col">Status</th><th scope="col">Approved to hire</th><th scope="col">Currency</th><th scope="col">Sub-companies</th><th scope="col">Stores</th><th scope="col">Account manager</th></tr></thead><tbody>${rows}</tbody></table></div>`
    : `<p class="empty-contexts" role="status">${directory.total === 0 ? "No companies match these filters." : "There are no more companies on this page."}</p>`;
  return workspaceDocument("Companies", `<header class="topbar">${brand}<form action="/logout" method="post"><button class="sign-out" type="submit">Sign out <span aria-hidden="true">↗</span></button></form></header><div class="workspace"><aside class="sidebar"><div class="eyebrow">YOUR WORKSPACE</div><nav aria-label="Workspace"><a class="nav-item" href="/profile">My profile</a><a class="nav-item" href="/workspace?${escapeHtml(String(new URLSearchParams(context)))}">Workspaces</a>${companiesLink(active, login, true)}${myCompaniesLink(login)}</nav><p class="sidebar-note">Read-only for now.<br>Changes still happen in the current StudentHub.</p></aside><main id="main" class="profile-main"><div class="profile-heading"><div><div class="eyebrow">${escapeHtml(active.organizationName)} · ${roleNames[active.role].toUpperCase()}</div><h1>Companies<span class="accent">.</span></h1><p>Top-level companies your role covers. Open one to see its details and sub-companies.</p></div><span class="badge">Read-only</span></div>${form}${table}${pager ? `<nav class="pager" aria-label="Pages">${pager}</nav>` : ""}<section class="next-note"><div class="eyebrow">ABOUT THIS LIST</div><h2>Unavailable means we don’t have an approved value.</h2><p>Filters only match approved values. A company whose status or currency hasn’t been imported never matches a status or currency filter.</p></section><footer class="profile-footer">StudentHub · Connected by Universe</footer></main></div>`);
}

export function renderWorkspace(result: NavigationResult, login: BrowserLoginApplication, documentsAvailable = false): string {
  if (result.status !== 200) {
    if (result.status !== 403 && result.status !== 400) return renderError(result.status, login);
    return workspaceDocument("Workspace unavailable", `<header class="topbar">${brand}<a href="/profile">My profile</a></header><main id="main" class="error-page"><h1>This workspace isn’t available.</h1><p>Your access may have changed. Choose one of your current workspaces to continue.</p><a class="button primary" href="/workspace">Choose a workspace</a></main>`);
  }
  const { contexts, active } = result.body;
  const links = contexts.map((context) => {
    const current = active?.orgId === context.orgId && active.role === context.role;
    const href = `/workspace?${new URLSearchParams({ org_id: context.orgId, role: context.role })}`;
    return `<a class="context-option${current ? " active" : ""}" href="${escapeHtml(href)}"${current ? ' aria-current="page"' : ""}><span>${escapeHtml(context.organizationName)}</span><strong>${roleNames[context.role]}</strong><span aria-hidden="true">→</span></a>`;
  }).join("");
  const title = active ? `${roleNames[active.role]} workspace` : "Your workspaces";
  const intro = active
    ? `You’re viewing StudentHub as ${escapeHtml(roleNames[active.role].toLowerCase())} at ${escapeHtml(active.organizationName)}.`
    : "Choose the organization and role you want to use. You can switch without signing in again.";
  return workspaceDocument(title, `<header class="topbar">${brand}<form action="/logout" method="post"><button class="sign-out" type="submit">Sign out <span aria-hidden="true">↗</span></button></form></header><div class="workspace"><aside class="sidebar"><div class="eyebrow">YOUR WORKSPACE</div><nav aria-label="Workspace"><a class="nav-item" href="/profile">My profile</a>${documentsAvailable ? '<a class="nav-item" href="/profile/documents">My documents</a>' : ""}<a class="nav-item active" href="/workspace"${active ? "" : ' aria-current="page"'}>Workspaces</a>${companiesLink(active, login)}${myCompaniesLink(login)}</nav><p class="sidebar-note">One Universe account.<br>Switch between your roles.</p></aside><main id="main" class="profile-main"><div class="profile-heading"><div><div class="eyebrow">ONE ACCOUNT, EVERY ROLE</div><h1>${escapeHtml(title)}<span class="accent">.</span></h1><p>${intro}</p></div></div>${active ? `<section class="notice context-notice"><strong>${escapeHtml(active.organizationName)} · ${roleNames[active.role]}</strong><p>This workspace is selected. Applications, scheduling and other work tools will appear here as they become available.</p></section>${renderOrganization(result.body.organization,result.body.accountManager,result.body.accountManagerHistory,result.body.statusHistory,result.body.accountManagerOptions,active.orgId)}${renderOrganizationCounts(result.body.counts)}${renderSubOrganizations(result.body.subOrganizations, active)}` : ""}<section aria-labelledby="context-title"><h2 id="context-title">${contexts.length ? (active ? "Switch workspace" : "Choose a workspace") : "No workspaces assigned"}</h2>${contexts.length ? `<nav class="context-list" aria-label="Available roles and organizations">${links}</nav>` : '<p class="empty-contexts">Your personal profile is available. An organization will appear here when you’re given access.</p><a class="text-link" href="/profile">Open my profile →</a>'}</section><footer class="profile-footer">StudentHub · Connected by Universe</footer></main></div>`);
}

export function renderLanding(login?: BrowserLoginApplication): string {
  return document("Welcome", `<div class="entry"><header class="entry-header">${brand}<span class="eyebrow">YOUR STUDENTHUB</span></header><main id="main" class="entry-grid"><section class="intro"><div class="eyebrow">ONE ACCOUNT. YOUR NEXT CHAPTER.</div><h1>Good to<br>have you here<span class="accent">.</span></h1><p class="intro-copy">Your profile. Your possibilities.<br>One place to be yourself.</p><div class="intro-foot"><span class="line"></span><span>Connected through BAWES Universe</span></div></section><section class="sign-in" aria-labelledby="welcome"><div class="section-number" aria-hidden="true">01 / WELCOME</div><h2 id="welcome">Make yourself<br>at home.</h2><p>Use your Universe account to open your StudentHub profile.</p>${signIn(login)}<p class="small">Already signed in?</p><a class="text-link" href="/profile">Open my profile <span aria-hidden="true">→</span></a><div class="sign-in-note"><strong>One person. One account.</strong><p>You don’t need a separate login for each role.</p></div></section></main><footer class="entry-footer"><span>StudentHub · Connected by Universe</span><span>Profile access is read-only for now.</span></footer></div>`);
}

export function renderError(status: number, login?: BrowserLoginApplication): string {
  const [title, message] = status === 401
    ? ["Let’s get you signed in.", "Sign in to view your profile. If you were already here, your session may have ended."]
    : status === 503
      ? ["We couldn’t load that just now.", "Your profile hasn’t been changed. Please try again in a moment."]
      : status === 404
        ? ["This profile isn’t available.", "You can only open a profile you have access to."]
        : ["We couldn’t complete that request.", "Start again from StudentHub. Your private account details haven’t been displayed."];
  return document("Account access", `<header class="topbar">${brand}<a class="text-link" href="/">Back to StudentHub</a></header><main id="main" class="error-page"><div class="eyebrow">STUDENTHUB ACCOUNT</div><h1>${title}</h1><p>${message}</p>${status === 401 ? signIn(login) : '<a class="button primary" href="/profile">Try my profile again <span aria-hidden="true">→</span></a>'}</main>`);
}

function projectionFrom(result: BrowserResponse): OwnProfileProjection {
  const projection = result.body as Partial<OwnProfileProjection> | undefined;
  if (!projection || projection.version !== OWN_PROFILE_VERSION || typeof projection.fields !== "object"
    || projection.fields === null || Array.isArray(projection.fields)) {
    throw new Error("invalid authorized profile");
  }
  const keys = Object.keys(projection.fields);
  if (keys.some(key => !OWN_PROFILE_FIELD_NAMES.includes(key as OwnProfileFieldName) && key !== "phone" && key !== "handle" && key !== "kuwaitiMother")
    || OWN_PROFILE_FIELD_NAMES.some((name) => !Object.hasOwn(projection.fields!, name))) {
    throw new Error("invalid authorized profile");
  }
  return projection as OwnProfileProjection;
}

export async function profileDocument(result: BrowserResponse, login: Partial<BrowserLoginApplication>, verifiedNotice?: VerifiedProfileNotice, documentsAvailable = false, contributions: Contributions = CONTRIBUTIONS): Promise<{ status: number; html: string }> {
  if (result.status !== 200) return { status: result.status, html: renderError(result.status, login as BrowserLoginApplication) };
  const profile = projectionFrom(result);
  const language: ProfileLanguage = profile.fields.language.state === "available" && profile.fields.language.value === "ar" ? "ar" : "en";
  const text = (key: ProfileCopyKey, params: Readonly<Record<string, string | number>> = {}): string => PROFILE_COPY[language][key].replace(/\{([A-Za-z]+)\}/g, (_, name: string) => String(params[name] ?? ""));
  const copy = (key: ProfileCopyKey, params?: Readonly<Record<string, string | number>>) => escapeHtml(text(key, params));
  type Key = OwnProfileFieldName | "phone" | "handle" | "kuwaitiMother";
  const label = (key: Key) => text(`field.${key}`);
  const editable = new Set<Key>(["displayName", "arabicName", "objective", "intro", "preferredTime", "gender", "birthDate", "drivingLicence", "jobSearchStatus", "phone", "handle", "nationality", "university"]);
  const loaded = login.profileEdit?.choices ? await login.profileEdit.choices() : undefined;
  const originChoices = { countries: Array.isArray(loaded?.countries) ? loaded.countries : [], universities: Array.isArray(loaded?.universities) ? loaded.universities : [] };
  const nationalityId = profile.fields.nationality.state === "available" ? profile.fields.nationality.editValue : undefined;
  const nationalityIsKuwaiti = originChoices.countries.some(item => item.id === nationalityId && item.code === "KW");
  const nationalityAllowsMother = originChoices.countries.some(item => item.id === nationalityId && item.code !== "KW");
  if (nationalityAllowsMother && !nationalityIsKuwaiti) editable.add("kuwaitiMother");
  const hasWrites = Object.values(profile.fields).some(field => field.freshness.kind === "written_by_person");
  const date = (value: string) => /^\d{4}-\d{2}-\d{2}$/.test(value.slice(0,10)) && Number.isFinite(Date.parse(value.slice(0,10)))
    ? new Intl.DateTimeFormat(language === "ar" ? "ar-KW" : "en-GB", {day:"numeric",month:"short",year:"numeric",timeZone:"UTC"}).format(new Date(value.slice(0,10))) : value;
  const formatted = (key: Key): string => {
    const field = profile.fields[key];
    if ((key === "isProfileCompleted" || key === "pendingFields") && hasWrites) return text("profile.checkedLater");
    if (!field || field.state !== "available") return text(field?.freshness.kind === "written_by_person" || !field ? "value.missing" : "value.unavailable");
    const value = field.value;
    if (key === "gender") return text(({male:"value.male",female:"value.female",other:"value.other"} as const)[String(value) as "male" | "female" | "other"] ?? "value.unavailable");
    if (key === "jobSearchStatus") return text(({not_looking:"value.notLooking",active:"value.active",open_to_offers:"value.open"} as const)[String(value) as "not_looking" | "active" | "open_to_offers"] ?? "value.unavailable");
    if (key === "drivingLicence" || key === "committed" || key === "kuwaitiMother") return text(value ? "value.yes" : "value.no");
    if (key === "isProfileCompleted") return text(value ? "value.complete" : "value.incomplete");
    if (key === "civilExpired") return text(value ? "value.expired" : "value.notExpired");
    if (key === "language") return text(value === "ar" ? "value.arabic" : "value.english");
    if (key === "age") return text("value.years", {count: String(value)});
    if (key === "birthDate") return date(String(value));
    if (key === "pendingFields") return Array.isArray(value) && value.length ? value.map(v => text(`pending.${v}` as ProfileCopyKey)).join(language === "ar" ? "، " : ", ") : text("value.none");
    if (key === "phone" && /^\+965[0-9]{8}$/.test(String(value))) return `${String(value).slice(0,4)} ${String(value).slice(4,8)} ${String(value).slice(8)}`;
    return String(value);
  };
  const valueHtml = (key: Key): string => {
    const field = profile.fields[key];
    return `<bdi class="p-value" dir="${key === "phone" || key === "handle" || key === "employeeIdentifier" ? "ltr" : "auto"}"${field?.state === "unavailable" ? ' data-state="unavailable"' : ""}>${escapeHtml(formatted(key))}</bdi>`;
  };
  const editLink = (field: Key, fieldLabel: string) => `<a class="p-edit" href="/profile/edit/${field}" aria-label="${copy("action.editField", {field:fieldLabel})}">${copy("action.edit")}</a>`;
  // Keep the existing preview/confirm protocol usable when browser single-Save is absent.
  const legacyForm = (key: Key): string => {
    if (!login.profileEdit || !editable.has(key)) return "";
    const field = profile.fields[key], value = field?.state === "available" ? String(field.editValue ?? field.value) : "";
    const choices = key === "gender" ? [["male",text("value.male")],["female",text("value.female")],["other",text("value.other")]] : key === "drivingLicence" || key === "kuwaitiMother" ? [["true",text("value.yes")],["false",text("value.no")]] : key === "jobSearchStatus" ? [["not_looking",text("value.notLooking")],["active",text("value.active")],["open_to_offers",text("value.open")]] : undefined;
    const control = choices ? `<fieldset><legend>${escapeHtml(label(key))}</legend>${choices.map(([code,name]) => `<label><input type="radio" name="value" value="${code}" required${value === code ? " checked" : ""}>${escapeHtml(name!)}</label>`).join("")}</fieldset>`
      : key === "nationality" || key === "university" ? `<label>${escapeHtml(label(key))}<select name="value" data-origin-field="${key}"><option value="">${copy(key === "university" ? "value.none" : "value.missing")}</option>${key === "university" ? `<option value="">${copy("value.notListed")}</option>` : ""}${(key === "nationality" ? originChoices.countries : originChoices.universities).map(item => `<option value="${escapeHtml(item.id)}"${value === item.id ? " selected" : ""}>${escapeHtml(item.name)}</option>`).join("")}</select></label>${key === "university" ? `<small>${copy("help.university")}</small>` : ""}`
      : `<label>${escapeHtml(label(key))}${key === "intro" ? `<textarea name="value">${escapeHtml(value)}</textarea>` : `<input type="${key === "birthDate" ? "date" : key === "phone" ? "tel" : "text"}" name="value" value="${escapeHtml(value)}"${key === "handle" ? ' maxlength="30"' : key === "phone" ? ' maxlength="32"' : ""}>`}</label>`;
    return `<form method="post" action="/profile/edit/preview" aria-label="${copy("profile.changeField",{field:label(key)})}"><input type="hidden" name="field" value="${key}">${control}<button class="p-button" type="submit">${copy("action.review")}</button></form>`;
  };
  const row = (key: Key): string => `<div id="field-${key}" class="p-row" tabindex="-1"${key === "kuwaitiMother" ? ' data-origin-field="kuwaitiMother"' : ""}><dt>${escapeHtml(label(key))}</dt><dd>${valueHtml(key)}${editable.has(key) ? login.browserEdit ? `<div class="p-row-actions">${editLink(key,label(key))}</div>` : login.profileEdit ? legacyForm(key) : `<p class="p-meta">${copy("meta.readOnly")}</p>` : key === "language" && login.preferences ? `<a class="p-edit" href="#profile-language">${copy("profile.changeLanguage")}</a>` : `<p class="p-meta">${copy("meta.readOnly")}</p>`}</dd></div>`;
  const section = (key: "work" | "personal" | "background", fields: readonly Key[], extra = "") => `<section id="section-${key}" class="p-card" aria-labelledby="${key}-heading"><h2 id="${key}-heading">${copy(`section.${key}`)}</h2>${extra}<dl class="p-fields">${fields.map(row).join("")}${contributions.profileRows.filter(item => item.section === key).map(item => item.render(language, copy)).join("")}</dl></section>`;
  const displayName = profile.fields.displayName, name = displayName.state === "available" ? displayName.value : text("title.fallback");
  const initial = Array.from(name.trim())[0]?.toUpperCase() ?? "S";
  const languageForm = login.preferences ? `<form class="p-language" method="post" action="/profile/language/preview"><label for="profile-language">${copy("profile.changeLanguage")}</label><select id="profile-language" name="language"><option value="en"${language === "en" ? " selected" : ""}>English</option><option value="ar"${language === "ar" ? " selected" : ""}>العربية</option></select><button class="p-button" type="submit">${copy("action.review")}</button></form>` : "";
  const provenanceKeys: Key[] = [...OWN_PROFILE_FIELD_NAMES,...(["phone","handle","kuwaitiMother"] as const).filter(key => profile.fields[key])];
  const provenance = `<details class="p-provenance"><summary>${copy("profile.sources")}</summary><dl>${provenanceKeys.map(key => { const field = profile.fields[key]!; return `<div><dt>${escapeHtml(label(key))}</dt><dd>${copy(field.freshness.kind === "written_by_person" ? "meta.updated" : field.freshness.kind === "not_imported" ? "meta.notImported" : field.freshness.observedAt ? "meta.imported" : "meta.importedUndated",{date:date(field.freshness.observedAt ?? "")})}</dd></div>`; }).join("")}</dl></details>`;
  const summary = `<section id="profile-summary" class="p-card p-identity" aria-labelledby="profile-name"><div class="p-monogram" aria-hidden="true">${escapeHtml(initial)}</div><div class="p-identity-text"><p class="p-kicker">${copy("profile.account")}</p><h2 id="profile-name"><bdi dir="auto">${escapeHtml(name)}</bdi></h2>${profile.fields.arabicName.state === "available" ? `<p lang="ar"><bdi dir="auto">${escapeHtml(profile.fields.arabicName.value)}</bdi></p>` : ""}${profile.fields.objective.state === "available" ? `<p class="p-lead"><bdi dir="auto">${escapeHtml(profile.fields.objective.value)}</bdi></p>` : ""}</div><dl class="p-status">${row("jobSearchStatus")}</dl></section>`;
  const navigation = `<nav class="p-nav" aria-label="${copy("nav.main")}">${contributions.navigation.filter(item => item.visible(login)).map(item => `<a href="${item.href}"${item.current ? ' aria-current="page"' : ""}>${copy(item.labelKey)}</a>${item.key === "profile" && documentsAvailable ? `<a href="/profile/documents">${language === "ar" ? "مستنداتي" : "My documents"}</a>` : ""}`).join("")}</nav>`;
  const sections = `<nav class="p-sections" aria-label="${copy("nav.sections")}">${(["work","personal","background","details"] as const).map(key => `<a href="#section-${key}">${copy(`section.${key}`)}</a>`).join("")}</nav>`;
  const details = `<details id="section-details" class="p-card p-details"><summary>${copy("section.details")}</summary><p class="p-hint">${copy("profile.detailsHint")}</p><dl class="p-fields">${(["committed","isProfileCompleted","pendingFields","employeeIdentifier","civilExpired","language"] as const).map(row).join("")}${contributions.profileRows.filter(item => item.section === "details").map(item => item.render(language, copy)).join("")}</dl>${provenance}</details>`;
  const localBrand = brand.replace('aria-label="StudentHub home"', `aria-label="${copy("profile.home")}"`);
  const html = `<div class="profile-ui p-journey"><header class="p-topbar">${localBrand}<div class="p-header-actions">${languageForm}<form action="/logout" method="post"><button class="p-button" type="submit">${copy("action.signOut")}</button></form></div></header><div class="p-layout"><aside class="p-rail">${navigation}<p class="p-meta">StudentHub · ${copy("profile.connected")}</p></aside><main id="main" class="p-main p-stack"><header class="p-header"><h1 id="profile-heading">${copy("nav.profile")}</h1><p class="p-hint">${copy("profile.intro")}</p></header>${verifiedNotice ? profileNotice(verifiedNotice.title,verifiedNotice.message).html : ""}${summary}${sections}${section("work",["objective","intro","preferredTime"])}${section("personal",["displayName","arabicName","phone","handle","gender","birthDate","age","nationality",...(profile.fields.kuwaitiMother || nationalityAllowsMother ? ["kuwaitiMother" as const] : []),"area","drivingLicence"])}${section("background",["university"],`<p class="p-hint">${copy("profile.backgroundHint")}</p><a class="p-background-link" href="/profile/background">${copy("action.background")} <span aria-hidden="true">${language === "ar" ? "←" : "→"}</span></a>`)}${details}<section class="p-guide"><p>${copy("profile.missingHint")}</p>${login.browserEdit ? `<p>${copy("profile.editHint")}</p>` : ""}<p>${copy("help.privacy")}</p><p>${copy("help.language")}</p></section><footer class="p-footer">StudentHub · ${copy("profile.connected")}</footer></main></div></div>`;
  return {status:200,html:pageDocument(text("nav.profile"),html,language)};
}

export const WEB_CSS = `
:root{font-family:Inter,ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#172433;background:#f7f9fc;font-synthesis:none;line-height:1.5;font-size:16px;--blue:#2256e8;--muted:#566579;--border:#dfe5ef}
*{box-sizing:border-box}body{margin:0}a{color:inherit}button{font:inherit}a,button{-webkit-tap-highlight-color:transparent}a:focus-visible,button:focus-visible{outline:3px solid #a74400;outline-offset:5px}p,h1,h2{margin:0}p{color:var(--muted)}button,a{touch-action:manipulation}.skip{position:absolute;left:1rem;top:-8rem;background:white;padding:1rem;z-index:5}.skip:focus{top:1rem}.brand{display:inline-flex;align-items:center;text-decoration:none;font-weight:800;font-size:1.6rem;letter-spacing:-.07em;white-space:nowrap}.brand-mark{display:grid;place-items:center;width:2.25rem;height:2.25rem;background:var(--blue);color:white;border-radius:.65rem;margin-right:.65rem;font-size:1.8rem;line-height:1;letter-spacing:0}.brand-dot,.accent{color:var(--blue)}.eyebrow{font-size:.75rem;letter-spacing:.12em;font-weight:750;color:#4e6075}.entry{max-width:1440px;margin:auto;padding:0 5.5vw;min-height:100svh;display:flex;flex-direction:column}.entry-header{display:flex;align-items:center;justify-content:space-between;padding:2rem 0;border-bottom:1px solid var(--border);gap:1rem}.entry-grid{display:grid;grid-template-columns:1.2fr 1fr;gap:7vw;align-items:center;flex:1;padding:4rem 0}.intro h1{font-size:clamp(3rem,5.7vw,5.5rem);line-height:1.05;letter-spacing:-.065em;margin:1.5rem 0 1.75rem;font-weight:750}.intro-copy{font-size:1.25rem;line-height:1.7}.intro-foot{display:flex;align-items:center;gap:1rem;margin-top:3rem;font-size:.875rem;color:var(--muted)}.line{height:2px;width:2rem;background:var(--blue)}.sign-in{background:white;border:1px solid var(--border);border-radius:1.5rem;padding:clamp(1.5rem,4vw,3.5rem);box-shadow:0 18px 60px #182b4b08;max-width:33rem;width:100%}.section-number{font-family:ui-monospace,monospace;font-size:.75rem;letter-spacing:.12em;color:var(--blue);margin-bottom:2rem}.sign-in h2{font-size:2.25rem;line-height:1.15;letter-spacing:-.045em;margin-bottom:1rem}.sign-in>p{margin-bottom:1.5rem}.button{min-height:3.4rem;display:flex;justify-content:space-between;align-items:center;gap:1.5rem;padding:.95rem 1.25rem;border-radius:.65rem;text-decoration:none;font-weight:650}.primary{background:var(--blue);color:white}.primary:hover{background:#1641be}.button span{font-size:1.4rem}.sign-in .small{font-size:.875rem;margin:1.5rem 0 .2rem}.text-link{font-weight:650;font-size:.9375rem;text-underline-offset:4px}.sign-in-note{margin-top:2rem;padding-top:1.5rem;border-top:1px solid var(--border);font-size:.875rem}.sign-in-note p{margin-top:.3rem}.entry-footer{display:flex;justify-content:space-between;gap:1rem;padding:1.5rem 0;border-top:1px solid var(--border);font-size:.8125rem;color:var(--muted)}.notice{padding:1rem;border:1px solid #ccd7ea;border-radius:.65rem;background:#f7f9ff}.notice p{margin-top:.35rem}.topbar{background:white;border-bottom:1px solid var(--border);min-height:5.5rem;padding:1.4rem 4vw;display:flex;align-items:center;justify-content:space-between;gap:1.5rem}.sign-out{border:1px solid var(--border);border-radius:.6rem;background:white;padding:.65rem 1rem;min-height:2.75rem;cursor:pointer;color:#253e5a;font-size:.9375rem}.sign-out:hover{background:#f0f4fc}.workspace{max-width:1440px;margin:auto;display:grid;grid-template-columns:15rem minmax(0,1fr);min-height:calc(100svh - 5.5rem)}.sidebar{padding:2.5rem 1.75rem;border-right:1px solid var(--border);display:flex;flex-direction:column}.sidebar nav{margin-top:1.5rem}.nav-item{display:flex;align-items:center;gap:.75rem;text-decoration:none;font-weight:650;font-size:.9375rem;padding:.85rem 1rem;border-radius:.65rem}.active{background:#e8eeff;color:#1d46b8}.sidebar-note{font-size:.8125rem;line-height:1.7;margin-top:auto;padding-top:3rem}.profile-main{max-width:1050px;width:100%;padding:3rem clamp(1.25rem,5vw,5rem)}.profile-heading{display:flex;align-items:center;justify-content:space-between;gap:1rem;margin-bottom:2.25rem}.profile-heading h1{font-size:clamp(2.5rem,4vw,3.5rem);letter-spacing:-.065em;line-height:1.2;margin:.4rem 0 .6rem}.badge{font-size:.8125rem;border:1px solid #cbd5e4;border-radius:2rem;padding:.4rem .8rem;color:#475a72;white-space:nowrap;background:white}.profile-card{background:white;border:1px solid var(--border);border-radius:1rem;overflow:hidden}.identity{display:flex;gap:1rem;align-items:center;padding:2rem;border-bottom:1px solid var(--border);flex-wrap:wrap}.avatar{width:3.5rem;height:3.5rem;border-radius:1rem;display:grid;place-items:center;flex-shrink:0;background:#e9efff;color:#234ebd;font-size:1.5rem;font-weight:750}.identity h2{font-size:1.3rem;letter-spacing:-.025em;overflow-wrap:anywhere}.identity p{font-size:.875rem;margin-top:.25rem}.identity-label{font-size:.75rem;letter-spacing:.07em;color:#57677b;margin-left:auto}.profile-fields{display:grid;grid-template-columns:1fr 1fr;margin:0;padding:0 2rem}.profile-fields>div{padding:1.25rem 1rem 1.25rem 0;border-bottom:1px solid var(--border);min-width:0}.profile-fields>div:nth-child(even){padding-left:1rem;padding-right:0}.profile-fields>div:nth-last-child(-n+2){border-bottom:0}dt{font-size:.875rem;color:var(--muted);margin-bottom:.35rem}dd{margin:0;font-size:1rem;font-weight:550;overflow-wrap:anywhere}.field-meta{display:block;color:#718096;font-size:.72rem;margin-top:.4rem}.missing{font-weight:550;color:#5d6c80}.privacy-note{display:flex;align-items:flex-start;gap:1rem;padding:1.25rem 2rem;background:#f5f8ff;font-size:.875rem}.privacy-symbol{color:var(--blue);font-size:1.4rem;line-height:1}.next-note{margin-top:2rem;padding:1.5rem 0}.next-note h2{font-size:1.125rem;letter-spacing:-.015em;margin:.65rem 0}.next-note p{font-size:.9375rem;margin-top:.5rem;max-width:42rem;line-height:1.7}.profile-footer{margin-top:2rem;padding-top:1.5rem;border-top:1px solid var(--border);font-size:.8125rem;color:var(--muted)}.error-page{max-width:44rem;margin:6rem auto;padding:0 1.5rem}.error-page h1{font-size:clamp(2rem,5vw,3.5rem);letter-spacing:-.05em;line-height:1.15;margin:1rem 0}.error-page p{line-height:1.7}.error-page .button,.error-page .notice{margin-top:2rem;max-width:26rem}
@media(max-width:800px){.entry-grid{gap:2.5rem;grid-template-columns:1fr;padding:2.5rem 0}.intro h1{font-size:3.5rem}.intro-foot{margin-top:1.5rem}.sign-in{max-width:none}.entry-footer{flex-direction:column;gap:.4rem}.workspace{grid-template-columns:minmax(0,1fr)}.sidebar{padding:1rem 1.25rem;border-right:0;border-bottom:1px solid var(--border)}.sidebar>.eyebrow,.sidebar-note{display:none}.sidebar nav{margin:0}.nav-item{display:inline-flex}.profile-main{padding-top:2rem}.identity{padding:1.5rem}.identity-label{width:100%;margin-left:4.5rem}.profile-fields{padding:0 1.5rem}.privacy-note{padding:1.25rem 1.5rem}.profile-heading{align-items:flex-start}.badge{margin-top:.5rem}}
@media(max-width:480px){.entry-header>.eyebrow{display:none}.intro h1{font-size:3rem}.topbar{padding:1rem}.brand{font-size:1.4rem}.profile-fields{grid-template-columns:1fr}.profile-fields>div,.profile-fields>div:nth-child(even){padding-left:0;padding-right:0}.profile-fields>div:nth-last-child(2){border-bottom:1px solid var(--border)}.profile-heading{flex-wrap:wrap}.identity-label{margin-left:0}.sign-out span{display:none}.error-page{margin-top:3rem}}
.topbar{flex-wrap:wrap}body{overflow-wrap:anywhere}.entry-grid>*{min-width:0}
.context-list{display:grid;gap:.75rem;margin-top:1.25rem}.context-option{display:grid;grid-template-columns:minmax(0,1fr) auto auto;gap:1rem;align-items:center;padding:1.2rem 1.4rem;border:1px solid var(--border);border-radius:.75rem;background:white;text-decoration:none}.context-option.active{background:#e8eeff;border-color:#2256e8}.context-option:hover{border-color:#2256e8}.context-option strong{font-size:.875rem}.context-notice{margin-bottom:2rem}.org-card,.org-notice{margin-bottom:2rem}.directory-filters{display:flex;flex-wrap:wrap;gap:1rem;align-items:flex-end;margin-bottom:1.5rem}.directory-filters label{display:flex;flex-direction:column;gap:.35rem;font-size:.875rem;color:var(--muted)}.directory-filters input,.directory-filters select{font:inherit;min-height:2.75rem;padding:.5rem .75rem;border:1px solid var(--border);border-radius:.6rem;background:white;color:inherit}.directory-table{overflow-x:auto;background:white;border:1px solid var(--border);border-radius:1rem}.directory-table table{width:100%;min-width:40rem;border-collapse:collapse}.directory-filters label:first-of-type{flex:1 1 18rem}.directory-table td,.directory-table thead th{white-space:nowrap}.directory-table caption{text-align:left;padding:1rem 1.25rem;font-size:.875rem;color:var(--muted)}.directory-table th,.directory-table td{text-align:left;padding:.85rem 1.25rem;border-top:1px solid var(--border);font-size:.9375rem}.directory-table thead th{font-size:.8125rem;color:var(--muted);font-weight:650}.pager{display:flex;gap:1.5rem;margin-top:1.25rem}.empty-contexts{margin:1rem 0}.context-option span{overflow-wrap:anywhere}@media(max-width:480px){.context-option{grid-template-columns:minmax(0,1fr) auto}.context-option strong{grid-column:1;grid-row:2}.context-option>span:last-child{grid-column:2;grid-row:1/3}}
@media(prefers-reduced-motion:no-preference){.button,.sign-out{transition:background-color .15s ease}}
/* Profile journey only: no selector changes the legacy workspace or landing pages. */
.profile-ui.p-journey{min-block-size:100svh}.profile-ui .p-topbar{display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:1.25rem;padding:1rem clamp(1rem,4vw,3rem);border-block-end:1px solid var(--p-line);background:var(--p-surface)}.profile-ui .brand{direction:ltr;unicode-bidi:isolate}.profile-ui .brand-mark{margin:0;margin-inline-end:.65rem}.profile-ui .p-header-actions,.profile-ui .p-language{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}.profile-ui .p-language label{font-size:.8125rem;flex-basis:100%;color:var(--p-muted)}.profile-ui .p-language select{min-block-size:2.75rem;padding:.5rem;border:1px solid var(--p-control-line);border-radius:var(--p-radius);background:white;font:inherit;color:inherit;max-inline-size:100%}.profile-ui .p-layout{max-inline-size:88rem;margin-inline:auto;display:grid;grid-template-columns:minmax(0,1fr)}.profile-ui .p-rail{padding:1rem;border-block-end:1px solid var(--p-line)}.profile-ui .p-nav{display:flex;flex-wrap:wrap;gap:.25rem}.profile-ui .p-nav a{display:flex;align-items:center;min-block-size:2.75rem;padding:.65rem .85rem;border-radius:var(--p-radius);text-decoration:none;font-size:.9375rem;font-weight:650}.profile-ui .p-nav a[aria-current]{background:#e8eeff;color:#1d46b8}.profile-ui .p-rail>.p-meta{display:none}.profile-ui .p-layout>.p-main{inline-size:100%;max-inline-size:64rem;padding:2rem 1rem;gap:1.5rem}.profile-ui .p-header h1{font-size:clamp(2.25rem,4vw,3.2rem);font-weight:750;letter-spacing:-.035em}.profile-ui[dir=rtl] .p-header h1,[dir=rtl] .profile-ui .p-header h1{letter-spacing:normal}.profile-ui .p-header .p-hint{font-size:1rem}.profile-ui .p-identity{display:flex;align-items:flex-start;flex-wrap:wrap;gap:1rem;border-block-start:4px solid var(--p-blue);box-shadow:0 12px 35px #182b4b06}.profile-ui .p-monogram{display:grid;place-items:center;inline-size:3.25rem;block-size:3.25rem;flex-shrink:0;border-radius:.9rem;background:#e8eeff;color:#1d46b8;font-size:1.5rem;font-weight:750}.profile-ui .p-identity-text{flex:1 1 12rem;min-inline-size:0;display:grid;gap:.5rem}.profile-ui .p-identity h2{font-size:clamp(1.6rem,3vw,2.25rem);line-height:1.3;overflow-wrap:anywhere}.profile-ui .p-kicker{font-size:.75rem;font-weight:650;color:var(--p-muted)}.profile-ui .p-lead{max-inline-size:60ch;line-height:1.7}.profile-ui .p-status{flex-basis:100%;margin:0}.profile-ui .p-status .p-row{padding-block-end:0}.profile-ui .p-status .p-value{font-weight:650}.profile-ui .p-sections{display:flex;flex-wrap:wrap;gap:.5rem .75rem}.profile-ui .p-sections a{display:inline-flex;align-items:center;min-block-size:2.75rem;padding:.5rem .75rem;text-underline-offset:.3rem;font-size:.875rem;font-weight:650;color:var(--p-muted)}.profile-ui .p-card>h2{padding-block-end:.25rem}.profile-ui .p-card>.p-hint{margin-block-start:.5rem;line-height:1.7}.profile-ui .p-row{scroll-margin-block-start:1rem}.profile-ui .p-row:target{outline:2px solid var(--p-blue);outline-offset:4px;border-radius:.25rem}.profile-ui .p-row .p-value{display:block;max-inline-size:65ch;line-height:1.7}.profile-ui .p-row-actions{margin-block-start:.5rem}.profile-ui .p-edit{padding:.4rem .8rem;min-inline-size:4.5rem}.profile-ui .p-background-link{display:inline-flex;gap:1rem;align-items:center;min-block-size:2.75rem;margin-block-start:.75rem;color:var(--p-blue);font-weight:650;text-underline-offset:.3rem}.profile-ui .p-details>summary{font-size:1.25rem;font-weight:650;cursor:pointer;min-block-size:2.75rem;padding-block:.35rem}.profile-ui .p-provenance{margin-block-start:1rem;border-block-start:1px solid var(--p-line);padding-block-start:1rem;color:var(--p-muted);font-size:.875rem}.profile-ui .p-provenance summary{min-block-size:2.75rem;cursor:pointer;padding-block:.5rem;font-weight:650}.profile-ui .p-provenance dl{margin:0}.profile-ui .p-provenance dl>div{padding-block:.5rem}.profile-ui .p-provenance dt,.profile-ui .p-provenance dd{font-size:.8125rem}.profile-ui .p-guide{display:grid;gap:.75rem;padding:0 .25rem;color:var(--p-muted);font-size:.875rem;line-height:1.7;max-inline-size:70ch}.profile-ui .p-footer{padding-block-start:1.25rem;border-block-start:1px solid var(--p-line);font-size:.8125rem;color:var(--p-muted)}.profile-ui :is(a,button,input,select,textarea,summary):focus-visible{outline:3px solid var(--p-focus);outline-offset:4px}.profile-ui .p-row form{display:grid;gap:.75rem;margin-block-start:.75rem}.profile-ui .p-row :is(input:not([type=radio]),select,textarea){font:inherit;max-inline-size:100%;inline-size:100%;min-block-size:2.75rem;border:1px solid var(--p-control-line);border-radius:var(--p-radius);padding:.625rem}.profile-ui .p-row fieldset{border:0;padding:0;margin:0}.profile-ui .p-row fieldset label{display:flex;gap:.75rem;min-block-size:2.75rem;align-items:center}.profile-ui .p-row input[type=radio]{inline-size:1.25rem;block-size:1.25rem}
@media(min-width:64rem){.profile-ui .p-layout{grid-template-columns:14rem minmax(0,1fr)}.profile-ui .p-rail{border-block-end:0;border-inline-end:1px solid var(--p-line);padding:2.5rem 1rem;display:flex;flex-direction:column;gap:3rem}.profile-ui .p-nav{display:grid;gap:.25rem}.profile-ui .p-rail>.p-meta{display:block;margin-block-start:auto}.profile-ui .p-layout>.p-main{padding:3rem clamp(1.5rem,4vw,4rem)}.profile-ui .p-identity{padding:2rem}.profile-ui .p-provenance dl{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:.5rem 1.5rem}}
`;
