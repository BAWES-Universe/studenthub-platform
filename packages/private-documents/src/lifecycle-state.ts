import type { StoredResponse } from '../../idempotency-contract/src/index.js';

export const CANDIDATE_DOCUMENT_TYPES = ['personal-photo', 'resume', 'civil-id-front', 'civil-id-back'] as const;
export type CandidateDocumentType = typeof CANDIDATE_DOCUMENT_TYPES[number];
export interface UploadTicket {
  id: string; objectKey: string; principalId: string; orgId: string;
  type: CandidateDocumentType; mime: string; size: number;
  expectedVersion: string | null; issuedAt: number; expiresAt: number;
  data?: string; digest?: string; committed?: boolean; expectedDigest?: string; contentMd5?: string;
}
export interface LifecycleState {
  format: 1;
  uploads: UploadTicket[];
  receipts: { principalRef: string; key: string; fingerprint: string; expiresAt: number; response: StoredResponse }[];
  cleanup: { id: string; documentId: string; version: string; retiredAt: number; status: 'held' | 'deleted' }[];
  audit: { id: string; operation: 'finalize' | 'remove'; principalRef: string; at: number }[];
}
export const emptyLifecycleState = (): LifecycleState => ({ format: 1, uploads: [], receipts: [], cleanup: [], audit: [] });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const reference = /^[0-9a-f]{64}$/;
const name = /^[\w-]{1,128}$/;
function object(v: unknown): v is Record<string, any> { return v !== null && typeof v === 'object' && !Array.isArray(v); }
function keys(v: Record<string, any>, allowed: string[]): boolean { return Object.keys(v).every(k => allowed.includes(k)); }
const instant = (n: unknown): n is number => Number.isSafeInteger(n) && Number(n) >= 0;
function requireValid(v: unknown): asserts v { if (!v) throw new Error('unavailable'); }
/** Validate the private transaction journal at both snapshot boundaries. Never trust persisted headers or credentials. */
export function validateLifecycleState(value: unknown): asserts value is LifecycleState {
  requireValid(object(value) && keys(value, ['format','uploads','receipts','cleanup','audit']) && value.format === 1);
  requireValid(Array.isArray(value.uploads) && Array.isArray(value.receipts) && Array.isArray(value.cleanup) && Array.isArray(value.audit));
  const ids = new Set();
  for (const t of value.uploads) {
    requireValid(object(t) && keys(t, ['id','objectKey','principalId','orgId','type','mime','size','expectedVersion','issuedAt','expiresAt','data','digest','committed','expectedDigest','contentMd5']));
    requireValid(uuid.test(t.id) && t.objectKey === `uploads/${t.id}` && !ids.has(t.id)); ids.add(t.id);
    requireValid(name.test(t.principalId) && name.test(t.orgId) && CANDIDATE_DOCUMENT_TYPES.includes(t.type));
    requireValid(t.type === 'resume' ? t.mime === 'application/pdf' : ['image/png','image/jpeg'].includes(t.mime));
    requireValid(Number.isSafeInteger(t.size) && t.size > 0 && t.size <= 10 * 1024 * 1024);
    requireValid(t.expectedVersion === null || uuid.test(t.expectedVersion));
    requireValid(instant(t.issuedAt) && instant(t.expiresAt) && t.expiresAt > t.issuedAt && t.expiresAt - t.issuedAt <= 300000);
    requireValid(t.expectedDigest === undefined || (typeof t.expectedDigest === 'string' && reference.test(t.expectedDigest)));
    requireValid(t.contentMd5 === undefined || (typeof t.contentMd5 === 'string' && /^[A-Za-z0-9+/]{22}==$/.test(t.contentMd5)));
    requireValid(t.committed === undefined || typeof t.committed === 'boolean');
    requireValid(t.data === undefined ? t.digest === undefined : typeof t.data === 'string' && reference.test(t.digest)
      && Buffer.from(t.data, 'base64').toString('base64') === t.data && Buffer.from(t.data, 'base64').length === t.size);
  }
  const receipts = new Set();
  for (const r of value.receipts) {
    requireValid(object(r) && keys(r, ['principalRef','key','fingerprint','expiresAt','response']));
    requireValid(reference.test(r.principalRef) && reference.test(r.fingerprint) && /^v1\.\d{13}\.[0-9a-f-]{36}$/.test(r.key) && instant(r.expiresAt));
    const key = `${r.principalRef}:${r.key}`; requireValid(!receipts.has(key)); receipts.add(key);
    requireValid(object(r.response) && keys(r.response, ['status','body']) && [200,201,204].includes(r.response.status));
    requireValid(r.response.body === undefined || (object(r.response.body) && keys(r.response.body, ['uploadId','objectKey','credential','expiresAt','metadata','removed','directUpload'])));
    if (r.response.body?.directUpload !== undefined) {
      const d=r.response.body.directUpload;
      requireValid(object(d) && keys(d,['url','headers']) && typeof d.url==='string' && d.url.length<8192 && object(d.headers)
        && keys(d.headers,['content-type','content-length','content-md5','if-none-match']));
    }
    if (r.response.body?.metadata !== undefined) {
      const m = r.response.body.metadata;
      requireValid(object(m) && keys(m, ['id','version','type','mime','size']) && uuid.test(m.id) && uuid.test(m.version)
        && CANDIDATE_DOCUMENT_TYPES.includes(m.type) && ['application/pdf','image/png','image/jpeg'].includes(m.mime) && Number.isSafeInteger(m.size));
    }
  }
  const cleanup = new Set();
  for (const c of value.cleanup) {
    requireValid(object(c) && keys(c, ['id','documentId','version','retiredAt','status']) && uuid.test(c.documentId) && uuid.test(c.version)
      && c.id === `${c.documentId}:${c.version}` && instant(c.retiredAt) && ['held','deleted'].includes(c.status) && !cleanup.has(c.id));
    cleanup.add(c.id);
  }
  for (const a of value.audit) requireValid(object(a) && keys(a, ['id','operation','principalRef','at']) && uuid.test(a.id)
    && ['finalize','remove'].includes(a.operation) && reference.test(a.principalRef) && instant(a.at));
}
