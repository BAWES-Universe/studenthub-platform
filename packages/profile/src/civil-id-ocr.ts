import { randomUUID } from "node:crypto";
import { normalizeCivilIdNumber, validateCivilId, type CivilIdCountry, type CivilIdVault } from "./civil-id.js";

export type CivilIdOcrFailureCode="provider_unavailable"|"provider_rejected"|"image_too_large"|"image_missing"|"attempts_exhausted";
export class CivilIdOcrError extends Error { constructor(readonly code:CivilIdOcrFailureCode){super(code);this.name="CivilIdOcrError";} }
export interface CivilIdOcrReader { read(photo:{bytes:Buffer;mime:string}):Promise<readonly string[]> }
export class FakeCivilIdOcrReader implements CivilIdOcrReader { calls=0; constructor(readonly lines:readonly string[]=[]){ } async read(){this.calls++;return this.lines;} }
export interface CivilIdPhoto {principalId:string;side:"front"|"back";documentId:string;version:string;size:number}
export interface CivilIdPhotoSource { list():Promise<readonly CivilIdPhoto[]>; read(photo:{documentId:string;version:string}):Promise<{bytes:Buffer;mime:string}|null> }
export type OcrStatus="pending"|"running"|"read"|"unreadable"|"failed"|"noted";
export interface CivilIdOcrJob extends CivilIdPhoto {id:string;status:OcrStatus;attempts:number;notBefore:string;leaseOwner:string|null;leaseExpiresAt:string|null;failureCode:CivilIdOcrFailureCode|null;country:CivilIdCountry|null;numberCiphertext:Buffer|null;keyVersion:number|null;last4:string|null;expiry:string|null;fallbackVersion:string|null;supersededAt:string|null;resolved:"accepted"|"dismissed"|null;createdAt:string;updatedAt:string}
export interface CivilIdSuggestion {id:string;state:"read"|"unreadable"|"failed";last4:string|null;country:CivilIdCountry|null;expiry:string|null;expired:boolean}
export interface CivilIdOcrStore {
 beginSweep(photos:readonly CivilIdPhoto[],at:string):Promise<{baseline:boolean;queued:number}>;
 claim(owner:string,at:string,leaseExpires:string,limit:number):Promise<readonly CivilIdOcrJob[]>;
 current(documentId:string,version:string):Promise<boolean>;
 complete(id:string,owner:string,result:{country:CivilIdCountry|null;numberCiphertext:Buffer|null;keyVersion:number|null;last4:string|null;expiry:string|null;fallbackVersion:string|null},at:string):Promise<boolean>;
 unreadable(id:string,owner:string,at:string):Promise<boolean>;
 fail(id:string,owner:string,code:CivilIdOcrFailureCode,at:string,retryAt?:string):Promise<boolean>;
 currentSuggestion(principalId:string,today:string):Promise<CivilIdSuggestion|null>;
 openForAccept(id:string,principalId:string):Promise<{country:CivilIdCountry;ciphertext:Buffer}|null>;
 resolve(id:string,principalId:string,how:"accepted"|"dismissed",at:string):Promise<boolean>;
}

const digits=(s:string)=>normalizeCivilIdNumber(s).replace(/[^0-9]/g,c=>c);
function dateIn(line:string):string|null { const normalized=line.normalize("NFKC").replace(/[\u0660-\u0669]/g,c=>String(c.charCodeAt(0)-0x0660));const matches=normalized.matchAll(/(^|[^0-9])(\d{2})\/(\d{2})\/(\d{4})(?=$|[^0-9])/g);let found:null|string=null;for(const m of matches){const d=+m[2]!,mo=+m[3]!,y=+m[4]!;const x=new Date(Date.UTC(y,mo-1,d));if(x.getUTCFullYear()===y&&x.getUTCMonth()===mo-1&&x.getUTCDate()===d)found=`${m[4]}-${m[3]}-${m[2]}`;}return found;}
export function parseCivilIdLines(lines:readonly string[]):{number:string|null;country:CivilIdCountry|null;expiry:string|null} {
 let number:string|null=null,country:CivilIdCountry|null=null,expiry:string|null=null;
 for(const raw of lines){const line=digits(raw);const date=dateIn(raw);if(date)expiry=date;if(number===null&&/^[0-9]+$/.test(line)&&line.length>5){for(const c of ["KW","BH"] as const){const valid=validateCivilId({country:c,number:line});if(valid.ok){number=valid.value.number;country=c;break;}}}}
 return {number,country,expiry};
}

export class InMemoryCivilIdOcrStore implements CivilIdOcrStore {
 readonly jobs:CivilIdOcrJob[]=[]; baseline=false; lastSweep=0; readonly review=new Map<string,{needsReview:boolean;revision:number;enteredNumber?:string}>();
 async beginSweep(photos:readonly CivilIdPhoto[],at:string){const sweepAt=Date.parse(at);if(!this.baseline){this.baseline=true;this.lastSweep=sweepAt;for(const p of photos)this.add(p,"noted",at);return {baseline:true,queued:0};}if(sweepAt-this.lastSweep<300_000)return {baseline:false,queued:0};this.lastSweep=sweepAt;let queued=0;const keys=new Set(photos.map(p=>`${p.documentId}:${p.version}`));for(const j of this.jobs)if(!keys.has(`${j.documentId}:${j.version}`)&&!j.supersededAt&&!j.resolved)j.supersededAt=at;for(const p of photos){if(this.jobs.some(j=>j.documentId===p.documentId&&j.version===p.version))continue;for(const j of this.jobs)if(j.principalId===p.principalId&&j.side===p.side&&!j.supersededAt&&!j.resolved)j.supersededAt=at;this.add(p,"pending",at);queued++;const r=this.review.get(p.principalId);if(r&&!r.needsReview)this.review.set(p.principalId,{...r,needsReview:true,revision:r.revision+1});}return {baseline:false,queued};}
 private add(p:CivilIdPhoto,status:OcrStatus,at:string){this.jobs.push({...p,id:randomUUID(),status,attempts:0,notBefore:at,leaseOwner:null,leaseExpiresAt:null,failureCode:null,country:null,numberCiphertext:null,keyVersion:null,last4:null,expiry:null,fallbackVersion:null,supersededAt:null,resolved:null,createdAt:at,updatedAt:at});}
 async claim(owner:string,at:string,until:string,limit:number){const out:CivilIdOcrJob[]=[];for(const j of this.jobs){if(out.length>=limit)break;if(j.supersededAt||!((j.status==="pending"&&j.notBefore<=at)||(j.status==="running"&&j.leaseExpiresAt!<=at)))continue;if(j.attempts>=5){j.status="failed";j.failureCode="attempts_exhausted";j.leaseOwner=j.leaseExpiresAt=null;continue;}j.status="running";j.attempts++;j.leaseOwner=owner;j.leaseExpiresAt=until;j.updatedAt=at;out.push({...j});}return out;}
 async current(documentId:string,version:string){return this.jobs.some(j=>j.documentId===documentId&&j.version===version&&!j.supersededAt);}
 private owned(id:string,owner:string){const j=this.jobs.find(x=>x.id===id);return j?.status==="running"&&j.leaseOwner===owner?j:null;}
 async complete(id:string,o:string,r:Parameters<CivilIdOcrStore["complete"]>[2],at:string){const j=this.owned(id,o);if(!j)return false;Object.assign(j,r,{status:"read",failureCode:null,leaseOwner:null,leaseExpiresAt:null,updatedAt:at});return true;}
 async unreadable(id:string,o:string,at:string){const j=this.owned(id,o);if(!j)return false;Object.assign(j,{status:"unreadable",leaseOwner:null,leaseExpiresAt:null,updatedAt:at});return true;}
 async fail(id:string,o:string,code:CivilIdOcrFailureCode,at:string,retryAt?:string){const j=this.owned(id,o);if(!j)return false;if(retryAt&&j.attempts<5)Object.assign(j,{status:"pending",failureCode:null,notBefore:retryAt,leaseOwner:null,leaseExpiresAt:null,updatedAt:at});else Object.assign(j,{status:"failed",failureCode:code,leaseOwner:null,leaseExpiresAt:null,updatedAt:at});return true;}
 async currentSuggestion(id:string,today:string){const j=[...this.jobs].reverse().find(x=>x.principalId===id&&x.side==="front"&&!x.supersededAt&&!x.resolved&&["read","unreadable","failed"].includes(x.status));return j?{id:j.id,state:j.status as "read"|"unreadable"|"failed",last4:j.last4,country:j.country,expiry:j.expiry,expired:!!j.expiry&&j.expiry<today}:null;}
 async openForAccept(id:string,p:string){const j=this.jobs.find(x=>x.id===id&&x.principalId===p&&x.status==="read"&&!x.supersededAt&&!x.resolved);return j?.country&&j.numberCiphertext?{country:j.country,ciphertext:Buffer.from(j.numberCiphertext)}:null;}
 async resolve(id:string,p:string,how:"accepted"|"dismissed",at:string){const j=this.jobs.find(x=>x.id===id&&x.principalId===p&&!x.resolved);if(!j)return false;j.resolved=how;j.updatedAt=at;return true;}
}

export async function runCivilIdOcr(o:{store:CivilIdOcrStore;photos:CivilIdPhotoSource;reader:CivilIdOcrReader;vault:CivilIdVault;clock?:{now():Date};workerId:string;leaseMs:number;batchSize:number}){
 const now=o.clock?.now()??new Date(),at=now.toISOString(),photos=await o.photos.list(),sweep=await o.store.beginSweep(photos,at);const jobs=await o.store.claim(o.workerId,at,new Date(now.getTime()+o.leaseMs).toISOString(),o.batchSize);let processed=0;
 for(const j of jobs){if(!await o.store.current(j.documentId,j.version)){await o.store.unreadable(j.id,o.workerId,at);continue;}if(j.side==="back"){await o.store.unreadable(j.id,o.workerId,at);continue;}try{const photo=await o.photos.read(j);if(!photo){await o.store.fail(j.id,o.workerId,"image_missing",at);continue;}if(photo.bytes.length>5*1024*1024){await o.store.fail(j.id,o.workerId,"image_too_large",at);continue;}let parsed=parseCivilIdLines(await o.reader.read(photo)),fallbackVersion:string|null=null;if(!parsed.expiry){const back=photos.find(p=>p.principalId===j.principalId&&p.side==="back");if(back){const b=await o.photos.read(back);if(b&&b.bytes.length<=5*1024*1024){const bp=parseCivilIdLines(await o.reader.read(b));parsed={...parsed,expiry:bp.expiry};fallbackVersion=back.version;}}}if(!parsed.number&&!parsed.expiry)await o.store.unreadable(j.id,o.workerId,at);else {const sealed=parsed.number&&parsed.country?o.vault.seal(j.principalId,parsed.country,parsed.number):null;await o.store.complete(j.id,o.workerId,{country:parsed.country,numberCiphertext:sealed?.ciphertext??null,keyVersion:sealed?.keyVersion??null,last4:parsed.number?.slice(-4)??null,expiry:parsed.expiry,fallbackVersion},at);}processed++;}catch(e){const code=e instanceof CivilIdOcrError?e.code:"provider_unavailable";const retry=code==="provider_unavailable"?new Date(now.getTime()+60_000).toISOString():undefined;await o.store.fail(j.id,o.workerId,code,at,retry);}}
 return {swept:sweep.queued,processed};
}
