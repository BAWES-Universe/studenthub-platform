import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { createIdempotencyKey } from '../../../packages/idempotency-contract/src/idempotency.js';
import { CANDIDATE_DOCUMENT_ADMISSION, LifecycleError, type CandidateDocuments } from '../../../packages/private-documents/src/candidate-lifecycle.js';
import { CANDIDATE_DOCUMENT_TYPES, type CandidateDocumentType } from '../../../packages/private-documents/src/lifecycle-state.js';
import { pageDocument, writeHtml, type BrowserLoginApplication } from './web-ui.js';

const MULTIPART_OVERHEAD = 64 * 1024;
class FormError extends Error { constructor(readonly status: 400 | 413, readonly reason: 'invalid' | 'no_file' | 'too_large') { super(reason); } }
function cookie(request: IncomingMessage): string | undefined {
  const matches = (request.headers.cookie?.split(';') ?? []).map(value => value.trim()).filter(value => value.startsWith('__Host-studenthub_session='));
  if (matches.length !== 1) return undefined;
  const value = matches[0]!.slice('__Host-studenthub_session='.length);
  return /^[A-Za-z0-9_-]{43}$/.test(value) ? value : undefined;
}
const labels = { en: { 'personal-photo': 'Personal photo', resume: 'CV', 'civil-id-front': 'Civil ID front', 'civil-id-back': 'Civil ID back' }, ar: { 'personal-photo': 'الصورة الشخصية', resume: 'السيرة الذاتية', 'civil-id-front': 'البطاقة المدنية (الوجه الأمامي)', 'civil-id-back': 'البطاقة المدنية (الوجه الخلفي)' } } as const;
function refusal(response: ServerResponse, status: number, type: CandidateDocumentType, reason: string, signIn: boolean, language: 'en'|'ar'): void {
  const action = signIn ? `<p><a class="p-button p-primary" href="/login/universe?return_to=%2Fprofile%2Fdocuments">${language === 'ar' ? 'المتابعة مع Universe' : 'Continue with Universe'}</a></p>` : '';
  writeHtml(response, status, pageDocument(language === 'ar' ? 'رفع مستند' : 'Upload document', `<main id="main"><h1>${labels[language][type]}</h1><p role="status">${reason}</p>${action}<a href="/profile/documents">${language === 'ar' ? 'العودة إلى مستنداتي' : 'Back to My documents'}</a></main>`, language));
}
async function readBounded(request: IncomingMessage, limit: number): Promise<Buffer> {
  const length = Number(request.headers['content-length']);
  if (Number.isFinite(length) && length > limit) { request.pause(); throw new FormError(413, 'too_large'); }
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > limit) { request.pause(); throw new FormError(413, 'too_large'); }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
function parseMultipart(body: Buffer, contentType: string): { bytes: Buffer; mime: string; submission: string } {
  const match = /^multipart\/form-data;\s*boundary=(?:"([A-Za-z0-9'()+_,.\/:=?-]{1,70})"|([A-Za-z0-9'()+_,.\/:=?-]{1,70}))$/.exec(contentType);
  if (!match) throw new FormError(400, 'invalid');
  const token = match[1] ?? match[2]!; const boundary = Buffer.from(`--${token}`); const close = Buffer.from(`\r\n--${token}--`);
  const trailing = body.subarray(-2).equals(Buffer.from('\r\n')) ? 2 : 0;
  if (!body.subarray(0, boundary.length).equals(boundary) || !body.subarray(body.length - trailing - close.length, body.length - trailing).equals(close)) throw new FormError(400, 'invalid');
  const raw = body.subarray(boundary.length + 2, body.length - trailing - close.length); const delimiter = Buffer.from(`\r\n--${token}\r\n`);
  const parts: Buffer[] = []; let start = 0;
  while (start <= raw.length) { const next = raw.indexOf(delimiter, start); parts.push(raw.subarray(start, next < 0 ? raw.length : next)); if (next < 0) break; start = next + delimiter.length; }
  let file: Buffer | undefined; let mime = ''; let submission: string | undefined;
  for (const part of parts) {
    const split = part.indexOf('\r\n\r\n'); if (split < 0 || split > 8192) throw new FormError(400, 'invalid');
    const headers = part.subarray(0, split).toString('latin1'); const data = part.subarray(split + 4);
    const disposition = /^Content-Disposition: form-data; name="([^"]+)"(?:; filename="([^"]*)")?$/mi.exec(headers);
    if (!disposition) throw new FormError(400, 'invalid');
    if (disposition[1] === 'file' && disposition[2] !== undefined) {
      if (file !== undefined) throw new FormError(400, 'invalid');
      if (disposition[2] === '') throw new FormError(400, 'no_file');
      const declared = /^Content-Type:\s*([^\r\n]+)$/mi.exec(headers); if (!declared) throw new FormError(400, 'invalid');
      file = data; mime = declared[1]!.trim();
    } else if (disposition[1] === 'submission' && disposition[2] === undefined && submission === undefined) submission = data.toString('utf8');
    else throw new FormError(400, 'invalid');
  }
  if (file === undefined) throw new FormError(400, 'no_file');
  if (!submission) throw new FormError(400, 'invalid');
  return { bytes: file, mime, submission };
}
function serverKeys(service: CandidateDocuments, type: CandidateDocumentType, value: string): [string, string, string] {
  const match = /^(\d{13})\.([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(value); if (!match) throw new FormError(400, 'invalid');
  const raw = `${match[1]}.${match[2]}`; const expected = createHmac('sha256', service.options.signingKey).update(`documents-upload:${type}:${raw}`).digest();
  const supplied = Buffer.from(match[3]!, 'base64url'); if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) throw new FormError(400, 'invalid');
  return [0, 1, 2].map(index => {
    const uuid = createHash('sha256').update(`${raw}:${index}`).digest().subarray(0, 16); uuid[6] = (uuid[6]! & 15) | 64; uuid[8] = (uuid[8]! & 63) | 128;
    const hex = uuid.toString('hex'); return createIdempotencyKey(new Date(Number(match[1])), `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`);
  }) as [string, string, string];
}
export async function handleDocumentsUpload(request: IncomingMessage, response: ServerResponse, service?: CandidateDocuments, _login?: BrowserLoginApplication): Promise<boolean> {
  const match = /^\/profile\/documents\/([^/]+)\/upload$/.exec((request.url ?? '').split('?')[0]!); if (!match) return false;
  if (request.method !== 'POST' || !CANDIDATE_DOCUMENT_TYPES.includes(match[1] as CandidateDocumentType)) { request.resume(); response.writeHead(404, { 'cache-control': 'no-store' }); response.end(); return true; }
  const type = match[1] as CandidateDocumentType; const session = cookie(request);
  const language: 'en'|'ar' = String(request.headers['accept-language'] ?? '').toLowerCase().startsWith('ar') ? 'ar' : 'en';
  if (!session) { request.resume(); refusal(response, 401, type, language === 'ar' ? 'سجّل الدخول لرفع مستند.' : 'Sign in to upload a document.', true, language); return true; }
  if (!service) { request.resume(); refusal(response, 503, type, language === 'ar' ? 'المستندات غير متاحة مؤقتًا.' : 'Documents are temporarily unavailable.', false, language); return true; }
  if (request.headers.origin !== service.options.origin || request.headers['sec-fetch-site'] === 'cross-site') { request.resume(); refusal(response, 403, type, language === 'ar' ? 'تم رفض هذا الرفع.' : 'This upload was refused.', false, language); return true; }
  try {
    const current = (await service.list(session)).find(document => document.type === type);
    const parsed = parseMultipart(await readBounded(request, CANDIDATE_DOCUMENT_ADMISSION[type].maxBytes + MULTIPART_OVERHEAD), String(request.headers['content-type'] ?? ''));
    const keys = serverKeys(service, type, parsed.submission);
    const sha256 = createHash('sha256').update(parsed.bytes).digest('hex'); const contentMd5 = createHash('md5').update(parsed.bytes).digest('base64');
    const authorization = await service.authorizeUpload(session, keys[0], { type, mime: parsed.mime, size: parsed.bytes.length, expectedVersion: current?.version ?? null, ...(service.options.directUploads ? { sha256, contentMd5 } : {}) });
    const ticket = authorization.body as { uploadId: string; objectKey: string; credential: string };
    await service.put(session, keys[1], ticket.uploadId, ticket.objectKey, ticket.credential, parsed.bytes);
    await service.finalize(session, keys[2], { uploadId: ticket.uploadId });
    response.writeHead(303, { location: '/profile/documents', 'cache-control': 'no-store' }); response.end();
  } catch (error) {
    const status = error instanceof FormError ? error.status : error instanceof LifecycleError ? error.status : 503;
    const code = error instanceof FormError ? error.reason : error instanceof LifecycleError ? error.code : 'unavailable';
    const reason = language === 'ar'
      ? status === 413 ? `الملف كبير جدًا. الحد الأقصى ${CANDIDATE_DOCUMENT_ADMISSION[type].maxBytes / (1024 * 1024)} MiB.` : code === 'no_file' ? 'اختر ملفًا أولًا.' : status === 409 ? 'تغيّرت مستنداتك، حاول مرة أخرى.' : status === 400 ? 'اختر ملفًا صالحًا بإحدى الصيغ المقبولة.' : status === 403 ? 'تم رفض هذا الرفع.' : 'المستندات غير متاحة مؤقتًا.'
      : status === 413 ? `The file is too large. Maximum size is ${CANDIDATE_DOCUMENT_ADMISSION[type].maxBytes / (1024 * 1024)} MiB.` : code === 'no_file' ? 'Choose a file first.' : status === 409 ? 'Your documents changed, try again.' : status === 400 ? 'Choose a valid file in an accepted format.' : status === 403 ? 'This upload was refused.' : 'Documents are temporarily unavailable.';
    refusal(response, status === 400 || status === 403 || status === 409 || status === 413 ? status : 503, type, reason, false, language);
  }
  return true;
}
