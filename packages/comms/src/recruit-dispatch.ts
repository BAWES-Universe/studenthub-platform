/**
 * The recruit lane's outbox reaches people from the email delivery job: each run first dispatches
 * waiting recruit events (feed items, and the job invitation email for a sent invitation), then
 * delivers one batch of due email, oldest due first. An invitation's email goes out in the same run
 * when it fits that batch, otherwise in the following runs, in order (like legacy's mail queue).
 * A failed dispatch never holds back delivery of other email; the rows stay waiting for the next run.
 */
export const RECRUIT_DISPATCH_BATCH = 200;
export interface RecruitDispatchPort { dispatch(limit: number, at: Date): Promise<number> }

export async function dispatchRecruitThenDeliver(port: RecruitDispatchPort, deliver: () => Promise<number>, now: () => Date = () => new Date()): Promise<number> {
  let failure: unknown, failed = false;
  try { await port.dispatch(RECRUIT_DISPATCH_BATCH, now()); } catch (error) { failed = true; failure = error; }
  const sent = await deliver();
  if (failed) throw failure;
  return sent;
}
