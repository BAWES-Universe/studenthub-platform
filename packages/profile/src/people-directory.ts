import { validatePersonSelfEditValue } from "./self-edit.js";

export const PEOPLE_PAGE_SIZE = 25;
export type PeopleWorkStatus = "not_looking" | "active" | "open_to_offers" | "unset";
export type PeopleCivilState = "none" | "waiting" | "rejected" | "expired" | "checked" | "recorded";
export interface PeopleDirectoryQuery { q?: string; status?: PeopleWorkStatus; nationality?: string; civil?: PeopleCivilState; details?: "complete" | "missing"; page: number }
export interface PeopleDirectoryRow { principalId:string; name:string|null; universeName:string|null; arabicName:string|null; workStatus:Exclude<PeopleWorkStatus,"unset">|null; nationality:{id:string;name:string}|null; detailsMissing:number; civilState:PeopleCivilState; imported:boolean; employeeId:string|null; phoneLast4:string|null }
export interface PeopleDirectoryStore { page(query:PeopleDirectoryQuery,today:string):Promise<{rows:PeopleDirectoryRow[];total:number}> }

export const PEOPLE_DETAILS_KEYS = Object.freeze(["nationality","display_name","arabic_name","gender","objective","email","phone","birth_date","civil_id","civil_expiry","driving_licence","location","kuwaiti_mother","education","skill"] as const);
export const PEOPLE_DOCUMENT_KEYS = Object.freeze(["personal_photo","civil_front","civil_back"] as const);

export interface ClassifiedSearchTerm { employeeId:string|null; fullPhone:string|null; phoneSuffix:string|null; handle:string|null; nameTokens:readonly string[] }
const digits=(s:string)=>s.replace(/[\u0660-\u0669\u06f0-\u06f9]/g,c=>String(c.charCodeAt(0)%16));
export function classifySearchTerm(input:string):ClassifiedSearchTerm {
  const q=input.trim().normalize("NFC");
  const employee=/^c(\d+)$/i.exec(q);
  const phoneCandidate=digits(q);
  const phone=validatePersonSelfEditValue("phone",phoneCandidate,"2000-01-01");
  const digitOnly=/^[0-9\s()+-]+$/.test(phoneCandidate);
  const compact=digitOnly?phoneCandidate.replace(/[^0-9]/g,""):"";
  const handle=/^(?:https?:\/\/[^/]+\/profile\/|@)([a-z][a-z0-9._-]{2,29})\/?$/i.exec(q) ?? /^([a-z][a-z0-9._-]{2,29})$/i.exec(q);
  const nameTokens=[...q.toLowerCase().matchAll(/[\p{L}\p{N}]+/gu)].map(m=>m[0]!);
  return Object.freeze({
    employeeId:employee?String(BigInt(employee[1]!)):null,
    fullPhone:digitOnly&&phone.ok&&phone.value!==""?phone.value:null,
    phoneSuffix:digitOnly&&!phone.ok&&compact.length>=4?compact:null,
    handle:handle?handle[1]!.toLowerCase():null,
    nameTokens:Object.freeze(nameTokens),
  });
}

export function civilStateOf(value:{released?:boolean;number?:boolean;expiry?:string|null;needsReview?:boolean;decision?:"confirmed"|"rejected"|null},today:string):PeopleCivilState {
  if(value.released||(!value.number&&!value.expiry))return "none";
  if(value.needsReview)return "waiting";
  if(value.decision==="rejected")return "rejected";
  if(value.expiry!==null&&value.expiry!==undefined&&value.expiry<today)return "expired";
  if(value.decision==="confirmed")return "checked";
  return "recorded";
}
export function maskPhone(last4:string):string{return `•••• ${last4}`;}
