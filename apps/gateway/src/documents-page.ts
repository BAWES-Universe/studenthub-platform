import type { IncomingMessage, ServerResponse } from 'node:http';
import { CANDIDATE_DOCUMENT_ADMISSION, LifecycleError, type CandidateDocuments } from '../../../packages/private-documents/src/candidate-lifecycle.js';
import { CANDIDATE_DOCUMENT_TYPES } from '../../../packages/private-documents/src/lifecycle-state.js';
import { DocumentError, type Metadata } from '../../../packages/private-documents/src/index.js';
import { pageDocument, wantsHtml, writeHtml, type BrowserLoginApplication } from './web-ui.js';
import type { ProfileLanguage } from './ui/profile-copy.js';
import { createIdempotencyKey } from '../../../packages/idempotency-contract/src/idempotency.js';

const COPY = {
  en: { title: 'My documents', back: 'My profile', onFile: 'On file', missing: 'Not uploaded', accepted: 'Accepted formats', maximum: 'Maximum size', bytes: 'bytes', signIn: 'Sign in to view your documents', continue: 'Continue with Universe', unavailable: 'Documents are temporarily unavailable. Please try again.', slots: ['Personal photo', 'CV', 'Civil ID front', 'Civil ID back'] },
  ar: { title: 'مستنداتي', back: 'ملفي الشخصي', onFile: 'محفوظ', missing: 'لم يتم الرفع', accepted: 'الصيغ المقبولة', maximum: 'الحجم الأقصى', bytes: 'بايت', signIn: 'سجّل الدخول لعرض مستنداتك', continue: 'المتابعة مع Universe', unavailable: 'المستندات غير متاحة مؤقتًا. يرجى المحاولة مرة أخرى.', slots: ['الصورة الشخصية', 'السيرة الذاتية', 'البطاقة المدنية (الوجه الأمامي)', 'البطاقة المدنية (الوجه الخلفي)'] },
} as const;
function escape(value: string): string {
  return value.replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]!);
}
const format = (mime: string): string => ({ 'image/png': 'PNG', 'image/jpeg': 'JPEG', 'application/pdf': 'PDF' })[mime] ?? mime;
function shell(language: ProfileLanguage, content: string): string {
  const copy = COPY[language];
  return pageDocument(copy.title, `<main id="main" class="profile-ui"><div class="p-shell"><section class="p-main p-card p-stack"><a href="/profile">${copy.back}</a><h1 id="documents-heading">${copy.title}</h1>${content}</section></div></main>`, language);
}
/** Presentation is a closed four-slot projection. Never serialize a metadata row. */
export function documentsPage(documents: readonly Metadata[], language: ProfileLanguage, now: () => number = Date.now): string {
  const copy = COPY[language];
  const slots = CANDIDATE_DOCUMENT_TYPES.map((type, index) => {
    const document = documents.find(row => row.type === type); // SHU366_PAGE slot presence
    const admission = CANDIDATE_DOCUMENT_ADMISSION[type];
    const submission = createIdempotencyKey(new Date(now()));
    return `<div id="document-${type}" class="p-row"><dt>${copy.slots[index]}</dt><dd><strong>${document ? copy.onFile : copy.missing}</strong><p class="p-meta">${document
      ? `${escape(format(document.mime))} · ${escape(String(document.size))} ${copy.bytes}`
      : `${copy.accepted}: ${admission.mimeTypes.map(mime => escape(format(mime))).join(', ')}. ${copy.maximum}: ${escape(String(admission.maxBytes / (1024 * 1024)))} MiB.`}</p><form method="post" enctype="multipart/form-data" action="/profile/documents/${type}/upload"><input type="file" name="file" accept="${admission.mimeTypes.join(',')}" required><input type="hidden" name="submission" value="${submission}"><button class="p-button p-primary" type="submit">${document ? 'Replace' : 'Upload'}</button></form></dd></div>`;
  }).join('');
  return shell(language, `<dl class="p-stack">${slots}</dl>`);
}
function sessionCookie(request: IncomingMessage): string | undefined {
  const matches = (request.headers.cookie?.split(';') ?? []).map(item => item.trim()).filter(item => item.split('=')[0] === '__Host-studenthub_session');
  if (matches.length !== 1) return undefined;
  const match = /^__Host-studenthub_session=([A-Za-z0-9_-]{43})$/.exec(matches[0]!);
  return match?.[1];
}
export async function handleDocumentsPage(request: IncomingMessage, response: ServerResponse, service?: CandidateDocuments, login?: BrowserLoginApplication): Promise<boolean> {
  if ((request.url ?? '').split('?')[0] !== '/profile/documents') return false;
  if (request.method !== 'GET' || !wantsHtml(request.headers.accept)) {
    request.resume();
    response.writeHead(404, { 'content-type': 'application/json', 'cache-control': 'no-store', vary: 'Accept' });
    response.end(JSON.stringify({ error: 'not_found' })); return true;
  }
  let language: ProfileLanguage = 'en';
  const fail = (status: 401 | 503): void => {
    const copy = COPY[language];
    const link = status === 401 && login?.web?.returnTo ? `<a class="p-button p-primary" href="/login/universe?return_to=${escape(encodeURIComponent(login.web.returnTo))}">${copy.continue}</a>` : '';
    writeHtml(response, status, shell(language, `<p role="status">${status === 401 ? copy.signIn : copy.unavailable}</p>${link}`));
  };
  const sessionId = sessionCookie(request);
  try {
    // Authentication precedes even the configuration check and every document-store access.
    if (!sessionId) { fail(401); return true; }
    if (!login) { fail(503); return true; }
    const authorized = await login.profile({ sessionId });
    if (authorized.status === 401) { fail(401); return true; }
    const personId = authorized.body?.personId;
    if (authorized.status !== 200 || typeof personId !== 'string' || !personId || !login.web) { fail(503); return true; }
    const own = await login.web.profiles.readOwn({ requesterPrincipalId: personId, targetPersonId: personId });
    if (own.kind !== 'found') { fail(503); return true; }
    language = own.profile.fields.language.state === 'available' && own.profile.fields.language.value === 'ar' ? 'ar' : 'en';
    if (!service) { fail(503); return true; }
    const documents = await service.list(sessionId);
    writeHtml(response, 200, documentsPage(documents, language, service.options.now ?? Date.now));
  } catch (error) {
    // A session may have been revoked between profile authentication and the list.
    if ((error instanceof LifecycleError || error instanceof DocumentError) && error.code === 'denied' && sessionId && login) {
      try { if ((await login.profile({ sessionId })).status === 401) { fail(401); return true; } } catch { /* closed unavailable response */ }
    }
    fail(503);
  }
  return true;
}
