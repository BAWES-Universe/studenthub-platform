import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { CANDIDATE_DOCUMENT_ADMISSION, LifecycleError, type CandidateDocuments } from '../../../packages/private-documents/src/candidate-lifecycle.js';
import { CANDIDATE_DOCUMENT_TYPES, type CandidateDocumentType } from '../../../packages/private-documents/src/lifecycle-state.js';
import { pageDocument, writeHtml } from './web-ui.js';

const MULTIPART_OVERHEAD = 64 * 1024;
const SUBMISSION_PATTERN = /^v1\.\d{13}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SLOT_NAMES: Record<CandidateDocumentType, string> = {
  'personal-photo': 'Personal photo', resume: 'CV', 'civil-id-front': 'Civil ID front', 'civil-id-back': 'Civil ID back',
};
type Part = { name: string; filename?: string; mime?: string; bytes: Buffer };
const escape = (value: string): string => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
function cookie(request: IncomingMessage): string | undefined {
  const values = (request.headers.cookie?.split(';') ?? []).map(v => v.trim()).filter(v => v.startsWith('__Host-studenthub_session='));
  if (values.length !== 1) return undefined;
  return /^__Host-studenthub_session=([A-Za-z0-9_-]{43})$/.exec(values[0]!)?.[1];
}
async function boundedBody(request: IncomingMessage, limit: number): Promise<Buffer> {
  const length = request.headers['content-length'];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > limit)) { request.resume(); throw new LifecycleError(413, 'too_large'); }
  const chunks: Buffer[] = []; let total = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk); total += bytes.length;
    if (total > limit) { request.resume(); throw new LifecycleError(413, 'too_large'); }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks, total);
}
function multipart(body: Buffer, contentType: string): Part[] {
  const match = /^multipart\/form-data;\s*boundary=(?:"([A-Za-z0-9'()+_,./:=?-]{1,70})"|([A-Za-z0-9'()+_,./:=?-]{1,70}))$/i.exec(contentType);
  if (!match) throw new LifecycleError(400, 'invalid');
  const boundary = Buffer.from(`--${match[1] ?? match[2]}`), divider = Buffer.from('\r\n\r\n');
  if (!body.subarray(0, boundary.length).equals(boundary)) throw new LifecycleError(400, 'invalid');
  const parts: Part[] = []; let cursor = boundary.length;
  while (true) {
    if (body.subarray(cursor, cursor + 2).equals(Buffer.from('--'))) {
      if (cursor + 2 !== body.length && !body.subarray(cursor + 2).equals(Buffer.from('\r\n'))) throw new LifecycleError(400, 'invalid');
      return parts;
    }
    if (!body.subarray(cursor, cursor + 2).equals(Buffer.from('\r\n'))) throw new LifecycleError(400, 'invalid');
    cursor += 2;
    const headerEnd = body.indexOf(divider, cursor);
    if (headerEnd < 0 || headerEnd - cursor > MULTIPART_OVERHEAD / 2) throw new LifecycleError(400, 'invalid');
    const headers = body.subarray(cursor, headerEnd).toString('latin1').split('\r\n');
    const disposition = headers.find(h => h.toLowerCase().startsWith('content-disposition:'));
    if (!disposition || headers.some(h => !/^[!#$%&'*+.^_`|~0-9A-Za-z-]+:\s*[^\r\n]*$/.test(h))) throw new LifecycleError(400, 'invalid');
    const cd = /^content-disposition:\s*form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?$/i.exec(disposition);
    if (!cd) throw new LifecycleError(400, 'invalid');
    const mimeHeader = headers.find(h => h.toLowerCase().startsWith('content-type:'));
    const mime = mimeHeader && /^content-type:\s*([^\s;]+)\s*$/i.exec(mimeHeader)?.[1];
    cursor = headerEnd + divider.length;
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), boundary]), cursor);
    if (next < 0) throw new LifecycleError(400, 'invalid');
    parts.push({ name: cd[1]!, ...(cd[2] !== undefined ? { filename: cd[2] } : {}), ...(mime ? { mime: mime.toLowerCase() } : {}), bytes: body.subarray(cursor, next) });
    cursor = next + 2 + boundary.length;
  }
}
function operationKey(submission: string, operation: string): string {
  const match = /^(v1\.\d{13}\.)[0-9a-f-]{36}$/.exec(submission);
  if (!match || !SUBMISSION_PATTERN.test(submission)) throw new LifecycleError(400, 'invalid');
  const hex = createHash('sha256').update(`${submission}:${operation}`).digest('hex').slice(0, 32).split('');
  hex[12] = '4'; hex[16] = ['8','9','a','b'][Number.parseInt(hex[16]!, 16) % 4]!;
  return `${match[1]}${hex.slice(0,8).join('')}-${hex.slice(8,12).join('')}-${hex.slice(12,16).join('')}-${hex.slice(16,20).join('')}-${hex.slice(20).join('')}`;
}
function errorPage(slot: CandidateDocumentType, status: number, code: string): string {
  const reason = status === 413 ? `The file is too large. The maximum size is ${CANDIDATE_DOCUMENT_ADMISSION[slot].maxBytes / 1048576} MiB.`
    : status === 409 ? 'Your documents changed. Try again.'
    : status === 400 ? 'Choose a valid, non-empty file in an accepted format.'
    : status === 401 ? 'Sign in to upload your document.'
    : status === 403 ? 'This upload request could not be verified.' : 'Documents are temporarily unavailable.';
  return pageDocument(`${SLOT_NAMES[slot]} upload`, `<main id="main" class="profile-ui"><div class="p-shell"><section class="p-main p-card p-stack"><h1>${escape(SLOT_NAMES[slot])}</h1><p role="status">${reason}</p><a href="/profile/documents">Back to My documents</a></section></div></main>`, 'en');
}
export async function handleDocumentsUpload(request: IncomingMessage, response: ServerResponse, service?: CandidateDocuments): Promise<boolean> {
  const path = (request.url ?? '').split('?')[0]!;
  const match = /^\/profile\/documents\/([^/]+)\/upload$/.exec(path);
  if (!match) return false;
  if (request.method !== 'POST' || !CANDIDATE_DOCUMENT_TYPES.includes(match[1] as CandidateDocumentType)) return false;
  const slot = match[1] as CandidateDocumentType;
  response.setHeader('cache-control', 'no-store');
  try {
    if (!service) throw new LifecycleError(503, 'unavailable');
    const session = cookie(request);
    if (!session) throw new LifecycleError(401, 'denied');
    await service.principal(session);
    if (request.headers.origin !== service.options.origin || request.headers['sec-fetch-site'] === 'cross-site') throw new LifecycleError(403, 'denied');
    const body = await boundedBody(request, CANDIDATE_DOCUMENT_ADMISSION[slot].maxBytes + MULTIPART_OVERHEAD); // SHU521_BODY_BOUND
    const parts = multipart(body, typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : '');
    if (parts.length !== 2 || parts.some(p => p.name !== 'file' && p.name !== 'submission')) throw new LifecycleError(400, 'invalid');
    const files = parts.filter(p => p.name === 'file'), submissions = parts.filter(p => p.name === 'submission');
    if (files.length !== 1 || submissions.length !== 1 || files[0]!.filename === undefined || !files[0]!.filename || !files[0]!.mime || files[0]!.bytes.length === 0) throw new LifecycleError(400, 'invalid');
    const submission = submissions[0]!.bytes.toString('utf8');
    const current = (await service.list(session)).find(document => document.type === slot);
    const bytes = files[0]!.bytes;
    const authorized = await service.authorizeUpload(session, operationKey(submission, 'authorize'), { type: slot, mime: files[0]!.mime, size: bytes.length,
      expectedVersion: current?.version ?? null, ...(service.options.directUploads ? { sha256: createHash('sha256').update(bytes).digest('hex'), contentMd5: createHash('md5').update(bytes).digest('base64') } : {}) });
    const ticket = authorized.body as { uploadId?: unknown; objectKey?: unknown; credential?: unknown } | undefined;
    if (typeof ticket?.uploadId !== 'string' || typeof ticket.objectKey !== 'string' || typeof ticket.credential !== 'string') throw new LifecycleError(503, 'unavailable');
    await service.put(session, operationKey(submission, 'bytes'), ticket.uploadId, ticket.objectKey, ticket.credential, bytes);
    const finalized = await service.finalize(session, operationKey(submission, 'finalize'), { uploadId: ticket.uploadId }); // SHU521_FINALIZE
    if (finalized.status !== 200) throw new LifecycleError(503, 'unavailable');
    response.writeHead(303, { location: '/profile/documents' }); response.end();
  } catch (error) {
    let status = error instanceof LifecycleError ? error.status : 503;
    const code = error instanceof LifecycleError ? error.code : 'unavailable';
    if (status === 403 && code === 'denied' && !cookie(request)) status = 401;
    if (![400,401,403,409,413].includes(status)) status = 503;
    writeHtml(response, status, errorPage(slot, status, code));
  }
  return true;
}
