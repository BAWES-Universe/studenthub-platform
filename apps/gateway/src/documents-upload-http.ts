import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHash } from 'node:crypto';
import { createIdempotencyKey } from '../../../packages/idempotency-contract/src/index.js';
import { CANDIDATE_DOCUMENT_ADMISSION, LifecycleError, type CandidateDocuments } from '../../../packages/private-documents/src/candidate-lifecycle.js';
import { CANDIDATE_DOCUMENT_TYPES, type CandidateDocumentType } from '../../../packages/private-documents/src/lifecycle-state.js';
import { pageDocument, writeHtml } from './web-ui.js';

export const DOCUMENT_MULTIPART_OVERHEAD = 64 * 1024;
const LIMIT = CANDIDATE_DOCUMENT_ADMISSION.resume.maxBytes + DOCUMENT_MULTIPART_OVERHEAD;
const submissionPattern = /^v1\.(\d{13})\.([0-9a-f-]{36})$/;
const escape = (value: string): string => value.replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const slotName = (slot: CandidateDocumentType): string => ({'personal-photo':'Personal photo',resume:'CV','civil-id-front':'Civil ID front','civil-id-back':'Civil ID back'})[slot];

function sessionCookie(request: IncomingMessage): string | undefined {
  const values = (request.headers.cookie?.split(';') ?? []).map(v => v.trim()).filter(v => v.startsWith('__Host-studenthub_session='));
  if (values.length !== 1) return undefined;
  return /^__Host-studenthub_session=([A-Za-z0-9_-]{43})$/.exec(values[0]!)?.[1];
}
function key(submission: string, operation: string): string {
  const match = submissionPattern.exec(submission); if (!match) throw new LifecycleError(400, 'invalid');
  const hex = createHash('sha256').update(`documents-form:${operation}:${submission}`).digest('hex').slice(0,32).split('');
  hex[12] = '4'; hex[16] = ((parseInt(hex[16]!,16)&3)|8).toString(16);
  const uuid = `${hex.slice(0,8).join('')}-${hex.slice(8,12).join('')}-${hex.slice(12,16).join('')}-${hex.slice(16,20).join('')}-${hex.slice(20).join('')}`;
  return createIdempotencyKey(new Date(Number(match[1])), uuid as `${string}-${string}-${string}-${string}-${string}`);
}
async function read(request: IncomingMessage): Promise<Buffer> {
  const declared = request.headers['content-length'];
  if (declared !== undefined && (!/^\d+$/.test(declared) || Number(declared) > LIMIT)) { request.resume(); throw new LifecycleError(413,'too_large'); }
  const chunks: Buffer[]=[]; let size=0;
  for await (const chunk of request.iterator({destroyOnReturn:false})) {
    const bytes=Buffer.from(chunk); size+=bytes.length;
    if (size>LIMIT) { request.resume(); throw new LifecycleError(413,'too_large'); }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
type Form = { bytes: Buffer; mime: string; submission: string };
function multipart(body: Buffer, contentType: string): Form {
  const type = /^multipart\/form-data;\s*boundary=(?:"([A-Za-z0-9'()+_,.\/:=? -]{1,70})"|([A-Za-z0-9'()+_,.\/:=?-]{1,70}))$/.exec(contentType);
  const boundary=type?.[1] ?? type?.[2]; if (!boundary) throw new LifecycleError(400,'invalid');
  const marker=Buffer.from(`--${boundary}`), separator=Buffer.from('\r\n\r\n');
  const closingWithCrlf=Buffer.from(`--${boundary}--\r\n`), closing=Buffer.from(`--${boundary}--`);
  if (!body.subarray(0,marker.length).equals(marker) || (!body.subarray(-closingWithCrlf.length).equals(closingWithCrlf) && !body.subarray(-closing.length).equals(closing))) throw new LifecycleError(400,'invalid');
  const raw=body.toString('latin1').split(`--${boundary}`); if (raw.shift()!=='' || !['--','--\r\n'].includes(raw.pop()!)) throw new LifecycleError(400,'invalid');
  let file: Form['bytes']|undefined, mime='', submission: string|undefined, emptyName=false;
  for (const value of raw) {
    if (!value.startsWith('\r\n') || !value.endsWith('\r\n')) throw new LifecycleError(400,'invalid');
    const part=Buffer.from(value.slice(2,-2),'latin1'), at=part.indexOf(separator); if (at<0 || at>8192) throw new LifecycleError(400,'invalid');
    const headers=part.subarray(0,at).toString('latin1').split('\r\n'); const payload=part.subarray(at+4);
    if (headers.some(h=>/^\s/.test(h)) || new Set(headers.map(h=>h.split(':',1)[0]!.toLowerCase())).size!==headers.length) throw new LifecycleError(400,'invalid');
    const disposition=headers.find(h=>h.toLowerCase().startsWith('content-disposition:'));
    if (!disposition) throw new LifecycleError(400,'invalid');
    const fileMatch=/^content-disposition: form-data; name="file"; filename="([^"]*)"$/i.exec(disposition);
    const submissionMatch=/^content-disposition: form-data; name="submission"$/i.exec(disposition);
    if (fileMatch) {
      if (file !== undefined || headers.length!==2) throw new LifecycleError(400,'invalid');
      const content=/^content-type: ([a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+)$/i.exec(headers.find(h=>h.toLowerCase().startsWith('content-type:')) ?? '');
      if (!content) throw new LifecycleError(400,'invalid'); file=payload; mime=content[1]!.toLowerCase(); emptyName=fileMatch[1]==='';
    } else if (submissionMatch) {
      if (submission!==undefined || headers.length!==1) throw new LifecycleError(400,'invalid'); submission=payload.toString('utf8');
    } else throw new LifecycleError(400,'invalid');
  }
  if (!file || !submission || emptyName) throw new LifecycleError(400,emptyName?'no_file':'invalid');
  return {bytes:file,mime,submission};
}
function errorPage(slot: CandidateDocumentType, status: number, code: string): string {
  const reason = status===413 ? `The file is too large. Maximum size is ${CANDIDATE_DOCUMENT_ADMISSION[slot].maxBytes/(1024*1024)} MiB.`
    : status===409 ? 'Your documents changed. Try again.' : status===401 ? 'Sign in to upload your document.'
    : status===403 ? 'This upload was not allowed.' : status===400 && code==='no_file' ? 'Choose a file first.'
    : status===400 ? 'Choose a valid file in an accepted format.' : 'Documents are temporarily unavailable.';
  return pageDocument(`${slotName(slot)} upload`, `<main id="main" class="profile-ui"><div class="p-shell"><section class="p-main p-card p-stack"><h1>${escape(slotName(slot))}</h1><p role="status">${escape(reason)}</p><a href="/profile/documents">Back to My documents</a></section></div></main>`, 'en');
}
export async function handleDocumentsUpload(request: IncomingMessage, response: ServerResponse, service?: CandidateDocuments): Promise<boolean> {
  const path=(request.url??'').split('?',1)[0]!, match=/^\/profile\/documents\/([^/]+)\/upload$/.exec(path);
  if (!match) return false;
  if (request.method!=='POST' || !CANDIDATE_DOCUMENT_TYPES.includes(match[1] as CandidateDocumentType)) return false;
  const slot=match[1] as CandidateDocumentType;
  const send=(status:number,code:string)=>writeHtml(response,status,errorPage(slot,status,code));
  try {
    const session=sessionCookie(request); if (!session) { request.resume(); send(401,'denied'); return true; }
    if (!service) { request.resume(); send(503,'unavailable'); return true; }
    if (request.headers.origin!==service.options.origin || request.headers['sec-fetch-site']==='cross-site') { request.resume(); send(403,'denied'); return true; }
    await service.principal(session);
    const form=multipart(await read(request),String(request.headers['content-type']??''));
    const current=(await service.list(session)).find(document=>document.type===slot);
    const digest=createHash('sha256').update(form.bytes).digest('hex'), contentMd5=createHash('md5').update(form.bytes).digest('base64');
    const authorized=await service.authorizeUpload(session,key(form.submission,'authorize'),{type:slot,mime:form.mime,size:form.bytes.length,expectedVersion:current?.version??null,...(service.options.directUploads?{sha256:digest,contentMd5}:{})});
    const ticket=authorized.body as {uploadId:string;objectKey:string;credential:string};
    await service.put(session,key(form.submission,'bytes'),ticket.uploadId,ticket.objectKey,ticket.credential,form.bytes);
    await service.finalize(session,key(form.submission,'finalize'),{uploadId:ticket.uploadId});
    response.writeHead(303,{'location':'/profile/documents','cache-control':'no-store'}); response.end();
  } catch (error) {
    const e=error instanceof LifecycleError?error:new LifecycleError(503,'unavailable');
    send(e.code==='denied'?401:[400,401,403,409,413].includes(e.status)?e.status:503,e.code);
  }
  return true;
}
