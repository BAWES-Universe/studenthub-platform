export const EMAIL_CLASSES=["account.notice"] as const;
export type EmailClass=typeof EMAIL_CLASSES[number];
export interface EmailTemplateParameters{"account.notice":{readonly heading:string;readonly message:string}}
export interface RenderedEmail{readonly subject:string;readonly body:string}
const exact=(value:unknown,keys:readonly string[]):value is Record<string,string>=>typeof value==="object"&&value!==null&&!Array.isArray(value)&&Object.keys(value).sort().join("\0")===[...keys].sort().join("\0")&&keys.every(key=>typeof (value as Record<string,unknown>)[key]==="string");
export function validateTemplateParameters<C extends EmailClass>(emailClass:C,value:unknown):EmailTemplateParameters[C]{if(emailClass==="account.notice"&&exact(value,["heading","message"]))return value as EmailTemplateParameters[C];throw new TypeError("invalid closed email template parameters")}
export function renderEmail<C extends EmailClass>(emailClass:C,value:EmailTemplateParameters[C]):RenderedEmail{const parameters=validateTemplateParameters(emailClass,value);return{subject:parameters.heading,body:parameters.message}}
export function emailClassRequired(_emailClass:EmailClass):boolean{return false}
