import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { CANDIDATE_DOCUMENT_ADMISSION, LifecycleError, type CandidateDocuments } from '../../../packages/private-documents/src/candidate-lifecycle.js';
import { CANDIDATE_DOCUMENT_TYPES, type CandidateDocumentType } from '../../../packages/private-documents/src/lifecycle-state.js';
import { pageDocument, renderError, writeHtml, type BrowserLoginApplication } from './web-ui.js';

export const DOCUMENT_MULTIPART_OVERHEAD = 64 * 1024;
const LIMIT = 10 * 1024 * 1024 + DOCUMENT_MULTIPART_OVERHEAD;
const KEY_PATTERN = /^v1\.\d{13}\.[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const slotNames: Readonly<Record<CandidateDocumentType, string>> = {
  'personal-photo': 'Personal photo', resume: 'CV', 'civil-id-front': 'Civil ID front', 'civil-id-back': 'Civil ID back',
};
function sessionCookie(request: IncomingMessage): string | undefined {
  const values = (request.headers.cookie?.split(';') ?? []).map(v => v.trim()).filter(v => v.startsWith('__Host-studenthub_session='));
  if (values.length !== 1) return undefined;
  return /^__Host-studenthub_session=([A-Za-z0-9_-]{43})$/.exec(values[0]!)?.[1];
}
function html(response: ServerResponse, status: number, slot: CandidateDocumentType, reason: string): void {
  writeHtml(response, status, pageDocument(`${slotNames[slot]} upload`, `<main id="main" class="profile-ui"><div class="p-shell"><section class="p-main p-card p-stack"><h1>${slotNames[slot]}</h1><p role="status">${reason}</p><a href="/profile/documents">Back to My documents</a></section></div></main>`, 'en'));
}
async function boundedBody(request: IncomingMessage): Promise<Buffer> {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > LIMIT)) {
    request.resume(); throw new LifecycleError(413, 'too_large');
  }
  const chunks: Buffer[] = []; let total = 0;
  for await (const value of request.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.from(value); total += chunk.length;
    if (total > LIMIT) { request.resume(); throw new LifecycleError(413, 'too_large'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}
type Parsed = { bytes: Buffer; mime: string; submission: string };
function multipart(body: Buffer, contentType: string): Parsed {
  const match = /^multipart\/form-data;\s*boundary=(?:"([!#$%&'*+.^_`|~0-9A-Za-z-]{1,70})"|([!#$%&'*+.^_`|~0-9A-Za-z-]{1,70}))$/.exec(contentType);
  if (!match) throw new LifecycleError(400, 'invalid');
  const boundary = Buffer.from(`--${match[1] ?? match[2]}`), delimiter = Buffer.from(`\r\n--${match[1] ?? match[2]}`);
  if (!body.subarray(0, boundary.length).equals(boundary)) throw new LifecycleError(400, 'invalid');
  const parts: { name: string; filename?: string; mime?: string; data: Buffer }[] = [];
  let offset = boundary.length;
  while (true) {
    if (body.subarray(offset, offset + 2).toString() === '--') {
      if (offset + 4 !== body.length || body.subarray(offset + 2).toString() !== '\r\n') throw new LifecycleError(400, 'invalid');
      break;
    }
    if (body.subarray(offset, offset + 2).toString() !== '\r\n') throw new LifecycleError(400, 'invalid');
    offset += 2;
    const headersEnd = body.indexOf('\r\n\r\n', offset);
    if (headersEnd < 0 || headersEnd - offset > 16 * 1024) throw new LifecycleError(400, 'invalid');
    const rawHeaders = body.subarray(offset, headersEnd).toString('latin1').split('\r\n');
    const headers = new Map<string, string>();
    for (const line of rawHeaders) {
      const colon = line.indexOf(':'); if (colon < 1) throw new LifecycleError(400, 'invalid');
      const key = line.slice(0, colon).toLowerCase(), value = line.slice(colon + 1).trim();
      if (headers.has(key)) throw new LifecycleError(400, 'invalid'); headers.set(key, value);
    }
    const disposition = headers.get('content-disposition') ?? '';
    const d = /^form-data;\s*name="([^"]+)"(?:;\s*filename="([^"]*)")?$/.exec(disposition);
    if (!d) throw new LifecycleError(400, 'invalid');
    const dataStart = headersEnd + 4, next = body.indexOf(delimiter, dataStart);
    if (next < 0) throw new LifecycleError(400, 'invalid');
    parts.push({ name: d[1]!, ...(d[2] === undefined ? {} : { filename: d[2] }), ...(headers.get('content-type') ? { mime: headers.get('content-type')! } : {}), data: body.subarray(dataStart, next) });
    offset = next + delimiter.length;
  }
  if (parts.length !== 2 || parts.filter(p => p.name === 'file').length !== 1 || parts.filter(p => p.name === 'submission').length !== 1) throw new LifecycleError(400, 'invalid');
  const file = parts.find(p => p.name === 'file')!, submission = parts.find(p => p.name === 'submission')!;
  if (file.filename === undefined || file.filename === '' || !file.mime || submission.filename !== undefined || submission.mime !== undefined) throw new LifecycleError(400, 'no_file');
  if (submission.data.length > 256) throw new LifecycleError(400, 'invalid');
  return { bytes: file.data, mime: file.mime, submission: submission.data.toString('utf8') };
}
function operationKeys(value: string, secret: Uint8Array): [string, string, string] {
  const dot = value.lastIndexOf('.'), key = value.slice(0, dot), supplied = value.slice(dot + 1);
  if (!KEY_PATTERN.test(key) || !/^[A-Za-z0-9_-]{43}$/.test(supplied)) throw new LifecycleError(400, 'invalid');
  const expected = createHmac('sha256', secret).update(`document-form:${key}`).digest('base64url');
  if (!timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) throw new LifecycleError(400, 'invalid');
  const timestamp = key.split('.')[1]!;
  return (['authorize', 'bytes', 'finalize'] as const).map(operation => {
    const hex = createHmac('sha256', secret).update(`document-form-key:${operation}:${key}`).digest('hex').slice(0, 32).split('');
    hex[12] = '4'; hex[16] = ['8','9','a','b'][parseInt(hex[16]!, 16) % 4]!;
    const raw = hex.join(''); return `v1.${timestamp}.${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`;
  }) as [string, string, string];
}

/** Browser-only composite. Capabilities and storage identities never leave this process. */
export async function handleDocumentsUpload(request: IncomingMessage, response: ServerResponse, service?: CandidateDocuments, login?: BrowserLoginApplication): Promise<boolean> {
  const path = (request.url ?? '').split('?')[0]!, match = /^\/profile\/documents\/([^/]+)\/upload$/.exec(path);
  if (!match) return false;
  if (request.method !== 'POST' || !CANDIDATE_DOCUMENT_TYPES.includes(match[1] as CandidateDocumentType)) {
    request.resume(); response.writeHead(404, { 'cache-control': 'no-store' }); response.end(); return true;
  }
  const slot = match[1] as CandidateDocumentType, session = sessionCookie(request);
  try {
    if (!session || !login) { request.resume(); writeHtml(response, 401, renderError(401, login)); return true; }
    const authorized = await login.profile({ sessionId: session });
    if (authorized.status !== 200 || typeof authorized.body?.personId !== 'string') { request.resume(); writeHtml(response, 401, renderError(401, login)); return true; }
    if (!service) throw new LifecycleError(503, 'unavailable');
    if (request.headers.origin !== service.options.origin || request.headers['sec-fetch-site'] === 'cross-site') {
      request.resume(); html(response, 403, slot, 'This upload was refused. Return to My documents and try again.'); return true;
    }
    const parsed = multipart(await boundedBody(request), typeof request.headers['content-type'] === 'string' ? request.headers['content-type'] : '');
    if (parsed.bytes.length > CANDIDATE_DOCUMENT_ADMISSION[slot].maxBytes) throw new LifecycleError(413, 'too_large');
    const [authorizeKey, bytesKey, finalizeKey] = operationKeys(parsed.submission, service.options.signingKey);
    const current = (await service.list(session)).find(document => document.type === slot);
    const sha256 = createHash('sha256').update(parsed.bytes).digest('hex');
    const contentMd5 = createHash('md5').update(parsed.bytes).digest('base64');
    const result = await service.authorizeUpload(session, authorizeKey, { type: slot, mime: parsed.mime, size: parsed.bytes.length,
      expectedVersion: current?.version ?? null, ...(service.options.directUploads ? { sha256, contentMd5 } : {}) });
    const ticket = result.body as { uploadId: string; objectKey: string; credential: string };
    await service.put(session, bytesKey, ticket.uploadId, ticket.objectKey, ticket.credential, parsed.bytes);
    const finalized = await service.finalize(session, finalizeKey, { uploadId: ticket.uploadId });
    if (finalized.status !== 200) throw new LifecycleError(503, 'unavailable');
    response.writeHead(303, { location: '/profile/documents', 'cache-control': 'no-store' }); response.end();
  } catch (error) {
    const e = error instanceof LifecycleError ? error : new LifecycleError(503, 'unavailable');
    if (e.status === 413 || e.code === 'too_large') html(response, 413, slot, 'The file is too large. The size limit is 10 MiB.');
    else if (e.status === 409 || e.code === 'conflict' || e.code === 'key_payload_mismatch') html(response, 409, slot, 'Your documents changed. Try again.');
    else if (e.status === 400 || e.code === 'invalid') html(response, 400, slot, e.code === 'no_file' ? 'Choose a file first.' : 'Choose a valid file in an accepted format.');
    else if (e.status === 403 || e.code === 'denied') html(response, 403, slot, 'This upload was refused.');
    else html(response, 503, slot, 'Documents are temporarily unavailable.');
  }
  return true;
}
