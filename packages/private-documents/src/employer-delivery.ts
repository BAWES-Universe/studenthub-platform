import { createHmac, timingSafeEqual } from 'node:crypto';
import { documentReadHydrator, type DocumentState } from './index.js';
import { CANDIDATE_DOCUMENT_TYPES, type CandidateDocumentType } from './lifecycle-state.js';
import { CandidateDocuments, LifecycleError } from './candidate-lifecycle.js';

// Recruit R5 (decision SHU-200): a company keeps legacy sight of the CV, photo and
// civil-ID images of people suggested to, invited to or working through its
// requests, but only through links that are issued per viewer, expire, are signed,
// re-check sight on delivery and are audited both when issued and when opened.
// Sight and audit are ports owned by the recruit area. Additive beside StaffDocuments.

export const EMPLOYER_DELIVERY_PATH = '/recruit/documents/delivery';
export const EMPLOYER_LINK_TTL_MS = 600_000;

export interface EmployerSightPort {
  /** True while the viewer may see the subject through the request (company reader, store manager or operator staff, with a live link). */
  maySee(viewerPrincipalId: string, subjectPrincipalId: string, requestId: string): Promise<boolean>;
}
export interface EmployerDocumentAuditPort {
  recordView(view: { viewerPrincipalId: string; subjectPrincipalId: string; requestId: string; operation: 'issue' | 'deliver'; documentType: CandidateDocumentType; documentVersion: string }): Promise<void>;
}

type Claim = { viewer: string; subject: string; request: string; type: CandidateDocumentType; version: string; issuedAt: number; expiresAt: number };

const deny = (): never => { throw new LifecycleError(403, 'denied'); };
const unavailable = (): never => { throw new LifecycleError(503, 'unavailable'); };
const types = new Set<string>(CANDIDATE_DOCUMENT_TYPES);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const REQUEST = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class EmployerDocuments {
  private readonly clock: () => number;
  constructor(private readonly options: { documents: CandidateDocuments; sight: EmployerSightPort; audit: EmployerDocumentAuditPort; now?: () => number }) {
    this.clock = options.now ?? Date.now;
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) return unavailable();
    return value;
  }

  private async viewer(credential: unknown, subject: string, requestId: string): Promise<string> {
    const viewer = await this.options.documents.principal(credential);
    if (typeof subject !== 'string' || !subject.length || subject.length > 255 || typeof requestId !== 'string' || !REQUEST.test(requestId)) return deny();
    // EMPLOYERDOC_MUTANT_SIGHT: every issue and every delivery re-checks sight.
    if (!await this.options.sight.maySee(viewer, subject, requestId)) return deny();
    return viewer;
  }

  private async read<T>(fn: (state: DocumentState) => Promise<T>): Promise<T> {
    const store = this.options.documents.options.store;
    return store.readPath ? store.readPath.read(fn) : store.transaction(fn);
  }

  private rows(state: DocumentState, subject: string) {
    return state.documents.filter(row => row.scope.orgId === this.options.documents.options.orgId && row.scope.personId === subject && types.has(row.type));
  }

  private mac(payload: string): string {
    // EMPLOYERDOC_MUTANT_LABEL: a staff token can never verify here, nor the reverse.
    return createHmac('sha256', this.options.documents.options.signingKey).update('employer-delivery-v1\u0000' + payload).digest('base64url');
  }

  /** One link per document on file, each audited before it is returned. */
  async links(credential: unknown, subject: string, requestId: string): Promise<Array<{ type: CandidateDocumentType; url: string; expiresAt: number }>> {
    const viewer = await this.viewer(credential, subject, requestId);
    return this.read(async state => {
      const out: Array<{ type: CandidateDocumentType; url: string; expiresAt: number }> = [];
      for (const type of CANDIDATE_DOCUMENT_TYPES) {
        const rows = this.rows(state, subject).filter(row => row.type === type);
        if (rows.length !== 1) continue;
        const row = rows[0]!, issuedAt = this.now(), expiresAt = issuedAt + EMPLOYER_LINK_TTL_MS;
        try { await this.options.audit.recordView({ viewerPrincipalId: viewer, subjectPrincipalId: subject, requestId, operation: 'issue', documentType: type, documentVersion: row.version }); }
        catch { return unavailable(); } // EMPLOYERDOC_MUTANT_AUDIT
        const claim: Claim = { viewer, subject, request: requestId, type, version: row.version, issuedAt, expiresAt };
        const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
        out.push({ type, url: `${EMPLOYER_DELIVERY_PATH}?t=${payload}.${this.mac(payload)}`, expiresAt });
      }
      return out;
    });
  }

  async deliver(credential: unknown, token: string): Promise<{ bytes: Buffer; headers: Record<string, string> }> {
    if (typeof token !== 'string' || token.length > 8192) return deny();
    let url: URL;
    try { url = new URL(token, this.options.documents.options.origin); } catch { return deny(); }
    if (url.origin !== this.options.documents.options.origin || url.pathname !== EMPLOYER_DELIVERY_PATH || url.hash !== ''
      || [...url.searchParams.keys()].length !== 1 || [...url.searchParams.keys()].some(key => key !== 't')) return deny();
    const parts = url.searchParams.get('t')?.split('.');
    if (!parts || parts.length !== 2) return deny();
    const [payload, supplied] = parts as [string, string];
    const a = Buffer.from(supplied), b = Buffer.from(this.mac(payload));
    if (a.length !== b.length || !timingSafeEqual(a, b)) return deny();
    let claim: unknown;
    try { claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return deny(); }
    if (!isRecord(claim) || Object.keys(claim).length !== 7 || typeof claim.viewer !== 'string' || typeof claim.subject !== 'string' || typeof claim.request !== 'string'
      || typeof claim.type !== 'string' || !types.has(claim.type) || typeof claim.version !== 'string' || typeof claim.issuedAt !== 'number' || typeof claim.expiresAt !== 'number') return deny();
    const viewer = await this.viewer(credential, claim.subject, claim.request);
    if (claim.viewer !== viewer) return deny(); // EMPLOYERDOC_MUTANT_VIEWER
    const now = this.now();
    if (!Number.isSafeInteger(claim.issuedAt) || claim.expiresAt !== claim.issuedAt + EMPLOYER_LINK_TTL_MS || now < claim.issuedAt || now >= claim.expiresAt) return deny();
    const subject = claim.subject, requestId = claim.request, type = claim.type as CandidateDocumentType, version = claim.version;
    return this.read(async state => {
      const rows = this.rows(state, subject).filter(row => row.type === type);
      if (rows.length !== 1 || rows[0]!.version !== version) return deny(); // EMPLOYERDOC_MUTANT_VERSION
      const row = rows[0]!;
      try { await this.options.audit.recordView({ viewerPrincipalId: viewer, subjectPrincipalId: subject, requestId, operation: 'deliver', documentType: type, documentVersion: row.version }); }
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
