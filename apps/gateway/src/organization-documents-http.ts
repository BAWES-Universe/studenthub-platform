import type { IncomingMessage, ServerResponse } from 'node:http';
import { DocumentError, PrivateDocuments, type DocumentType, type Metadata } from '../../../packages/private-documents/src/index.js';

export interface OrganizationDocumentsRuntime {
  service: PrivateDocuments;
  origin: string;
}

function credential(request: IncomingMessage): string {
  const auth = request.headers.authorization;
  if (auth?.startsWith('Bearer ')) return auth.slice(7);
  for (const item of request.headers.cookie?.split(';') ?? []) {
    const [key, value] = item.trim().split('=');
    if (key === '__Host-studenthub_session' && /^[A-Za-z0-9_-]{43}$/.test(value ?? '')) return value!;
  }
  return '';
}
function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function exact(value: Record<string, unknown>, fields: string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every(field => field in value);
}
async function json(request: IncomingMessage): Promise<unknown> {
  const limit = 14 * 1024 * 1024;
  if (request.headers['content-type'] !== 'application/json') throw new DocumentError('invalid');
  if (Number(request.headers['content-length']) > limit) throw new DocumentError('invalid');
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const bytes = Buffer.from(chunk); size += bytes.length;
    if (size > limit) { request.resume(); throw new DocumentError('invalid'); }
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new DocumentError('invalid'); }
}
function upload(value: unknown): { scope: { orgId: string }; type: DocumentType; mime: string; bytes: Buffer } {
  if (!record(value) || !exact(value, ['orgId', 'type', 'mime', 'data']) ||
      typeof value.orgId !== 'string' || typeof value.type !== 'string' || typeof value.mime !== 'string' ||
      typeof value.data !== 'string' || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value.data))
    throw new DocumentError('invalid');
  const bytes = Buffer.from(value.data, 'base64');
  if (bytes.toString('base64') !== value.data || !['company-logo', 'commercial-licence'].includes(value.type))
    throw new DocumentError('invalid');
  return { scope: { orgId: value.orgId }, type: value.type as DocumentType, mime: value.mime, bytes };
}
function metadata(value: Metadata): Metadata {
  return { id: value.id, type: value.type, mime: value.mime, size: value.size, version: value.version };
}

export async function handleOrganizationDocuments(request: IncomingMessage, response: ServerResponse, runtime?: OrganizationDocumentsRuntime): Promise<boolean> {
  const raw = request.url ?? '';
  if (!raw.startsWith('/organization-documents')) return false;
  response.setHeader('Cache-Control', 'private, no-store');
  response.setHeader('X-Content-Type-Options', 'nosniff');
  response.setHeader('Referrer-Policy', 'no-referrer');
  response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  const send = (status: number, value?: unknown): void => {
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(value === undefined ? undefined : JSON.stringify(value));
  };
  try {
    if (!runtime) { send(503, { error: 'unavailable' }); return true; }
    const session = credential(request);
    if (request.method === 'GET' && raw.startsWith('/organization-documents/delivery?')) {
      const result = await runtime.service.deliver(session, runtime.origin + raw);
      response.writeHead(200, result.headers); response.end(result.bytes); return true;
    }
    const routes = new Set(['/organization-documents/upload', '/organization-documents/replace', '/organization-documents/remove', '/organization-documents/delivery']);
    if (request.method !== 'POST' || !routes.has(raw)) { send(404, { error: 'not_found' }); return true; }
    if (request.headers.origin !== runtime.origin || request.headers['sec-fetch-site'] === 'cross-site') {
      send(403, { error: 'denied' }); return true;
    }
    const input = await json(request);
    if (raw === '/organization-documents/upload') {
      send(201, metadata(await runtime.service.upload(session, upload(input)))); return true;
    }
    if (raw === '/organization-documents/replace') {
      if (!record(input) || !exact(input, ['documentId', 'orgId', 'type', 'mime', 'data']) || typeof input.documentId !== 'string') throw new DocumentError('invalid');
      const { documentId, ...body } = input;
      send(200, metadata(await runtime.service.replace(session, documentId, upload(body)))); return true;
    }
    if (!record(input) || !exact(input, ['documentId']) || typeof input.documentId !== 'string') throw new DocumentError('invalid');
    if (raw === '/organization-documents/delivery') {
      const delivery = await runtime.service.issueDelivery(session, input.documentId);
      send(200, { url: delivery.url, expiresAt: delivery.expiresAt }); return true;
    }
    const previous = metadata(await runtime.service.metadata(session, input.documentId));
    await runtime.service.remove(session, input.documentId);
    send(200, previous);
  } catch (error) {
    const code = error instanceof DocumentError ? error.code : 'unavailable';
    send(code === 'denied' ? 404 : code === 'invalid' ? 400 : 503, { error: code === 'denied' ? 'not_found' : code });
  }
  return true;
}
