import { createHmac, timingSafeEqual } from 'node:crypto';
import { documentReadHydrator, readPerson, type DocumentState } from './index.js';
import { CandidateDocuments, LifecycleError } from './candidate-lifecycle.js';

// People M-05: a store manager sees the photo and CV of a person placed at their
// store, only through links that are issued per viewer and per store, expire,
// are signed, re-check sight on delivery and are audited both when issued and
// when delivered. Civil ID images are never offered here (decision D1: employers
// do not see civil ID images). Sight and audit are ports. Additive beside
// StaffDocuments and EmployerDocuments; their tokens cannot verify here.

export const STORE_DELIVERY_PATH = '/workspace/stores/documents/delivery';
export const STORE_LINK_TTL_MS = 60_000;
export const STORE_DOCUMENT_TYPES = ['personal-photo', 'resume'] as const;
export type StoreDocumentType = typeof STORE_DOCUMENT_TYPES[number];

export interface StoreSightPort {
  /** True while the viewer manages the store and the subject is placed there (working now or starting later). */
  maySee(viewerPrincipalId: string, subjectPrincipalId: string, storeId: string): Promise<boolean>;
}
export interface StoreDocumentAuditPort {
  recordView(view: { viewerPrincipalId: string; subjectPrincipalId: string; storeId: string; operation: 'issue' | 'deliver'; documentType: StoreDocumentType; documentVersion: string }): Promise<void>;
}

type Claim = { viewer: string; subject: string; store: string; type: StoreDocumentType; version: string; issuedAt: number; expiresAt: number };

const deny = (): never => { throw new LifecycleError(403, 'denied'); };
const unavailable = (): never => { throw new LifecycleError(503, 'unavailable'); };
const types = new Set<string>(STORE_DOCUMENT_TYPES);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const STORE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class StoreDocuments {
  private readonly clock: () => number;
  constructor(private readonly options: { documents: CandidateDocuments; sight: StoreSightPort; audit: StoreDocumentAuditPort; now?: () => number }) {
    this.clock = options.now ?? Date.now;
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) return unavailable();
    return value;
  }

  private async viewer(credential: unknown, subject: unknown, storeId: unknown): Promise<string> {
    const viewer = await this.options.documents.principal(credential);
    if (typeof subject !== 'string' || !subject.length || subject.length > 256 || typeof storeId !== 'string' || !STORE.test(storeId)) return deny();
    // STOREDOC_MUTANT_SIGHT: every list, issue and delivery re-checks sight.
    if (!await this.options.sight.maySee(viewer, subject, storeId)) return deny();
    return viewer;
  }

  /** Reads only `subject`'s documents when the store is per-owner. */
  private async read<T>(subject: string, fn: (state: DocumentState) => Promise<T>): Promise<T> {
    return readPerson(this.options.documents.options.store, subject, fn);
  }

  private rows(state: DocumentState, subject: string, type: StoreDocumentType) {
    return state.documents.filter(row => row.scope.orgId === this.options.documents.options.orgId && row.scope.personId === subject && row.type === type);
  }

  private mac(payload: string): string {
    // STOREDOC_MUTANT_LABEL: a staff or employer token can never verify here, nor the reverse.
    return createHmac('sha256', this.options.documents.options.signingKey).update('store-delivery-v1\u0000' + payload).digest('base64url');
  }

  /** The photo and CV: on file or not, with format and size. Records nothing. */
  async documents(credential: unknown, subject: string, storeId: string): Promise<Array<{ type: StoreDocumentType; mime: string; size: number } | { type: StoreDocumentType; missing: true }>> {
    await this.viewer(credential, subject, storeId);
    return this.read(subject, async state => STORE_DOCUMENT_TYPES.map(type => {
      const rows = this.rows(state, subject, type);
      return rows.length === 1 ? { type, mime: rows[0]!.mime, size: rows[0]!.size } : { type, missing: true as const };
    }));
  }

  /** One link for one document on file, audited before it is returned. */
  async issue(credential: unknown, subject: string, storeId: string, type: unknown): Promise<{ url: string; expiresAt: number }> {
    const viewer = await this.viewer(credential, subject, storeId);
    if (typeof type !== 'string' || !types.has(type)) return deny();
    const documentType = type as StoreDocumentType;
    return this.read(subject, async state => {
      const rows = this.rows(state, subject, documentType);
      if (rows.length !== 1) return deny();
      const row = rows[0]!, issuedAt = this.now(), expiresAt = issuedAt + STORE_LINK_TTL_MS;
      try { await this.options.audit.recordView({ viewerPrincipalId: viewer, subjectPrincipalId: subject, storeId, operation: 'issue', documentType, documentVersion: row.version }); }
      catch { return unavailable(); } // STOREDOC_MUTANT_AUDIT
      const claim: Claim = { viewer, subject, store: storeId, type: documentType, version: row.version, issuedAt, expiresAt };
      const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
      return { url: `${STORE_DELIVERY_PATH}?t=${payload}.${this.mac(payload)}`, expiresAt };
    });
  }

  async deliver(credential: unknown, token: string): Promise<{ bytes: Buffer; headers: Record<string, string> }> {
    if (typeof token !== 'string' || token.length > 8192) return deny();
    let url: URL;
    try { url = new URL(token, this.options.documents.options.origin); } catch { return deny(); }
    if (url.origin !== this.options.documents.options.origin || url.pathname !== STORE_DELIVERY_PATH || url.hash !== ''
      || [...url.searchParams.keys()].length !== 1 || [...url.searchParams.keys()].some(key => key !== 't')) return deny();
    const parts = url.searchParams.get('t')?.split('.');
    if (!parts || parts.length !== 2) return deny();
    const [payload, supplied] = parts as [string, string];
    const a = Buffer.from(supplied), b = Buffer.from(this.mac(payload));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return deny();
    let claim: unknown;
    try { claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return deny(); }
    if (!isRecord(claim) || Object.keys(claim).length !== 7 || typeof claim.viewer !== 'string' || typeof claim.subject !== 'string' || typeof claim.store !== 'string'
      || typeof claim.type !== 'string' || !types.has(claim.type) || typeof claim.version !== 'string' || typeof claim.issuedAt !== 'number' || typeof claim.expiresAt !== 'number') return deny();
    const viewer = await this.viewer(credential, claim.subject, claim.store);
    if (claim.viewer !== viewer) return deny(); // STOREDOC_MUTANT_VIEWER
    const now = this.now();
    if (!Number.isSafeInteger(claim.issuedAt) || claim.expiresAt !== claim.issuedAt + STORE_LINK_TTL_MS || now < claim.issuedAt || now >= claim.expiresAt) return deny();
    const subject = claim.subject, storeId = claim.store, type = claim.type as StoreDocumentType, version = claim.version;
    return this.read(subject, async state => {
      const rows = this.rows(state, subject, type);
      if (rows.length !== 1 || rows[0]!.version !== version) return deny(); // STOREDOC_MUTANT_VERSION
      const row = rows[0]!;
      try { await this.options.audit.recordView({ viewerPrincipalId: viewer, subjectPrincipalId: subject, storeId, operation: 'deliver', documentType: type, documentVersion: row.version }); }
      catch { return unavailable(); }
      const hydrate = (state as DocumentState & { [documentReadHydrator]?: (id: string) => Promise<void> })[documentReadHydrator];
      if (hydrate) await hydrate(row.id);
      const bytes = Buffer.from(row.data, 'base64');
      if (bytes.length !== row.size) return unavailable();
      return { bytes, headers: {
        'Content-Type': row.mime, 'Content-Length': String(row.size), 'Content-Disposition': 'inline', 'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer', 'Content-Security-Policy': "default-src 'none'; sandbox",
      } };
    });
  }
}
