export const EMAIL_FAILURE_CODES=["delivery_not_configured","non_production","address_unavailable","provider_rejected","provider_timeout","retry_limit"] as const;
export type EmailFailureCode=typeof EMAIL_FAILURE_CODES[number];
export type EmailSendResult={readonly ok:true}|{readonly ok:false;readonly code:"delivery_not_configured"|"provider_rejected"|"provider_timeout";readonly safeToRetry:boolean};
export interface EmailPort{send(message:{readonly to:string;readonly subject:string;readonly body:string}):Promise<EmailSendResult>}
export class EmailSendError extends Error{constructor(readonly code:"provider_rejected"|"provider_timeout",readonly safeToRetry:boolean,providerMessage?:string){super(providerMessage);this.name="EmailSendError"}}
export class FakeEmailPort implements EmailPort{readonly sent:{to:string;subject:string;body:string}[]=[];result:EmailSendResult={ok:true};async send(message:{to:string;subject:string;body:string}){this.sent.push({...message});return this.result}}
export class UnconfiguredEmailPort implements EmailPort{async send():Promise<EmailSendResult>{return{ok:false,code:"delivery_not_configured",safeToRetry:false}}}
