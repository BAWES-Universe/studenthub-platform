import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import {
  ProfileRecordError, isProfileRecordKind,
  type ProfileBackground, type ProfileRecord, type ProfileRecordKind, type ProfileRecords, type ReferenceType,
} from "@studenthub/profile-records";

const BODY_LIMIT = 16 * 1024;
const SESSION_COOKIE = "__Host-studenthub_session";

export interface ReferenceOption { readonly id: string; readonly name: string }

/** Everything the routes need. Built from validated runtime configuration, never from a request. */
export interface ProfileRecordsRuntime {
  readonly service: ProfileRecords;
  readonly sessions: SessionStore;
  /** Exact browser origin; cookie-authenticated writes must come from it. */
  readonly origin: string;
  /** Approved catalogue entries for the education form. */
  readonly options: (type: ReferenceType) => Promise<readonly ReferenceOption[]>;
}

function sessionCredential(request: IncomingMessage): string | undefined {
  const auth = request.headers.authorization;
  if (auth?.startsWith("Bearer ") && /^[A-Za-z0-9_-]{43}$/.test(auth.slice(7))) return auth.slice(7);
  for (const item of request.headers.cookie?.split(";") ?? []) {
    const [key, ...value] = item.trim().split("=");
    const candidate = value.join("=");
    if (key === SESSION_COOKIE && /^[A-Za-z0-9_-]{43}$/.test(candidate)) return candidate;
  }
  return undefined;
}

async function readBody(request: IncomingMessage): Promise<string> {
  if (Number(request.headers["content-length"]) > BODY_LIMIT) { request.resume(); throw new ProfileRecordError("profile_record_too_large", 400); }
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > BODY_LIMIT) { request.resume(); throw new ProfileRecordError("profile_record_too_large", 400); }
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

async function jsonBody(request: IncomingMessage): Promise<unknown> {
  if (!request.headers["content-type"]?.startsWith("application/json")) throw new ProfileRecordError("invalid_profile_record", 400);
  try { return JSON.parse(await readBody(request)) as unknown; }
  catch (error) { if (error instanceof ProfileRecordError) throw error; throw new ProfileRecordError("invalid_profile_record", 400); }
}

/** Native form posts. Only named fields pass; blanks are treated as absent. */
async function formBody(request: IncomingMessage, allowed: readonly string[]): Promise<Record<string, string>> {
  if (!request.headers["content-type"]?.startsWith("application/x-www-form-urlencoded")) throw new ProfileRecordError("invalid_profile_record", 400);
  const params = new URLSearchParams(await readBody(request));
  const out: Record<string, string> = {};
  for (const [key, value] of params) {
    if (!allowed.includes(key) || Object.hasOwn(out, key)) throw new ProfileRecordError("invalid_profile_record", 400);
    if (value.trim() !== "") out[key] = value;
  }
  return out;
}

const FORM_FIELDS: Readonly<Record<ProfileRecordKind, readonly string[]>> = {
  education: ["educationType", "universityId", "institutionName", "degreeId", "majorId", "customMajor", "graduationYear", "currentlyStudying"],
  experience: ["title", "employer", "startYear", "endYear"],
  skill: ["name"],
  link: ["title", "url"],
};

function sameOrigin(request: IncomingMessage, origin: string): boolean {
  return request.headers.origin === origin && request.headers["sec-fetch-site"] !== "cross-site";
}

function sendJson(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
  response.end(JSON.stringify(body));
}

function errorCode(error: unknown): { status: number; code: string } {
  if (error instanceof ProfileRecordError) return { status: error.status, code: error.code };
  return { status: 503, code: "profile_records_unavailable" };
}

/**
 * SHU-144 routes. JSON under /profile/records, a native-form page under /profile/background.
 * The owner is always the session's principal; no route accepts a principal, owner or person id.
 */
export async function handleProfileRecords(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: ProfileRecordsRuntime | undefined,
  renderPage: (status: number, body: string) => void,
): Promise<boolean> {
  const raw = request.url ?? "";
  const url = new URL(raw, "http://gateway.invalid");
  const json = url.pathname === "/profile/records" || url.pathname.startsWith("/profile/records/");
  const page = url.pathname === "/profile/background" || url.pathname.startsWith("/profile/background/");
  if (!json && !page) return false;
  const parts = url.pathname.split("/").filter(Boolean).slice(2);

  if (!runtime) {
    if (json) sendJson(response, 503, { error: "profile_records_unavailable" });
    else renderPage(503, unavailablePage());
    return true;
  }

  const credential = sessionCredential(request);
  let ownerId: string | undefined;
  try {
    ownerId = credential ? (await runtime.sessions.get(credential))?.personId : undefined;
  } catch {
    if (json) sendJson(response, 503, { error: "profile_records_unavailable" });
    else renderPage(503, unavailablePage());
    return true;
  }
  if (!ownerId) {
    if (json) sendJson(response, 401, { error: "unauthorized" });
    else renderPage(401, signedOutPage());
    return true;
  }

  const write = request.method !== "GET";
  if (write && !sameOrigin(request, runtime.origin)) {
    if (json) sendJson(response, 403, { error: "forbidden" });
    else renderPage(403, deniedPage());
    return true;
  }

  try {
    if (json) {
      await routeJson(request, response, runtime.service, ownerId, parts);
      return true;
    }
    if (request.method === "GET" && parts.length === 0) {
      const [background, universities, degrees, majors] = await Promise.all([
        runtime.service.background(ownerId),
        runtime.options("university").catch(() => []),
        runtime.options("degree").catch(() => []),
        runtime.options("major").catch(() => []),
      ]);
      renderPage(200, backgroundPage(background, { universities, degrees, majors }, url.searchParams));
      return true;
    }
    if (request.method === "POST" && parts.length === 1 && isProfileRecordKind(parts[0])) {
      const kind = parts[0];
      await runtime.service.create(ownerId, kind, await formBody(request, FORM_FIELDS[kind]));
      redirect(response, `?saved=${kind}#${kind}`);
      return true;
    }
    if (request.method === "POST" && parts.length === 3 && isProfileRecordKind(parts[0]) && (parts[2] === "remove" || parts[2] === "restore")) {
      await formBody(request, []);
      if (parts[2] === "remove") await runtime.service.remove(ownerId, parts[0], parts[1]);
      else await runtime.service.restore(ownerId, parts[0], parts[1]);
      redirect(response, `?${parts[2] === "remove" ? "removed" : "restored"}=${parts[0]}#${parts[0]}`);
      return true;
    }
    renderPage(404, deniedPage());
  } catch (error) {
    const { status, code } = errorCode(error);
    if (json) { sendJson(response, status, { error: code }); return true; }
    if (status === 400 || status === 409) {
      const kind = parts[0] && isProfileRecordKind(parts[0]) ? parts[0] : "education";
      redirect(response, `?error=${encodeURIComponent(code)}&on=${kind}#${kind}`);
    } else renderPage(status === 404 ? 404 : 503, status === 404 ? deniedPage() : unavailablePage());
  }
  return true;
}

async function routeJson(request: IncomingMessage, response: ServerResponse, service: ProfileRecords, ownerId: string, parts: readonly string[]): Promise<void> {
  if (request.method === "GET" && parts.length === 0) return sendJson(response, 200, await service.background(ownerId));
  if (request.method === "PUT" && parts.length === 1 && parts[0] === "skill") {
    const body = await jsonBody(request);
    const keys = typeof body === "object" && body !== null && !Array.isArray(body) ? Object.keys(body) : [];
    if (keys.length !== 1 || keys[0] !== "skills") throw new ProfileRecordError("invalid_profile_record", 400);
    return sendJson(response, 200, { skills: await service.replaceSkills(ownerId, (body as { skills: unknown }).skills) });
  }
  if (request.method === "POST" && parts.length === 1) return sendJson(response, 201, await service.create(ownerId, parts[0], await jsonBody(request)));
  if (request.method === "PATCH" && parts.length === 2) return sendJson(response, 200, await service.update(ownerId, parts[0], parts[1], await jsonBody(request)));
  if (request.method === "POST" && parts.length === 3 && parts[2] === "remove") return sendJson(response, 200, await service.remove(ownerId, parts[0], parts[1]));
  if (request.method === "POST" && parts.length === 3 && parts[2] === "restore") return sendJson(response, 200, await service.restore(ownerId, parts[0], parts[1]));
  sendJson(response, 404, { error: "not_found" });
}

function redirect(response: ServerResponse, query: string): void {
  response.writeHead(303, { location: `/profile/background${query}`, "cache-control": "no-store" });
  response.end();
}

// ---- HTML ---------------------------------------------------------------

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char]!);
}

const KIND_TITLES: Readonly<Record<ProfileRecordKind, string>> = {
  education: "Education", experience: "Experience", skill: "Skills", link: "Links",
};

const ERROR_TEXT: Readonly<Record<string, string>> = {
  invalid_education_type: "Choose what kind of study this is.",
  invalid_institution: "Pick a university from the list, or type the name of your school if it isn’t listed.",
  invalid_institution_name: "The school name is too long or has unusual characters.",
  invalid_university: "That university isn’t in the list any more. Please pick another.",
  invalid_degree: "That degree isn’t in the list any more. Please pick another.",
  invalid_major: "Pick a major from the list or type your own, not both.",
  invalid_custom_major: "The major is too long or has unusual characters.",
  invalid_graduation_year: "Enter a graduation year between 1950 and 2100.",
  invalid_experience_title: "Enter your role, up to 128 characters.",
  invalid_employer: "Enter the employer, up to 128 characters.",
  invalid_start_year: "Enter the year you started, between 1950 and 2100.",
  invalid_end_year: "The end year can’t be before the start year.",
  invalid_skill: "Enter a skill, up to 128 characters.",
  duplicate_skill: "You already have that skill.",
  invalid_link_title: "Give the link a title, up to 128 characters.",
  invalid_link_url: "Enter a full web address starting with https://",
  profile_record_limit: "You’ve reached the limit of 50 entries here. Remove one first.",
  profile_record_too_large: "That was too much text to save.",
};

const brand = `<a class="brand" href="/" aria-label="StudentHub home"><span class="brand-mark" aria-hidden="true">s</span>studenthub<span class="brand-dot" aria-hidden="true">.</span></a>`;

function shell(main: string): string {
  return `<header class="topbar">${brand}<form action="/logout" method="post"><button class="sign-out" type="submit">Sign out <span aria-hidden="true">↗</span></button></form></header><div class="workspace"><aside class="sidebar"><div class="eyebrow">YOUR WORKSPACE</div><nav aria-label="Workspace"><a class="nav-item" href="/profile">My profile</a><a class="nav-item active" href="/profile/background" aria-current="page">Education and experience</a><a class="nav-item" href="/workspace">Workspaces</a></nav><p class="sidebar-note">One Universe account.<br>Your StudentHub space.</p></aside><main id="main" class="profile-main">${main}<footer class="profile-footer">StudentHub · Connected by Universe</footer></main></div>`;
}

function message(params: URLSearchParams, kind: ProfileRecordKind): string {
  const error = params.get("error");
  if (error && params.get("on") === kind) {
    return `<p class="form-message error" role="alert">${escapeHtml(ERROR_TEXT[error] ?? "That couldn’t be saved. Please check the details and try again.")}</p>`;
  }
  if (params.get("saved") === kind) return `<p class="form-message" role="status">Saved.</p>`;
  if (params.get("removed") === kind) return `<p class="form-message" role="status">Removed. You can restore it below.</p>`;
  if (params.get("restored") === kind) return `<p class="form-message" role="status">Restored.</p>`;
  return "";
}

function removeButton(record: ProfileRecord): string {
  return `<form method="post" action="/profile/background/${record.kind}/${record.id}/remove"><button class="link-button" type="submit">Remove</button></form>`;
}

function select(name: string, label: string, options: readonly ReferenceOption[], blank: string): string {
  return `<label>${label}<select name="${name}"><option value="">${blank}</option>${options.map((o) => `<option value="${escapeHtml(o.id)}">${escapeHtml(o.name)}</option>`).join("")}</select></label>`;
}

function nameOf(options: readonly ReferenceOption[], id: string | undefined): string | undefined {
  return id === undefined ? undefined : options.find((o) => o.id === id)?.name;
}

interface Options { readonly universities: readonly ReferenceOption[]; readonly degrees: readonly ReferenceOption[]; readonly majors: readonly ReferenceOption[] }

function describe(record: ProfileRecord, options: Options): { title: string; detail: string } {
  const f = record.fields as unknown as Record<string, unknown>;
  switch (record.kind) {
    case "education": {
      const school = (f.institutionName as string | undefined) ?? nameOf(options.universities, f.universityId as string | undefined)
        ?? (f.educationType === "not_studying" ? "Not studying" : "Listed university");
      const major = (f.customMajor as string | undefined) ?? nameOf(options.majors, f.majorId as string | undefined);
      const degree = nameOf(options.degrees, f.degreeId as string | undefined);
      const when = f.currentlyStudying ? "Studying now" : f.graduationYear ? `Graduated ${String(f.graduationYear)}` : "";
      return { title: school, detail: [degree, major, f.educationType === "studying_abroad" ? "Abroad" : undefined, when].filter(Boolean).join(" · ") };
    }
    case "experience":
      return { title: `${String(f.title)} at ${String(f.employer)}`, detail: `${String(f.startYear)} – ${f.endYear === undefined ? "now" : String(f.endYear)}` };
    case "skill":
      return { title: String(f.name), detail: "" };
    case "link":
      return { title: String(f.title), detail: String(f.url) };
  }
}

function list(records: readonly ProfileRecord[], options: Options, empty: string): string {
  if (records.length === 0) return `<p class="empty-records">${empty}</p>`;
  return `<ul class="record-list">${records.map((record) => {
    const { title, detail } = describe(record, options);
    const body = record.kind === "link"
      ? `<a href="${escapeHtml(detail)}" rel="noopener noreferrer nofollow" target="_blank">${escapeHtml(title)}</a><small>${escapeHtml(detail)}</small>`
      : `<strong>${escapeHtml(title)}</strong>${detail ? `<small>${escapeHtml(detail)}</small>` : ""}`;
    return `<li><div>${body}</div>${removeButton(record)}</li>`;
  }).join("")}</ul>`;
}

function section(kind: ProfileRecordKind, records: readonly ProfileRecord[], options: Options, params: URLSearchParams, empty: string, form: string): string {
  return `<section class="record-section" id="${kind}" aria-labelledby="${kind}-title"><h2 id="${kind}-title">${KIND_TITLES[kind]}</h2>${message(params, kind)}${list(records, options, empty)}<details class="record-add"${params.get("on") === kind ? " open" : ""}><summary>Add ${kind === "skill" ? "a skill" : kind === "link" ? "a link" : kind === "education" ? "education" : "experience"}</summary><form class="record-form" method="post" action="/profile/background/${kind}">${form}<button class="button primary" type="submit">Save <span aria-hidden="true">→</span></button></form></details></section>`;
}

export function backgroundPage(background: ProfileBackground, options: Options, params: URLSearchParams = new URLSearchParams()): string {
  const listed = options.universities.length > 0;
  const educationForm = `<label>Type of study<select name="educationType" required>${listed ? '<option value="standard">A university in the list</option>' : ""}<option value="custom_university">A school that isn’t listed</option><option value="studying_abroad">Studying abroad</option><option value="not_studying">Not studying</option></select></label>${listed ? select("universityId", "University", options.universities, "Choose a university") : ""}<label>School name (if it isn’t listed)<input name="institutionName" maxlength="160"></label>${options.degrees.length ? select("degreeId", "Degree", options.degrees, "No degree selected") : ""}${options.majors.length ? select("majorId", "Major", options.majors, "Choose a major") : ""}<label>Major (if it isn’t listed)<input name="customMajor" maxlength="128"></label><label>Graduation year<input name="graduationYear" inputmode="numeric" pattern="[0-9]{4}" maxlength="4"></label><label class="check"><input type="checkbox" name="currentlyStudying" value="true"> I’m studying here now</label>`;
  const experienceForm = `<label>Role<input name="title" maxlength="128" required></label><label>Employer<input name="employer" maxlength="128" required></label><label>Start year<input name="startYear" inputmode="numeric" pattern="[0-9]{4}" maxlength="4" required></label><label>End year (leave blank if you still work there)<input name="endYear" inputmode="numeric" pattern="[0-9]{4}" maxlength="4"></label>`;
  const skillForm = `<label>Skill<input name="name" maxlength="128" required></label>`;
  const linkForm = `<label>Title<input name="title" maxlength="128" required></label><label>Web address<input name="url" type="url" maxlength="2048" placeholder="https://" required></label>`;
  const removed = background.removed.length === 0 ? "" : `<section class="record-section" id="removed" aria-labelledby="removed-title"><h2 id="removed-title">Recently removed</h2><ul class="record-list">${background.removed.map((record) => {
    const { title } = describe(record, options);
    return `<li><div><strong>${escapeHtml(title)}</strong><small>${KIND_TITLES[record.kind]}</small></div><form method="post" action="/profile/background/${record.kind}/${record.id}/restore"><button class="link-button" type="submit">Restore</button></form></li>`;
  }).join("")}</ul></section>`;
  return shell(`<div class="profile-heading"><div><div class="eyebrow">YOUR PROFILE</div><h1>Education and experience<span class="accent">.</span></h1><p>Add where you study, where you’ve worked, your skills and links. Only you can see and change these.</p></div></div>${section("education", background.education, options, params, "No education added yet.", educationForm)}${section("experience", background.experience, options, params, "No experience added yet.", experienceForm)}${section("skill", background.skill, options, params, "No skills added yet.", skillForm)}${section("link", background.link, options, params, "No links added yet.", linkForm)}${removed}`);
}

function signedOutPage(): string {
  return `<header class="topbar">${brand}<a class="text-link" href="/">Back to StudentHub</a></header><main id="main" class="error-page"><div class="eyebrow">STUDENTHUB ACCOUNT</div><h1>Let’s get you signed in.</h1><p>Sign in to add your education and experience.</p><a class="button primary" href="/">Sign in <span aria-hidden="true">→</span></a></main>`;
}

function deniedPage(): string {
  return `<header class="topbar">${brand}<a class="text-link" href="/profile/background">Back</a></header><main id="main" class="error-page"><div class="eyebrow">STUDENTHUB ACCOUNT</div><h1>We couldn’t complete that request.</h1><p>Nothing was changed. Go back and try again.</p><a class="button primary" href="/profile/background">Education and experience <span aria-hidden="true">→</span></a></main>`;
}

function unavailablePage(): string {
  return `<header class="topbar">${brand}<a class="text-link" href="/">Back to StudentHub</a></header><main id="main" class="error-page"><div class="eyebrow">STUDENTHUB ACCOUNT</div><h1>We couldn’t load that just now.</h1><p>Nothing was changed. Please try again in a moment.</p><a class="button primary" href="/profile/background">Try again <span aria-hidden="true">→</span></a></main>`;
}

export const PROFILE_RECORDS_CSS = `
.record-section{background:white;border:1px solid var(--border);border-radius:1rem;padding:1.75rem 2rem;margin-bottom:1.5rem}.record-section h2{font-size:1.25rem;letter-spacing:-.02em;margin-bottom:1rem}.record-list{list-style:none;margin:0 0 1rem;padding:0}.record-list li{display:flex;justify-content:space-between;align-items:center;gap:1rem;padding:.9rem 0;border-bottom:1px solid var(--border)}.record-list li:last-child{border-bottom:0}.record-list strong,.record-list a{display:block;font-weight:600;overflow-wrap:anywhere}.record-list small{display:block;color:var(--muted);font-size:.85rem;margin-top:.15rem;overflow-wrap:anywhere}.empty-records{margin-bottom:1rem}.link-button{border:0;background:none;color:#1d46b8;font-weight:600;cursor:pointer;padding:.5rem;min-height:2.75rem;white-space:nowrap;overflow-wrap:normal}.record-list li>div{min-width:0}.record-list li>form{flex-shrink:0}.record-add summary{cursor:pointer;font-weight:650;color:#1d46b8;padding:.5rem 0;min-height:2.75rem}.record-form{display:grid;gap:1rem;margin-top:.75rem;max-width:32rem}.record-form label{display:grid;gap:.35rem;font-size:.9rem;color:var(--muted)}.record-form input,.record-form select{font:inherit;color:#172433;border:1px solid #c8d2e1;border-radius:.55rem;padding:.7rem .8rem;min-height:2.75rem;background:white}.record-form .check{display:flex;align-items:center;gap:.6rem}.record-form .check input{min-height:auto;width:1.1rem;height:1.1rem}.record-form .button{border:0;cursor:pointer;justify-content:space-between}.form-message{margin-bottom:1rem;padding:.75rem 1rem;border-radius:.55rem;background:#eef6ee;color:#1f5130}.form-message.error{background:#fdf0ec;color:#8a2d12}
@media(max-width:480px){.record-section{padding:1.25rem}.record-list li{align-items:flex-start}}
`;
