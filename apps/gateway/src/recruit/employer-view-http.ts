import type { IncomingMessage, ServerResponse } from "node:http";
import type { SessionStore } from "@studenthub/login-contract";
import type { CandidateDocuments } from "../../../../packages/private-documents/src/candidate-lifecycle.js";
import { EMPLOYER_DELIVERY_PATH, EmployerDocuments } from "../../../../packages/private-documents/src/employer-delivery.js";
import { employerMaySee, employerPersonView, isRecruitId, type EmployerLinkRow, type EmployerPersonRow, type EmployerPersonView, type EmployerRecordRow } from "../../../../packages/recruit/src/index.js";
import { NOT_FOUND, UNAUTHORIZED, decodeSegment, errorPage, html, sendJson, sessionCookie, type RecruitPageWriter, type RecruitResult } from "./http-common.js";

// Recruit R5: GET /recruit/requests/<requestId>/people/<personId> shows a person
// suggested to, invited to or working through a request to the request's company
// (and to operator staff). Documents (CV, photo, civil ID images) come only as
// authorised, time-limited, audited links from the documents area, through a port.

export interface RecruitEmployerViewStore {
  person(principalId: string, requestId: string, personId: string): Promise<{ person: EmployerPersonRow; records: readonly EmployerRecordRow[]; link: EmployerLinkRow; staff: boolean } | null>;
  recordEmployerDocumentView(view: { viewerPrincipalId: string; subjectPrincipalId: string; requestId: string; operation: "issue" | "deliver"; documentType: string; documentVersion: string }): Promise<void>;
}
export type EmployerDocumentLink = { readonly type: "personal-photo" | "resume" | "civil-id-front" | "civil-id-back"; readonly url: string; readonly expiresAt: string };
/** Per-viewer, expiring, signed and audited document links; "unavailable" until the documents store is wired. */
export interface EmployerDocumentsPort {
  links(session: string, personId: string, requestId: string): Promise<readonly EmployerDocumentLink[] | "unavailable">;
  deliver(session: string, url: string): Promise<{ bytes: Buffer; headers: Record<string, string> }>;
}
export const EMPLOYER_DOCUMENTS_UNAVAILABLE: EmployerDocumentsPort = { links: async () => "unavailable", deliver: async () => { throw new Error("unavailable"); } };

export interface EmployerPersonBody { readonly requestId: string; readonly person: EmployerPersonView; readonly documents: readonly EmployerDocumentLink[] | null }
export interface RecruitEmployerView {
  person(session: string | undefined, requestId: string, personId: string): Promise<RecruitResult<EmployerPersonBody>>;
  /** The document bytes behind an issued link, or undefined when refused (answered as not found). */
  deliver(session: string | undefined, url: string): Promise<{ bytes: Buffer; headers: Record<string, string> } | undefined>;
  /** The same view with links issued from the candidate documents store. */
  withDocuments(documents: CandidateDocuments): RecruitEmployerView;
}

/** Sight through a request, as the employer page decides it: staff, or a company or store reader with a live link. */
export async function employerSight(store: RecruitEmployerViewStore, viewer: string, personId: string, requestId: string): Promise<boolean> {
  const r = await store.person(viewer, requestId, personId);
  return Boolean(r && (r.staff || employerMaySee(r.link)));
}

export function employerDocumentsPort(store: RecruitEmployerViewStore, documents: CandidateDocuments): EmployerDocumentsPort {
  const delivery = new EmployerDocuments({ documents, sight: { maySee: (viewer, subject, requestId) => employerSight(store, viewer, subject, requestId) }, audit: { recordView: (view) => store.recordEmployerDocumentView(view) } });
  return {
    links: async (session, personId, requestId) => (await delivery.links(session, personId, requestId)).map((l) => ({ type: l.type, url: l.url, expiresAt: new Date(l.expiresAt).toISOString() })),
    deliver: (session, url) => delivery.deliver(session, url),
  };
}

const kuwaitToday = (now: Date) => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Kuwait", year: "numeric", month: "2-digit", day: "2-digit" }).format(now);

export function createRecruitEmployerView(p: { sessions: Pick<SessionStore, "get">; store: RecruitEmployerViewStore; documents?: EmployerDocumentsPort; now?: () => Date }): RecruitEmployerView {
  return {
    withDocuments: (documents) => createRecruitEmployerView({ ...p, documents: employerDocumentsPort(p.store, documents) }),
    async deliver(s, url) {
      if (!s || !p.documents) return undefined;
      try { return await p.documents.deliver(s, url); } catch { return undefined; }
    },
    async person(s, requestId, personId) {
      const id = s ? (await p.sessions.get(s))?.personId : undefined;
      if (!id) return UNAUTHORIZED;
      if (!isRecruitId(requestId) || personId.length < 1 || personId.length > 255) return NOT_FOUND;
      const r = await p.store.person(id, requestId.toLowerCase(), personId);
      if (!r || !(r.staff || employerMaySee(r.link))) return NOT_FOUND;
      const links = await (p.documents ?? EMPLOYER_DOCUMENTS_UNAVAILABLE).links(s!, personId, requestId.toLowerCase()).catch(() => "unavailable" as const);
      return { status: 200, body: { requestId: requestId.toLowerCase(), person: employerPersonView(r.person, r.records, r.link, kuwaitToday((p.now ?? (() => new Date()))())), documents: links === "unavailable" ? null : links } };
    },
  };
}

const GENDER: Readonly<Record<string, string>> = { male: "Male", female: "Female", other: "Other" };
const DOC: Readonly<Record<EmployerDocumentLink["type"], string>> = { "personal-photo": "Photo", resume: "CV", "civil-id-front": "Civil ID (front)", "civil-id-back": "Civil ID (back)" };
const STAGE: Readonly<Record<string, string>> = { suggested: "Suggested", contacted: "Contacted", interviewing: "Interviewing", offered: "Offered", placed: "Placed" };

export function renderEmployerPerson(body: EmployerPersonBody): string {
  const v = body.person;
  const row = (label: string, value: string | null) => (value ? `<div><dt>${html(label)}</dt><dd>${html(value)}</dd></div>` : "");
  const facts = [
    row("Arabic name", v.arabicName), row("Objective", v.objective), row("Age", v.age === null ? null : String(v.age)), row("Gender", v.gender ? GENDER[v.gender] ?? v.gender : null),
    row("Nationality", v.nationality), row("Area", v.area), row("Driving licence", v.drivingLicence === null ? null : v.drivingLicence ? "Yes" : "No"),
    row("Preferred time", v.preferredTime), row("On this request", v.stage ? STAGE[v.stage] ?? v.stage : v.invitation ? "Invited" : null),
  ].join("");
  const education = v.education.map((e) => `<li>${html([e.institution, e.degree, e.major].filter(Boolean).join(", ") || "Education")}${e.currentlyStudying ? " (studying)" : e.graduationYear ? ` (${e.graduationYear})` : ""}</li>`).join("");
  const experience = v.experience.map((e) => `<li>${html(e.title)} at ${html(e.employer)}, ${e.startYear}${e.endYear ? `–${e.endYear}` : "–now"}</li>`).join("");
  const docs = body.documents === null ? "<p>Documents will appear here once secure document links are available.</p>"
    : body.documents.length ? `<ul>${body.documents.map((d) => `<li><a class="text-link" href="${html(d.url)}" rel="noreferrer">${DOC[d.type]}</a></li>`).join("")}</ul>` : "<p>No documents on file.</p>";
  const section = (title: string, inner: string) => (inner ? `<section><h2>${title}</h2>${inner}</section>` : "");
  return `<main id="main" class="profile-main"><h1>${html(v.name ?? "Unnamed person")}<span class="accent">.</span></h1><dl>${facts}</dl>${v.introduction ? `<p style="white-space:pre-wrap">${html(v.introduction)}</p>` : ""}${section("Education", education ? `<ul>${education}</ul>` : "")}${section("Experience", experience ? `<ul>${experience}</ul>` : "")}${section("Skills", v.skills.length ? `<p>${v.skills.map(html).join(" · ")}</p>` : "")}<section><h2>Documents</h2>${docs}</section><p><a class="text-link" href="/recruit/requests/${html(body.requestId)}">Back to the request</a></p></main>`;
}

const PERSON = /^\/recruit\/requests\/([^/]+)\/people\/([^/]+)$/;

export async function handleRecruitEmployerView(req: IncomingMessage, res: ServerResponse, s: RecruitEmployerView | undefined, write: RecruitPageWriter, wantsHtml: boolean): Promise<boolean> {
  const pathname = new URL(req.url ?? "/", "http://x").pathname;
  if (pathname === EMPLOYER_DELIVERY_PATH) {
    const out = req.method === "GET" && s ? await s.deliver(sessionCookie(req.headers.cookie), req.url ?? "").catch(() => undefined) : undefined;
    if (out) { res.writeHead(200, out.headers); res.end(out.bytes); } else sendJson(res, NOT_FOUND);
    return true;
  }
  const match = PERSON.exec(pathname);
  if (!match) return false;
  const requestId = decodeSegment(match), back = { href: `/recruit/requests/${encodeURIComponent(requestId)}`, label: "Back to the request" };
  if (req.method !== "GET") { sendJson(res, NOT_FOUND); return true; }
  try {
    if (!s) { wantsHtml ? errorPage(write, 503, back) : sendJson(res, { status: 503, body: { error: "recruit_unavailable" } }); return true; }
    let personId = "";
    try { personId = decodeURIComponent(match[2]!); } catch { personId = ""; }
    const r = await s.person(sessionCookie(req.headers.cookie), requestId, personId);
    if (!wantsHtml) sendJson(res, r);
    else if (r.status === 200) write(200, r.body.person.name ?? "Person", renderEmployerPerson(r.body));
    else errorPage(write, r.status, back);
  } catch {
    if (!res.headersSent) wantsHtml ? errorPage(write, 503, back) : sendJson(res, { status: 503, body: { error: "recruit_unavailable" } });
    else res.destroy();
  }
  return true;
}
