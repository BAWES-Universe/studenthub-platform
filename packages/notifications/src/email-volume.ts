/**
 * Daily email volume alert (contract C-2, legacy `MailLog::afterSave`).
 *
 * Legacy counts the day's sends and alerts once they pass `mailThreshold` (500), then raises
 * the threshold by another 500 for the rest of the day, so it alerts again past 1000, 1500
 * and so on. Its cache check `$cacheObject["date"] = $today` assigns instead of comparing, so
 * yesterday's raised threshold carries into today and the first alert of a day can be missed.
 * Here the day is the Asia/Kuwait calendar day, level n means the day's sends passed n times
 * the threshold, and the store records each (day, level) once, so each level alerts exactly
 * once and every day starts again at level 1.
 */
export const EMAIL_VOLUME_THRESHOLD=500;
export interface EmailVolumeCrossing{readonly day:string;readonly level:number;readonly sentCount:number;readonly threshold:number}
export interface EmailVolumeStore{
  /** Counts the day's sent attempts and records every level passed that is not yet recorded (a jump from 500 to 1501 records 1, 2 and 3). Returns the new crossings, lowest first. */
  recordVolumeCrossings(day:string,threshold:number,at:Date):Promise<readonly EmailVolumeCrossing[]>;
}
export function kuwaitDay(at:Date):string{return new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Kuwait",year:"numeric",month:"2-digit",day:"2-digit"}).format(at)}
/** The level a day's count has passed: 0 at or below the threshold, 1 above it, 2 above twice it, and so on. */
export function volumeLevel(sentCount:number,threshold:number):number{if(!Number.isSafeInteger(threshold)||threshold<1)throw new RangeError("threshold must be a positive integer");return sentCount>threshold?Math.floor((sentCount-1)/threshold):0}
export async function checkEmailVolume(store:EmailVolumeStore,now=new Date(),threshold=EMAIL_VOLUME_THRESHOLD):Promise<readonly EmailVolumeCrossing[]>{volumeLevel(0,threshold);return store.recordVolumeCrossings(kuwaitDay(now),threshold,now)}
/**
 * One email delivery run: send what is due, then check the day's volume even when the send
 * failed (a run that sent mail and then failed still counts). The send's error, if any, is
 * raised after the check, so the job still records a failure.
 */
export async function deliverAndCheckVolume(deliver:()=>Promise<number>,store:EmailVolumeStore,alert:(crossing:EmailVolumeCrossing)=>void|Promise<void>,now:()=>Date=()=>new Date(),threshold=EMAIL_VOLUME_THRESHOLD):Promise<number>{
  let sent=0,failure:unknown,failed=false;
  try{sent=await deliver()}catch(error){failed=true;failure=error}
  try{for(const crossing of await checkEmailVolume(store,now(),threshold))await alert(crossing)}
  catch(error){throw failed?failure:error}
  if(failed)throw failure;
  return sent;
}
