/**
 * Email classes (contract C-2). `required` marks a transactional class: it is always sent and
 * nobody can switch it off. The database class table (`email_classes.transactional`, migration
 * 0354) says the same for every class; a db test compares the two.
 */
import{MORNING_SUMMARY_COUNTERS,MORNING_SUMMARY_HIDDEN_AT_ZERO,MORNING_SUMMARY_KEYS,type MorningSummaryCounts}from"../../reports/src/morning-summary-counters.js";
export const EMAIL_CLASSES=["account.notice","civil_id.result","staff.morning_summary","staff.firing_spike","recruit.invitation"] as const;
export type EmailClass=typeof EMAIL_CLASSES[number];
export interface EmailTemplateParameters {
  readonly "account.notice":{readonly heading:string;readonly message:string};
  readonly "civil_id.result":{readonly decision:"confirmed"}|{readonly decision:"rejected";readonly reason:string};
  readonly "staff.morning_summary":{readonly day:string;readonly counters:MorningSummaryCounts};
  /** One company's month passed its 12-month average (warning) or twice it (danger); counts are placements ended. */
  readonly "staff.firing_spike":{readonly company:string;readonly month:string;readonly level:"warning"|"danger";readonly total:number;readonly twelveMonthTotal:number};
  /** The person was invited to apply for a request's position (legacy `candidate/job-invitation`). */
  readonly "recruit.invitation":{readonly position:string;readonly company:string};
}
export interface RenderedEmail{readonly subject:string;readonly body:string}
export interface EmailTemplate<C extends EmailClass=EmailClass>{readonly required:boolean;render(parameters:EmailTemplateParameters[C]):RenderedEmail}
const exact=(value:unknown,keys:readonly string[]):value is Record<string,string>=>{if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join("\0")!==[...keys].sort().join("\0"))return false;return keys.every(key=>typeof (value as Record<string,unknown>)[key]==="string")};
/** Same rule as the staff decision (`civil_id_review_decisions`): 1 to 300 characters, no control characters. */
const reasonOk=(reason:string)=>{const n=[...reason].length;return n>=1&&n<=300&&!/[\u0000-\u001f\u007f-\u009f]/.test(reason)};
function civilIdResult(value:unknown):value is EmailTemplateParameters["civil_id.result"]{
  if(exact(value,["decision"]))return value.decision==="confirmed";
  return exact(value,["decision","reason"])&&value.decision==="rejected"&&reasonOk(value.reason);
}
const realDay=(day:unknown):day is string=>typeof day==="string"&&/^\d{4}-\d{2}-\d{2}$/.test(day)&&new Date(`${day}T00:00:00Z`).toISOString().startsWith(day);
/** The day and every counter, each a whole number from 0 up or null ("not available"); nothing else. */
function morningSummary(value:unknown):value is EmailTemplateParameters["staff.morning_summary"]{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join("\0")!=="counters\0day")return false;
  const{day,counters}=value as{day:unknown;counters:unknown};
  if(!realDay(day)||!counters||typeof counters!=="object"||Array.isArray(counters)||Object.keys(counters).sort().join("\0")!==[...MORNING_SUMMARY_KEYS].sort().join("\0"))return false;
  return Object.values(counters).every(n=>n===null||(Number.isSafeInteger(n)&&(n as number)>=0));
}
const longDay=(day:string)=>new Intl.DateTimeFormat("en-US",{timeZone:"UTC",month:"long",day:"numeric",year:"numeric"}).format(new Date(`${day}T00:00:00Z`));
function renderMorningSummary(p:EmailTemplateParameters["staff.morning_summary"]):RenderedEmail{
  const lines=MORNING_SUMMARY_COUNTERS.filter(c=>!(MORNING_SUMMARY_HIDDEN_AT_ZERO.includes(c.key)&&p.counters[c.key]===0)).map(c=>`${c.label}: ${p.counters[c.key]===null?"not available":p.counters[c.key]}`);
  return{subject:`Morning Report for ${longDay(p.day)}`,body:`Good morning. This is StudentHub on ${longDay(p.day)} (Kuwait time).\n\n${lines.join("\n")}\n\n"Not available" means the data behind that number is not in StudentHub yet. The same numbers, always current, are on the morning summary page in the staff workspace.`};
}
/** The company name (1 to 200 characters, no control characters), a real month, a level and the counts that make it that level. */
/** One line of 1 to 255 characters with no control characters, as a position title or company name is shown. */
const lineOk=(text:string)=>{const n=[...text].length;return n>=1&&n<=255&&!/[\u0000-\u001f\u007f-\u009f]/.test(text)};
const recruitInvitation=(value:unknown):value is EmailTemplateParameters["recruit.invitation"]=>exact(value,["position","company"])&&lineOk(value.position)&&lineOk(value.company);
function firingSpike(value:unknown):value is EmailTemplateParameters["staff.firing_spike"]{
  if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join("\0")!=="company\0level\0month\0total\0twelveMonthTotal")return false;
  const{company,month,level,total,twelveMonthTotal}=value as Record<string,unknown>;
  if(typeof company!=="string"||[...company].length<1||[...company].length>200||/[\u0000-\u001f\u007f-\u009f]/.test(company))return false;
  if(typeof month!=="string"||!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)||(level!=="warning"&&level!=="danger"))return false;
  if(!Number.isSafeInteger(total)||!Number.isSafeInteger(twelveMonthTotal)||(total as number)<1||(twelveMonthTotal as number)<(total as number))return false;
  // The level must be the one the counts give: above twice the average is danger, above it is warning.
  const t=(total as number)*12,sum=twelveMonthTotal as number;
  return level===(t>2*sum?"danger":t>sum?"warning":null);
}
const longMonth=(month:string)=>new Intl.DateTimeFormat("en-US",{timeZone:"UTC",month:"long",year:"numeric"}).format(new Date(`${month}-01T00:00:00Z`));
function renderFiringSpike(p:EmailTemplateParameters["staff.firing_spike"]):RenderedEmail{
  const average=Math.round(p.twelveMonthTotal*100/12)/100;
  return{subject:`Firing spike for ${p.company}`,body:`${p.company}: ${p.total} ${p.total===1?"placement":"placements"} ended in ${longMonth(p.month)} so far, ${p.level==="danger"?"more than twice":"more than"} its 12-month average of ${average} a month.\n\nThe hit map in the staff workspace (Statistics, placements ended per company) shows every company's last 12 months. You get one email per company and month.`};
}
export function validateTemplateParameters<C extends EmailClass>(emailClass:C,value:unknown):EmailTemplateParameters[C]{
  if(emailClass==="account.notice"&&exact(value,["heading","message"]))return value as EmailTemplateParameters[C];
  if(emailClass==="civil_id.result"&&civilIdResult(value))return value as EmailTemplateParameters[C];
  if(emailClass==="staff.morning_summary"&&morningSummary(value))return value as EmailTemplateParameters[C];
  if(emailClass==="staff.firing_spike"&&firingSpike(value))return value as EmailTemplateParameters[C];
  if(emailClass==="recruit.invitation"&&recruitInvitation(value))return value as EmailTemplateParameters[C];
  throw new TypeError("invalid closed email template parameters");
}
export const EMAIL_TEMPLATES:{readonly [C in EmailClass]:EmailTemplate<C>}={
  "account.notice":{required:false,render:p=>({subject:p.heading,body:p.message})},
  "civil_id.result":{required:true,render:p=>p.decision==="confirmed"
    ?{subject:"Your civil ID is confirmed",body:"StudentHub staff checked your civil ID and confirmed it. You do not need to do anything."}
    :{subject:"We could not confirm your civil ID",body:`StudentHub staff checked your civil ID and could not confirm it.\n\nReason: ${p.reason}\n\nUpload new photos of the front and back of your civil ID from your profile, and staff will check it again.`}},
  "staff.morning_summary":{required:false,render:renderMorningSummary},
  "staff.firing_spike":{required:false,render:renderFiringSpike},
  "recruit.invitation":{required:false,render:p=>({subject:"You’re invited to apply for a job opening",body:`You're invited to apply for ${p.position} at ${p.company}.\n\nOpen Invitations in your StudentHub account to accept or decline it.`})},
};
