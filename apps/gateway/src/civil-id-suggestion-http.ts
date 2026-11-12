import type { IncomingMessage, ServerResponse } from "node:http";
import { CIVIL_ID_MESSAGES, type CivilIdOcrStore, type CivilIdService, type CivilIdStore, type CivilIdSuggestion, type CivilIdVault } from "@studenthub/profile";

const LIMIT = 2048;
const esc = (value:string) => value.replace(/[&<>"']/g, char => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]!);
const sessionCookie = (header:string|undefined) => { for (const part of header?.split(";") ?? []) { const [key,...rest]=part.trim().split("="); const value=rest.join("="); if(key==="__Host-studenthub_session"&&/^[A-Za-z0-9_-]{43}$/.test(value))return value; } };
// The civil ID event table keys submissions by uuid, and a suggestion id is already one, so it doubles as the submission id.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const submissionId = (id:string) => id;
const errorBody = (message:string) => `<main id="main" class="profile-ui"><div class="p-shell"><section class="p-main p-card p-stack"><h1>Civil ID</h1><section class="p-error-summary" role="alert"><h2>Check your details</h2><p>${esc(message)}</p></section><a href="/profile#field-civilId">Back to profile</a></section></div></main>`;

export interface CivilIdSuggestionService {
  readonly store: CivilIdOcrStore;
  readonly civilId: CivilIdService;
  readonly civilStore: CivilIdStore;
  readonly vault: CivilIdVault;
  now(): Date;
  current(principalId:string): Promise<CivilIdSuggestion|null>;
}

export function renderCivilIdSuggestion(language:"en"|"ar", suggestion:CivilIdSuggestion|undefined):string {
  if (!suggestion) return "";
  const hidden = `<input type="hidden" name="suggestionId" value="${esc(suggestion.id)}"><input type="hidden" name="submissionId" value="${esc(submissionId(suggestion.id))}">`;
  const dismiss = `<form method="post" action="/profile/civil-id/suggestion/dismiss">${hidden}<button class="p-button" type="submit">${language==="ar"?"لا، سأدخل البيانات بنفسي":"No, I will enter them myself"}</button></form>`;
  if (suggestion.state !== "read") return `<div class="p-row"><dt>${language==="ar"?"قراءة صورة البطاقة المدنية":"Civil ID photo"}</dt><dd><p>${language==="ar"?"تعذر علينا قراءة الصورة. يرجى إدخال الرقم المدني وتاريخ الانتهاء.":"We could not read your photo. Please type your civil ID number and expiry."}</p><a class="p-edit" href="/profile/civil-id">${language==="ar"?"إدخال البيانات":"Enter my own values"}</a></dd></div>`;
  if (suggestion.expired && suggestion.expiry) return `<div class="p-row"><dt>${language==="ar"?"قراءة صورة البطاقة المدنية":"Civil ID photo"}</dt><dd><p>${language==="ar"?`تاريخ البطاقة المقروء (${esc(suggestion.expiry)}) قد مضى. يرجى رفع صورة حديثة أو إدخال بياناتك.`:`The date we read (${esc(suggestion.expiry)}) has passed. Please upload a current photo or enter your own values.`}</p><a class="p-edit" href="/profile/documents">${language==="ar"?"رفع صورة حديثة":"Upload a current photo"}</a>${dismiss}</dd></div>`;
  const parts = [suggestion.last4 ? (language==="ar"?`رقماً ينتهي بـ ${esc(suggestion.last4)}`:`a number ending ${esc(suggestion.last4)}`) : "", suggestion.expiry ? (language==="ar"?`ينتهي في ${esc(suggestion.expiry)}`:`expiring ${esc(suggestion.expiry)}`) : ""].filter(Boolean).join(language==="ar"?"، ":", ");
  const accept = `<form method="post" action="/profile/civil-id/suggestion/accept">${hidden}<button class="p-button p-primary" type="submit">${language==="ar"?"نعم، استخدم هذه البيانات":"Yes, use these"}</button></form>`;
  return `<div class="p-row"><dt>${language==="ar"?"قراءة صورة البطاقة المدنية":"Civil ID photo"}</dt><dd><p>${language==="ar"?`قرأنا ${parts}. هل هذا صحيح؟`:`We read ${parts}. Is this right?`}</p>${accept}${dismiss}</dd></div>`;
}

export async function handleCivilIdSuggestion(request:IncomingMessage,response:ServerResponse,service:CivilIdSuggestionService|undefined,origin:string|undefined,authorize:(session:string)=>Promise<string|undefined>,write:(status:number,title:string,body:string)=>void):Promise<boolean>{
  const path=request.url?.split("?",1)[0]; const how=path==="/profile/civil-id/suggestion/accept"?"accepted":path==="/profile/civil-id/suggestion/dismiss"?"dismissed":undefined;
  if(!how)return false;
  const finish=(status:number,headers:Record<string,string>={})=>{response.writeHead(status,{"cache-control":"no-store","referrer-policy":"no-referrer",...headers});response.end();};
  if(request.method!=="POST"){finish(405,{allow:"POST"});return true;} if(!service){finish(404);return true;}
  const session=sessionCookie(request.headers.cookie); if(!session){write(401,"Sign in",errorBody("Sign in again to continue safely."));return true;} const principal=await authorize(session);if(!principal){write(401,"Sign in",errorBody("Sign in again to continue safely."));return true;}
  if(!request.headers.origin||!origin||request.headers.origin!==origin||request.headers["sec-fetch-site"]==="cross-site"){request.resume();write(403,"Civil ID",errorBody("We could not verify this request."));return true;}
  if(!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"]??"")||Number(request.headers["content-length"])>LIMIT){request.resume();write(400,"Civil ID",errorBody("Invalid request."));return true;}
  request.setEncoding("utf8");let raw="";for await(const chunk of request){raw+=String(chunk);if(Buffer.byteLength(raw)>LIMIT){write(400,"Civil ID",errorBody("Invalid request."));return true;}}
  const params=new URLSearchParams(raw),keys=[...params.keys()].sort();if(keys.join()!==["submissionId","suggestionId"].sort().join()||keys.some((key,index)=>index>0&&key===keys[index-1])){write(400,"Civil ID",errorBody("Invalid request."));return true;}
  const id=params.get("suggestionId")??"", submitted=params.get("submissionId")??"";if(!UUID.test(id)||submitted!==submissionId(id)){write(400,"Civil ID",errorBody("Invalid request."));return true;}
  const current=await service.current(principal);if(!current||current.id!==id){if(how==="accepted"&&await service.civilStore.submissionRecorded(principal,submitted)){finish(303,{location:"/profile#field-civilId"});return true;}write(409,"Civil ID",errorBody(CIVIL_ID_MESSAGES.stale_revision));return true;}
  if(how==="dismissed"){await service.store.resolve(id,principal,"dismissed",service.now().toISOString());finish(303,{location:"/profile/civil-id"});return true;}
  if(current.state!=="read"||current.expired){write(409,"Civil ID",errorBody(CIVIL_ID_MESSAGES.stale_revision));return true;}
  const opened=current.last4 ? await service.store.openForAccept(id,principal) : null;if(current.last4&&!opened){write(409,"Civil ID",errorBody(CIVIL_ID_MESSAGES.stale_revision));return true;}
  const number=opened ? service.vault.open(principal,opened.country,opened.ciphertext) : undefined, own=await service.civilId.readOwn(principal);
  const saved=await service.civilId.save({principalId:principal,submissionId:submitted,revision:own?.revision??0,country:opened?.country,number,expiry:current.expiry??undefined});
  if(!saved.ok&&saved.reason!=="submission_reused"&&saved.reason!=="nothing_to_save"){write(saved.reason==="duplicate"||saved.reason==="stale_revision"?409:400,"Civil ID",errorBody(CIVIL_ID_MESSAGES[saved.reason]));return true;}
  await service.store.resolve(id,principal,"accepted",service.now().toISOString());finish(303,{location:"/profile#field-civilId"});return true;
}
