import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { CIVIL_ID_MESSAGES, type CivilIdReason, type CivilIdService } from "@studenthub/profile";

const LIMIT=8192;
const esc=(s:string)=>s.replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[c]!);
const cookie=(header:string|undefined)=>{for(const part of header?.split(";")??[]){const [k,...v]=part.trim().split("=");if(k==="__Host-studenthub_session"&&/^[A-Za-z0-9_-]{43}$/.test(v.join("=")))return v.join("=");}return undefined;};
async function body(request:IncomingMessage){let value="";for await(const chunk of request){value+=String(chunk);if(Buffer.byteLength(value)>LIMIT)return null;}return value;}
const page=(current:{country:string|null;expiry:string|null;revision:number}|null,error?:string)=>`<main id="main" class="profile-ui"><div class="p-shell"><section class="p-main p-card p-stack"><a href="/profile#field-civilId">Back to profile</a><h1>Civil ID</h1>${error?`<section class="p-error-summary" role="alert"><h2>Check your details</h2><p>${esc(error)}</p></section>`:""}<form class="p-stack" method="post" action="/profile/civil-id"><input type="hidden" name="revision" value="${current?.revision??0}"><input type="hidden" name="submissionId" value="${randomUUID()}"><label>Country<select class="p-control" name="country" required><option value="KW"${current?.country!=="BH"?" selected":""}>Kuwait</option><option value="BH"${current?.country==="BH"?" selected":""}>Bahrain</option></select></label><label>Civil ID number<input class="p-control" name="number" inputmode="numeric" autocomplete="off" value=""></label><p class="p-hint">Leave blank to keep the number on file.</p><label>Expiry date<input class="p-control" type="date" name="expiry" value="${esc(current?.expiry??"")}"></label><button class="p-button p-primary" type="submit">Save</button></form></section></div></main>`;
export const CIVIL_ID_REASON_MESSAGES:Readonly<Record<CivilIdReason,string>>=CIVIL_ID_MESSAGES;

export async function handleCivilId(request:IncomingMessage,response:ServerResponse,service:CivilIdService|undefined,origin:string|undefined,authorize:(session:string)=>Promise<string|undefined>,write:(status:number,title:string,body:string)=>void):Promise<boolean>{
  const path=request.url?.split("?",1)[0];if(path!=="/profile/civil-id")return false;
  const finish=(status:number,headers:Record<string,string>={})=>{response.writeHead(status,{"cache-control":"no-store","referrer-policy":"no-referrer",...headers});response.end();};
  if(!service){finish(404);return true;} const session=cookie(request.headers.cookie);if(!session){write(401,"Sign in",page(null,"Sign in again to continue safely."));return true;}const principal=await authorize(session);if(!principal){write(401,"Sign in",page(null,"Sign in again to continue safely."));return true;}
  const current=await service.readOwn(principal);
  if(request.method==="GET"){write(200,"Civil ID",page(current));return true;}
  if(request.method!=="POST"){finish(405,{allow:"GET, POST"});return true;}
  const requestOrigin=request.headers.origin;
  if(!requestOrigin||!origin||requestOrigin!==origin||request.headers["sec-fetch-site"]==="cross-site"){request.resume();write(403,"Civil ID",page(current,"We could not verify this request."));return true;}
  if(!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"]??"")||Number(request.headers["content-length"])>LIMIT){request.resume();write(400,"Civil ID",page(current,"Invalid request."));return true;}
  const raw=await body(request);if(raw===null){write(400,"Civil ID",page(current,"Invalid request."));return true;}const params=new URLSearchParams(raw);const keys=[...params.keys()].sort();if(keys.join()!==["country","expiry","number","revision","submissionId"].sort().join()||keys.some((k,i)=>i>0&&k===keys[i-1])){write(400,"Civil ID",page(current,"Invalid request."));return true;}
  const revision=Number(params.get("revision"));const submissionId=params.get("submissionId")??"";if(!Number.isSafeInteger(revision)||revision<0||!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(submissionId)){write(400,"Civil ID",page(current,"Invalid request."));return true;}
  const result=await service.save({principalId:principal,submissionId,revision,country:params.get("country")??"",number:params.get("number")??"",expiry:params.get("expiry")??""});
  if(result.ok||result.reason==="submission_reused"){finish(303,{location:"/profile#field-civilId"});return true;}const status=result.reason==="duplicate"||result.reason==="stale_revision"?409:400;write(status,"Civil ID",page(current,CIVIL_ID_MESSAGES[result.reason]));return true;
}

export function renderCivilIdRow(language:"en"|"ar",value:{country:string|null;maskedNumber:string|null;expiry:string|null;needsReview:boolean}|null):string{
  const label=language==="ar"?"البطاقة المدنية":"Civil ID",change=language==="ar"?"تغيير":"Change",missing=language==="ar"?"غير مسجل":"Not recorded",waiting=language==="ar"?"بانتظار تحقق StudentHub":"Waiting for StudentHub to check";
  const shown=value?(value.maskedNumber??missing)+(value.expiry?`, ${language==="ar"?"تنتهي":"expires"} ${value.expiry}`:""):missing;
  return `<div id="field-civilId" class="p-row" tabindex="-1"><dt>${label}</dt><dd><bdi class="p-value" dir="ltr">${esc(shown)}</bdi>${value?.needsReview?`<p class="p-meta">${waiting}</p>`:""}<div class="p-row-actions"><a class="p-edit" href="/profile/civil-id">${change}</a></div></dd></div>`;
}
