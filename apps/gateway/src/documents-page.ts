import type { CandidateDocuments } from "../../../packages/private-documents/src/candidate-lifecycle.js";
import { LifecycleError } from "../../../packages/private-documents/src/candidate-lifecycle.js";
import { CANDIDATE_DOCUMENT_TYPES, type CandidateDocumentType } from "../../../packages/private-documents/src/lifecycle-state.js";
import { pageDocument } from "./web-ui.js";

/** Only the own-document list is read. The page never issues delivery links or uploads. */
export type DocumentsReader = Pick<CandidateDocuments, "list">;

export interface DocumentSlot {
  readonly type: CandidateDocumentType;
  readonly mime: string;
  readonly size: number;
}

export type DocumentsPageResult =
  | { readonly status: 200; readonly documents: readonly DocumentSlot[] }
  | { readonly status: 401 | 503 };

const LABELS: Record<CandidateDocumentType, { readonly title: string; readonly hint: string }> = {
  "personal-photo": { title: "Personal photo", hint: "A clear photo of your face. PNG or JPEG." },
  resume: { title: "CV", hint: "Your resume as one PDF." },
  "civil-id-front": { title: "Civil ID, front", hint: "The front of your civil ID card. PNG or JPEG." },
  "civil-id-back": { title: "Civil ID, back", hint: "The back of your civil ID card. PNG or JPEG." },
};

const FORMATS: Readonly<Record<string, string>> = { "application/pdf": "PDF", "image/png": "PNG", "image/jpeg": "JPEG" };

export async function readOwnDocuments(reader: DocumentsReader | undefined, sessionId: string | undefined): Promise<DocumentsPageResult> {
  if (!reader) return { status: 503 };
  if (!sessionId) return { status: 401 };
  try {
    const listed = await reader.list(sessionId);
    const documents: DocumentSlot[] = [];
    for (const item of listed) {
      // The list is closed to the four candidate types; anything else is dropped, never shown.
      if (!(CANDIDATE_DOCUMENT_TYPES as readonly string[]).includes(item.type)) continue;
      documents.push({ type: item.type as CandidateDocumentType, mime: item.mime, size: item.size });
    }
    return { status: 200, documents };
  } catch (error) {
    if (error instanceof LifecycleError && error.status === 403) return { status: 401 };
    return { status: 503 };
  }
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]!);
}

export function formatSize(bytes: number): string {
  if (!Number.isSafeInteger(bytes) || bytes < 0) return "Unknown size";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

const brand = `<a class="brand" href="/" aria-label="StudentHub home"><span class="brand-mark" aria-hidden="true">s</span>studenthub<span class="brand-dot" aria-hidden="true">.</span></a>`;

function slot(type: CandidateDocumentType, document: DocumentSlot | undefined): string {
  const label = LABELS[type];
  const state = document
    ? `<span class="doc-state on-file">On file</span><p class="doc-meta">${escapeHtml(FORMATS[document.mime] ?? "Unknown format")} · ${escapeHtml(formatSize(document.size))}</p>`
    : `<span class="doc-state missing-doc">Not uploaded</span><p class="doc-meta">${escapeHtml(label.hint)}</p>`;
  return `<li class="doc-slot" data-type="${type}"><div class="doc-icon" aria-hidden="true">${type === "resume" ? "PDF" : "IMG"}</div><div class="doc-body"><h3>${escapeHtml(label.title)}</h3>${state}</div></li>`;
}

/** Signed-in page shell: same sidebar as My profile, with My documents selected. */
export function renderDocumentsPage(result: DocumentsPageResult, options: { readonly navigation: boolean }): string {
  if (result.status !== 200) {
    const signedOut = result.status === 401;
    return pageDocument("My documents", `<header class="topbar">${brand}<a class="text-link" href="/">Back to StudentHub</a></header><main id="main" class="error-page"><div class="eyebrow">YOUR DOCUMENTS</div><h1>${signedOut ? "Sign in to see your documents." : "Your documents aren’t available right now."}</h1><p>${signedOut ? "Your documents are private to you. Sign in with your Universe account to see them." : "Nothing has changed with your files. Please try again in a few minutes."}</p><a class="button primary" href="${signedOut ? "/" : "/profile"}">${signedOut ? "Go to sign in" : "Back to my profile"} <span aria-hidden="true">→</span></a></main>`);
  }
  const byType = new Map(result.documents.map((d) => [d.type, d]));
  const onFile = CANDIDATE_DOCUMENT_TYPES.filter((type) => byType.has(type)).length;
  const summary = onFile === CANDIDATE_DOCUMENT_TYPES.length
    ? "All four documents are on file."
    : `${onFile} of ${CANDIDATE_DOCUMENT_TYPES.length} documents on file.`;
  const slots = CANDIDATE_DOCUMENT_TYPES.map((type) => slot(type, byType.get(type))).join("");
  return pageDocument("My documents", `<header class="topbar">${brand}<form action="/logout" method="post"><button class="sign-out" type="submit">Sign out <span aria-hidden="true">↗</span></button></form></header><div class="workspace"><aside class="sidebar"><div class="eyebrow">YOUR WORKSPACE</div><nav aria-label="Workspace"><a class="nav-item" href="/profile">My profile</a><a class="nav-item" href="/profile/background">Education and experience</a><a class="nav-item active" href="/profile/documents" aria-current="page">My documents</a>${options.navigation ? '<a class="nav-item" href="/workspace">Workspaces</a>' : ""}</nav><p class="sidebar-note">One Universe account.<br>Your StudentHub space.</p></aside><main id="main" class="profile-main"><div class="profile-heading"><div><div class="eyebrow">YOUR ACCOUNT</div><h1>My documents<span class="accent">.</span></h1><p>The files companies and StudentHub staff rely on when you’re hired.</p></div><span class="badge">Read-only</span></div><section class="profile-card" aria-labelledby="documents-title"><div class="identity"><div><h2 id="documents-title">${escapeHtml(summary)}</h2><p>Private to you. Only you can see this list.</p></div><span class="identity-label">PRIVATE DOCUMENTS</span></div><ul class="doc-list">${slots}</ul><div class="privacy-note"><span class="privacy-symbol" aria-hidden="true">↳</span><p>File names and contents are never shown here. Each document is checked for its format before it is kept.</p></div></section><section class="next-note" aria-labelledby="next-title"><div class="eyebrow">ABOUT THIS PAGE</div><h2 id="next-title">Uploading here is coming next.</h2><p>For now, send new or updated documents through the current StudentHub. They appear here once they are imported.</p></section><footer class="profile-footer">StudentHub · Connected by Universe</footer></main></div>`);
}

export const DOCUMENTS_CSS = `
.doc-list{list-style:none;margin:0;padding:0 2rem;display:grid;grid-template-columns:1fr 1fr}.doc-slot{display:flex;gap:1rem;align-items:flex-start;padding:1.4rem 1rem 1.4rem 0;border-bottom:1px solid var(--border);min-width:0}.doc-slot:nth-child(even){padding-left:1rem;padding-right:0}.doc-slot:nth-last-child(-n+2){border-bottom:0}.doc-icon{flex-shrink:0;width:3rem;height:3.5rem;border-radius:.5rem;border:1px solid var(--border);display:grid;place-items:center;font-size:.7rem;font-weight:750;letter-spacing:.06em;color:#234ebd;background:#f5f8ff}.doc-body{min-width:0}.doc-body h3{margin:0 0 .4rem;font-size:1rem;letter-spacing:-.01em}.doc-state{display:inline-block;font-size:.75rem;font-weight:700;letter-spacing:.04em;border-radius:2rem;padding:.2rem .65rem}.on-file{background:#e3f4ea;color:#1c6b3c}.missing-doc{background:#fff2e6;color:#8a3d00}.doc-meta{font-size:.875rem;margin-top:.45rem}
@media(max-width:800px){.doc-list{padding:0 1.5rem}}
@media(max-width:480px){.doc-list{grid-template-columns:1fr}.doc-slot,.doc-slot:nth-child(even){padding-left:0;padding-right:0}.doc-slot:nth-last-child(2){border-bottom:1px solid var(--border)}}
`;
