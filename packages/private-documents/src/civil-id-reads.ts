import { FileDocumentStore, documentReadHydrator, readPerson, storeHolding, type CurrentCursor, type DocumentStore } from "./index.js";
import { PartitionedR2DocumentStore, PostgresDocumentPartitions, R2Objects } from "./r2-storage.js";
type CivilIdPhoto={principalId:string;side:"front"|"back";documentId:string;version:string;size:number};
type CivilIdPhotoSource={list():Promise<readonly CivilIdPhoto[]>;read(photo:{documentId:string;version:string}):Promise<{bytes:Buffer;mime:string}|null>;readonly inStore?:boolean;back?(principalId:string):Promise<CivilIdPhoto|null>};

const readState=<T>(store:DocumentStore,fn:(state:Parameters<Parameters<DocumentStore["transaction"]>[0]>[0])=>Promise<T>)=>store.readPath?store.readPath.read(fn):store.transaction(fn);
const civilTypes=["civil-id-front","civil-id-back"];
const toPhoto=(d:{id:string;version:string;type:string;size:number;scope:{orgId:string;personId?:string}}):CivilIdPhoto=>({principalId:d.scope.personId!,side:d.type==="civil-id-front"?"front":"back",documentId:d.id,version:d.version,size:d.size});
/** The current civil ID photos of `orgId`, a bounded page at a time (keyset by person, then document); every photo is yielded exactly once. */
export async function* civilIdPhotoPages(store:DocumentStore,orgId:string,pageSize=500):AsyncGenerator<CivilIdPhoto[]>{
 if(!store.listCurrent){yield await readState(store,async state=>state.documents.filter(d=>d.scope.orgId===orgId&&d.scope.personId&&civilTypes.includes(d.type)).map(toPhoto));return;}
 let after:CurrentCursor|undefined;
 for(;;){const page=await store.listCurrent(orgId,civilTypes,{after,limit:pageSize});yield page.documents.map(toPhoto);if(!page.next)return;after=page.next;}
}
/** Every current civil ID photo of `orgId` (the OCR sweep needs the complete set): read page by page, never truncated. */
export async function listCivilIdPhotos(store:DocumentStore,orgId:string,options:{pageSize?:number}={}):Promise<CivilIdPhoto[]> { const all:CivilIdPhoto[]=[];for await(const page of civilIdPhotoPages(store,orgId,options.pageSize))all.push(...page);return all; }
/** One person's current civil ID back photo in `orgId`, metadata only (no body is read), or null. */
export async function civilIdBack(store:DocumentStore,orgId:string,principalId:string):Promise<CivilIdPhoto|null>{return readPerson(store,principalId,async state=>{const rows=state.documents.filter(d=>d.scope.orgId===orgId&&d.scope.personId===principalId&&d.type==="civil-id-back");return rows.length===1?toPhoto(rows[0]!):null;});}
export async function readCivilIdPhoto(store:DocumentStore,orgId:string,wanted:{documentId:string;version:string}):Promise<{bytes:Buffer;mime:string}|null>{const holder=await storeHolding(store,wanted.documentId);if(!holder)return null;return readState(holder,async state=>{const d=state.documents.find(x=>x.scope.orgId===orgId&&x.id===wanted.documentId&&x.version===wanted.version&&(x.type==="civil-id-front"||x.type==="civil-id-back"));if(!d)return null;await (state as typeof state&{[documentReadHydrator]?:(id:string)=>Promise<void>})[documentReadHydrator]?.(d.id);return {bytes:Buffer.from(d.data,"base64"),mime:d.mime};});}
export async function openCivilIdPhotoSourceFromEnv(env:NodeJS.ProcessEnv=process.env):Promise<{source:CivilIdPhotoSource;close():Promise<void>}|undefined>{
 const names=["DOCUMENT_STORAGE","DOCUMENT_ORG_ID","DATABASE_URL","DOCUMENT_ROOT","DOCUMENT_R2_ACCOUNT_ID","DOCUMENT_R2_BUCKET","DOCUMENT_R2_ACCESS_KEY_ID","DOCUMENT_R2_SECRET_ACCESS_KEY"];
 if(names.every(n=>env[n]===undefined))return undefined;let store:DocumentStore;const close:Array<()=>Promise<void>>=[];
 if(env.DOCUMENT_STORAGE==="synthetic-file"&&env.DOCUMENT_ORG_ID&&env.DOCUMENT_ROOT){store=await FileDocumentStore.open(env.DOCUMENT_ROOT);}
 else if(env.DOCUMENT_STORAGE==="r2"&&env.DOCUMENT_ORG_ID&&env.DATABASE_URL&&env.DOCUMENT_R2_ACCOUNT_ID&&env.DOCUMENT_R2_BUCKET&&env.DOCUMENT_R2_ACCESS_KEY_ID&&env.DOCUMENT_R2_SECRET_ACCESS_KEY){const objects=new R2Objects({accountId:env.DOCUMENT_R2_ACCOUNT_ID,bucket:env.DOCUMENT_R2_BUCKET,accessKeyId:env.DOCUMENT_R2_ACCESS_KEY_ID,secretAccessKey:env.DOCUMENT_R2_SECRET_ACCESS_KEY});const snapshots=new PostgresDocumentPartitions(env.DATABASE_URL);store=new PartitionedR2DocumentStore(snapshots,objects);close.push(async()=>{objects.close();},()=>snapshots.close());}
 else throw new Error("invalid document configuration");const orgId=env.DOCUMENT_ORG_ID;// On the per-owner store the OCR sweep reads the photos in its own database (inStore), and the expiry fallback asks for one person's back photo.
 const partitioned=store.listCurrent!==undefined;
 return {source:{list:()=>listCivilIdPhotos(store,orgId),read:p=>readCivilIdPhoto(store,orgId,p),...(partitioned?{inStore:true,back:(principalId:string)=>civilIdBack(store,orgId,principalId)}:{})},close:async()=>{await Promise.all(close.map(x=>x()));}};
}
