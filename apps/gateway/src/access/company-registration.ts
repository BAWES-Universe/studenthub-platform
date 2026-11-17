import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import {
  COMPANY_NAME_MAX,
  CONTACT_NAME_MAX,
  CONTACT_POSITION_MAX,
  EMAIL_MAX,
  REASON_MAX,
  REQUESTING_FOR_MAX,
  mayReviewRegistrations,
  parseCompanyRegistration,
  parseRegistrationReview,
  type AccessReadStore,
  type CompanyRegistration,
  type CompanyRegistrationService,
  type CompanyRegistrationStore,
  type ReviewRefusal,
} from "../../../../packages/access/src/index.js";
import { escapeHtml, readForm, sessionCookie } from "./admin-access.js";

/**
 * Access lane A7: a company signs up and StudentHub staff approve it.
 *
 * GET  /companies/register                  the form, and the person's own registrations
 * POST /companies/register                  submit one (at most one pending per person)
 * GET  /admin/access/registrations          the staff review queue (operator staff and admins)
 * POST /admin/access/registrations/{id}     approve or reject, with a reason
 *
 * The queue answers the unknown-path 404 to everyone else.
 */
export interface CompanyRegistrationPorts {
  readonly sessions: Pick<SessionStore, "get">;
  readonly reads: Pick<AccessReadStore, "callerGrants">;
  readonly registrations: Pick<CompanyRegistrationStore, "submit" | "mine" | "queue">;
  readonly service: CompanyRegistrationService;
  readonly operatorOrgIds?: readonly string[];
}

export type RegistrationPageWriter = (status: number, title: string, body: string) => void;

const REGISTER = "/companies/register";
const QUEUE = "/admin/access/registrations";
const REVIEW = /^\/admin\/access\/registrations\/([0-9a-f-]{36})$/;
const e = escapeHtml;

const brand = `<a class="brand" href="/" aria-label="StudentHub home"><span class="brand-mark" aria-hidden="true">s</span>studenthub<span class="brand-dot" aria-hidden="true">.</span></a>`;
function layout(main: string, staff: boolean): string {
  const nav = staff
    ? `<a class="nav-item" href="/profile">My profile</a><a class="nav-item" href="/workspace">Workspaces</a><a class="nav-item" href="/admin/access">Access</a><a class="nav-item active" href="${QUEUE}" aria-current="page">Company sign-ups</a>`
    : `<a class="nav-item" href="/profile">My profile</a><a class="nav-item" href="/workspace">Workspaces</a><a class="nav-item active" href="${REGISTER}" aria-current="page">Register a company</a>`;
  return `<header class="topbar">${brand}<form action="/logout" method="post"><button class="sign-out" type="submit">Sign out</button></form></header><div class="workspace"><aside class="sidebar"><div class="eyebrow">YOUR WORKSPACE</div><nav aria-label="Workspace">${nav}</nav></aside><main id="main" class="profile-main">${main}<footer class="profile-footer">StudentHub · Connected by Universe</footer></main></div>`;
}

const STATUS_TEXT = { pending: "Waiting for review", approved: "Approved", rejected: "Not approved" } as const;
const day = (iso: string) => iso.slice(0, 10);

const field = (id: string, label: string, name: string, max: number, extra = "") =>
  `<label for="${id}">${label}</label><input id="${id}" name="${name}" maxlength="${max}"${extra}>`;

export function renderRegisterForm(mine: readonly CompanyRegistration[], notice?: string): string {
  const pending = mine.some((row) => row.status === "pending");
  const form = pending
    ? `<p role="status">Your registration is waiting for StudentHub to review it. We’ll show the decision here.</p>`
    : `<form method="post" action="${REGISTER}">${field("reg-company", "Company name", "companyName", COMPANY_NAME_MAX, " minlength=\"2\" required autocomplete=\"organization\"")}${field("reg-contact", "Your name", "contactName", CONTACT_NAME_MAX, " minlength=\"2\" required autocomplete=\"name\"")}${field("reg-position", "Your position (optional)", "contactPosition", CONTACT_POSITION_MAX, " autocomplete=\"organization-title\"")}${field("reg-phone", "Phone number", "phoneNumber", 24, " type=\"tel\" minlength=\"6\" required autocomplete=\"tel\"")}${field("reg-email", "Company email address", "companyEmail", EMAIL_MAX, " type=\"email\" required autocomplete=\"email\"")}${field("reg-for", "What are you hiring for? (optional)", "requestingFor", REQUESTING_FOR_MAX)}<button class="button primary" type="submit">Send for review</button></form>`;
  const list = mine.length === 0 ? "" : `<section><h2>Your registrations</h2><div class="directory-table"><table><caption>Registrations you sent</caption><thead><tr><th>Company</th><th>Sent</th><th>Status</th><th>Note from StudentHub</th></tr></thead><tbody>${mine.map((row) =>
    `<tr><th scope="row">${e(row.companyName)}</th><td>${e(day(row.submittedAt))}</td><td>${STATUS_TEXT[row.status]}${row.status === "approved" ? ` · <a class="text-link" href="/workspace">Open your workspace</a>` : ""}</td><td>${row.status === "rejected" ? e(row.reviewReason ?? "") : ""}</td></tr>`).join("")}</tbody></table></div></section>`;
  return layout(`<div class="profile-heading"><h1>Register a company<span class="accent">.</span></h1></div><p>Tell us about your company. StudentHub reviews every registration; once it’s approved, the company is created and you become its owner. You’ll add your commercial licence when you activate the company.</p>${notice ? `<section class="notice context-notice" role="status"><strong>${e(notice)}</strong></section>` : ""}${form}${list}`, false);
}

export function renderRegistrationQueue(queue: { readonly pending: readonly CompanyRegistration[]; readonly decided: readonly CompanyRegistration[] }, notice?: string): string {
  const reason = (id: string) => `<label for="${id}">Reason (shown to the person if you reject)</label><textarea id="${id}" name="reason" minlength="3" maxlength="${REASON_MAX}" required></textarea>`;
  const pending = queue.pending.length === 0 ? `<p class="empty-contexts" role="status">No registration is waiting.</p>`
    : queue.pending.map((row, index) => `<article class="context-card"><h3>${e(row.companyName)}</h3><dl><dt>Sent by</dt><dd>${e(row.submitter.displayName ?? row.submitter.email ?? "Unknown")} (${e(row.submitter.email ?? "no email address")})</dd><dt>Contact</dt><dd>${e(row.contactName)}${row.contactPosition ? `, ${e(row.contactPosition)}` : ""}</dd><dt>Phone</dt><dd>${e(row.phoneNumber)}</dd><dt>Company email</dt><dd>${e(row.companyEmail)}</dd>${row.requestingFor ? `<dt>Hiring for</dt><dd>${e(row.requestingFor)}</dd>` : ""}<dt>Sent</dt><dd>${e(day(row.submittedAt))}</dd></dl><form method="post" action="${QUEUE}/${e(row.id)}"><input type="hidden" name="registrationId" value="${e(row.id)}">${reason(`review-reason-${index}`)}<button class="button primary" type="submit" name="action" value="approve">Approve and create the company</button> <button class="sign-out" type="submit" name="action" value="reject">Reject</button></form></article>`).join("");
  const decided = queue.decided.length === 0 ? "" : `<section><h2>Recently decided</h2><div class="directory-table"><table><caption>Decided registrations (latest ${queue.decided.length})</caption><thead><tr><th>Company</th><th>Decision</th><th>When</th><th>Reason</th></tr></thead><tbody>${queue.decided.map((row) =>
    `<tr><th scope="row">${e(row.companyName)}</th><td>${STATUS_TEXT[row.status]}</td><td>${e(day(row.reviewedAt ?? row.submittedAt))}</td><td>${e(row.reviewReason ?? "")}</td></tr>`).join("")}</tbody></table></div></section>`;
  return layout(`<div class="profile-heading"><h1>Company sign-ups<span class="accent">.</span></h1></div><p>Approving creates the company as active and approved to hire, and makes the person who sent it the owner.</p>${notice ? `<section class="notice context-notice" role="status"><strong>${e(notice)}</strong></section>` : ""}<section><h2>Waiting for review (${queue.pending.length})</h2>${pending}</section>${decided}`, true);
}

const REFUSALS: Readonly<Record<ReviewRefusal | "invalid_request" | "unavailable", [number, string]>> = Object.freeze({
  invalid_request: [400, "Choose approve or reject and give a reason of 3 to 500 characters."],
  unavailable: [503, "Company sign-ups are unavailable right now. Please try again in a moment."],
  not_allowed: [403, "Only StudentHub staff can review company sign-ups."],
  unknown_registration: [404, "This registration no longer exists."],
  already_decided: [409, "Someone already decided this registration."],
  own_registration: [409, "You can’t review a registration you sent. Ask another member of staff."],
  name_taken: [409, "A company with this name already exists. Reject this registration with a reason, or rename the existing company first."],
  submitter_paused: [409, "The person who sent this has their access paused. Resume their access before approving."],
});

const sameOrigin = (req: IncomingMessage, origin: string | undefined) =>
  Boolean(origin) && req.headers.origin === origin && req.headers["sec-fetch-site"] !== "cross-site";

function redirect(res: ServerResponse, location: string): true {
  res.writeHead(303, { location, "cache-control": "no-store" });
  res.end();
  return true;
}

export async function handleCompanyRegistration(
  req: IncomingMessage,
  res: ServerResponse,
  ports: CompanyRegistrationPorts | undefined,
  origin: string | undefined,
  write: RegistrationPageWriter,
): Promise<boolean> {
  if (!ports) return false;
  const url = new URL(req.url ?? "/", "http://gateway.invalid");
  const path = url.pathname;
  const review = REVIEW.exec(path);
  if (path !== REGISTER && path !== QUEUE && !review) return false;
  if (req.method !== "GET" && req.method !== "POST") return false;
  if ((path === QUEUE && req.method !== "GET") || (review && req.method !== "POST")) return false;
  const session = sessionCookie(req.headers.cookie);
  const caller = session ? (await ports.sessions.get(session))?.personId : undefined;

  if (path === REGISTER) {
    if (!caller) {
      req.resume();
      write(200, "Register a company", `<header class="topbar">${brand}</header><main id="main" class="error-page"><div class="eyebrow">STUDENTHUB</div><h1>Register a company</h1><p>Sign in first, then come back to this page to register your company.</p><p><a class="button primary" href="/login/universe">Sign in</a></p></main>`);
      return true;
    }
    if (req.method === "GET") {
      const done = url.searchParams.get("done");
      write(200, "Register a company", renderRegisterForm(await ports.registrations.mine(caller), done === "submitted" ? "Thanks. Your registration was sent for review." : undefined));
      return true;
    }
    const refuse = (status: number, text: string) => {
      write(status, "Register a company", layout(`<div class="profile-heading"><h1>Nothing was sent<span class="accent">.</span></h1></div><p>${e(text)}</p><p><a class="button primary" href="${REGISTER}">Back</a></p>`, false));
      return true;
    };
    if (!sameOrigin(req, origin)) {
      req.resume();
      return refuse(400, "Send the registration from this page.");
    }
    const form = await readForm(req);
    const keys = ["companyName", "contactName", "contactPosition", "phoneNumber", "companyEmail", "requestingFor"];
    const request = form && Object.keys(form).every((key) => keys.includes(key)) ? parseCompanyRegistration(form) : undefined;
    if (!request) return refuse(400, "Fill in the company name, your name, a phone number and a company email address.");
    const outcome = await ports.registrations.submit(caller, request);
    if (outcome.kind === "refused") return refuse(409, outcome.reason === "already_pending" ? "You already have a registration waiting for review." : "Your account couldn’t be found. Sign in again.");
    return redirect(res, `${REGISTER}?done=submitted`);
  }

  // The staff queue: the unknown-path 404 for anyone without the right.
  if (!caller || !mayReviewRegistrations(await ports.reads.callerGrants(caller), ports.operatorOrgIds)) return false;
  if (req.method === "GET") {
    const done = url.searchParams.get("done");
    write(200, "Company sign-ups", renderRegistrationQueue(await ports.registrations.queue(),
      done === "approved" ? "The company was created and its owner can use it now." : done === "rejected" ? "The registration was rejected." : undefined));
    return true;
  }
  const refuse = (key: keyof typeof REFUSALS) => {
    const [status, text] = REFUSALS[key];
    write(status, "Company sign-ups", layout(`<div class="profile-heading"><h1>Nothing was changed<span class="accent">.</span></h1></div><p>${e(text)}</p><p><a class="button primary" href="${QUEUE}">Back to company sign-ups</a></p>`, true));
    return true;
  };
  if (!sameOrigin(req, origin)) {
    req.resume();
    return refuse("invalid_request");
  }
  const form = await readForm(req);
  const parsed = form && Object.keys(form).every((key) => key === "registrationId" || key === "action" || key === "reason") ? parseRegistrationReview(form) : undefined;
  if (!parsed || parsed.registrationId !== review![1]) return refuse("invalid_request");
  try {
    const outcome = await ports.service.review(caller, parsed);
    if (outcome.kind === "refused") return refuse(outcome.reason);
    return redirect(res, `${QUEUE}?done=${outcome.kind}`);
  } catch {
    return refuse("unavailable");
  }
}
