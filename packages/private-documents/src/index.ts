import type { IncomingMessage, ServerResponse } from 'node:http';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, unlink, lstat } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { resolveActiveContext, type AuthzStore, type RequestIdentity } from '../../contracts/src/index.js';
export type DocumentType = 'personal-photo' | 'resume' | 'civil-id-front' | 'civil-id-back' | 'video' | 'video-thumbnail' | 'company-logo' | 'commercial-licence';
export interface Scope {
    orgId: string;
    personId?: string;
}
export interface Metadata {
    id: string;
    version: string;
    type: DocumentType;
    mime: string;
    size: number;
}
interface StoredDocument extends Metadata {
    scope: Scope;
    acl: 'private';
    data: string;
}
export interface DocumentState {
    format: 1;
    documents: StoredDocument[];
    retired: StoredDocument[];
}
/** Must isolate concurrent transactions, commit atomically, and roll back on callback failure.
 * This is a trusted server-only port, never a client adapter or metadata endpoint. */
export interface DocumentStore {
    transaction<T>(fn: (state: DocumentState) => Promise<T>): Promise<T>;
}
type Code = 'denied' | 'invalid' | 'unavailable';
class DocumentError extends Error {
    constructor(readonly code: Code) { super(code); this.name = 'DocumentError'; }
}
function fail(code: Code): never { throw new DocumentError(code); }
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const types = new Set(['personal-photo', 'resume', 'civil-id-front', 'civil-id-back', 'video', 'video-thumbnail', 'company-logo', 'commercial-licence']);
const orgType = (type: string) => type === 'company-logo' || type === 'commercial-licence';
function record(value: unknown): value is Record<string, unknown> { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function exact(value: Record<string, unknown>, fields: string[]): boolean { return Object.keys(value).every(k => fields.includes(k)); }
function scopeOf(value: unknown): Scope {
    if (!record(value) || !exact(value, ['orgId', 'personId']) || typeof value.orgId !== 'string' || !/^[\w-]{1,128}$/.test(value.orgId) ||
        (value.personId !== undefined && (typeof value.personId !== 'string' || !/^[\w-]{1,128}$/.test(value.personId))))
        return fail('invalid');
    return { orgId: value.orgId, ...(value.personId === undefined ? {} : { personId: value.personId as string }) };
}
function privateAcl(value: unknown): void { if (value !== undefined && value !== 'private')
    fail('invalid'); }
function validateContent(type: string, mime: string, bytes: Buffer): void {
    if (!types.has(type) || bytes.length === 0 || bytes.length > (type === 'video' ? 100 : 10) * 1024 * 1024)
        fail('invalid');
    const image = mime === 'image/png' && bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex')) || mime === 'image/jpeg' && bytes.subarray(0, 3).equals(Buffer.from([255, 216, 255]));
    const pdf = mime === 'application/pdf' && bytes.subarray(0, 5).toString('ascii') === '%PDF-';
    const mp4 = mime === 'video/mp4' && bytes.length >= 16 && bytes.subarray(4, 8).toString('ascii') === 'ftyp';
    if (!(type === 'video' ? mp4 : type === 'resume' ? pdf : type === 'commercial-licence' ? pdf || image : image))
        fail('invalid');
}
function uploadOf(value: unknown): Omit<StoredDocument, 'id' | 'version'> {
    if (!record(value) || !exact(value, ['scope', 'type', 'mime', 'bytes', 'acl']) || typeof value.type !== 'string' || typeof value.mime !== 'string' || !Buffer.isBuffer(value.bytes))
        return fail('invalid');
    privateAcl(value.acl);
    const scope = scopeOf(value.scope);
    const bytes = Buffer.from(value.bytes);
    validateContent(value.type, value.mime, bytes);
    if (orgType(value.type) !== (scope.personId === undefined))
        fail('invalid');
    return { scope, type: value.type as DocumentType, mime: value.mime, size: bytes.length, data: bytes.toString('base64'), acl: 'private' };
}
function metadata(d: StoredDocument): Metadata { return { id: d.id, version: d.version, type: d.type, mime: d.mime, size: d.size }; }
function validateState(value: unknown): asserts value is DocumentState {
    if (!record(value) || value.format !== 1 || !exact(value, ['format', 'documents', 'retired']) || !Array.isArray(value.documents) || !Array.isArray(value.retired))
        fail('unavailable');
    const ids = new Set<string>();
    for (const d of [...value.documents, ...value.retired]) {
        if (!record(d) || !exact(d, ['id', 'version', 'type', 'mime', 'size', 'scope', 'acl', 'data']) || typeof d.id !== 'string' || !uuid.test(d.id) || typeof d.version !== 'string' || !uuid.test(d.version) || d.acl !== 'private' || typeof d.data !== 'string' || !Number.isSafeInteger(d.size) || typeof d.type !== 'string' || typeof d.mime !== 'string')
            fail('unavailable');
        const bytes = Buffer.from(d.data as string, 'base64');
        if (bytes.toString('base64') !== d.data || bytes.length !== d.size)
            fail('unavailable');
        try {
            uploadOf({ scope: d.scope, type: d.type, mime: d.mime, bytes, acl: d.acl });
        }
        catch {
            fail('unavailable');
        }
    }
    for (const d of value.documents) {
        if (ids.has(d.id))
            fail('unavailable');
        ids.add(d.id);
    }
}
/** Durable private filesystem reference adapter for isolated/synthetic storage.
 * No web root, public ACL or unsigned URL capability. A busy/stale lock fails closed;
 * operator recovery must first prove the old writer stopped. Never steal a lock. */
export class FileDocumentStore implements DocumentStore {
    private constructor(private readonly root: string) { }
    static async create(root: string): Promise<FileDocumentStore> {
        root = resolve(root);
        await mkdir(root, { mode: 0o700 });
        const file = await open(join(root, 'state.json'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        try {
            await file.writeFile(JSON.stringify({ format: 1, documents: [], retired: [] }));
            await file.sync();
        }
        finally {
            await file.close();
        }
        return FileDocumentStore.open(root);
    }
    static async open(root: string): Promise<FileDocumentStore> {
        const store = new FileDocumentStore(resolve(root));
        await store.checkRoot();
        return store;
    }
    private async checkRoot(): Promise<void> {
        const stat = await lstat(this.root);
        if (!stat.isDirectory() || (stat.mode & 0o777) !== 0o700 || stat.uid !== process.getuid?.())
            fail('unavailable');
    }
    async transaction<T>(fn: (state: DocumentState) => Promise<T>): Promise<T> {
        await this.checkRoot();
        const lock = await open(join(this.root, '.lock'), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        const temp = join(this.root, `.state-${randomUUID()}`);
        try {
            const file = await open(join(this.root, 'state.json'), constants.O_RDONLY | constants.O_NOFOLLOW);
            let raw: string;
            try {
                const stat = await file.stat();
                if (!stat.isFile() || (stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.() || stat.nlink !== 1 || stat.size > 256 * 1024 * 1024)
                    fail('unavailable');
                raw = await file.readFile('utf8');
            }
            finally {
                await file.close();
            }
            const state: unknown = JSON.parse(raw);
            validateState(state);
            const result = await fn(state);
            validateState(state);
            const next = JSON.stringify(state);
            if (next === raw)
                return result;
            if (Buffer.byteLength(next) > 256 * 1024 * 1024)
                fail('unavailable');
            const out = await open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
            try {
                await out.writeFile(next);
                await out.sync();
            }
            finally {
                await out.close();
            }
            await rename(temp, join(this.root, 'state.json'));
            const dir = await open(this.root, constants.O_RDONLY | constants.O_DIRECTORY);
            try {
                await dir.sync();
            }
            finally {
                await dir.close();
            }
            return result;
        }
        finally {
            await unlink(temp).catch(() => undefined);
            await lock.close();
            await unlink(join(this.root, '.lock'));
        }
    }
}
export interface PrivateDocumentOptions {
    store: DocumentStore;
    authz: AuthzStore;
    /** Trusted authentication adapter: resolve an opaque, verified session/assertion each call.
     * Must never interpret a client-supplied principal ID as proof of identity. */
    authenticate: (credential: string) => Promise<RequestIdentity | null>;
    signingKey: Uint8Array;
    origin: string;
    now?: () => number;
    /** Whitelisted operational events only. No caller input, identifiers, errors or URLs. */
    audit?: (event: {
        operation: string;
        code: 'ok' | Code;
    }) => void;
}
export class PrivateDocuments {
    private readonly key: Buffer;
    private readonly origin: string;
    private readonly clock: () => number;
    constructor(private readonly options: PrivateDocumentOptions) {
        const url = new URL(options.origin);
        if (url.protocol !== 'https:' || url.origin !== options.origin || options.signingKey.byteLength < 32)
            throw new TypeError('invalid private-document configuration');
        this.origin = url.origin;
        this.key = Buffer.from(options.signingKey);
        this.clock = options.now ?? Date.now;
    }
    private now(): number { const n = this.clock(); if (!Number.isSafeInteger(n) || n < 0)
        fail('unavailable'); return n; }
    private mac(value: string): string { return createHmac('sha256', this.key).update(value).digest('base64url'); }
    private async run<T>(operation: string, credential: unknown, fn: (identity: RequestIdentity, state: DocumentState) => Promise<T>): Promise<T> {
        try {
            if (typeof credential !== 'string' || credential.length === 0 || credential.length > 8192)
                fail('denied');
            const identity = await this.options.authenticate(credential as string);
            if (!identity)
                return fail('denied');
            const result = await this.options.store.transaction(async (state) => {
                validateState(state);
                return fn(identity, state);
            });
            this.log(operation, 'ok');
            return result;
        }
        catch (error) {
            const code = error instanceof DocumentError ? error.code : 'unavailable';
            this.log(operation, code);
            throw new DocumentError(code);
        }
    }
    private log(operation: string, code: 'ok' | Code): void { try {
        this.options.audit?.({ operation, code });
    }
    catch { /* logging cannot expose dependency errors or change a committed result */ } }
    private async authorize(identity: RequestIdentity, scope: Scope): Promise<string> {
        const role = scope.personId === undefined ? 'org-owner' : 'candidate';
        const result = await resolveActiveContext(identity, { orgId: scope.orgId, role }, this.options.authz);
        if (result.kind !== 'authorized')
            return fail('denied');
        if (scope.personId !== undefined && result.context.principalId !== scope.personId)
            fail('denied');
        return result.context.principalId;
    }
    private async find(identity: RequestIdentity, state: DocumentState, id: unknown): Promise<StoredDocument> {
        if (typeof id !== 'string' || !uuid.test(id))
            return fail('denied');
        const d = state.documents.find(d => d.id === id);
        if (!d)
            return fail('denied');
        await this.authorize(identity, d.scope);
        return d;
    }
    upload(credential: unknown, input: unknown): Promise<Metadata> {
        return this.run('upload', credential, async (identity, state) => {
            const data = uploadOf(input);
            await this.authorize(identity, data.scope);
            const d = { ...data, id: randomUUID(), version: randomUUID() };
            state.documents.push(d);
            return metadata(d);
        });
    }
    metadata(credential: unknown, id: unknown): Promise<Metadata> { return this.run('metadata', credential, async (i, s) => metadata(await this.find(i, s, id))); }
    copy(credential: unknown, id: unknown, target: unknown, options: unknown = {}): Promise<Metadata> {
        return this.run('copy', credential, async (i, s) => {
            if (!record(options) || !exact(options, ['acl']))
                return fail('invalid');
            privateAcl(options.acl);
            const source = await this.find(i, s, id);
            const scope = scopeOf(target);
            if (orgType(source.type) !== (scope.personId === undefined))
                fail('invalid');
            await this.authorize(i, scope);
            const d = { ...source, scope, id: randomUUID(), version: randomUUID(), acl: 'private' as const };
            s.documents.push(d);
            return metadata(d);
        });
    }
    replace(credential: unknown, id: unknown, input: unknown): Promise<Metadata> {
        return this.run('replace', credential, async (i, s) => {
            const previous = await this.find(i, s, id);
            const data = uploadOf(input);
            if (data.type !== previous.type || data.scope.orgId !== previous.scope.orgId || data.scope.personId !== previous.scope.personId)
                fail('invalid');
            const d = { ...data, id: previous.id, version: randomUUID() };
            s.retired.push(previous);
            s.documents[s.documents.indexOf(previous)] = d;
            return metadata(d);
        });
    }
    remove(credential: unknown, id: unknown): Promise<void> {
        return this.run('remove', credential, async (i, s) => { const d = await this.find(i, s, id); s.retired.push(d); s.documents.splice(s.documents.indexOf(d), 1); });
    }
    issueDelivery(credential: unknown, id: unknown, ttlSeconds: unknown = 60): Promise<{
        url: string;
        expiresAt: number;
    }> {
        return this.run('issue-delivery', credential, async (i, s) => {
            if (typeof ttlSeconds !== 'number' || !Number.isInteger(ttlSeconds) || ttlSeconds < 1 || ttlSeconds > 300)
                return fail('invalid');
            const d = await this.find(i, s, id);
            const principal = await this.authorize(i, d.scope);
            const now = this.now();
            const expiresAt = now + ttlSeconds * 1000;
            const payload = Buffer.from(JSON.stringify({ v: 1, id: d.id, version: d.version, subject: this.mac('subject:' + principal), iat: now, exp: expiresAt })).toString('base64url');
            return { url: `${this.origin}/private-documents/delivery?t=${payload}.${this.mac('delivery:' + payload)}`, expiresAt };
        });
    }
    /** Opt-in HTTP adapter; this package does not mount or enable a live route.
     * Bearer value is opaque input to authenticate(), never an identity claim. */
    async handleDelivery(request: IncomingMessage, response: ServerResponse): Promise<void> {
        response.setHeader('Cache-Control', 'private, no-store');
        response.setHeader('X-Content-Type-Options', 'nosniff');
        response.setHeader('Referrer-Policy', 'no-referrer');
        response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
        const error = (status: number, code: string): void => {
            response.writeHead(status, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: code }));
        };
        if (!request.url?.startsWith('/private-documents/delivery?'))
            return error(404, 'not_found');
        if (request.method !== 'GET') {
            response.setHeader('Allow', 'GET');
            return error(405, 'method_not_allowed');
        }
        const authorization = request.headers.authorization;
        const credential = typeof authorization === 'string' && authorization.startsWith('Bearer ') ? authorization.slice(7) : '';
        try {
            const result = await this.deliver(credential, this.origin + request.url);
            response.writeHead(200, result.headers);
            response.end(result.bytes);
        }
        catch (cause) {
            const code = cause instanceof DocumentError ? cause.code : 'unavailable';
            error(code === 'unavailable' ? 503 : 403, code);
        }
    }
    deliver(credential: unknown, link: unknown): Promise<{
        bytes: Buffer;
        headers: Record<string, string>;
    }> {
        return this.run('deliver', credential, async (i, s) => {
            if (typeof link !== 'string' || link.length > 4096)
                return fail('denied');
            let url: URL;
            try {
                url = new URL(link);
            }
            catch {
                return fail('denied');
            }
            const token = url.searchParams.get('t');
            if (!token || url.origin !== this.origin || link !== `${this.origin}/private-documents/delivery?t=${token}`)
                return fail('denied');
            const parts = token.split('.');
            if (parts.length !== 2 || !parts.every(p => /^[A-Za-z0-9_-]+$/.test(p)))
                return fail('denied');
            const [payload, signature] = parts;
            const expected = this.mac('delivery:' + payload);
            if (signature.length !== expected.length || !timingSafeEqual(Buffer.from(signature), Buffer.from(expected)))
                return fail('denied');
            let claim: unknown;
            try {
                claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
            }
            catch {
                return fail('denied');
            }
            const now = this.now();
            if (!record(claim) || claim.v !== 1 || !Number.isSafeInteger(claim.exp) || !Number.isSafeInteger(claim.iat) || Number(claim.exp) <= now || Number(claim.iat) > now || Number(claim.exp) - Number(claim.iat) > 300000 || Number(claim.exp) <= Number(claim.iat))
                return fail('denied');
            const d = await this.find(i, s, claim.id);
            const principal = await this.authorize(i, d.scope);
            if (claim.version !== d.version || claim.subject !== this.mac('subject:' + principal))
                return fail('denied');
            return { bytes: Buffer.from(d.data, 'base64'), headers: { 'Content-Type': d.mime, 'Content-Length': String(d.size), 'Content-Disposition': 'attachment', 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' } };
        });
    }
}
