export type EmailFailureCode="delivery_not_configured"|"non_production"|"recipient_unavailable"|"provider_rejected"|"provider_timeout"|"attempt_limit";
export type EmailSendResult={readonly ok:true}|{readonly ok:false;readonly code:EmailFailureCode;readonly safeToRetry:boolean};
export interface EmailPort{send(input:{readonly to:string;readonly subject:string;readonly body:string}):Promise<EmailSendResult>}
export class FakeEmailPort implements EmailPort{readonly sent:Array<{to:string;subject:string;body:string}>=[];constructor(readonly result:EmailSendResult={ok:true}){}async send(input:{to:string;subject:string;body:string}){this.sent.push({...input});return this.result}}
export class UnconfiguredEmailPort implements EmailPort{async send(){return{ok:false as const,code:"delivery_not_configured" as const,safeToRetry:false}}}
