import { createHash } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createIdempotencyKey } from '../../../packages/idempotency-contract/src/index.js';
import { CANDIDATE_DOCUMENT_ADMISSION, LifecycleError, type CandidateDocuments } from '../../../packages/private-documents/src/candidate-lifecycle.js';
import { CANDIDATE_DOCUMENT_TYPES, type CandidateDocumentType } from '../../../packages/private-documents/src/lifecycle-state.js';
import { pageDocument, writeHtml, type BrowserLoginApplication } from './web-ui.js';

const OVERHEAD = 64 * 1024;
const LIMIT = 10 * 1024 * 1024;
const LABELS: Record<CandidateDocumentType, string> = {
  'personal-photo': 'Personal photo', resume: 'CV', 'civil-id-front': 'Civil ID front', 'civil-id-back': 'Civil ID back',
};

function escape(value: string): string {
  return value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
function page(type: CandidateDocumentType, reason: string): string {
  return pageDocument(`${LABELS[type]} upload`, `<main id="main" class="profile-ui"><div class="p-shell"><section class="p-main p-card p-stack"><a href="/profile/documents">Back to My documents</a><h1>${LABELS[type]}</h1><p role="alert">${escape(reason)}</p></section></div></main>`, 'en');
}
function sessionCookie(request: IncomingMessage): string | undefined {
  const values = (request.headers.cookie?.split(';') ?? []).map(v => v.trim()).filter(v => v.startsWith('__Host-studenthub_session='));
  if (values.length !== 1) return undefined;
  return /^__Host-studenthub_session=([A-Za-z0-9_-]{43})$/.exec(values[0]!)?.[1];
}
function submissionKey(value: string, operation: string): string {
  const match = /^(\d{13})\.([0-9a-f-]{36})$/i.exec(value);
  if (!match || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(match[2]!)) throw new LifecycleError(400, 'invalid');
  const hex = createHash('sha256').update(`${match[2]}:${operation}`).digest('hex');
  const uuid = `${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
  return createIdempotencyKey(new Date(Number(match[1])), uuid as `${string}-${string}-${string}-${string}-${string}`);
}
async function bounded(request: IncomingMessage): Promise<Buffer> {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > LIMIT + OVERHEAD)) throw new LifecycleError(413, 'too_large');
  const chunks: Buffer[] = []; let size = 0;
  for await (const raw of request.iterator({ destroyOnReturn: false })) {
    const chunk = Buffer.from(raw); size += chunk.length;
    if (size > LIMIT + OVERHEAD) { request.pause(); throw new LifecycleError(413, 'too_large'); }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, size);
}
type Form = { bytes: Buffer; mime: string; submission: string; noFile: boolean };
function multipart(body: Buffer, contentType: string | undefined): Form {
  const match = /^multipart\/form-data;\s*boundary=([!#$%&'*+.^_`|~0-9A-Za-z-]{1,70})$/.exec(contentType ?? '');
  if (!match) throw new LifecycleError(400, 'invalid');
  const boundary = Buffer.from(`--${match[1]}`), divider = Buffer.from('\r\n\r\n');
  if (!body.subarray(0, boundary.length).equals(boundary)) throw new LifecycleError(400, 'invalid');
  const sections: Buffer[] = []; let at = boundary.length;
  while (true) {
    if (body.subarray(at, at + 2).toString() === '--') { if (at + 2 !== body.length && body.subarray(at + 2).toString() !== '\r\n') throw new LifecycleError(400, 'invalid'); break; }
    if (body.subarray(at, at + 2).toString() !== '\r\n') throw new LifecycleError(400, 'invalid');
    const next = body.indexOf(Buffer.concat([Buffer.from('\r\n'), boundary]), at + 2);
    if (next < 0) throw new LifecycleError(400, 'invalid');
    sections.push(body.subarray(at + 2, next)); at = next + 2 + boundary.length;
  }
  let file: Form | undefined, submission: string | undefined;
  for (const section of sections) {
    const split = section.indexOf(divider); if (split < 0 || split > OVERHEAD) throw new LifecycleError(400, 'invalid');
    const headers = section.subarray(0, split).toString('latin1').split('\r\n');
    const disposition = headers.find(h => h.toLowerCase().startsWith('content-disposition:'));
    const name = /(?:^|;)\s*name="([^"]*)"/.exec(disposition ?? '')?.[1];
    const filename = /(?:^|;)\s*filename="([^"]*)"/.exec(disposition ?? '')?.[1];
    const data = section.subarray(split + divider.length);
    if (name === 'file' && filename !== undefined) {
      if (file) throw new LifecycleError(400, 'invalid');
      const mime = headers.find(h => h.toLowerCase().startsWith('content-type:'))?.slice(13).trim() ?? '';
      file = { bytes: data, mime, submission: '', noFile: filename === '' };
    } else if (name === 'submission' && filename === undefined) {
      if (submission !== undefined || data.length > 128) throw new LifecycleError(400, 'invalid');
      submission = data.toString('utf8');
    } else throw new LifecycleError(400, 'invalid');
  }
  if (!file || submission === undefined) throw new LifecycleError(400, 'invalid');
  return { ...file, submission };
}

export async function handleDocumentsUpload(request: IncomingMessage, response: ServerResponse, service?: CandidateDocuments, login?: BrowserLoginApplication): Promise<boolean> {
  const path = (request.url ?? '').split('?')[0]!;
  const route = /^\/profile\/documents\/([^/]+)\/upload$/.exec(path);
  if (!route) return false;
  const type = route[1] as CandidateDocumentType;
  if (!CANDIDATE_DOCUMENT_TYPES.includes(type)) { request.resume(); response.writeHead(404, { 'cache-control': 'no-store' }); response.end(); return true; }
  if (request.method !== 'POST') { request.resume(); response.writeHead(404, { 'cache-control': 'no-store' }); response.end(); return true; }
  const fail = (status: number, reason: string): void => writeHtml(response, status, page(type, reason), status === 413 ? { connection: 'close' } : {});
  try {
    const session = sessionCookie(request);
    if (!session || !login) { fail(401, 'Sign in to upload your document.'); return true; }
    const identity = await login.profile({ sessionId: session });
    if (identity.status !== 200 || typeof identity.body?.personId !== 'string') { fail(401, 'Sign in to upload your document.'); return true; }
    if (!service) { fail(503, ''); return true; }
    if (request.headers.origin !== service.options.origin || request.headers['sec-fetch-site'] === 'cross-site') { fail(403, 'This upload must come from My documents.'); return true; }
    const form = multipart(await bounded(request), request.headers['content-type']);
    if (form.noFile) throw new LifecycleError(400, 'no_file');
    const current = (await service.list(session)).find(document => document.type === type);
    const digest = createHash('sha256').update(form.bytes).digest('hex');
    const md5 = createHash('md5').update(form.bytes).digest('base64');
    const authorized = await service.authorizeUpload(session, submissionKey(form.submission, 'authorize'), {
      type, mime: form.mime, size: form.bytes.length, expectedVersion: current?.version ?? null, ...(service.options.directUploads ? { sha256: digest, contentMd5: md5 } : {}),
    });
    const ticket = authorized.body as { uploadId: string; objectKey: string; credential: string };
    await service.put(session, submissionKey(form.submission, 'bytes'), ticket.uploadId, ticket.objectKey, ticket.credential, form.bytes);
    await service.finalize(session, submissionKey(form.submission, 'finalize'), { uploadId: ticket.uploadId });
    response.writeHead(303, { location: '/profile/documents', 'cache-control': 'no-store' }); response.end();
  } catch (error) {
    const lifecycle = error instanceof LifecycleError ? error : new LifecycleError(503, 'unavailable');
    if (lifecycle.status === 413 || lifecycle.code === 'too_large') fail(413, `The file is too large. The maximum size is ${CANDIDATE_DOCUMENT_ADMISSION[type].maxBytes / 1024 / 1024} MiB.`);
    else if (lifecycle.status === 409 || lifecycle.code.includes('conflict') || lifecycle.code === 'key_payload_mismatch') fail(409, 'Your documents changed, try again.');
    else if (lifecycle.status === 400) fail(400, lifecycle.code === 'no_file' ? 'Choose a file first.' : 'Choose a valid file in an accepted format.');
    else if (lifecycle.status === 403) fail(403, 'This upload is not allowed.');
    else fail(503, '');
  }
  return true;
}
