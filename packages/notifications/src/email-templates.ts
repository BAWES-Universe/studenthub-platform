export const EMAIL_CLASSES=["account.notice"] as const;
export type EmailClass=typeof EMAIL_CLASSES[number];
export interface EmailTemplate {readonly required:boolean;render(parameters:Readonly<Record<string,string>>):{subject:string;body:string}}
const exact=(value:Readonly<Record<string,string>>,keys:readonly string[])=>{if(Object.keys(value).sort().join()!==[...keys].sort().join()||Object.values(value).some(x=>typeof x!=="string"))throw new TypeError("invalid template parameters")};
export const EMAIL_TEMPLATES:Readonly<Record<EmailClass,EmailTemplate>>=Object.freeze({
 "account.notice":Object.freeze({required:false,render(parameters:Readonly<Record<string,string>>){exact(parameters,["title","message"]);return{subject:parameters.title!,body:parameters.message!}}})
});
export function validateTemplateParameters(messageClass:EmailClass,parameters:Readonly<Record<string,string>>){EMAIL_TEMPLATES[messageClass].render(parameters)}
