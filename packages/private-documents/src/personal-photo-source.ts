import { FileDocumentStore, documentReadHydrator, type DocumentState, type DocumentStore } from './index.js';
import { PostgresDocumentSnapshot, R2DocumentStore, R2Objects } from './r2-storage.js';

/**
 * The person's own profile photo, read on the server to print on their ID card. It is never
 * served as a link: the bytes go only into a PDF that the caller has already authorized (the
 * person themselves, or StudentHub staff). Every read that returns bytes is audited first as
 * `id_card_render`; when the audit cannot be written, no bytes are returned.
 *
 * A photo is returned only when exactly one current personal photo is on file, it is a JPEG or
 * PNG, and it is at most PERSONAL_PHOTO_MAX_BYTES. Anything else reads as no photo, and the card
 * prints without one.
 */
export const PERSONAL_PHOTO_MAX_BYTES = 2 * 1024 * 1024;
const MIMES = new Set(['image/jpeg', 'image/png']);
const PERSON = /^[\w-]{1,128}$/;

export interface PersonalPhotoAuditPort {
  recordView(view: { viewerPrincipalId: string; subjectPrincipalId: string; kind: 'id_card_render'; documentType: 'personal-photo'; documentVersion: string }): Promise<void>;
}
export interface PersonalPhoto { readonly bytes: Buffer; readonly mime: string; readonly version: string }
export interface PersonalPhotoSource {
  /** The photo of `personId` for an ID card that `viewerId` is printing, or null. */
  read(personId: string, viewerId: string): Promise<PersonalPhoto | null>;
}

/** Records an anonymous read from the public card check page, keyed by card and hashed client address. */
export interface PublicPhotoAuditPort {
  recordPublicView(view: { cardNumber: number; subjectPrincipalId: string; documentVersion: string; clientHash: string }): Promise<void>;
}
export interface PublicPersonalPhotoSource {
  /** The photo of `personId` for the public check of card `cardNumber`, read by the client `clientHash`, or null. */
  read(personId: string, view: { readonly cardNumber: number; readonly clientHash: string }): Promise<PersonalPhoto | null>;
}

const readState = <T>(store: DocumentStore, fn: (state: DocumentState) => Promise<T>) => store.readPath ? store.readPath.read(fn) : store.transaction(fn);

/** The current personal photo of `personId` in `orgId`'s namespace, or null; no audit. */
export async function readPersonalPhoto(store: DocumentStore, orgId: string, personId: string): Promise<PersonalPhoto | null> {
  if (!PERSON.test(personId)) return null;
  return readState(store, async state => {
    const rows = state.documents.filter(d => d.scope.orgId === orgId && d.scope.personId === personId && d.type === 'personal-photo');
    const d = rows.length === 1 ? rows[0]! : undefined;
    if (!d || !MIMES.has(d.mime) || d.size > PERSONAL_PHOTO_MAX_BYTES) return null;
    await (state as DocumentState & { [documentReadHydrator]?: (id: string) => Promise<void> })[documentReadHydrator]?.(d.id);
    const bytes = Buffer.from(d.data, 'base64');
    return bytes.length > PERSONAL_PHOTO_MAX_BYTES ? null : { bytes, mime: d.mime, version: d.version };
  });
}

export function personalPhotoSource(options: { store: DocumentStore; orgId: string; audit: PersonalPhotoAuditPort }): PersonalPhotoSource {
  return {
    async read(personId, viewerId) {
      const photo = await readPersonalPhoto(options.store, options.orgId, personId);
      if (!photo) return null;
      await options.audit.recordView({ viewerPrincipalId: viewerId, subjectPrincipalId: personId, kind: 'id_card_render', documentType: 'personal-photo', documentVersion: photo.version });
      return photo;
    },
  };
}

/**
 * The same photo for the public card check page (the QR code). The caller has checked the signed
 * link and that the card is valid; each read that returns bytes is recorded first, and the caller
 * rebuilds the image without metadata before sending it.
 */
export function publicPersonalPhotoSource(options: { store: DocumentStore; orgId: string; audit: PublicPhotoAuditPort }): PublicPersonalPhotoSource {
  return {
    async read(personId, view) {
      const photo = await readPersonalPhoto(options.store, options.orgId, personId);
      if (!photo) return null;
      await options.audit.recordPublicView({ cardNumber: view.cardNumber, subjectPrincipalId: personId, documentVersion: photo.version, clientHash: view.clientHash });
      return photo;
    },
  };
}

/** Opens the same document storage as the civil ID reads (synthetic files or R2); undefined when none is configured. */
export async function openPersonalPhotoSourceFromEnv(audit: PersonalPhotoAuditPort, env: NodeJS.ProcessEnv = process.env, publicAudit?: PublicPhotoAuditPort): Promise<{ source: PersonalPhotoSource; publicSource?: PublicPersonalPhotoSource; close(): Promise<void> } | undefined> {
  const names = ['DOCUMENT_STORAGE', 'DOCUMENT_ORG_ID', 'DOCUMENT_ROOT', 'DOCUMENT_R2_ACCOUNT_ID', 'DOCUMENT_R2_BUCKET', 'DOCUMENT_R2_ACCESS_KEY_ID', 'DOCUMENT_R2_SECRET_ACCESS_KEY'];
  if (names.every(n => env[n] === undefined)) return undefined;
  let store: DocumentStore; const close: Array<() => Promise<void>> = [];
  if (env.DOCUMENT_STORAGE === 'synthetic-file' && env.DOCUMENT_ORG_ID && env.DOCUMENT_ROOT) store = await FileDocumentStore.open(env.DOCUMENT_ROOT);
  else if (env.DOCUMENT_STORAGE === 'r2' && env.DOCUMENT_ORG_ID && env.DATABASE_URL && env.DOCUMENT_R2_ACCOUNT_ID && env.DOCUMENT_R2_BUCKET && env.DOCUMENT_R2_ACCESS_KEY_ID && env.DOCUMENT_R2_SECRET_ACCESS_KEY) {
    const objects = new R2Objects({ accountId: env.DOCUMENT_R2_ACCOUNT_ID, bucket: env.DOCUMENT_R2_BUCKET, accessKeyId: env.DOCUMENT_R2_ACCESS_KEY_ID, secretAccessKey: env.DOCUMENT_R2_SECRET_ACCESS_KEY });
    const snapshots = new PostgresDocumentSnapshot(env.DATABASE_URL);
    store = new R2DocumentStore(snapshots, objects); close.push(async () => { objects.close(); }, () => snapshots.close());
  } else throw new Error('invalid document configuration');
  return { source: personalPhotoSource({ store, orgId: env.DOCUMENT_ORG_ID, audit }), ...(publicAudit ? { publicSource: publicPersonalPhotoSource({ store, orgId: env.DOCUMENT_ORG_ID, audit: publicAudit }) } : {}), close: async () => { await Promise.all(close.map(x => x())); } };
}
