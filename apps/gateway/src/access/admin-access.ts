import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import type { SessionStore } from "@studenthub/login-contract";
import {
  GRANT_TOKEN_KEYS,
  mediaType,
  REASON_MAX,
  grantCatalogue,
  grantCatalogueView,
  grantChangeEffect,
  mayOpenAccessAdmin,
  mayPauseAccount,
  parseGrantChange,
  parseGrantToken,
  parsePeopleQuery,
  parsePauseRequest,
  type AccountPause,
  type AccountSessionList,
  type AccountSessionsStore,
  type AccountPauseService,
  type AccountPauseStore,
  type PauseRefusal,
  type AccessGrantRow,
  type GrantChangeEffect,
  type AccessGrantService,
  type AccessEventRow,
  type AccessOrganization,
  type AccessPerson,
  type AccessReadStore,
  type GrantChangeRequest,
  type GrantOption,
  type GrantRefusal,
  type GrantToken,
  type GrantCatalogueView,
  type CatalogueCapability,
  type CatalogueGiver,
  type OwnAccessRow,
} from "../../../../packages/access/src/index.js";

/**
 * Access lane A1: the admin Access pages and the person's own read-only list.
 *
 * GET  /admin/access                      find a person (exact email or name prefix)
 * GET  /admin/access/catalogue           G-01: every role at every scope, who gives it, what it opens
 * GET  /admin/access/people/{principalId} their grants, history, and the grant forms
 * POST /admin/access/preview              review one change, with a single-use token
 * POST /admin/access/confirm              apply it
 * GET  /profile/access                    "Your access", read-only, for everyone signed in
 * GET  /account                           U-03: where the person is signed in, for everyone signed in
 * POST /account/sign-out-everywhere       U-03: end every StudentHub session of the person
 *
 * A caller without an operator admin or staff grant is not answered here at
 * all: the handler returns false and the gateway sends the same 404 it sends
 * for an unknown path, so the pages' existence is not revealed.
 */

export interface AccessPorts {
  readonly sessions: Pick<SessionStore, "get">;
  readonly reads: AccessReadStore;
  /** Absent when the signing key is not configured: the pages are read-only. */
  readonly writes?: AccessGrantService;
  readonly operatorOrgIds?: readonly string[];
  /** A6: pause and resume a person's access. Writes absent without the signing key. */
  readonly pauses?: { readonly reads: Pick<AccountPauseStore, "pause">; readonly writes?: AccountPauseService };
  /** A9: when StudentHub staff viewed the signed-in person's account, for their own Access page. */
  readonly views?: { viewedOn(principalId: string): Promise<readonly string[]> };
  /** U-03: the person's own sessions. Absent: /account is not answered. */
  readonly account?: AccountSessionsStore;
}

export type AccessPageWriter = (status: number, title: string, body: string) => void;

const SESSION = "__Host-studenthub_session";
const BODY_LIMIT = 8192;
const PERSON = /^\/admin\/access\/people\/([^/]+)$/;
const PAUSE = /^\/admin\/access\/people\/([^/]+)\/(pause|resume)$/;

export const ROLE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  candidate: "Candidate", staff: "Staff", admin: "Administrator",
  "org-owner": "Organization owner", recruiter: "Recruiter", finance: "Finance", "store-manager": "Store manager",
});
export const SCOPE_NAMES: Readonly<Record<string, string>> = Object.freeze({
  self: "This organization only",
  subtree: "This organization and its sub-companies",
  store: "One store",
});

const REFUSAL_TEXT: Readonly<Record<GrantRefusal, string>> = Object.freeze({
  self_change: "You can’t change your own access. Ask another administrator.",
  unknown_person: "This person no longer exists.",
  unknown_organization: "This organization no longer exists or was deleted.",
  not_allowed: "You don’t have the right to give or take away this role here.",
  not_held: "This person doesn’t hold this role here any more.",
  last_admin: "This is the last administrator. Add another administrator first.",
  token_invalid: "This review doesn’t match the change. Start again from the person’s page.",
  token_expired: "This review expired after 15 minutes. Start again from the person’s page.",
  token_already_used: "This change was already confirmed.",
  state_changed: "This person’s access changed while you were reviewing. Review it again.",
});

const REFUSAL_STATUS: Readonly<Record<GrantRefusal, number>> = Object.freeze({
  self_change: 403, unknown_person: 404, unknown_organization: 404, not_allowed: 403, not_held: 409,
  last_admin: 409, token_invalid: 409, token_expired: 409, token_already_used: 409, state_changed: 409,
});

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

export function sessionCookie(header: string | undefined): string | undefined {
  for (const item of header?.split(";") ?? []) {
    const [key, ...parts] = item.trim().split("=");
    const value = parts.join("=");
    if (key === SESSION && /^[A-Za-z0-9_-]{43}$/.test(value)) return value;
  }
  return undefined;
}

export async function readForm(req: IncomingMessage): Promise<Record<string, string> | undefined> {
  if (mediaType(req.headers["content-type"]) !== "application/x-www-form-urlencoded" ||
    Number(req.headers["content-length"]) > BODY_LIMIT) {
    req.resume();
    return undefined;
  }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk as Uint8Array);
    size += bytes.length;
    if (size > BODY_LIMIT) {
      req.resume();
      return undefined;
    }
    chunks.push(bytes);
  }
  // A null-prototype record, so a field named __proto__ is kept as a field (and so counted and refused) rather than dropped.
  const out = Object.create(null) as Record<string, string>;
  for (const [key, value] of new URLSearchParams(Buffer.concat(chunks).toString("utf8"))) {
    if (Object.hasOwn(out, key)) return undefined;
    out[key] = value;
  }
  return out;
}

const personName = (person: { displayName: string | null; principalId: string }): string =>
  person.displayName?.trim() || "Unnamed person";

const dateText = (value: string): string =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kuwait" }).format(new Date(value));

const personHref = (principalId: string, extra: Record<string, string> = {}): string => {
  const query = new URLSearchParams(extra).toString();
  return `/admin/access/people/${encodeURIComponent(principalId)}${query ? `?${query}` : ""}`;
};

const brand = `<a class="brand" href="/" aria-label="StudentHub home"><span class="brand-mark" aria-hidden="true">s</span>studenthub<span class="brand-dot" aria-hidden="true">.</span></a>`;

function layout(main: string, current: "access" | "own" | "account"): string {
  const nav = current === "own"
    ? `<a class="nav-item" href="/profile">My profile</a><a class="nav-item active" href="/profile/access" aria-current="page">Your access</a><a class="nav-item" href="/account">Account</a><a class="nav-item" href="/workspace">Workspaces</a>`
    : current === "account"
    ? `<a class="nav-item" href="/profile">My profile</a><a class="nav-item" href="/profile/access">Your access</a><a class="nav-item active" href="/account" aria-current="page">Account</a><a class="nav-item" href="/workspace">Workspaces</a>`
    : `<a class="nav-item" href="/profile">My profile</a><a class="nav-item" href="/workspace">Workspaces</a><a class="nav-item" href="/workspace/people">People</a><a class="nav-item active" href="/admin/access" aria-current="page">Access</a>`;
  return `<header class="topbar">${brand}<form action="/logout" method="post"><button class="sign-out" type="submit">Sign out</button></form></header><div class="workspace"><aside class="sidebar"><div class="eyebrow">YOUR WORKSPACE</div><nav aria-label="Workspace">${nav}</nav></aside><main id="main" class="profile-main">${main}<footer class="profile-footer">StudentHub · Connected by Universe</footer></main></div>`;
}

// --- Rendering -----------------------------------------------------------------

const CAPABILITY_TEXT: Readonly<Record<CatalogueCapability, string>> = Object.freeze({
  access_pages: "Open the Access pages",
  review_registrations: "Review company sign-ups",
  pause_and_view_as: "Pause a person and view as them",
  pause_operator_roles: "Pause StudentHub staff and administrators",
  manage_ip_blocks: "Manage blocked addresses",
  operations_reports: "Operations reports",
  finance_reports: "Finance reports",
  give_operator_roles: "Give StudentHub roles",
  give_company_roles: "Give company roles",
  give_company_roles_below: "Give company roles in sub-companies",
  read_company_contacts: "See company contacts",
  change_company_contacts: "Change company contacts",
  manage_store_managers: "Manage store managers",
});
const GIVER_TEXT: Readonly<Record<CatalogueGiver, string>> = Object.freeze({
  operator_admins: "StudentHub administrators",
  operator_staff_and_admins: "StudentHub staff and administrators",
  not_on_access_pages: "Not given on the Access pages",
});

export function renderGrantCatalogue(view: GrantCatalogueView): string {
  const e = escapeHtml;
  const table = (place: "operator" | "company", caption: string) =>
    `<div class="directory-table"><table><caption>${caption}</caption><thead><tr><th>Role</th><th>Scope</th><th>Given by</th><th>Opens</th></tr></thead><tbody>${view.rows.filter((row) => row.place === place).map((row) =>
      `<tr><th scope="row">${e(ROLE_NAMES[row.role] ?? row.role)}</th><td>${e(SCOPE_NAMES[row.scope] ?? row.scope)}</td><td>${e(GIVER_TEXT[row.givenBy])}</td><td>${row.opens.length ? `<ul>${row.opens.map((capability) => `<li>${e(CAPABILITY_TEXT[capability])}</li>`).join("")}</ul>` : "Nothing on these pages"}</td></tr>`).join("")}</tbody></table></div>`;
  return layout(`<p><a class="text-link" href="/admin/access">← Access</a></p><div class="profile-heading"><div><div class="eyebrow">CATALOGUE VERSION ${view.version}</div><h1>Grant catalogue<span class="accent">.</span></h1><p>Every role at every scope: who can give it here, and what it opens. Each cell is worked out from the same rules the platform enforces.</p></div><span class="badge">Read-only</span></div><section><h2>Roles and scopes</h2><p>Roles: ${view.roles.map((role) => e(ROLE_NAMES[role] ?? role)).join(", ")}.</p><p>Scopes: ${view.scopes.map((scope) => e(SCOPE_NAMES[scope] ?? scope)).join("; ")}.</p></section><section><h2>On StudentHub</h2>${table("operator", "Roles on StudentHub itself")}</section><section><h2>On a company</h2>${table("company", "Roles on a company")}</section><section class="next-note"><p>Company owners can also invite their team from the company’s Team page. A role marked “Not given on the Access pages” is never offered here.</p></section>`, "access");
}

export function renderAccessSearch(query: string, people: readonly AccessPerson[] | undefined): string {
  const e = escapeHtml;
  const form = `<form class="directory-filters" method="get" action="/admin/access" role="search"><label>Email address or name<input type="search" name="q" minlength="3" maxlength="254" value="${e(query)}" required></label><button class="sign-out" type="submit">Find</button></form>`;
  const hint = `<p>Enter a full email address, or the first 3 or more letters of a name.</p>`;
  const results = people === undefined ? (query ? `<p class="empty-contexts" role="status">Enter a full email address or at least 3 letters of a name.</p>` : "")
    : people.length === 0 ? `<p class="empty-contexts" role="status">No one matches “${e(query)}”.</p>`
      : `<div class="directory-table"><table><caption>People (${people.length}${people.length === 25 ? ", first 25" : ""})</caption><thead><tr><th>Name</th><th>Email address</th></tr></thead><tbody>${people.map((person) =>
        `<tr><th scope="row"><a class="text-link" href="${e(personHref(person.principalId))}">${e(personName(person))}</a></th><td>${e(person.email ?? "Not recorded")}</td></tr>`).join("")}</tbody></table></div>`;
  return layout(`<div class="profile-heading"><h1>Access<span class="accent">.</span></h1></div><p>Find a person to see and change the roles they hold.</p>${form}${hint}${results}<p><a class="text-link" href="/admin/access/catalogue">See what each role opens →</a></p>`, "access");
}

export interface PersonPageModel {
  readonly person: AccessPerson;
  readonly grants: readonly AccessGrantRow[];
  readonly history: readonly AccessEventRow[];
  readonly orgQuery: string;
  readonly organizations: readonly (AccessOrganization & { readonly options: readonly GrantOption[] })[] | undefined;
  /** Catalogue per current grant's organization, to offer "Take away" only where allowed. */
  readonly revocable: ReadonlySet<string>;
  readonly writable: boolean;
  readonly isSelf: boolean;
  readonly done?: "granted" | "revoked" | "unchanged" | "paused" | "resumed";
  /** A6: the live pause, when the pause ports exist. */
  readonly pause?: AccountPause | null;
  /** A6: whether this caller may pause or resume this person. */
  readonly pausable?: boolean;
  /** A9: offer "View as this person". */
  readonly viewAs?: boolean;
}

const PAUSE_REFUSAL_TEXT: Readonly<Record<PauseRefusal, string>> = Object.freeze({
  self_change: "You can’t pause your own access. Ask another administrator.",
  unknown_person: "This person no longer exists.",
  not_allowed: "You don’t have the right to pause or resume this person’s access.",
  already_paused: "This person’s access is already paused.",
  not_paused: "This person’s access isn’t paused.",
});
const PAUSE_REFUSAL_STATUS: Readonly<Record<PauseRefusal, number>> = Object.freeze({
  self_change: 403, unknown_person: 404, not_allowed: 403, already_paused: 409, not_paused: 409,
});

function renderPauseSection(model: PersonPageModel): string {
  const e = escapeHtml;
  if (model.pause === undefined) return "";
  const { person, pause } = model;
  const action = pause ? "resume" : "pause";
  const form = model.pausable && !model.isSelf
    ? `<form method="post" action="${e(`/admin/access/people/${encodeURIComponent(person.principalId)}/${action}`)}"><input type="hidden" name="targetPrincipalId" value="${e(person.principalId)}"><input type="hidden" name="action" value="${action}"><label for="pause-reason">Reason (shown to administrators only)</label><textarea id="pause-reason" name="reason" minlength="3" maxlength="${REASON_MAX}" required></textarea><button class="sign-out" type="submit">${pause ? "Resume access" : "Pause access"}</button></form>`
    : "";
  const status = pause
    ? `<p><strong>Access paused</strong> on ${e(dateText(pause.pausedAt))} by ${e(personName(pause.pausedBy))}: ${e(pause.reason)}</p><p>${pause.grants.length + pause.storeGrants.length} role${pause.grants.length + pause.storeGrants.length === 1 ? "" : "s"} will be given back on resume, except at a deleted company or a removed store.</p>`
    : `<p>Pausing takes every role away, signs ${e(personName(person))} out everywhere on their next request, and refuses sign-in until access is resumed. Their profile is hidden from companies while paused.</p>`;
  const view = model.viewAs ? `<p><a class="text-link" href="${e(`/admin/access/people/${encodeURIComponent(person.principalId)}/view`)}">View as ${e(personName(person))}, read-only</a></p>` : "";
  return `<section><h2>Account</h2>${status}${form}${view}</section>`;
}

const reasonField = (id: string): string =>
  `<label for="${id}">Reason (shown to StudentHub administrators and authorized staff; not shown on Your access page)</label><textarea id="${id}" name="reason" minlength="3" maxlength="${REASON_MAX}" required></textarea>`;

export function renderPersonAccess(model: PersonPageModel): string {
  const e = escapeHtml;
  const { person } = model;
  const notice = model.done === "granted" ? "The role was given." : model.done === "revoked" ? "The role was taken away." : model.done === "unchanged" ? "Nothing changed: the person already held this."
    : model.done === "paused" ? "Access was paused." : model.done === "resumed" ? "Access was resumed." : "";
  const grantRows = model.grants.length === 0
    ? `<p class="empty-contexts" role="status">${e(personName(person))} holds no roles.</p>`
    : `<div class="directory-table"><table><caption>Roles held</caption><thead><tr><th>Organization</th><th>Role</th><th>Scope</th><th>Given by</th><th>When</th><th>Reason</th>${model.writable && !model.isSelf ? "<th>Change</th>" : ""}</tr></thead><tbody>${model.grants.map((grant, index) => {
      const key = `${grant.orgId}\u0000${grant.role}`;
      const revoke = model.writable && !model.isSelf && model.revocable.has(key)
        ? `<td><form method="post" action="/admin/access/preview"><input type="hidden" name="action" value="revoke"><input type="hidden" name="targetPrincipalId" value="${e(person.principalId)}"><input type="hidden" name="orgId" value="${e(grant.orgId)}"><input type="hidden" name="role" value="${e(grant.role)}"><input type="hidden" name="scope" value="${e(grant.scope)}">${reasonField(`revoke-reason-${index}`)}<button class="sign-out" type="submit">Review taking it away</button></form></td>`
        : model.writable && !model.isSelf ? "<td>—</td>" : "";
      return `<tr><th scope="row">${e(grant.orgName)}</th><td>${e(ROLE_NAMES[grant.role] ?? grant.role)}</td><td>${e(SCOPE_NAMES[grant.scope] ?? grant.scope)}</td><td>${grant.grantedBy ? e(personName(grant.grantedBy)) : "Unknown"}</td><td>${grant.grantedAt ? e(dateText(grant.grantedAt)) : "Unknown"}</td><td>${grant.reason ? e(grant.reason) : "Not recorded"}</td>${revoke}</tr>`;
    }).join("")}</tbody></table></div>`;
  const orgSearch = `<form class="directory-filters" method="get" action="${e(personHref(person.principalId))}" role="search"><label>Organization name<input type="search" name="org" minlength="1" maxlength="200" value="${e(model.orgQuery)}" required></label><button class="sign-out" type="submit">Find organization</button></form>`;
  const orgResults = model.organizations === undefined ? ""
    : model.organizations.length === 0 ? `<p class="empty-contexts" role="status">No organization matches “${e(model.orgQuery)}”.</p>`
      : `<ul class="context-list">${model.organizations.map((org, index) => org.options.length === 0
        ? `<li class="profile-card"><strong>${e(org.name)}</strong><p>You can’t give roles here.</p></li>`
        : `<li class="profile-card"><form method="post" action="/admin/access/preview"><fieldset><legend>${e(org.name)}</legend><input type="hidden" name="action" value="grant"><input type="hidden" name="targetPrincipalId" value="${e(person.principalId)}"><input type="hidden" name="orgId" value="${e(org.orgId)}"><label for="grant-role-${index}">Role</label><select id="grant-role-${index}" name="role">${org.options.map((option) => `<option value="${e(option.role)}">${e(ROLE_NAMES[option.role] ?? option.role)}</option>`).join("")}</select><label for="grant-scope-${index}">Scope</label><select id="grant-scope-${index}" name="scope">${(org.options[0]?.scopes ?? []).map((scope) => `<option value="${e(scope)}">${e(SCOPE_NAMES[scope] ?? scope)}</option>`).join("")}</select>${reasonField(`grant-reason-${index}`)}<button class="sign-out" type="submit">Review giving this role</button></fieldset></form></li>`).join("")}</ul>`;
  const give = !model.writable ? `<p class="sidebar-note">Changes are unavailable right now.</p>`
    : model.isSelf ? `<p>You can’t change your own access. Ask another administrator.</p>`
      : `${orgSearch}${orgResults}`;
  const history = model.history.length === 0 ? `<p class="empty-contexts">No changes recorded on this page yet.</p>`
    : `<div class="directory-table"><table><caption>Changes (latest ${model.history.length})</caption><thead><tr><th>When</th><th>Change</th><th>Organization</th><th>Role</th><th>Scope</th><th>By</th><th>Reason</th></tr></thead><tbody>${model.history.map((event) =>
      `<tr><td>${e(dateText(event.occurredAt))}</td><td>${event.action === "grant" ? "Given" : "Taken away"}</td><td>${e(event.orgName)}</td><td>${e(ROLE_NAMES[event.role] ?? event.role)}</td><td>${e(SCOPE_NAMES[event.scope] ?? event.scope)}</td><td>${e(personName(event.actor))}</td><td>${e(event.reason)}</td></tr>`).join("")}</tbody></table></div>`;
  return layout(`<p><a class="text-link" href="/admin/access">← Find another person</a></p><div class="profile-heading"><h1>${e(personName(person))}<span class="accent">.</span></h1></div><p>${e(person.email ?? "No email address recorded")}</p>${notice ? `<section class="notice context-notice" role="status"><strong>${e(notice)}</strong></section>` : ""}${renderPauseSection(model)}<section><h2>Roles</h2>${grantRows}</section><section><h2>Give a role</h2>${give}</section><section><h2>History</h2>${history}</section>`, "access");
}

function renderGrantEffect(name: string, orgName: string, effect: GrantChangeEffect): string {
  const e = escapeHtml;
  const list = (items: readonly CatalogueCapability[]) => `<ul>${items.map((capability) => `<li>${e(CAPABILITY_TEXT[capability])}</li>`).join("")}</ul>`;
  const gained = effect.gained.length ? `<p>${e(name)} will be able to:</p>${list(effect.gained)}` : "";
  const lost = effect.lost.length ? `<p>${e(name)} will no longer be able to:</p>${list(effect.lost)}` : "";
  const gainedBelow = effect.gainedBelow.length ? `<p>In the companies below ${e(orgName)}, ${e(name)} will be able to:</p>${list(effect.gainedBelow)}` : "";
  const lostBelow = effect.lostBelow.length ? `<p>In the companies below ${e(orgName)}, ${e(name)} will no longer be able to:</p>${list(effect.lostBelow)}` : "";
  const none = gained || lost || gainedBelow || lostBelow ? "" : `<p>Nothing in the <a class="text-link" href="/admin/access/catalogue">grant catalogue</a> changes for ${e(name)}: their other roles already decide it.</p>`;
  return `<section class="grant-effect"><h2>What changes for them</h2>${gained}${lost}${gainedBelow}${lostBelow}${none}</section>`;
}

export function renderGrantReview(input: {
  readonly person: AccessPerson;
  readonly orgName: string;
  readonly request: GrantChangeRequest;
  readonly result: { readonly kind: "unchanged" } | { readonly kind: "change"; readonly before: string | null; readonly after: string | null; readonly token: GrantToken };
  /** G-02: what the change opens or closes for the person, their other roles counted. */
  readonly effect?: GrantChangeEffect;
}): string {
  const e = escapeHtml;
  const { request, person } = input;
  const back = personHref(person.principalId);
  const facts = `<dl class="profile-fields"><div><dt>Person</dt><dd>${e(personName(person))}</dd></div><div><dt>Organization</dt><dd>${e(input.orgName)}</dd></div><div><dt>Role</dt><dd>${e(ROLE_NAMES[request.role] ?? request.role)}</dd></div><div><dt>Scope</dt><dd>${e(SCOPE_NAMES[input.result.kind === "change" && request.action === "revoke" ? input.result.before ?? request.scope : request.scope] ?? request.scope)}</dd></div><div><dt>Reason</dt><dd>${e(request.reason)}</dd></div></dl>`;
  if (input.result.kind === "unchanged") {
    return layout(`<div class="profile-heading"><h1>Nothing to change<span class="accent">.</span></h1></div><p>${e(personName(person))} already holds this role at this scope or wider.</p>${facts}<a class="button primary" href="${e(back)}">Back to ${e(personName(person))}</a>`, "access");
  }
  const { token } = input.result;
  const hidden = [
    ...(["targetPrincipalId", "orgId", "role", "scope", "action", "reason"] as const).map((key) => [key, request[key]] as const),
    ...GRANT_TOKEN_KEYS.map((key) => [`token.${key}`, token[key]] as const),
  ].map(([key, value]) => `<input type="hidden" name="${e(key)}" value="${e(value)}">`).join("");
  const verb = request.action === "grant"
    ? input.result.before === null ? "Give this role" : "Widen this role to the sub-companies"
    : "Take this role away";
  return layout(`<div class="profile-heading"><h1>Review: ${e(verb.toLowerCase())}<span class="accent">.</span></h1></div><p>The change applies on ${e(personName(person))}’s next request. Confirm within 15 minutes.</p>${facts}${input.effect ? renderGrantEffect(personName(person), input.orgName, input.effect) : ""}<form method="post" action="/admin/access/confirm">${hidden}<button class="button primary" type="submit">${e(verb)}</button></form><a class="text-link" href="${e(back)}">Cancel</a>`, "access");
}

/** A confirm whose outcome is unknown: the change may or may not have been made. */
export function renderUnconfirmed(back: string): string {
  return layout(`<div class="error-page"><h1>We couldn’t confirm the change.</h1><p>The change may or may not have been made. Check this person’s roles and history before you start a new review.</p><a class="button primary" href="${escapeHtml(back)}">Check their access</a></div>`, "access");
}

export function renderAccessRefusal(reason: GrantRefusal | "invalid_request" | "unavailable", back: string): string {
  const text = reason === "invalid_request" ? "Some details were missing or not valid. The reason must be 3 to 500 characters."
    : reason === "unavailable" ? "Access changes are unavailable right now. Please try again in a moment."
      : REFUSAL_TEXT[reason];
  return layout(`<div class="error-page"><h1>Nothing was changed.</h1><p>${escapeHtml(text)}</p><a class="button primary" href="${escapeHtml(back)}">Back</a></div>`, "access");
}

export function renderPauseRefusal(reason: PauseRefusal | "invalid_request" | "unavailable", back: string): string {
  const text = reason === "invalid_request" ? "Some details were missing or not valid. The reason must be 3 to 500 characters."
    : reason === "unavailable" ? "Access changes are unavailable right now. Please try again in a moment."
      : PAUSE_REFUSAL_TEXT[reason];
  return layout(`<div class="error-page"><h1>Nothing was changed.</h1><p>${escapeHtml(text)}</p><a class="button primary" href="${escapeHtml(back)}">Back</a></div>`, "access");
}

export function renderOwnAccess(rows: readonly OwnAccessRow[], extra = ""): string {
  const e = escapeHtml;
  const list = rows.length === 0
    ? `<p class="empty-contexts" role="status">You hold no staff or company roles. Your profile is yours whatever roles you hold.</p>`
    : `<div class="directory-table"><table><caption>Roles you hold</caption><thead><tr><th>Organization</th><th>Role</th><th>Scope</th></tr></thead><tbody>${rows.map((row) =>
      `<tr><th scope="row">${e(row.orgName)}</th><td>${e(ROLE_NAMES[row.role] ?? row.role)}</td><td>${e(SCOPE_NAMES[row.scope] ?? row.scope)}</td></tr>`).join("")}</tbody></table></div>`;
  return layout(`<div class="profile-heading"><h1>Your access<span class="accent">.</span></h1><span class="badge">Read-only</span></div><p>These are the roles you hold in StudentHub. An administrator or your company’s owner changes them.</p>${list}${extra}`, "own");
}

const timeText = (value: string): string =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "Asia/Kuwait" }).format(new Date(value));

/** U-03: where the person is signed in, and the sign-out-everywhere form. */
export function renderAccount(list: AccountSessionList, notice = ""): string {
  const e = escapeHtml;
  const sessions = list.sessions;
  const rows = sessions.map((item) =>
    `<tr><th scope="row">${item.current ? "This browser" : "Another browser or device"}</th><td>${item.signedInAt ? e(timeText(item.signedInAt)) : "Not recorded"}</td><td>${e(timeText(item.expiresAt))}</td></tr>`).join("");
  // The real number of live sessions, not the capped list: it is what signing out everywhere ends.
  const others = Math.max(0, list.live - (sessions.some((item) => item.current) ? 1 : 0));
  const capped = list.live > sessions.length
    ? `<p>Showing the latest ${sessions.length} of your ${list.live} sign-ins. Signing out everywhere ends all ${list.live}.</p>` : "";
  const summary = others === 0
    ? `<p role="status">You are signed in to StudentHub only in this browser.</p>`
    : `<p role="status">You are signed in to StudentHub in this browser and ${others} other${others === 1 ? "" : "s"}.</p>`;
  return layout(`<div class="profile-heading"><h1>Account<span class="accent">.</span></h1></div>${notice}`
    + `<section><h2>Where you are signed in</h2>${summary}<div class="directory-table"><table><caption>Your StudentHub sign-ins (Kuwait time)</caption><thead><tr><th scope="col">Where</th><th scope="col">Signed in</th><th scope="col">Ends by itself</th></tr></thead><tbody>${rows}</tbody></table></div>${capped}</section>`
    + `<section><h2>Sign out everywhere</h2><p>This signs you out of StudentHub in every browser and device, this one included. Your Universe sign-in is not changed; sign in again to come back.</p>`
    + `<form action="/account/sign-out-everywhere" method="post"><button type="submit">Sign out everywhere</button></form></section>`, "account");
}

// --- Request handling ---------------------------------------------------------

const refusalStatus = (reason: GrantRefusal | "invalid_request" | "unavailable"): number =>
  reason === "invalid_request" ? 400 : reason === "unavailable" ? 503 : REFUSAL_STATUS[reason];

/**
 * Answers the Access paths. Returns false (so the gateway's unknown-path 404
 * answers) for a signed-out visitor, a caller without an operator admin or
 * staff grant, an unknown method, and an unknown person id.
 */
export async function handleAccess(
  req: IncomingMessage,
  res: ServerResponse,
  ports: AccessPorts | undefined,
  origin: string | undefined,
  write: AccessPageWriter,
): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://gateway.invalid");
  const path = url.pathname;
  const isOwn = path === "/profile/access";
  const isAccount = path === "/account" || path === "/account/sign-out-everywhere";
  if (isAccount) return handleAccount(req, res, ports, origin, write, path);
  const personMatch = PERSON.exec(path);
  const pauseMatch = PAUSE.exec(path);
  const isAdminPath = path === "/admin/access" || path === "/admin/access/catalogue" || path === "/admin/access/preview" || path === "/admin/access/confirm" || personMatch !== null
    || (pauseMatch !== null && ports?.pauses !== undefined);
  if (!isOwn && !isAdminPath) return false;
  if (!ports) return false;
  const session = sessionCookie(req.headers.cookie);
  const caller = session ? (await ports.sessions.get(session))?.personId : undefined;
  if (!caller) return false;

  if (isOwn) {
    if (req.method !== "GET") return false;
    const [own, viewed] = await Promise.all([ports.reads.ownGrants(caller), ports.views ? ports.views.viewedOn(caller) : Promise.resolve([])]);
    write(200, "Your access", renderOwnAccess(own, viewed.length ? `<section><h2>Staff views</h2><ul>${viewed.map((date) => `<li>StudentHub staff opened a view of your account on ${escapeHtml(date.slice(0, 10))}</li>`).join("")}</ul></section>` : ""));
    return true;
  }

  const callerGrants = await ports.reads.callerGrants(caller);
  if (!mayOpenAccessAdmin(callerGrants, ports.operatorOrgIds)) return false;

  if (path === "/admin/access/catalogue") {
    if (req.method !== "GET") return false;
    write(200, "Grant catalogue", renderGrantCatalogue(grantCatalogueView(ports.operatorOrgIds)));
    return true;
  }

  if (path === "/admin/access") {
    if (req.method !== "GET") return false;
    const raw = url.searchParams.get("q") ?? "";
    const query = parsePeopleQuery(raw);
    write(200, "Access", renderAccessSearch(raw.trim(), query ? await ports.reads.findPeople(query) : undefined));
    return true;
  }

  if (personMatch) {
    if (req.method !== "GET") return false;
    let principalId: string;
    try { principalId = decodeURIComponent(personMatch[1]!); } catch { return false; }
    if (principalId.includes("\u0000")) return false;
    const person = await ports.reads.person(principalId);
    if (!person) return false;
    const orgQuery = (url.searchParams.get("org") ?? "").trim().slice(0, 200);
    const [grants, history, found, pause] = await Promise.all([
      ports.reads.grants(principalId),
      ports.reads.history(principalId),
      orgQuery ? ports.reads.findOrganizations(orgQuery) : Promise.resolve(undefined),
      ports.pauses ? ports.pauses.reads.pause(principalId) : Promise.resolve(undefined),
    ]);
    // Ancestors of the held grants' organizations, for the "take away" offer: one batched read.
    const held = await ports.reads.organizations([...new Set(grants.map((grant) => grant.orgId))]);
    const revocable = new Set<string>();
    for (const grant of grants) {
      const org = held.find((item) => item.orgId === grant.orgId);
      if (!org) continue;
      const options = grantCatalogue({ callerGrants, targetOrgId: org.orgId, targetAncestors: org.ancestors, ...(ports.operatorOrgIds ? { operatorOrgIds: ports.operatorOrgIds } : {}) });
      if (options.some((option) => option.role === grant.role && (option.scopes as readonly string[]).includes(grant.scope))) {
        revocable.add(`${grant.orgId}\u0000${grant.role}`);
      }
    }
    const done = url.searchParams.get("done");
    write(200, personName(person), renderPersonAccess({
      person, grants, history, orgQuery,
      organizations: found?.map((org) => ({ ...org, options: grantCatalogue({ callerGrants, targetOrgId: org.orgId, targetAncestors: org.ancestors, ...(ports.operatorOrgIds ? { operatorOrgIds: ports.operatorOrgIds } : {}) }) })),
      revocable,
      writable: ports.writes !== undefined,
      isSelf: principalId === caller,
      ...(done === "granted" || done === "revoked" || done === "unchanged" || done === "paused" || done === "resumed" ? { done } : {}),
      ...(ports.pauses ? {
        pause: pause ?? null,
        pausable: ports.pauses.writes !== undefined && mayPauseAccount(caller, principalId, callerGrants,
          pause ? pause.grants : grants, ports.operatorOrgIds),
        viewAs: ports.views !== undefined && mayPauseAccount(caller, principalId, callerGrants, pause ? pause.grants : grants, ports.operatorOrgIds),
      } : {}),
    }));
    return true;
  }

  if (pauseMatch && ports.pauses) {
    if (req.method !== "POST") return false;
    let principalId: string;
    try { principalId = decodeURIComponent(pauseMatch[1]!); } catch { return false; }
    const back = personHref(principalId);
    if (!origin || req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") {
      req.resume();
      write(403, "Access", renderPauseRefusal("invalid_request", back));
      return true;
    }
    const form = await readForm(req);
    const request = form && Object.keys(form).every((key) => key === "targetPrincipalId" || key === "action" || key === "reason")
      ? parsePauseRequest(form) : undefined;
    if (!request || request.targetPrincipalId !== principalId || request.action !== pauseMatch[2]) {
      write(400, "Access", renderPauseRefusal("invalid_request", back));
      return true;
    }
    if (!ports.pauses.writes) {
      write(503, "Access", renderPauseRefusal("unavailable", back));
      return true;
    }
    try {
      const outcome = await ports.pauses.writes.change(caller, request, `access_${randomUUID()}`);
      if (outcome.kind === "refused") {
        write(PAUSE_REFUSAL_STATUS[outcome.reason], "Access", renderPauseRefusal(outcome.reason, back));
        return true;
      }
      res.writeHead(303, { location: personHref(principalId, { done: outcome.kind }), "cache-control": "no-store" });
      res.end();
    } catch {
      // The write may have committed before the error: say so, don't claim nothing changed.
      if (!res.headersSent) write(503, "Access", renderUnconfirmed(back));
      else res.destroy();
    }
    return true;
  }

  // Writes: same-origin form posts to the two write paths only; any other
  // method or path is not handled, so the unknown-path 404 answers.
  if (req.method !== "POST" || (path !== "/admin/access/preview" && path !== "/admin/access/confirm")) return false;
  if (!origin || req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") {
    req.resume();
    write(403, "Access", renderAccessRefusal("invalid_request", "/admin/access"));
    return true;
  }
  const form = await readForm(req);
  const request = form ? parseGrantChange(form) : undefined;
  const back = request ? personHref(request.targetPrincipalId) : "/admin/access";
  if (!form || !request) {
    write(400, "Access", renderAccessRefusal("invalid_request", back));
    return true;
  }
  if (!ports.writes) {
    write(503, "Access", renderAccessRefusal("unavailable", back));
    return true;
  }
  try {
    if (path === "/admin/access/preview") {
      const allowed = new Set(["targetPrincipalId", "orgId", "role", "scope", "action", "reason"]);
      if (Object.keys(form).some((key) => !allowed.has(key))) {
        write(400, "Access", renderAccessRefusal("invalid_request", back));
        return true;
      }
      const result = await ports.writes.preview(caller, request);
      // An unknown person is the unknown-path 404, as on the person page.
      if (!result.ok && result.reason === "unknown_person") return false;
      if (!result.ok) {
        write(refusalStatus(result.reason), "Access", renderAccessRefusal(result.reason, back));
        return true;
      }
      const [person, org, held] = await Promise.all([ports.reads.person(request.targetPrincipalId), ports.reads.organization(request.orgId), ports.reads.grants(request.targetPrincipalId)]);
      if (!person) return false;
      if (!org) {
        write(404, "Access", renderAccessRefusal("unknown_organization", back));
        return true;
      }
      write(200, "Review access change", renderGrantReview({
        person, orgName: org.name, request,
        result: result.kind === "unchanged" ? { kind: "unchanged" } : result,
        ...(result.kind === "unchanged" ? {} : { effect: grantChangeEffect({
          held, change: { orgId: request.orgId, role: request.role, after: result.after },
          orgAncestors: org.ancestors, ...(ports.operatorOrgIds ? { operatorOrgIds: ports.operatorOrgIds } : {}),
        }) }),
      }));
      return true;
    }
    const allowed = new Set(["targetPrincipalId", "orgId", "role", "scope", "action", "reason", ...GRANT_TOKEN_KEYS.map((key) => `token.${key}`)]);
    if (Object.keys(form).some((key) => !allowed.has(key))) {
      write(400, "Access", renderAccessRefusal("invalid_request", back));
      return true;
    }
    const token = parseGrantToken(Object.fromEntries(GRANT_TOKEN_KEYS.map((key) => [key, form[`token.${key}`]])));
    if (!token) {
      write(409, "Access", renderAccessRefusal("token_invalid", back));
      return true;
    }
    const outcome = await ports.writes.confirm(caller, request, token, `access_${randomUUID()}`);
    if (outcome.kind === "refused" && outcome.reason === "unknown_person") return false;
    if (outcome.kind === "refused") {
      write(refusalStatus(outcome.reason), "Access", renderAccessRefusal(outcome.reason, back));
      return true;
    }
    const done = outcome.kind === "unchanged" ? "unchanged" : outcome.after === null ? "revoked" : "granted";
    res.writeHead(303, { location: personHref(request.targetPrincipalId, { done }), "cache-control": "no-store" });
    res.end();
    return true;
  } catch {
    // A failed preview wrote nothing. A failed confirm may have committed
    // before the error reached us, so it never claims that nothing changed.
    if (!res.headersSent) write(503, "Access", path === "/admin/access/confirm" ? renderUnconfirmed(back) : renderAccessRefusal("unavailable", back));
    else res.destroy();
    return true;
  }
}

const SIGNED_OUT_COOKIE = "__Host-studenthub_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0";

/**
 * U-03. Signed out, or without the port: not answered (the unknown-path 404).
 * GET /account lists the person's own sessions; POST /account/sign-out-everywhere,
 * a same-origin form post with no fields, ends all of them and clears the cookie.
 * Both go by the person the session belongs to, never by an id in the request.
 */
async function handleAccount(req: IncomingMessage, res: ServerResponse, ports: AccessPorts | undefined, origin: string | undefined,
  write: AccessPageWriter, path: string): Promise<boolean> {
  if (!ports?.account) return false;
  const session = sessionCookie(req.headers.cookie);
  const caller = session ? (await ports.sessions.get(session))?.personId : undefined;
  if (!session || !caller) return false;
  if (path === "/account") {
    if (req.method !== "GET") return false;
    write(200, "Account", renderAccount(await ports.account.list(caller, session)));
    return true;
  }
  if (req.method !== "POST") return false;
  if (!origin || req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") {
    req.resume();
    write(403, "Account", renderAccount(await ports.account.list(caller, session),
      `<p class="error" role="alert">That request did not come from this page. Nothing changed.</p>`));
    return true;
  }
  const form = await readForm(req);
  if (!form || Object.keys(form).length !== 0) {
    write(400, "Account", renderAccount(await ports.account.list(caller, session),
      `<p class="error" role="alert">That request was not understood. Nothing changed.</p>`));
    return true;
  }
  await ports.account.endAll(caller);
  res.writeHead(303, { location: "/signed-out", "set-cookie": SIGNED_OUT_COOKIE, "cache-control": "no-store" });
  res.end();
  return true;
}
