/**
 * Email classes (contract C-2). `required` marks a transactional class: it is always sent and
 * nobody can switch it off. The database class table (`email_classes.transactional`, migration
 * 0354) says the same for every class; a db test compares the two.
 */
export const EMAIL_CLASSES=["account.notice","civil_id.result"] as const;
export type EmailClass=typeof EMAIL_CLASSES[number];
export interface EmailTemplateParameters {
  readonly "account.notice":{readonly heading:string;readonly message:string};
  readonly "civil_id.result":{readonly decision:"confirmed"}|{readonly decision:"rejected";readonly reason:string};
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
export function validateTemplateParameters<C extends EmailClass>(emailClass:C,value:unknown):EmailTemplateParameters[C]{
  if(emailClass==="account.notice"&&exact(value,["heading","message"]))return value as EmailTemplateParameters[C];
  if(emailClass==="civil_id.result"&&civilIdResult(value))return value as EmailTemplateParameters[C];
  throw new TypeError("invalid closed email template parameters");
}
export const EMAIL_TEMPLATES:{readonly [C in EmailClass]:EmailTemplate<C>}={
  "account.notice":{required:false,render:p=>({subject:p.heading,body:p.message})},
  "civil_id.result":{required:true,render:p=>p.decision==="confirmed"
    ?{subject:"Your civil ID is confirmed",body:"StudentHub staff checked your civil ID and confirmed it. You do not need to do anything."}
    :{subject:"We could not confirm your civil ID",body:`StudentHub staff checked your civil ID and could not confirm it.\n\nReason: ${p.reason}\n\nUpload new photos of the front and back of your civil ID from your profile, and staff will check it again.`}},
};
