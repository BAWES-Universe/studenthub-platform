import type { IncomingMessage, ServerResponse } from "node:http";
import { CIVIL_ID_MESSAGES, type CivilIdOcrStore, type CivilIdService, type CivilIdSuggestion, type CivilIdVault } from "@studenthub/profile";

const LIMIT = 1024;
const escapeHtml = (value: string) => value.replace(/[&<>"']/g, character => ({ "&":"&amp;", "<":"&lt;", ">":"&gt;", '"':"&quot;", "'":"&#39;" })[character]!);
const sessionCookie = (header: string | undefined) => { for (const part of header?.split(";") ?? []) { const [key,...rest]=part.trim().split("="); const value=rest.join("="); if (key==="__Host-studenthub_session" && /^[A-Za-z0-9_-]{43}$/.test(value)) return value; } return undefined; };
const kuwaitToday = (date: Date) => new Intl.DateTimeFormat("en-CA", { timeZone:"Asia/Kuwait", year:"numeric", month:"2-digit", day:"2-digit" }).format(date);
async function readBody(request: IncomingMessage): Promise<string|null> { request.setEncoding("utf8"); let value=""; for await (const chunk of request) { value += String(chunk); if (Buffer.byteLength(value)>LIMIT) return null; } return value; }

export interface CivilIdSuggestionService {
  current(principalId: string): Promise<CivilIdSuggestion|null>;
  openForAccept(id: string, principalId: string): ReturnType<CivilIdOcrStore["openForAccept"]>;
  resolve(id: string, principalId: string, how: "accepted"|"dismissed"): Promise<boolean>;
  readonly vault: CivilIdVault;
}

export function createCivilIdSuggestionService(options: { store: CivilIdOcrStore; vault: CivilIdVault; clock?: { now(): Date } }): CivilIdSuggestionService {
  const now = () => options.clock?.now() ?? new Date();
  return Object.freeze({
    current: (principalId: string) => options.store.currentSuggestion(principalId, kuwaitToday(now())),
    openForAccept: (id: string, principalId: string) => options.store.openForAccept(id, principalId),
    resolve: (id: string, principalId: string, how: "accepted"|"dismissed") => options.store.resolve(id, principalId, how, now().toISOString()),
    vault: options.vault,
  });
}

export function renderCivilIdSuggestion(language: "en"|"ar", suggestion?: CivilIdSuggestion|null): string {
  if (!suggestion) return "";
  const link = suggestion.state === "read" && suggestion.expired ? `<a class="p-edit" href="/profile/documents">${language==="ar"?"تحميل صورة حالية":"Upload a current photo"}</a>` : suggestion.state !== "read" ? `<a class="p-edit" href="/profile/civil-id">${language==="ar"?"إدخال القيم":"Enter my values"}</a>` : "";
  if (suggestion.state !== "read") return `<div class="p-row"><dt>${language==="ar"?"قراءة البطاقة المدنية":"Civil ID photo"}</dt><dd><p>${language==="ar"?"لم نتمكن من قراءة صورتك. يرجى كتابة رقم البطاقة المدنية وتاريخ انتهائها.":"We could not read your photo. Please type your civil ID number and expiry."}</p>${link}</dd></div>`;
  const fields = `<input type="hidden" name="suggestionId" value="${escapeHtml(suggestion.id)}"><input type="hidden" name="submissionId" value="${escapeHtml(suggestion.id)}">`;
  const dismiss = `<form method="post" action="/profile/civil-id/suggestion/dismiss">${fields}<button class="p-button" type="submit">${language==="ar"?"لا، سأدخلها بنفسي":"No, I will enter them myself"}</button></form>`;
  if (suggestion.expired && suggestion.expiry) return `<div class="p-row"><dt>${language==="ar"?"قراءة البطاقة المدنية":"Civil ID photo"}</dt><dd><p>${language==="ar"?`التاريخ الذي قرأناه (${escapeHtml(suggestion.expiry)}) قد مضى. يرجى تحميل صورة حالية أو إدخال قيمك.`:`The date we read (${escapeHtml(suggestion.expiry)}) has passed. Please upload a current photo or enter your own values.`}</p>${dismiss}${link}</dd></div>`;
  const details = [suggestion.last4 ? (language==="ar"?`رقم ينتهي بـ ${escapeHtml(suggestion.last4)}`:`a number ending ${escapeHtml(suggestion.last4)}`) : "", suggestion.expiry ? (language==="ar"?`ينتهي في ${escapeHtml(suggestion.expiry)}`:`expiring ${escapeHtml(suggestion.expiry)}`) : ""].filter(Boolean).join(language==="ar"?"، ":", ");
  const accept = `<form method="post" action="/profile/civil-id/suggestion/accept">${fields}<button class="p-button p-primary" type="submit">${language==="ar"?"نعم، استخدم هذه القيم":"Yes, use these"}</button></form>`;
  return `<div class="p-row"><dt>${language==="ar"?"قراءة البطاقة المدنية":"Civil ID photo"}</dt><dd><p>${language==="ar"?`قرأنا ${details}. هل هذا صحيح؟`:`We read ${details}. Is this right?`}</p>${accept}${dismiss}</dd></div>`;
}

const errorPage = (message: string) => `<main id="main" class="profile-ui"><div class="p-shell"><section class="p-main p-card p-stack"><a href="/profile#field-civilId">Back to profile</a><h1>Civil ID</h1><section class="p-error-summary" role="alert"><h2>Could not use that suggestion</h2><p>${escapeHtml(message)}</p></section></section></div></main>`;

export async function handleCivilIdSuggestion(request: IncomingMessage, response: ServerResponse, suggestion: CivilIdSuggestionService|undefined, civilId: CivilIdService|undefined, origin: string|undefined, authorize: (session: string)=>Promise<string|undefined>, write: (status:number,title:string,body:string)=>void): Promise<boolean> {
  const path=request.url?.split("?",1)[0]; const how=path==="/profile/civil-id/suggestion/accept"?"accepted":path==="/profile/civil-id/suggestion/dismiss"?"dismissed":null; if (!how) return false;
  const finish=(status:number,headers:Record<string,string>={})=>{response.writeHead(status,{"cache-control":"no-store","referrer-policy":"no-referrer",...headers});response.end();};
  if (request.method!=="POST") { finish(405,{allow:"POST"}); return true; }
  if (!suggestion || !civilId) { finish(404); return true; }
  const session=sessionCookie(request.headers.cookie); if (!session) { write(401,"Sign in",errorPage("Sign in again to continue safely.")); return true; }
  const principalId=await authorize(session); if (!principalId) { write(401,"Sign in",errorPage("Sign in again to continue safely.")); return true; }
  if (!request.headers.origin || !origin || request.headers.origin!==origin || request.headers["sec-fetch-site"]==="cross-site") { request.resume(); write(403,"Civil ID",errorPage("We could not verify this request.")); return true; }
  if (!/^application\/x-www-form-urlencoded(?:;\s*charset=utf-8)?$/i.test(request.headers["content-type"]??"") || Number(request.headers["content-length"])>LIMIT) { request.resume(); write(400,"Civil ID",errorPage("Invalid request.")); return true; }
  const raw=await readBody(request); if (raw===null) { write(400,"Civil ID",errorPage("Invalid request.")); return true; } const params=new URLSearchParams(raw); const keys=[...params.keys()].sort();
  if (keys.join()!==["submissionId","suggestionId"].sort().join() || keys.some((key,index)=>index>0&&key===keys[index-1])) { write(400,"Civil ID",errorPage("Invalid request.")); return true; }
  const id=params.get("suggestionId")??"", submissionId=params.get("submissionId")??""; if (!id || submissionId!==id) { write(400,"Civil ID",errorPage("Invalid request.")); return true; }
  const current=await suggestion.current(principalId); if (!current || current.id!==id) { write(409,"Civil ID",errorPage(CIVIL_ID_MESSAGES.stale_revision)); return true; }
  if (how==="dismissed") { if (!await suggestion.resolve(id,principalId,"dismissed")) { write(409,"Civil ID",errorPage(CIVIL_ID_MESSAGES.stale_revision)); return true; } finish(303,{location:"/profile/civil-id"}); return true; }
  if (current.state!=="read" || current.expired) { write(409,"Civil ID",errorPage(CIVIL_ID_MESSAGES.stale_revision)); return true; }
  const opened=current.last4 ? await suggestion.openForAccept(id,principalId) : null; if (current.last4 && !opened) { write(409,"Civil ID",errorPage(CIVIL_ID_MESSAGES.stale_revision)); return true; }
  const own=await civilId.readOwn(principalId); const number=opened ? suggestion.vault.open(principalId,opened.country,opened.ciphertext) : undefined;
  const saved=await civilId.save({principalId,submissionId,revision:own?.revision??0,country:opened?.country??current.country??undefined,number,expiry:current.expiry??undefined});
  if (!saved.ok && saved.reason!=="submission_reused") { write(saved.reason==="duplicate"||saved.reason==="stale_revision"?409:400,"Civil ID",errorPage(CIVIL_ID_MESSAGES[saved.reason])); return true; }
  await suggestion.resolve(id,principalId,"accepted"); finish(303,{location:"/profile#field-civilId"}); return true;
}
