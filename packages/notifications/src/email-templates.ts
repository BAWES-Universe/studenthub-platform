export const EMAIL_CLASSES=["account.notice"] as const;
export type EmailClass=typeof EMAIL_CLASSES[number];
export interface EmailTemplateParameters {"account.notice":{readonly heading:string;readonly message:string}}
export interface RenderedEmail{readonly subject:string;readonly body:string}
const exact=(value:unknown,keys:readonly string[])=>typeof value==="object"&&value!==null&&!Array.isArray(value)&&Object.keys(value).sort().join()=== [...keys].sort().join();
export function validateTemplateParameters<C extends EmailClass>(messageClass:C,value:unknown):value is EmailTemplateParameters[C]{return messageClass==="account.notice"&&exact(value,["heading","message"])&&typeof (value as any).heading==="string"&&typeof (value as any).message==="string"}
export function renderEmail<C extends EmailClass>(messageClass:C,parameters:EmailTemplateParameters[C]):RenderedEmail{if(!validateTemplateParameters(messageClass,parameters))throw new TypeError("invalid closed email template parameters");return{subject:parameters.heading,body:parameters.message}}
export function isRequiredEmailClass(_messageClass:EmailClass):boolean{return false}
