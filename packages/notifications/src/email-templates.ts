export const EMAIL_CLASSES=["account.notice"] as const;
export type EmailClass=typeof EMAIL_CLASSES[number];
export interface EmailTemplateParameters {readonly "account.notice":{readonly heading:string;readonly message:string}}
export interface RenderedEmail{readonly subject:string;readonly body:string}
export interface EmailTemplate<C extends EmailClass=EmailClass>{readonly required:boolean;render(parameters:EmailTemplateParameters[C]):RenderedEmail}
const exact=(value:unknown,keys:readonly string[]):value is Record<string,string>=>{if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join("\0")!==[...keys].sort().join("\0"))return false;return keys.every(key=>typeof (value as Record<string,unknown>)[key]==="string")};
export function validateTemplateParameters<C extends EmailClass>(emailClass:C,value:unknown):EmailTemplateParameters[C]{if(emailClass==="account.notice"&&exact(value,["heading","message"]))return value as EmailTemplateParameters[C];throw new TypeError("invalid closed email template parameters")}
export const EMAIL_TEMPLATES:{readonly [C in EmailClass]:EmailTemplate<C>}={"account.notice":{required:false,render:p=>({subject:p.heading,body:p.message})}};
