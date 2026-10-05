import { R2Objects, R2DocumentStore, PostgresDocumentSnapshot, type DirectUploadPort } from '../../../packages/private-documents/src/r2-storage.js';
import { PostgresAuthzStore, PostgresLoginStore } from '@studenthub/db';
import type { AuthzStore } from '@studenthub/contracts';
import type { SessionStore } from '@studenthub/login-contract';
import { FileDocumentStore, type DocumentStore } from '../../../packages/private-documents/src/index.js';
import { CandidateDocuments } from '../../../packages/private-documents/src/candidate-lifecycle.js';

/** Trusted dependency injection seam. Configured cloud stores must satisfy the same
 * atomic DocumentStore contract; an ordinary R2 object PUT is not a transaction. */
export function createCandidateDocuments(ports: {
  store: DocumentStore; authz: AuthzStore; sessions: SessionStore;
  origin: string; orgId: string; signingKey: Uint8Array; now?: () => number; directUploads?: DirectUploadPort;
}): CandidateDocuments {
  return new CandidateDocuments({...ports, authenticate: async credential => {
    const session = await ports.sessions.get(credential);
    return session ? {kind:'principal',principalId:session.personId} : null;
  }});
}
/** Explicit configured local or R2 ports. No implicit fallback, credential discovery,
 * bucket mutation or store initialization. Migration and operational approval are separate. */
export async function createRuntimeCandidateDocumentsFromEnv(env: NodeJS.ProcessEnv = process.env): Promise<{service:CandidateDocuments;close():Promise<void>} | undefined> {
  const common = ['DOCUMENT_STORAGE','DOCUMENT_ORG_ID','DOCUMENT_ORIGIN','DOCUMENT_SIGNING_KEY'] as const;
  const cloud = ['DOCUMENT_R2_ACCOUNT_ID','DOCUMENT_R2_BUCKET','DOCUMENT_R2_ACCESS_KEY_ID','DOCUMENT_R2_SECRET_ACCESS_KEY'] as const;
  if ([...common,...cloud,'DOCUMENT_ROOT'].every(n => env[n] === undefined)) return undefined;
  const closers: (()=>Promise<void>|void)[]=[];
  try {
    if (common.some(n => !env[n]) || !['synthetic-file','r2'].includes(env.DOCUMENT_STORAGE!) || !env.DATABASE_URL
      || !env.OIDC_CALLBACK_URL || new URL(env.OIDC_CALLBACK_URL).origin !== env.DOCUMENT_ORIGIN) throw new Error();
    const signingKey = Buffer.from(env.DOCUMENT_SIGNING_KEY!,'base64');
    if (signingKey.toString('base64') !== env.DOCUMENT_SIGNING_KEY || signingKey.length < 32) throw new Error();
    let store:DocumentStore, directUploads:DirectUploadPort|undefined;
    if(env.DOCUMENT_STORAGE==='synthetic-file') {
      if(!env.DOCUMENT_ROOT || cloud.some(n=>env[n]!==undefined))throw new Error();
      store=await FileDocumentStore.open(env.DOCUMENT_ROOT);
    } else {
      if(env.DOCUMENT_ROOT!==undefined || cloud.some(n=>!env[n]))throw new Error();
      const objects=new R2Objects({accountId:env.DOCUMENT_R2_ACCOUNT_ID!,bucket:env.DOCUMENT_R2_BUCKET!,
        accessKeyId:env.DOCUMENT_R2_ACCESS_KEY_ID!,secretAccessKey:env.DOCUMENT_R2_SECRET_ACCESS_KEY!});
      closers.push(()=>objects.close());
      const snapshots=new PostgresDocumentSnapshot(env.DATABASE_URL);closers.push(()=>snapshots.close());
      store=new R2DocumentStore(snapshots,objects);
      directUploads={authorize:async t=>{await snapshots.reserve(t.objectKey);return objects.authorize(t);},read:t=>objects.read(t)};
    }
    const authz = new PostgresAuthzStore({connectionString:env.DATABASE_URL});closers.push(()=>authz.close());
    const login = new PostgresLoginStore({connectionString:env.DATABASE_URL});closers.push(()=>login.close());
    const service = createCandidateDocuments({store,authz,sessions:login.sessions,origin:env.DOCUMENT_ORIGIN!,orgId:env.DOCUMENT_ORG_ID!,signingKey,directUploads});
    return {service,close:async()=>{await Promise.all(closers.map(close=>close()));}};
  } catch {
    await Promise.allSettled(closers.map(close=>Promise.resolve().then(close)));
    throw new Error('invalid candidate-document configuration');
  }
}
