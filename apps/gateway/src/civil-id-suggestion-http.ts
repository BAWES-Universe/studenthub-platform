import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CIVIL_ID_MESSAGES, type CivilIdOcrStore, type CivilIdService, type CivilIdStore, type CivilIdSuggestion, type CivilIdVault } from "@studenthub/profile";

const LIMIT = 1024;
const esc = (value:string) => value.replace(/[&<>"']/g, character => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[character]!);
const sessionCookie = (header:string|undefined) => { for (const part of header?.split(";") ?? []) { const [key,...value]=part.trim().split("="); if(key==="__Host-studenthub_session"&&/^[A-Za-z0-9_-]{43}$/.test(value.join("="))) return value.join("="); } return undefined; };
const submissionId = (id:string) => { const bytes=createHash("sha256").update("civil-id-suggestion\0").update(id).digest().subarray(0,16); bytes[6]=(bytes[6]!&15)|64; bytes[8]=(bytes[8]!&63)|128; const hex=bytes.toString("hex"); return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20)}`; };
const errorPage = (message:string) => `<main id="main" class="profile-ui"><div class="p-shell"><section class="p-main p-card p-stack"><a href="/profile#field-civilId">Back to profile</a><h1>Civil ID</h1><section class="p-error-summary" role="alert"><h2>Check your details</h2><p>${esc(message)}</p></section></section></div></main>`;
const readBody = async(request:IncomingMessage) => { request.setEncoding("utf8"); let value=""; for await(const chunk of request){value+=String(chunk);if(Buffer.byteLength(value)>LIMIT)return null;}return value; };

export interface CivilIdSuggestionService {
  current(principalId:string):Promise<CivilIdSuggestion|null>;
  open(suggestionId:string,principalId:string):Promise<{country:"KW"|"BH";number:string}|null>;
  resolve(suggestionId:string,principalId:string,how:"accepted"|"dismissed"):Promise<boolean>;
  submissionRecorded(principalId:string,suggestionId:string):Promise<boolean>;
  readonly civilId:CivilIdService;
}

export function createCivilIdSuggestion(options:{store:CivilIdOcrStore;civilId:CivilIdService;civilIdStore:CivilIdStore;vault:CivilIdVault;clock?:{now():Date}}):CivilIdSuggestionService {
  const now=()=>options.clock?.now()??new Date();
  const today=()=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kuwait",year:"numeric",month:"2-digit",day:"2-digit"}).format(now());
  return {
    civilId:options.civilId,
    current:(principalId:string)=>options.store.currentSuggestion(principalId,today()),
    async open(suggestionId:string,principalId:string){const sealed=await options.store.openForAccept(suggestionId,principalId);return sealed?{country:sealed.country,number:options.vault.open(principalId,sealed.country,sealed.ciphertext)}:null;},
    resolve:(suggestionId:string,principalId:string,how:"accepted"|"dismissed")=>options.store.resolve(suggestionId,principalId,how,now().toISOString()),
    submissionRecorded:(principalId:string,suggestionId:string)=>options.civilIdStore.submissionRecorded(principalId,submissionId(suggestionId)),
  };
}

export function renderCivilIdSuggestion(language:"en"|"ar", suggestion:CivilIdSuggestion|undefined|null):string {
  if(!suggestion)return "";
  const hidden=`<input type="hidden" name="suggestionId" value="${esc(suggestion.id)}">`;
  const dismiss=`<form method="post" action="/profile/civil-id/suggestion/dismiss">${hidden}<button class="p-button" type="submit">${language==="ar"?"لا، سأدخل القيم بنفسي":"No, I will enter them myself"}</button></form>`;
  if(suggestion.state!=="read")return `<div class="p-row"><dt>${language==="ar"?"قراءة صورة البطاقة المدنية":"Civil ID photo"}</dt><dd><p>${language==="ar"?"تعذر علينا قراءة الصورة. يرجى كتابة رقم البطاقة المدنية وتاريخ انتهائها.":"We could not read your photo. Please type your civil ID number and expiry."}</p><a class="p-edit" href="/profile/civil-id">${language==="ar"?"إدخال القيم":"Enter values"}</a></dd></div>`;
  if(suggestion.expired)return `<div class="p-row"><dt>${language==="ar"?"قراءة صورة البطاقة المدنية":"Civil ID photo"}</dt><dd><p>${language==="ar"?`التاريخ الذي قرأناه (${esc(suggestion.expiry??"")}) قد مضى. يرجى تحميل صورة حديثة أو إدخال قيمك.`:`The date we read (${esc(suggestion.expiry??"")}) has passed. Please upload a current photo or enter your own values.`}</p><a class="p-edit" href="/profile/documents">${language==="ar"?"تحميل صورة حديثة":"Upload a current photo"}</a>${dismiss}</dd></div>`;
  const details=[suggestion.last4?(language==="ar"?`رقماً ينتهي بـ ${esc(suggestion.last4)}`:`a number ending ${esc(suggestion.last4)}`):"",suggestion.expiry?(language==="ar"?`وتاريخ انتهائه ${esc(suggestion.expiry)}`:`expiring ${esc(suggestion.expiry)}`):""].filter(Boolean).join(language==="ar"?" ":", ");
  const question=language==="ar"?`قرأنا ${details}. هل هذا صحيح؟`:`We read ${details}. Is this right?`;
  const accept=`<form method="post" action="/profile/civil-id/suggestion/accept">${hidden}<button class="p-button p-primary" type="submit">${language==="ar"?"نعم، استخدم هذه القيم":"Yes, use these"}</button></form>`;
  return `<div class="p-row"><dt>${language==="ar"?"قراءة صورة البطاقة المدنية":"Civil ID photo"}</dt><dd><p>${question}</p>${accept}${dismiss}</dd></div>`;
}

export async function handleCivilIdSuggestion(request:IncomingMessage,response:ServerResponse,service:CivilIdSuggestionService|undefined,origin:string|undefined,authorize:(session:string)=>Promise<string|undefined>,write:(status:number,title:string,body:string)=>void):Promise<boolean>{
  const path=request.url?.split("?",1)[0]; if(path!=="/profile/civil-id/suggestion/accept"&&path!=="/profile/civil-id/suggestion/dismiss")return false;
  const finish=(status:number,headers:Record<string,string>={})=>{response.writeHead(status,{"cache-control":"no-store","referrer-policy":"no-referrer",...headers});response.end();};
  if(!service){finish(404);return true;} const session=sessionCookie(request.headers.cookie);if(!session){write(401,"Sign in",errorPage("Sign in again to continue safely."));return true;}const principal=await authorize(session);if(!principal){write(401,"Sign in",errorPage("Sign in again to continue safely."));return true;}
  if(request.method!=="POST"){finish(405,{allow:"POST"});return true;}
  if(!request.headers.origin||!origin||request.headers.origin!==origin||request.headers["sec-fetch-site"]==="cross-site"){write(403,"Civil ID",errorPage("We could not verify this request."));return true;}
  if(!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"]??"")||Number(request.headers["content-length"])>LIMIT){request.resume();write(400,"Civil ID",errorPage("Invalid request."));return true;}
  const raw=await readBody(request);const params=raw===null?null:new URLSearchParams(raw);const keys=params?[...params.keys()]:[];if(!params||keys.length!==1||keys[0]!=="suggestionId"||!params.get("suggestionId")){write(400,"Civil ID",errorPage("Invalid request."));return true;}const id=params.get("suggestionId")!;
  const current=await service.current(principal);if(!current||current.id!==id){if(path.endsWith("/accept")&&await service.submissionRecorded(principal,id)){finish(303,{location:"/profile#field-civilId"});return true;}write(409,"Civil ID",errorPage(CIVIL_ID_MESSAGES.stale_revision));return true;}
  if(path.endsWith("/dismiss")){await service.resolve(id,principal,"dismissed");finish(303,{location:"/profile/civil-id"});return true;}
  if(current.state!=="read"){write(409,"Civil ID",errorPage(CIVIL_ID_MESSAGES.stale_revision));return true;}
  let opened:Awaited<ReturnType<CivilIdSuggestionService["open"]>>;
  try { opened=await service.open(id,principal); } catch { write(409,"Civil ID",errorPage(CIVIL_ID_MESSAGES.stale_revision));return true; }
  if(!opened&&current.last4){write(409,"Civil ID",errorPage(CIVIL_ID_MESSAGES.stale_revision));return true;}
  const own=await service.civilId.readOwn(principal);const saved=await service.civilId.save({principalId:principal,submissionId:submissionId(id),revision:own?.revision??0,country:opened?.country??current.country??undefined,number:opened?.number,expiry:current.expiry??undefined});
  if(saved.ok||saved.reason==="submission_reused"||saved.reason==="nothing_to_save"){await service.resolve(id,principal,"accepted");finish(303,{location:"/profile#field-civilId"});return true;}
  write(saved.reason==="duplicate"||saved.reason==="stale_revision"?409:400,"Civil ID",errorPage(CIVIL_ID_MESSAGES[saved.reason]));return true;
}
