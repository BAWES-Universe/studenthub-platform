import type{RenderedEmail}from"./email-templates.js";
export const EMAIL_FAILURE_CODES=["delivery_not_configured","non_production","recipient_unavailable","provider_rejected","provider_timeout","attempt_limit"]as const;
export type EmailFailureCode=typeof EMAIL_FAILURE_CODES[number];
export type EmailSendResult={readonly ok:true}|{readonly ok:false;readonly code:EmailFailureCode;readonly retrySafe:boolean};
export interface EmailPort{send(input:{readonly to:string;readonly email:RenderedEmail}):Promise<EmailSendResult>}
export class FakeEmailPort implements EmailPort{readonly sent:{to:string;email:RenderedEmail}[]=[];constructor(readonly result:EmailSendResult={ok:true}){}async send(input:{to:string;email:RenderedEmail}){this.sent.push(input);return this.result}}
export class UnconfiguredEmailPort implements EmailPort{async send(){return{ok:false,code:"delivery_not_configured",retrySafe:false}as const}}
