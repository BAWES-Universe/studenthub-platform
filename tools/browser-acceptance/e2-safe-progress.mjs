/** Deliberately closed diagnostics vocabulary: no browser text, URLs or tokens. */
const stages=new Set(['fixture','context','copied-url','parent','signed-out','cancel-open','cancel-provider','cancel-return','retry-control','login-open','login-callback','native-return','profile','assertions','screenshot']);
export class E2CaseFailure extends Error {
  constructor(stage,error,facts={}) {
    super('E2 operation failed');
    this.evidence={stage:stages.has(stage)?stage:'fixture',failureKind:error?.name==='TimeoutError'?'timeout':error?.name==='AssertionError'?'assertion':'operation'};
    for(const key of ['connectCookie','callbackCookie','profileCookie'])if(typeof facts[key]==='boolean')this.evidence[key]=facts[key];
    for(const key of ['authorizations','exchanges','callbacks','profileReads'])if(Number.isSafeInteger(facts[key])&&facts[key]>=0)this.evidence[key]=facts[key];
  }
}
export function safeE2Failure(error) {return error instanceof E2CaseFailure?{...error.evidence}:undefined;}
