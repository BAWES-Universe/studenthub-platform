import { PostgresAuthzStore, PostgresLoginStore } from '@studenthub/db';
import type { AuthzStore } from '@studenthub/contracts';
import type { SessionStore } from '@studenthub/login-contract';
import { FileDocumentStore, PrivateDocuments, type DocumentStore } from '../../../packages/private-documents/src/index.js';
import { PostgresDocumentSnapshot, R2DocumentStore, R2Objects } from '../../../packages/private-documents/src/r2-storage.js';
import type { OrganizationDocumentsRuntime } from './organization-documents-http.js';

export function createOrganizationDocuments(ports: {
  store: DocumentStore; authz: AuthzStore; sessions: SessionStore; origin: string; signingKey: Uint8Array; now?: () => number;
}): OrganizationDocumentsRuntime {
  return { origin: ports.origin, service: new PrivateDocuments({ ...ports, deliveryPath: '/organization-documents/delivery', authenticate: async credential => {
    const session = await ports.sessions.get(credential);
    return session ? { kind: 'principal', principalId: session.personId } : null;
  } }) };
}

export async function createRuntimeOrganizationDocumentsFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<(OrganizationDocumentsRuntime & { close(): Promise<void> }) | undefined> {
  const common = ['DOCUMENT_STORAGE', 'DOCUMENT_ORG_ID', 'DOCUMENT_ORIGIN', 'DOCUMENT_SIGNING_KEY'] as const;
  const cloud = ['DOCUMENT_R2_ACCOUNT_ID', 'DOCUMENT_R2_BUCKET', 'DOCUMENT_R2_ACCESS_KEY_ID', 'DOCUMENT_R2_SECRET_ACCESS_KEY'] as const;
  if ([...common, ...cloud, 'DOCUMENT_ROOT'].every(name => env[name] === undefined)) return undefined;
  const closers: (() => Promise<void> | void)[] = [];
  try {
    if (common.some(name => !env[name]) || !['synthetic-file', 'r2'].includes(env.DOCUMENT_STORAGE!) || !env.DATABASE_URL ||
        !env.OIDC_CALLBACK_URL || new URL(env.OIDC_CALLBACK_URL).origin !== env.DOCUMENT_ORIGIN) throw new Error();
    const signingKey = Buffer.from(env.DOCUMENT_SIGNING_KEY!, 'base64');
    if (signingKey.toString('base64') !== env.DOCUMENT_SIGNING_KEY || signingKey.length < 32) throw new Error();
    let store: DocumentStore;
    if (env.DOCUMENT_STORAGE === 'synthetic-file') {
      if (!env.DOCUMENT_ROOT || cloud.some(name => env[name] !== undefined)) throw new Error();
      store = await FileDocumentStore.open(env.DOCUMENT_ROOT);
    } else {
      if (env.DOCUMENT_ROOT !== undefined || cloud.some(name => !env[name])) throw new Error();
      const objects = new R2Objects({ accountId: env.DOCUMENT_R2_ACCOUNT_ID!, bucket: env.DOCUMENT_R2_BUCKET!, accessKeyId: env.DOCUMENT_R2_ACCESS_KEY_ID!, secretAccessKey: env.DOCUMENT_R2_SECRET_ACCESS_KEY! });
      closers.push(() => objects.close());
      const snapshots = new PostgresDocumentSnapshot(env.DATABASE_URL); closers.push(() => snapshots.close());
      store = new R2DocumentStore(snapshots, objects);
    }
    const authz = new PostgresAuthzStore({ connectionString: env.DATABASE_URL }); closers.push(() => authz.close());
    const login = new PostgresLoginStore({ connectionString: env.DATABASE_URL }); closers.push(() => login.close());
    const runtime = createOrganizationDocuments({ store, authz, sessions: login.sessions, origin: env.DOCUMENT_ORIGIN!, signingKey });
    return { ...runtime, close: async () => { await Promise.all(closers.map(close => close())); } };
  } catch {
    await Promise.allSettled(closers.map(close => Promise.resolve().then(close)));
    throw new Error('invalid organization-document configuration');
  }
}
