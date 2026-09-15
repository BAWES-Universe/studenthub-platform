import type { IncomingMessage, ServerResponse } from 'node:http';
import { CandidateDocuments, LifecycleError } from '../../../packages/private-documents/src/candidate-lifecycle.js';

function credential(request: IncomingMessage): string {
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  for (const item of request.headers.cookie?.split(';') ?? []) {
    const [key,value] = item.trim().split('=');
    if (key === '__Host-studenthub_session' && /^[A-Za-z0-9_-]{43}$/.test(value ?? '')) return value!;
  }
  return '';
}
function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name]; return typeof value === 'string' ? value : '';
}
async function read(request: IncomingMessage, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = []; let size = 0;
  if (Number(request.headers['content-length']) > limit) { request.resume(); throw new LifecycleError(413,'too_large'); }
  for await (const chunk of request.iterator({destroyOnReturn:false})) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > limit) { request.resume(); throw new LifecycleError(413,'too_large'); }
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}
/** Mounted by createGatewayServer. Only verified session credentials reach the service.
 * The route never accepts principal, organization, role or arbitrary final object keys. */
export async function handleCandidateDocuments(request: IncomingMessage, response: ServerResponse, service?: CandidateDocuments): Promise<boolean> {
  const raw = request.url ?? '';
  if (!raw.startsWith('/candidate-documents') && !raw.startsWith('/private-documents/')) return false;
  response.setHeader('Cache-Control','private, no-store');
  response.setHeader('X-Content-Type-Options','nosniff');
  response.setHeader('Referrer-Policy','no-referrer');
  response.setHeader('Content-Security-Policy',"default-src 'none'; sandbox");
  const send = (status: number, value?: unknown): void => {
    response.writeHead(status,{'content-type':'application/json'});
    response.end(value === undefined ? undefined : JSON.stringify(value));
  };
  try {
    if (!service) { send(503,{error:'unavailable'}); return true; }
    const session = credential(request);
    await service.principal(session); // authenticate before reading any body or issuing a capability
    if (request.method === 'GET' && raw.startsWith('/private-documents/delivery?')) {
      const result = await service.deliver(session,service.options.origin+raw);
      response.writeHead(200,result.headers); response.end(result.bytes); return true;
    }
    if (request.method === 'GET' && raw === '/candidate-documents') {
      send(200,{documents:await service.list(session)}); return true;
    }
    // Cookie requests require exact configured Origin; host/forwarded headers are never authority.
    if (request.headers.origin !== service.options.origin || request.headers['sec-fetch-site'] === 'cross-site') {
      send(403,{error:'denied'}); return true;
    }
    const upload = /^\/candidate-documents\/uploads\/([0-9a-f-]{36})\/bytes$/.exec(raw);
    if (upload && request.method === 'PUT') {
      const bytes = await read(request,10*1024*1024);
      const result = await service.put(session,header(request,'idempotency-key') || undefined,upload[1]!,header(request,'x-object-key'),header(request,'x-upload-credential'),bytes);
      send(result.status,result.body); return true;
    }
    const operations = new Set(['/candidate-documents/uploads','/candidate-documents/finalize','/candidate-documents/remove','/candidate-documents/delivery']);
    if (request.method !== 'POST' || !operations.has(raw)) { send(404,{error:'not_found'}); return true; }
    if (header(request,'content-type') !== 'application/json') throw new LifecycleError(400,'invalid');
    let input: unknown;
    try { input = JSON.parse((await read(request,4096)).toString('utf8')); }
    catch (e) { if (e instanceof LifecycleError) throw e; throw new LifecycleError(400,'invalid'); }
    const key = header(request,'idempotency-key') || undefined;
    if (raw === '/candidate-documents/delivery') {
      if (input === null || typeof input !== 'object' || Array.isArray(input) || Object.keys(input).length !== 1 || !('documentId' in input)) throw new LifecycleError(400,'invalid');
      send(200,await service.issueDelivery(session,input.documentId)); return true;
    }
    const result = raw.endsWith('/uploads') ? await service.authorizeUpload(session,key,input)
      : raw.endsWith('/finalize') ? await service.finalize(session,key,input) : await service.remove(session,key,input);
    send(result.status,result.body);
  } catch (e) {
    // Only closed, service-created error vocabulary can escape. Never serialize dependency messages.
    const code = e instanceof LifecycleError ? e.code : (e as {code?:unknown})?.code;
    const known = typeof code === 'string' && ['denied','invalid','unavailable','conflict','too_large','missing_key','invalid_key','key_in_future','key_expired','key_payload_mismatch'].includes(code);
    const status = e instanceof LifecycleError ? e.status : code === 'denied' ? 403 : code === 'invalid' ? 400 : 503;
    send(known ? status : 503,{error:known ? code : 'unavailable'});
  }
  return true;
}
