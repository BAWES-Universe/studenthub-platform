import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import {
  CONTACT_CHANNELS_MAX,
  CONTACT_FORM_KEYS,
  CONTACT_LABEL_MAX,
  CONTACT_NAME_MAX,
  parseContactForm,
  type CompanyContact,
  type CompanyContactsService,
  type ContactFieldError,
  type ContactRefusal,
  type ContactsView,
} from "../../../../packages/access/src/index.js";
import { escapeHtml, readForm, sessionCookie, type AccessPageWriter } from "./admin-access.js";

/**
 * Access lane A3: a company's extra contacts, people without access.
 *
 * GET  /workspace/companies/{orgId}/contacts              list (owners, recruiters, finance, staff, admin)
 * POST /workspace/companies/{orgId}/contacts              add (owners, staff, admin)
 * GET  /workspace/companies/{orgId}/contacts/{id}/edit    the edit form
 * POST /workspace/companies/{orgId}/contacts/{id}         save changes
 * POST /workspace/companies/{orgId}/contacts/{id}/remove  remove (kept with removed_at, never listed)
 *
 * Anyone without a right here gets the gateway's unknown-path 404.
 */

export interface CompanyContactsPorts {
  readonly sessions: Pick<SessionStore, "get">;
  readonly contacts: CompanyContactsService;
}

const PATH = /^\/workspace\/companies\/([^/]+)\/contacts(?:\/([0-9a-f-]{36})(\/edit|\/remove)?)?$/;
const e = escapeHtml;
const brand = `<a class="brand" href="/" aria-label="StudentHub home"><span class="brand-mark" aria-hidden="true">s</span>studenthub<span class="brand-dot" aria-hidden="true">.</span></a>`;
export const contactsHref = (orgId: string, suffix = ""): string => `/workspace/companies/${encodeURIComponent(orgId)}/contacts${suffix}`;

const FIELD_TEXT: Readonly<Record<ContactFieldError, string>> = Object.freeze({
  name: `Enter a name of at most ${CONTACT_NAME_MAX} characters.`,
  role_title: `Enter a role title of at most ${CONTACT_NAME_MAX} characters, or leave it empty.`,
  phone: "Enter each phone number as 6 to 20 digits, with an optional + at the start.",
  email: "Enter each email address like name@example.com.",
  label: `Each label is at most ${CONTACT_LABEL_MAX} characters, next to a phone number or email address.`,
  too_many: `A contact has at most ${CONTACT_CHANNELS_MAX} phone numbers and ${CONTACT_CHANNELS_MAX} email addresses.`,
});
const REFUSAL_TEXT: Readonly<Record<ContactRefusal | "invalid_request" | "unavailable", string>> = Object.freeze({
  not_allowed: "Only an owner of this company, or StudentHub staff, can change its contacts.",
  unknown_organization: "This company no longer exists or was deleted.",
  not_found: "This contact was removed or doesn’t exist.",
  too_many_contacts: "This company already has the most contacts it can keep. Remove one first.",
  invalid_request: "Something in the form was not right. Go back and try again.",
  unavailable: "Contacts can’t be changed right now. Please try again later.",
});
const REFUSAL_STATUS: Readonly<Record<keyof typeof REFUSAL_TEXT, number>> = Object.freeze({
  not_allowed: 403, unknown_organization: 404, not_found: 404, too_many_contacts: 409, invalid_request: 400, unavailable: 503,
});

function layout(main: string): string {
  return `<header class="topbar">${brand}<form action="/logout" method="post"><button class="sign-out" type="submit">Sign out</button></form></header><div class="workspace"><aside class="sidebar"><div class="eyebrow">YOUR WORKSPACE</div><nav aria-label="Workspace"><a class="nav-item" href="/profile">My profile</a><a class="nav-item" href="/profile/access">Your access</a><a class="nav-item active" href="/workspace" aria-current="page">Workspaces</a></nav></aside><main id="main" class="profile-main">${main}<footer class="profile-footer">StudentHub · Connected by Universe</footer></main></div>`;
}

const channelText = (channel: { value: string; label: string | null }): string =>
  `${e(channel.value)}${channel.label ? ` <span class="field-meta">${e(channel.label)}</span>` : ""}`;

/** A read-only contacts table, used on the contacts page and on the Team page. */
export function renderContactsTable(view: ContactsView, actions: boolean): string {
  if (view.contacts.length === 0) return `<p class="empty-contexts" role="status">No contacts yet.</p>`;
  return `<div class="directory-table"><table><caption>Contacts (no access to StudentHub)</caption><thead><tr><th>Name</th><th>Role</th><th>Phone</th><th>Email address</th>${actions ? "<th>Change</th>" : ""}</tr></thead><tbody>${view.contacts.map((contact) =>
    `<tr><th scope="row">${e(contact.name)}</th><td>${contact.roleTitle ? e(contact.roleTitle) : "—"}</td><td>${contact.phones.map(channelText).join("<br>") || "—"}</td><td>${contact.emails.map(channelText).join("<br>") || "—"}</td>${actions
      ? `<td><a class="text-link" href="${e(contactsHref(view.orgId, `/${contact.id}/edit`))}">Edit</a><form method="post" action="${e(contactsHref(view.orgId, `/${contact.id}/remove`))}"><button class="sign-out" type="submit">Remove ${e(contact.name)}</button></form></td>` : ""}</tr>`).join("")}</tbody></table></div>`;
}

function contactForm(action: string, contact: CompanyContact | undefined, submit: string): string {
  const slots = (kind: "phone" | "email", label: string, type: string) => Array.from({ length: CONTACT_CHANNELS_MAX }, (_, index) => {
    const current = (kind === "phone" ? contact?.phones : contact?.emails)?.[index];
    return `<label>${label} ${index + 1}<input type="${type}" name="${kind}${index}" maxlength="254" value="${e(current?.value ?? "")}"></label><label>Label<input name="${kind}Label${index}" maxlength="${CONTACT_LABEL_MAX}" value="${e(current?.label ?? "")}"></label>`;
  }).join("");
  return `<form class="directory-filters" method="post" action="${e(action)}"><label>Name<input name="name" maxlength="${CONTACT_NAME_MAX}" required value="${e(contact?.name ?? "")}"></label><label>Role title<input name="roleTitle" maxlength="${CONTACT_NAME_MAX}" value="${e(contact?.roleTitle ?? "")}"></label><fieldset><legend>Phone numbers</legend>${slots("phone", "Phone", "tel")}</fieldset><fieldset><legend>Email addresses</legend>${slots("email", "Email", "email")}</fieldset><button class="sign-out" type="submit">${e(submit)}</button></form>`;
}

export function renderContacts(view: ContactsView): string {
  const add = view.writable
    ? `<h2>Add a contact</h2><p>A contact can’t sign in and has no access. To give someone access, invite them from the team page.</p>${contactForm(contactsHref(view.orgId), undefined, "Add contact")}`
    : `<p role="status">Only the company’s owners and StudentHub staff can change contacts.</p>`;
  return layout(`<div class="profile-heading"><h1>${e(view.orgName)} contacts<span class="accent">.</span></h1></div>${renderContactsTable(view, view.writable)}${add}`);
}

export function renderContactEdit(view: ContactsView, contact: CompanyContact): string {
  return layout(`<div class="profile-heading"><h1>Edit ${e(contact.name)}<span class="accent">.</span></h1></div>${contactForm(contactsHref(view.orgId, `/${contact.id}`), contact, "Save contact")}<p><a class="text-link" href="${e(contactsHref(view.orgId))}">Cancel</a></p>`);
}

function page(message: string, orgId: string): string {
  return layout(`<div class="profile-heading"><h1>Contacts<span class="accent">.</span></h1></div><p role="alert">${e(message)}</p><p><a class="text-link" href="${e(contactsHref(orgId))}">Back to the contacts</a></p>`);
}

export async function handleCompanyContacts(
  req: IncomingMessage,
  res: ServerResponse,
  ports: CompanyContactsPorts | undefined,
  origin: string | undefined,
  write: AccessPageWriter,
): Promise<boolean> {
  if (!ports) return false;
  const match = PATH.exec(new URL(req.url ?? "/", "http://gateway.invalid").pathname);
  if (!match) return false;
  let orgId: string;
  try { orgId = decodeURIComponent(match[1]!); } catch { return false; }
  const contactId = match[2];
  const suffix = match[3];
  const expected = contactId === undefined ? (req.method === "POST" ? "POST" : "GET") : suffix === "/edit" ? "GET" : "POST";
  if (req.method !== expected) return false;
  const session = sessionCookie(req.headers.cookie);
  const caller = session ? (await ports.sessions.get(session))?.personId : undefined;
  if (!caller) return false;
  const view = await ports.contacts.view(caller, orgId);
  if (!view) {
    req.resume();
    return false;
  }
  if (req.method === "GET") {
    if (!contactId) {
      write(200, `${view.orgName} contacts`, renderContacts(view));
      return true;
    }
    if (!view.writable) return false;
    const contact = view.contacts.find((item) => item.id === contactId);
    if (!contact) {
      write(404, "Contacts", page(REFUSAL_TEXT.not_found, view.orgId));
      return true;
    }
    write(200, `Edit ${contact.name}`, renderContactEdit(view, contact));
    return true;
  }
  if (!view.writable) {
    req.resume();
    return false;
  }
  const refuse = (reason: keyof typeof REFUSAL_TEXT, message = REFUSAL_TEXT[reason]): true => {
    write(REFUSAL_STATUS[reason], "Contacts", page(message, view.orgId));
    return true;
  };
  if (!origin || req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") {
    req.resume();
    return refuse("invalid_request");
  }
  const done = (): true => {
    res.writeHead(303, { location: contactsHref(view.orgId), "cache-control": "no-store" });
    res.end();
    return true;
  };
  try {
    if (suffix === "/remove") {
      req.resume();
      const result = await ports.contacts.remove(caller, view.orgId, contactId!);
      return result.kind === "refused" ? refuse(result.reason) : done();
    }
    const form = await readForm(req);
    if (!form || Object.keys(form).some((key) => !CONTACT_FORM_KEYS.has(key))) return refuse("invalid_request");
    const parsed = parseContactForm(form);
    if (!parsed.ok) return refuse("invalid_request", FIELD_TEXT[parsed.error]);
    const result = contactId
      ? await ports.contacts.update(caller, view.orgId, contactId, parsed.input)
      : await ports.contacts.create(caller, view.orgId, parsed.input);
    return result.kind === "refused" ? refuse(result.reason) : done();
  } catch {
    if (!res.headersSent) return refuse("unavailable");
    res.destroy();
    return true;
  }
}
