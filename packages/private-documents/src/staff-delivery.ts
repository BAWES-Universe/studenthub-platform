import { createHmac, timingSafeEqual } from 'node:crypto';
import { documentReadHydrator, type DocumentState } from './index.js';
import { CANDIDATE_DOCUMENT_TYPES, type CandidateDocumentType } from './lifecycle-state.js';
import { CandidateDocuments, LifecycleError } from './candidate-lifecycle.js';

export type StaffDocumentPurpose = 'civil_id_review' | 'person_page';
export interface StaffViewPort {
  recordView(view: {
    viewerPrincipalId: string;
    subjectPrincipalId: string;
    kind: 'civil_id_image_issue' | 'civil_id_image_deliver' | 'person_document_issue' | 'person_document_deliver';
    documentType: 'personal-photo' | 'resume' | 'civil-id-front' | 'civil-id-back';
    documentVersion: string;
  }): Promise<void>;
}
export const STAFF_DELIVERY_PATH = '/workspace/civil-ids/delivery';

type Claim = {
  viewer: string;
  subject: string;
  type: CandidateDocumentType;
  version: string;
  purpose: StaffDocumentPurpose;
  issuedAt: number;
  expiresAt: number;
};

const deny = (): never => { throw new LifecycleError(403, 'denied'); };
const unavailable = (): never => { throw new LifecycleError(503, 'unavailable'); };
const candidateTypes = new Set<string>(CANDIDATE_DOCUMENT_TYPES);
const civilTypes = new Set<string>(['civil-id-front', 'civil-id-back']);
const isRecord = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export class StaffDocuments {
  private readonly clock: () => number;
  private readonly staffOrgIds: ReadonlySet<string>;
  constructor(private readonly options: {
    documents: CandidateDocuments;
    staffOrgIds: readonly string[];
    audit: StaffViewPort;
    now?: () => number;
  }) {
    this.clock = options.now ?? Date.now;
    this.staffOrgIds = new Set(options.staffOrgIds);
  }

  private now(): number {
    const value = this.clock();
    if (!Number.isSafeInteger(value) || value < 0) return unavailable();
    return value;
  }

  private async viewer(credential: unknown): Promise<string> {
    const principalId = await this.options.documents.principal(credential);
    const grants = await this.options.documents.options.authz.listGrantsForPrincipal(principalId);
    // STAFFDOC_MUTANT_GATE: every operation requires an explicit operator subtree grant.
    if (!grants.some(grant => (grant.role === 'staff' || grant.role === 'admin')
      && grant.scope === 'subtree' // STAFFDOC_MUTANT_SCOPE
      && this.staffOrgIds.has(grant.orgId))) return deny(); // STAFFDOC_MUTANT_ORG
    return principalId;
  }

  private allowed(viewer: string, subject: string, type: CandidateDocumentType, purpose: StaffDocumentPurpose): void {
    if (purpose === 'civil_id_review' && (viewer === subject || !civilTypes.has(type))) return deny();
  }

  private current(state: DocumentState, subject: string, type: CandidateDocumentType) {
    const rows = state.documents.filter(row => row.scope.orgId === this.options.documents.options.orgId
      && row.scope.personId === subject && row.type === type);
    if (rows.length !== 1) return deny();
    return rows[0]!;
  }

  private async read<T>(fn: (state: DocumentState) => Promise<T>): Promise<T> {
    const store = this.options.documents.options.store;
    return store.readPath ? store.readPath.read(fn) : store.transaction(fn);
  }

  private mac(payload: string, label = 'staff-delivery-v1'): string {
    return createHmac('sha256', this.options.documents.options.signingKey)
      .update(label + '\u0000' + payload).digest('base64url');
  }

  private auditKind(purpose: StaffDocumentPurpose, operation: 'issue' | 'deliver') {
    return purpose === 'civil_id_review'
      ? `civil_id_image_${operation}` as const
      : `person_document_${operation}` as const;
  }

  async principal(credential: unknown): Promise<string> {
    return this.viewer(credential);
  }

  async documents(credential: unknown, subjectPrincipalId: string): Promise<Array<{type:CandidateDocumentType;mime:string;size:number;version:string}>> {
    await this.viewer(credential);
    return this.read(async state => state.documents
      .filter(row => row.scope.orgId === this.options.documents.options.orgId
        && row.scope.personId === subjectPrincipalId && candidateTypes.has(row.type))
      .map(row => ({ type: row.type as CandidateDocumentType, mime: row.mime, size: row.size, version: row.version })));
  }

  async issue(credential: unknown, subjectPrincipalId: string, type: CandidateDocumentType, purpose: StaffDocumentPurpose): Promise<{url:string;expiresAt:number}> {
    const viewer = await this.viewer(credential);
    if (!candidateTypes.has(type) || (purpose !== 'civil_id_review' && purpose !== 'person_page')) return deny();
    this.allowed(viewer, subjectPrincipalId, type, purpose);
    return this.read(async state => {
      const row = this.current(state, subjectPrincipalId, type);
      const issuedAt = this.now(), expiresAt = issuedAt + 60_000;
      // STAFFDOC_MUTANT_AUDIT: fail closed before exposing a capability.
      try { await this.options.audit.recordView({ viewerPrincipalId: viewer, subjectPrincipalId, kind: this.auditKind(purpose, 'issue'), documentType: type, documentVersion: row.version }); }
      catch { return unavailable(); }
      const claim: Claim = { viewer, subject: subjectPrincipalId, type, version: row.version, purpose, issuedAt, expiresAt };
      const payload = Buffer.from(JSON.stringify(claim)).toString('base64url');
      return { url: `${STAFF_DELIVERY_PATH}?t=${payload}.${this.mac(payload)}`, expiresAt };
    });
  }

  async deliver(credential: unknown, token: string): Promise<{bytes:Buffer;headers:Record<string,string>}> {
    const viewer = await this.viewer(credential);
    if (typeof token !== 'string' || token.length > 8192) return deny();
    let url: URL;
    try { url = new URL(token, this.options.documents.options.origin); } catch { return deny(); }
    if (url.origin !== this.options.documents.options.origin || url.pathname !== STAFF_DELIVERY_PATH
      || url.hash !== '' || [...url.searchParams.keys()].length !== 1 || [...url.searchParams.keys()].some(key => key !== 't')) return deny();
    const parts = url.searchParams.get('t')?.split('.');
    if (!parts || parts.length !== 2) return deny();
    const [payload, supplied] = parts as [string, string];
    const expected = this.mac(payload); // STAFFDOC_MUTANT_LABEL
    const a = Buffer.from(supplied), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return deny();
    let claim: unknown;
    try { claim = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')); } catch { return deny(); }
    if (!isRecord(claim) || Object.keys(claim).length !== 7
      || typeof claim.viewer !== 'string' || typeof claim.subject !== 'string'
      || typeof claim.type !== 'string' || !candidateTypes.has(claim.type)
      || typeof claim.version !== 'string' || typeof claim.issuedAt !== 'number' || typeof claim.expiresAt !== 'number'
      || (claim.purpose !== 'civil_id_review' && claim.purpose !== 'person_page')) return deny();
    if (claim.viewer !== viewer) return deny(); // STAFFDOC_MUTANT_VIEWER
    const now = this.now();
    if (!Number.isSafeInteger(claim.issuedAt) || !Number.isSafeInteger(claim.expiresAt)
      || claim.expiresAt !== claim.issuedAt + 60_000 || now < claim.issuedAt || now >= claim.expiresAt) return deny();
    const type = claim.type as CandidateDocumentType, purpose = claim.purpose as StaffDocumentPurpose;
    this.allowed(viewer, claim.subject, type, purpose);
    return this.read(async state => {
      const row = this.current(state, claim.subject as string, type);
      if (row.version !== claim.version) return deny(); // STAFFDOC_MUTANT_VERSION
      try { await this.options.audit.recordView({ viewerPrincipalId: viewer, subjectPrincipalId: claim.subject as string, kind: this.auditKind(purpose, 'deliver'), documentType: type, documentVersion: row.version }); }
      catch { return unavailable(); } // STAFFDOC_MUTANT_DELIVER_AUDIT
      const hydrate = (state as DocumentState & { [documentReadHydrator]?: (id: string) => Promise<void> })[documentReadHydrator];
      if (hydrate) await hydrate(row.id); // STAFFDOC_MUTANT_HYDRATE
      const bytes = Buffer.from(row.data, 'base64');
      if (bytes.length !== row.size) return unavailable();
      return { bytes, headers: {
        'Content-Type': row.mime,
        'Content-Length': String(row.size),
        'Content-Disposition': 'inline',
        'Cache-Control': 'private, no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer',
        'Content-Security-Policy': "default-src 'none'; sandbox",
      }};
    });
  }
}
