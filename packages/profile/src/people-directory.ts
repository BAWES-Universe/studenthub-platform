import { validatePersonSelfEditValue } from "./self-edit.js";

export const PEOPLE_PAGE_SIZE = 25;
export type PeopleWorkStatus = "not_looking" | "active" | "open_to_offers" | "unset";
export type PeopleCivilState = "none" | "waiting" | "rejected" | "expired" | "checked" | "recorded";
export interface PeopleDirectoryQuery { q?: string; status?: PeopleWorkStatus; nationality?: string; civil?: PeopleCivilState; details?: "complete" | "missing"; page: number }
export interface PeopleDirectoryRow { principalId: string; name: string | null; universeName: string | null; arabicName: string | null; workStatus: Exclude<PeopleWorkStatus,"unset"> | null; nationality: { id: string; name: string } | null; detailsMissing: number; civilState: PeopleCivilState; imported: boolean; employeeId: string | null; phoneLast4: string | null }
export interface PeopleDirectoryStore { page(query: PeopleDirectoryQuery,today:string):Promise<{rows:PeopleDirectoryRow[];total:number}> }

export const PEOPLE_DETAILS_KEYS = Object.freeze(["nationality","display_name","arabic_name","gender","objective","email","phone","birth_date","civil_id","civil_expiry","driving_licence","location","kuwaiti_mother","education","skill"] as const);
export const PEOPLE_DOCUMENT_KEYS = Object.freeze(["personal_photo","civil_front","civil_back"] as const);

export interface ClassifiedSearchTerm { employeeId:string|null; phone:string|null; phoneSuffix:string|null; handle:string|null; nameTokens:readonly string[] }
const digits=(value:string)=>value.replace(/[\u0660-\u0669\u06f0-\u06f9]/g,c=>String(c.charCodeAt(0)-(c<="\u0669"?0x0660:0x06f0)));
export function classifySearchTerm(raw:string):ClassifiedSearchTerm {
  const q=raw.trim().normalize("NFC"), employee=/^[cC]([0-9]+)$/.exec(q);
  const phoneCandidate=digits(q);
  const valid=validatePersonSelfEditValue("phone",phoneCandidate,"2000-01-01");
  const phone=valid.ok&&valid.value!==""?valid.value:null;
  const suffix=!phone&&/^[0-9\u0660-\u0669\u06f0-\u06f9]{4,8}$/.test(q)?digits(q):null;
  const handle=/^@?[A-Za-z][A-Za-z0-9._-]{2,29}$/.test(q)?q.replace(/^@/,"").toLowerCase():null;
  const nameTokens=[...q.toLowerCase().matchAll(/[\p{L}\p{M}\p{N}]+/gu)].map(m=>m[0]!);
  return Object.freeze({employeeId:employee?employee[1]!.replace(/^0+(?=\d)/,""):null,phone,phoneSuffix:suffix,handle,nameTokens:Object.freeze(nameTokens)});
}

export function civilStateOf(value:{released:boolean;number:boolean;expiry:string|null;needsReview:boolean;decision:"confirmed"|"rejected"|null},today:string):PeopleCivilState {
  if(value.released||(!value.number&&!value.expiry))return "none";
  if(value.needsReview)return "waiting";
  if(value.decision==="rejected")return "rejected";
  if(value.expiry!==null&&value.expiry<today)return "expired";
  if(value.decision==="confirmed")return "checked";
  return "recorded";
}
export function maskPhone(last4:string):string{return `•••• ${last4}`}
