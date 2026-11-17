import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import {
  MAX_PENDING_INVITATIONS,
  isInvitationTokenShape,
  type CompanyTeamService,
  type InvitationRefusal,
  type TeamView,
} from "../../../../packages/access/src/index.js";
import { ROLE_NAMES, SCOPE_NAMES, escapeHtml, readForm, sessionCookie, type AccessPageWriter } from "./admin-access.js";

/**
 * Access lane A2: a company's Team page and email invitations.
 *
 * GET  /workspace/companies/{orgId}/team                              members and pending invitations
 * POST /workspace/companies/{orgId}/team/invite                       invite an address; the link is shown once
 * POST /workspace/companies/{orgId}/team/invitations/{id}/revoke      revoke a pending invitation
 * GET  /workspace/companies/{orgId}/team/members/{principalId}/remove confirm step that names the person
 * POST /workspace/companies/{orgId}/team/members/{principalId}/remove remove their grants on this company
 * GET  /invitations/{token}                                           the invitation, company and role only
 * POST /invitations/{token}/accept                                    accept as the signed-in person
 *
 * Owners write; operator staff and admin covering the company read; anyone
 * else gets the gateway's unknown-path 404 (the handler returns false). A
 * signed-out invitee is sent to sign in with a short-lived cookie holding the
 * link, and the first GET /profile after sign-in sends them back to it.
 */

export interface CompanyTeamPorts {
  readonly sessions: Pick<SessionStore, "get">;
  readonly team: CompanyTeamService;
}

export const INVITE_COOKIE = "__Host-studenthub_invite";
const INVITE_COOKIE_SECONDS = 3600;
const TEAM = /^\/workspace\/companies\/([^/]+)\/team(?:\/(invite|invitations\/([^/]+)\/revoke|members\/([^/]+)\/remove))?$/;
const INVITATION = /^\/invitations\/([^/]+)(\/accept)?$/;

const REFUSAL_TEXT: Readonly<Record<InvitationRefusal | "invalid_email" | "invalid_request" | "unavailable", string>> = Object.freeze({
  invalid_email: "Enter one email address, like name@example.com.",
  not_owner: "Only an owner of this company can change its team.",
  role_not_allowed: "You can’t invite for this role or scope here.",
  unknown_organization: "This company no longer exists or was deleted.",
  duplicate_invitation: "This address already has a pending invitation for this role. Revoke it first to send a new one.",
  too_many_invitations: `This company already has ${MAX_PENDING_INVITATIONS} pending invitations. Revoke some first.`,
  already_member: "This person already holds this role here.",
  not_found: "This person or invitation is no longer on the team.",
  last_owner: "This is the company’s last owner. Make someone else an owner first.",
  invalid_request: "Something in the form was not right. Go back and try again.",
  unavailable: "The team can’t be changed right now. Please try again later.",
});
const REFUSAL_STATUS: Readonly<Record<keyof typeof REFUSAL_TEXT, number>> = Object.freeze({
  invalid_email: 400, not_owner: 403, role_not_allowed: 403, unknown_organization: 404, duplicate_invitation: 409,
  too_many_invitations: 409, already_member: 409, not_found: 404, last_owner: 409, invalid_request: 400, unavailable: 503,
});

export const INVITATION_DEAD_TEXT = "This invitation is no longer valid";
export const INVITATION_WRONG_ADDRESS_TEXT = "This invitation is for a different address";

const e = escapeHtml;
const brand = `<a class="brand" href="/" aria-label="StudentHub home"><span class="brand-mark" aria-hidden="true">s</span>studenthub<span class="brand-dot" aria-hidden="true">.</span></a>`;
const dateText = (value: string): string =>
  new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "Asia/Kuwait" }).format(new Date(value));
const name = (person: { displayName: string | null; email?: string | null }): string =>
  person.displayName?.trim() || person.email || "Unnamed person";
const teamHref = (orgId: string, suffix = ""): string => `/workspace/companies/${encodeURIComponent(orgId)}/team${suffix}`;

function layout(main: string): string {
  return `<header class="topbar">${brand}<form action="/logout" method="post"><button class="sign-out" type="submit">Sign out</button></form></header><div class="workspace"><aside class="sidebar"><div class="eyebrow">YOUR WORKSPACE</div><nav aria-label="Workspace"><a class="nav-item" href="/profile">My profile</a><a class="nav-item" href="/profile/access">Your access</a><a class="nav-item active" href="/workspace" aria-current="page">Workspaces</a></nav></aside><main id="main" class="profile-main">${main}<footer class="profile-footer">StudentHub · Connected by Universe</footer></main></div>`;
}

function simplePage(heading: string, message: string, back?: { href: string; label: string }): string {
  return layout(`<div class="profile-heading"><h1>${e(heading)}<span class="accent">.</span></h1></div><p role="alert">${e(message)}</p>${back ? `<p><a class="text-link" href="${e(back.href)}">${e(back.label)}</a></p>` : ""}`);
}

// --- Rendering -----------------------------------------------------------------

export function renderTeam(view: TeamView): string {
  const roleOptions = view.options.map((option) => `<option value="${e(option.role)}">${e(ROLE_NAMES[option.role] ?? option.role)}</option>`).join("");
  const scopes = [...new Set(view.options.flatMap((option) => option.scopes))];
  const scopeOptions = scopes.map((scope) => `<option value="${e(scope)}">${e(SCOPE_NAMES[scope] ?? scope)}</option>`).join("");
  const members = view.members.length === 0
    ? `<p class="empty-contexts" role="status">No one holds a role on this company yet.</p>`
    : `<div class="directory-table"><table><caption>Team</caption><thead><tr><th>Name</th><th>Role</th><th>Scope</th>${view.writable ? "<th>Change</th>" : ""}</tr></thead><tbody>${view.members.map((member) =>
      `<tr><th scope="row">${e(name(member))}</th><td>${e(ROLE_NAMES[member.role] ?? member.role)}</td><td>${e(SCOPE_NAMES[member.scope] ?? member.scope)}</td>${view.writable
        ? `<td><a class="text-link" href="${e(teamHref(view.orgId, `/members/${encodeURIComponent(member.principalId)}/remove`))}">Remove from team</a></td>` : ""}</tr>`).join("")}</tbody></table></div>`;
  const pending = view.invitations.length === 0
    ? `<p class="empty-contexts" role="status">No pending invitations.</p>`
    : `<div class="directory-table"><table><caption>Pending invitations</caption><thead><tr><th>Email address</th><th>Role</th><th>Invited by</th><th>Expires</th>${view.writable ? "<th>Change</th>" : ""}</tr></thead><tbody>${view.invitations.map((invitation) =>
      `<tr><th scope="row">${e(invitation.email)}</th><td>${e(ROLE_NAMES[invitation.role] ?? invitation.role)}</td><td>${e(name(invitation.invitedBy))}</td><td>${e(dateText(invitation.expiresAt))}</td>${view.writable
        ? `<td><form method="post" action="${e(teamHref(view.orgId, `/invitations/${encodeURIComponent(invitation.id)}/revoke`))}"><button class="sign-out" type="submit">Revoke</button></form></td>` : ""}</tr>`).join("")}</tbody></table></div>`;
  const invite = view.writable
    ? `<h2>Invite someone</h2><form class="directory-filters" method="post" action="${e(teamHref(view.orgId, "/invite"))}"><label>Email address<input type="email" name="email" maxlength="254" required></label><label>Role<select name="role" required>${roleOptions}</select></label><label>Scope<select name="scope" required>${scopeOptions}</select></label><button class="sign-out" type="submit">Create invitation</button></form><p>The person accepts by signing in with Universe under this address. The link works for 7 days.</p>`
    : `<p role="status">You can see this team but only its owners can change it.</p>`;
  return layout(`<div class="profile-heading"><h1>${e(view.orgName)} team<span class="accent">.</span></h1></div>${members}<h2>Invitations</h2>${pending}${invite}`);
}

export function renderInviteCreated(orgId: string, result: { readonly email: string; readonly link: string; readonly mailed: boolean; readonly expiresAt: string }): string {
  const sent = result.mailed ? `<p>An email with this link was sent to ${e(result.email)}.</p>` : `<p>No email was sent. Copy this link and send it to ${e(result.email)} yourself.</p>`;
  return layout(`<div class="profile-heading"><h1>Invitation created<span class="accent">.</span></h1></div>${sent}<p><label>Invitation link (shown only now)<input type="text" readonly value="${e(result.link)}"></label></p><p>It works until ${e(dateText(result.expiresAt))}, once, for the person signed in with Universe under ${e(result.email)}.</p><p><a class="text-link" href="${e(teamHref(orgId))}">Back to the team</a></p>`);
}

export function renderRemoveConfirm(view: TeamView, principalId: string): string | undefined {
  const held = view.members.filter((member) => member.principalId === principalId);
  const first = held[0];
  if (!first) return undefined;
  const roles = held.map((member) => ROLE_NAMES[member.role] ?? member.role).join(", ");
  return layout(`<div class="profile-heading"><h1>Remove ${e(name(first))}?<span class="accent">.</span></h1></div><p>${e(name(first))} will lose ${e(roles)} on ${e(view.orgName)}. Roles they hold on other companies stay.</p><form method="post" action="${e(teamHref(view.orgId, `/members/${encodeURIComponent(principalId)}/remove`))}"><button class="sign-out" type="submit">Remove ${e(name(first))} from the team</button></form><p><a class="text-link" href="${e(teamHref(view.orgId))}">Cancel</a></p>`);
}

export function renderInvitation(token: string, invitation: { readonly orgName: string; readonly role: string; readonly scope: string }): string {
  return layout(`<div class="profile-heading"><h1>Join ${e(invitation.orgName)}<span class="accent">.</span></h1></div><p>You were invited to ${e(invitation.orgName)} as ${e(ROLE_NAMES[invitation.role] ?? invitation.role)} (${e(SCOPE_NAMES[invitation.scope] ?? invitation.scope)}).</p><form method="post" action="/invitations/${e(token)}/accept"><button class="sign-out" type="submit">Accept the invitation</button></form>`);
}

// --- Handler -------------------------------------------------------------------

function inviteCookie(header: string | undefined): string | undefined {
  for (const item of header?.split(";") ?? []) {
    const [key, ...parts] = item.trim().split("=");
    const value = parts.join("=");
    if (key === INVITE_COOKIE && isInvitationTokenShape(value)) return value;
  }
  return undefined;
}

const clearInviteCookie = `${INVITE_COOKIE}=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax`;

function redirect(res: ServerResponse, location: string, cookie?: string): true {
  res.writeHead(303, { location, "cache-control": "no-store", ...(cookie ? { "set-cookie": cookie } : {}) });
  res.end();
  return true;
}

function decode(value: string): string | undefined {
  try { return decodeURIComponent(value); } catch { return undefined; }
}

const sameOrigin = (req: IncomingMessage, origin: string | undefined): boolean =>
  origin !== undefined && req.headers.origin === origin && req.headers["sec-fetch-site"] !== "cross-site";

/**
 * Answers the Team and invitation paths, and sends a just-signed-in invitee
 * from GET /profile back to their link. Returns false for everything the
 * gateway should answer itself, including every caller without a right here.
 */
export async function handleCompanyTeam(
  req: IncomingMessage,
  res: ServerResponse,
  ports: CompanyTeamPorts | undefined,
  web: { readonly origin?: string; readonly returnTo?: string } | undefined,
  write: AccessPageWriter,
): Promise<boolean> {
  if (!ports) return false;
  const url = new URL(req.url ?? "/", "http://gateway.invalid");
  const path = url.pathname;
  const session = sessionCookie(req.headers.cookie);
  const caller = async (): Promise<string | undefined> => session ? (await ports.sessions.get(session))?.personId : undefined;

  if (path === "/profile") {
    const pending = req.method === "GET" ? inviteCookie(req.headers.cookie) : undefined;
    if (!pending || !await caller()) return false;
    return redirect(res, `/invitations/${pending}`, clearInviteCookie);
  }

  const invitationMatch = INVITATION.exec(path);
  if (invitationMatch) {
    const token = invitationMatch[1]!;
    const accepting = invitationMatch[2] !== undefined;
    if (accepting ? req.method !== "POST" : req.method !== "GET") return false;
    if (accepting && !sameOrigin(req, web?.origin)) {
      req.resume();
      write(403, "Invitation", simplePage("Invitation", REFUSAL_TEXT.invalid_request));
      return true;
    }
    if (accepting) req.resume();
    const principalId = await caller();
    if (!principalId) {
      if (!web?.returnTo) {
        write(503, "Invitation", simplePage("Invitation", "Sign-in is temporarily unavailable. Please try again later."));
        return true;
      }
      const cookie = isInvitationTokenShape(token)
        ? `${INVITE_COOKIE}=${token}; Path=/; Max-Age=${INVITE_COOKIE_SECONDS}; HttpOnly; Secure; SameSite=Lax` : undefined;
      return redirect(res, `/login/universe?return_to=${encodeURIComponent(web.returnTo)}`, cookie);
    }
    try {
      if (!accepting) {
        const invitation = await ports.team.invitation(token);
        if (!invitation) write(404, "Invitation", simplePage("Invitation", INVITATION_DEAD_TEXT));
        else write(200, `Join ${invitation.orgName}`, renderInvitation(token, invitation));
        return true;
      }
      const outcome = await ports.team.accept(token, principalId);
      if (outcome.kind === "invalid") write(404, "Invitation", simplePage("Invitation", INVITATION_DEAD_TEXT));
      else if (outcome.kind === "wrong_address") {
        write(403, "Invitation", simplePage("Invitation", `${INVITATION_WRONG_ADDRESS_TEXT}. Sign in with Universe under the address the invitation was sent to.`));
      } else return redirect(res, "/profile/access");
      return true;
    } catch {
      if (!res.headersSent) write(503, "Invitation", simplePage("Invitation", REFUSAL_TEXT.unavailable));
      else res.destroy();
      return true;
    }
  }

  const teamMatch = TEAM.exec(path);
  if (!teamMatch) return false;
  const orgId = decode(teamMatch[1]!);
  const principalId = await caller();
  if (!orgId || !principalId) return false;
  const action = teamMatch[2];
  const isRemove = teamMatch[4] !== undefined;
  const expected = action === undefined || (isRemove && req.method === "GET") ? "GET" : "POST";
  if (req.method !== expected) return false;

  const view = await ports.team.team(principalId, orgId);
  if (!view) {
    req.resume();
    return false;
  }
  const back = { href: teamHref(view.orgId), label: "Back to the team" };
  const refuse = (reason: keyof typeof REFUSAL_TEXT): true => {
    write(REFUSAL_STATUS[reason], "Team", simplePage("Team", REFUSAL_TEXT[reason], back));
    return true;
  };

  if (action === undefined) {
    write(200, `${view.orgName} team`, renderTeam(view));
    return true;
  }
  const targetId = isRemove ? decode(teamMatch[4]!) : undefined;
  if (isRemove && req.method === "GET") {
    if (!view.writable || !targetId) return false;
    const page = renderRemoveConfirm(view, targetId);
    if (!page) return refuse("not_found");
    write(200, "Remove from team", page);
    return true;
  }

  // Writes: same-origin form posts by an owner only.
  if (!view.writable) {
    req.resume();
    return false;
  }
  if (!sameOrigin(req, web?.origin)) {
    req.resume();
    write(403, "Team", simplePage("Team", REFUSAL_TEXT.invalid_request, back));
    return true;
  }
  try {
    if (action === "invite") {
      const form = await readForm(req);
      if (!form || Object.keys(form).some((key) => key !== "email" && key !== "role" && key !== "scope")) return refuse("invalid_request");
      const result = await ports.team.invite(principalId, view.orgId, { email: form.email ?? "", role: form.role ?? "", scope: form.scope ?? "" }, web!.origin!);
      if (result.kind === "refused") return refuse(result.reason);
      res.setHeader("cache-control", "no-store");
      write(201, "Invitation created", renderInviteCreated(view.orgId, result));
      return true;
    }
    req.resume();
    if (isRemove) {
      if (!targetId) return refuse("invalid_request");
      const result = await ports.team.remove(principalId, view.orgId, targetId);
      return result.kind === "refused" ? refuse(result.reason) : redirect(res, teamHref(view.orgId));
    }
    const invitationId = decode(teamMatch[3]!);
    if (!invitationId || !/^[0-9a-f-]{36}$/.test(invitationId)) return refuse("not_found");
    const result = await ports.team.revoke(principalId, view.orgId, invitationId);
    return result.kind === "refused" ? refuse(result.reason) : redirect(res, teamHref(view.orgId));
  } catch {
    if (!res.headersSent) return refuse("unavailable");
    res.destroy();
    return true;
  }
}
