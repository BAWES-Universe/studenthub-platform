import { FileDocumentStore, documentReadHydrator, type DocumentStore } from "./index.js";
import { PostgresDocumentSnapshot, R2DocumentStore, R2Objects } from "./r2-storage.js";
type CivilIdPhoto={principalId:string;side:"front"|"back";documentId:string;version:string;size:number};
type CivilIdPhotoSource={list():Promise<readonly CivilIdPhoto[]>;read(photo:{documentId:string;version:string}):Promise<{bytes:Buffer;mime:string}|null>};

export async function listCivilIdPhotos(store:DocumentStore,orgId:string):Promise<CivilIdPhoto[]> { return store.transaction(async state=>state.documents.filter(d=>d.scope.orgId===orgId&&d.scope.personId&&(d.type==="civil-id-front"||d.type==="civil-id-back")).map(d=>({principalId:d.scope.personId!,side:d.type==="civil-id-front"?"front":"back",documentId:d.id,version:d.version,size:d.size}))); }
export async function readCivilIdPhoto(store:DocumentStore,orgId:string,wanted:{documentId:string;version:string}):Promise<{bytes:Buffer;mime:string}|null>{return store.transaction(async state=>{const d=state.documents.find(x=>x.scope.orgId===orgId&&x.id===wanted.documentId&&x.version===wanted.version&&(x.type==="civil-id-front"||x.type==="civil-id-back"));if(!d)return null;await (state as typeof state&{[documentReadHydrator]?:(id:string)=>Promise<void>})[documentReadHydrator]?.(d.id);return {bytes:Buffer.from(d.data,"base64"),mime:d.mime};});}
export async function openCivilIdPhotoSourceFromEnv(env:NodeJS.ProcessEnv=process.env):Promise<{source:CivilIdPhotoSource;close():Promise<void>}|undefined>{
 const names=["DOCUMENT_STORAGE","DOCUMENT_ORG_ID","DATABASE_URL","DOCUMENT_ROOT","DOCUMENT_R2_ACCOUNT_ID","DOCUMENT_R2_BUCKET","DOCUMENT_R2_ACCESS_KEY_ID","DOCUMENT_R2_SECRET_ACCESS_KEY"];
 if(names.every(n=>env[n]===undefined))return undefined;let store:DocumentStore;const close:Array<()=>Promise<void>>=[];
 if(env.DOCUMENT_STORAGE==="synthetic-file"&&env.DOCUMENT_ORG_ID&&env.DOCUMENT_ROOT){store=await FileDocumentStore.open(env.DOCUMENT_ROOT);}
 else if(env.DOCUMENT_STORAGE==="r2"&&env.DOCUMENT_ORG_ID&&env.DATABASE_URL&&env.DOCUMENT_R2_ACCOUNT_ID&&env.DOCUMENT_R2_BUCKET&&env.DOCUMENT_R2_ACCESS_KEY_ID&&env.DOCUMENT_R2_SECRET_ACCESS_KEY){const objects=new R2Objects({accountId:env.DOCUMENT_R2_ACCOUNT_ID,bucket:env.DOCUMENT_R2_BUCKET,accessKeyId:env.DOCUMENT_R2_ACCESS_KEY_ID,secretAccessKey:env.DOCUMENT_R2_SECRET_ACCESS_KEY});const snapshots=new PostgresDocumentSnapshot(env.DATABASE_URL);store=new R2DocumentStore(snapshots,objects);close.push(async()=>{objects.close();},()=>snapshots.close());}
 else throw new Error("invalid document configuration");const orgId=env.DOCUMENT_ORG_ID;return {source:{list:()=>listCivilIdPhotos(store,orgId),read:p=>readCivilIdPhoto(store,orgId,p)},close:async()=>{await Promise.all(close.map(x=>x()));}};
}
