export type EmailFailureCode="delivery_not_configured"|"non_production"|"provider_rejected"|"provider_timeout"|"address_unavailable";
export type EmailSendResult={readonly outcome:"sent"}|{readonly outcome:"failed";readonly failureCode:Extract<EmailFailureCode,"provider_rejected"|"provider_timeout">;readonly safeToRetry:boolean};
export interface EmailPort{send(message:{readonly to:string;readonly subject:string;readonly body:string}):Promise<EmailSendResult>}
export class FakeEmailPort implements EmailPort{readonly sent:{to:string;subject:string;body:string}[]=[];result:EmailSendResult={outcome:"sent"};async send(message:{to:string;subject:string;body:string}){this.sent.push({...message});return this.result}}
export class UnconfiguredEmailPort implements EmailPort{async send():Promise<EmailSendResult>{return{outcome:"failed",failureCode:"provider_rejected",safeToRetry:false}}}
