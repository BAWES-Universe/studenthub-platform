import type { DirectUploadPort } from './r2-storage.js';
import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { createIdempotency, type JsonValue, type StoredResponse } from '../../idempotency-contract/src/index.js';
import { resolveActiveContext } from '../../contracts/src/index.js';
import { PrivateDocuments, type DocumentState, type PrivateDocumentOptions, type Metadata } from './index.js';
import { CANDIDATE_DOCUMENT_TYPES, emptyLifecycleState, type CandidateDocumentType, type UploadTicket } from './lifecycle-state.js';
import { validateCandidateContent } from './candidate-content.js';

export class LifecycleError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}
const deny = (): never => { throw new LifecycleError(403, 'denied'); };
const invalid = (): never => { throw new LifecycleError(400, 'invalid'); };
const conflict = (): never => { throw new LifecycleError(409, 'conflict'); };
const hash = (s: string | Buffer): string => createHash('sha256').update(s).digest('hex');
export interface CandidateDocumentOptions extends PrivateDocumentOptions {
  /** Server-owned organization, never inferred from client role/person fields. */
  orgId: string;
  directUploads?: DirectUploadPort;
}
function body(v: unknown, fields: string[]): Record<string, unknown> {
  if (v === null || typeof v !== 'object' || Array.isArray(v) || Object.keys(v).some(k => !fields.includes(k))) return invalid();
  return v as Record<string, unknown>;
}
function kind(v: unknown): CandidateDocumentType {
  if (!CANDIDATE_DOCUMENT_TYPES.includes(v as CandidateDocumentType)) return invalid();
  return v as CandidateDocumentType;
}
function version(v: unknown): string | null {
  if (v !== null && (typeof v !== 'string' || !/^[0-9a-f-]{36}$/.test(v))) return invalid();
  return v as string | null;
}
/** S4 orchestration over SHU-101's transaction/storage and authorization primitive.
 * Tickets, metadata, receipts, retention work and audit commit in ONE transaction. */
export class CandidateDocuments {
  readonly primitive: PrivateDocuments;
  constructor(readonly options: CandidateDocumentOptions) {
    if (!/^[\w-]{1,128}$/.test(options.orgId)) throw new TypeError('invalid candidate-document configuration');
    this.primitive = new PrivateDocuments(options);
  }
  private now(): number {
    const now = (this.options.now ?? Date.now)();
    if (!Number.isSafeInteger(now) || now < 0) throw new LifecycleError(503, 'unavailable');
    return now;
  }
  async principal(credential: unknown): Promise<string> {
    if (typeof credential !== 'string' || !credential.length || credential.length > 8192) return deny();
    const identity = await this.options.authenticate(credential);
    if (!identity) return deny();
    const result = await resolveActiveContext(identity, { orgId: this.options.orgId, role: 'candidate' }, this.options.authz);
    if (result.kind !== 'authorized') return deny();
    return result.context.principalId;
  }
  private token(t: UploadTicket): string {
    return createHmac('sha256', this.options.signingKey).update(JSON.stringify(['upload-v1',t.id,t.objectKey,t.principalId,t.orgId,t.issuedAt,t.expiresAt])).digest('base64url');
  }
  private ticket(s: DocumentState, principalId: string, id: unknown): UploadTicket {
    const ticket = s.lifecycle?.uploads.find(t => t.id === id);
    if (!ticket || ticket.principalId !== principalId || ticket.orgId !== this.options.orgId) return deny();
    return ticket;
  }
  private live(t: UploadTicket): void {
    const now = this.now();
    if (now >= t.expiresAt || now < t.issuedAt) deny();
  }
  private current(s: DocumentState, principalId: string, type: CandidateDocumentType) {
    const rows = s.documents.filter(d => d.scope.personId === principalId && d.scope.orgId === this.options.orgId && d.type === type);
    if (rows.length > 1) throw new LifecycleError(503, 'unavailable');
    return rows[0];
  }
  private bound(s: DocumentState): PrivateDocuments {
    return new PrivateDocuments({ ...this.options, audit: undefined, store: { transaction: fn => fn(s) } });
  }
  private enqueue(s: DocumentState, d: Metadata): void {
    const id = `${d.id}:${d.version}`;
    if (!s.lifecycle!.cleanup.some(c => c.id === id)) s.lifecycle!.cleanup.push({ id, documentId: d.id, version: d.version, retiredAt: this.now(), status: 'held' });
  }
  private async mutation(credential: unknown, key: string | undefined, operation: string, payload: JsonValue,
    fn: (s: DocumentState, principalId: string) => Promise<StoredResponse>,
    preflight?: (s: DocumentState, principalId: string) => void): Promise<StoredResponse> {
    try {
      const principalId = await this.principal(credential), principalRef = hash(principalId);
      let operationError: unknown;
      let transactionState: DocumentState | undefined;
      const result = await createIdempotency({ clock: { now: () => new Date(this.now()) }, store: {
        cleanupExpired: async () => 0,
        executeAtomic: (input, execute) => this.options.store.transaction(async s => {
          s.lifecycle ??= emptyLifecycleState();
          // Transaction-clock check must precede receipt lookup, including retries.
          if (this.now() >= input.expiresAt.getTime()) return { kind: 'expired' };
          // Re-read grants inside the transaction; a cached success never revives a revoked grant.
          if (await this.principal(credential) !== principalId) return deny();
          try { preflight?.(s, principalId); } catch (error) { operationError = error; throw error; }
          const old = s.lifecycle.receipts.find(r => r.key === input.key && r.principalRef === input.principalRef);
          if (old) return old.fingerprint !== input.fingerprint ? {kind:'conflict'} : {kind:'replayed',response:old.response};
          try {
            transactionState = s;
            const response = await execute({insert: () => invalid(), enqueue: () => invalid()});
            s.lifecycle.receipts.push({...input, expiresAt:input.expiresAt.getTime(), response});
            return {kind:'executed',response};
          } catch (error) { operationError = error; throw error; }
        }),
      }}).execute({ key, principalRef, method:operation === 'bytes' ? 'PUT' : 'POST',
        route:operation === 'authorize' ? '/candidate-documents/uploads' : operation === 'bytes' ? '/candidate-documents/uploads/{uploadId}/bytes' : `/candidate-documents/${operation}`,
        payload:{orgId:this.options.orgId,request:payload} }, async () => {
        if (!transactionState) return invalid();
        return fn(transactionState, principalId);
      });
      if (operationError instanceof LifecycleError) throw operationError;
      if (!result.ok) throw new LifecycleError(result.status, result.status === 503 ? 'unavailable' : result.reason);
      this.log(operation, 'ok');
      return result.response;
    } catch (error) {
      const e = error instanceof LifecycleError ? error : new LifecycleError(503,'unavailable');
      this.log(operation,e.status === 503 ? 'unavailable' : e.status === 400 ? 'invalid' : 'denied');
      throw e;
    }
  }
  private log(operation: string, code: 'ok'|'invalid'|'denied'|'unavailable'): void {
    try { void Promise.resolve(this.options.audit?.({operation,code})).catch(() => undefined); } catch { /* no dependency payloads */ }
  }
  authorizeUpload(credential: unknown, key: string | undefined, input: unknown): Promise<StoredResponse> {
    const b = body(input,['type','mime','size','expectedVersion','sha256','contentMd5']);
    const type = kind(b.type), expectedVersion = version(b.expectedVersion);
    if (this.options.directUploads && (typeof b.sha256 !== 'string' || !/^[0-9a-f]{64}$/.test(b.sha256) || typeof b.contentMd5 !== 'string' || !/^[A-Za-z0-9+/]{22}==$/.test(b.contentMd5))) return invalid();
    if (typeof b.mime !== 'string' || !(type === 'resume' ? b.mime === 'application/pdf' : ['image/png','image/jpeg'].includes(b.mime))
      || !Number.isSafeInteger(b.size) || Number(b.size) <= 0 || Number(b.size) > 10*1024*1024) return invalid();
    return this.mutation(credential,key,'authorize',b as JsonValue,async (s,principalId) => {
      if ((this.current(s,principalId,type)?.version ?? null) !== expectedVersion) return conflict();
      const id = randomUUID(), now = this.now();
      const t: UploadTicket = {id,objectKey:`uploads/${id}`,principalId,orgId:this.options.orgId,type,mime:b.mime as string,size:b.size as number,expectedVersion,issuedAt:now,expiresAt:now+60000};
      if (this.options.directUploads) {t.expectedDigest=b.sha256 as string;t.contentMd5=b.contentMd5 as string;}
      s.lifecycle!.uploads.push(t);
      const directUpload = await this.options.directUploads?.authorize(t);
      return {status:201,body:{uploadId:id,objectKey:t.objectKey,credential:this.token(t),expiresAt:t.expiresAt,...(directUpload?{directUpload}:{})}};
    });
  }
  put(credential: unknown, key: string | undefined, id: string, objectKey: string, uploadCredential: string, bytes: Buffer): Promise<StoredResponse> {
    return this.mutation(credential,key,'bytes',{id,objectKey,uploadCredential:hash(uploadCredential),digest:hash(bytes)},async(s,principalId) => {
      const t = this.ticket(s,principalId,id); this.live(t);
      if (t.committed) return conflict();
      if (bytes.length !== t.size) return invalid();
      try { validateCandidateContent(t.type,t.mime,bytes); } catch { return invalid(); }
      const digest = hash(bytes);
      if (t.digest && t.digest !== digest) return conflict();
      t.data = bytes.toString('base64'); t.digest = digest;
      return {status:204};
    }, (s, principalId) => {
      const t = this.ticket(s, principalId, id); this.live(t);
      const expected = this.token(t);
      if (objectKey !== t.objectKey || uploadCredential.length !== expected.length || !timingSafeEqual(Buffer.from(uploadCredential),Buffer.from(expected))) return deny();
    });
  }
  finalize(credential: unknown, key: string | undefined, input: unknown): Promise<StoredResponse> {
    const b = body(input,['uploadId']);
    if (typeof b.uploadId !== 'string') return invalid();
    return this.mutation(credential,key,'finalize',b as JsonValue,async(s,principalId) => {
      const t = this.ticket(s,principalId,b.uploadId); this.live(t);
      if (t.committed) return conflict();
      if (!t.data && this.options.directUploads) {
        const uploaded = await this.options.directUploads.read(t);
        t.data=uploaded.toString('base64');t.digest=hash(uploaded);
      }
      if (!t.data || !t.digest) return conflict();
      const bytes = Buffer.from(t.data,'base64');
      if (hash(bytes) !== t.digest || (t.expectedDigest !== undefined && hash(bytes) !== t.expectedDigest) || bytes.length !== t.size) return invalid();
      try { validateCandidateContent(t.type,t.mime,bytes); } catch { return invalid(); }
      const previous = this.current(s,principalId,t.type);
      if ((previous?.version ?? null) !== t.expectedVersion) return conflict();
      const data = {scope:{orgId:this.options.orgId,personId:principalId},type:t.type,mime:t.mime,bytes};
      const primitive = this.bound(s);
      const metadata = previous ? await primitive.replace(credential,previous.id,data) : await primitive.upload(credential,data);
      if (previous) this.enqueue(s,previous);
      t.committed = true;
      s.lifecycle!.audit.push({id:randomUUID(),operation:'finalize',principalRef:hash(principalId),at:this.now()});
      return {status:200,body:{metadata:{...metadata}}};
    });
  }
  remove(credential: unknown, key: string | undefined, input: unknown): Promise<StoredResponse> {
    const b = body(input,['type','expectedVersion']); const type = kind(b.type), expectedVersion = version(b.expectedVersion);
    return this.mutation(credential,key,'remove',b as JsonValue,async(s,principalId) => {
      const previous = this.current(s,principalId,type);
      if (!previous || previous.version !== expectedVersion) return conflict();
      await this.bound(s).remove(credential,previous.id);
      this.enqueue(s,previous);
      s.lifecycle!.audit.push({id:randomUUID(),operation:'remove',principalRef:hash(principalId),at:this.now()});
      return {status:200,body:{removed:true}};
    });
  }
  private own(s: DocumentState, principalId: string, id: unknown): void {
    const d = s.documents.find(d => d.id === id);
    if (!d || d.scope.personId !== principalId || d.scope.orgId !== this.options.orgId || !CANDIDATE_DOCUMENT_TYPES.includes(d.type as CandidateDocumentType)) deny();
  }
  async issueDelivery(credential: unknown, id: unknown): Promise<{url:string;expiresAt:number}> {
    const principalId = await this.principal(credential);
    return this.options.store.transaction(async s => {
      this.own(s, principalId, id);
      return this.bound(s).issueDelivery(credential, id);
    });
  }
  async deliver(credential: unknown, link: string): Promise<{bytes:Buffer;headers:Record<string,string>}> {
    const principalId = await this.principal(credential);
    return this.options.store.transaction(async s => {
      const result = await this.bound(s).deliver(credential, link);
      // Parse only AFTER the primitive verified signature, exact URL shape and expiry.
      const payload = new URL(link).searchParams.get('t')!.split('.')[0]!;
      const claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as {id:string};
      this.own(s, principalId, claim.id);
      return result;
    });
  }
  async list(credential: unknown): Promise<Metadata[]> {
    const principalId = await this.principal(credential);
    return this.options.store.transaction(async s => {
      const result: Metadata[] = [];
      for (const type of CANDIDATE_DOCUMENT_TYPES) {
        const d = this.current(s,principalId,type);
        if (d) result.push(await this.bound(s).metadata(credential,d.id));
      }
      return result;
    });
  }
  /** Operator-only inspection. No purge capability exists while D6 is unresolved.
   * Queue entries are durable and unique; a hold is never interpreted as permission. */
  async cleanup(): Promise<{held:number;deleted:0}> {
    return this.options.store.transaction(async s => ({held:s.lifecycle?.cleanup.filter(c => c.status === 'held').length ?? 0,deleted:0}));
  }
}
