import { kuwaitDay } from "../../notifications/src/index.js";

/**
 * When the person reminder emails are queued (comms lane slice 10). Legacy ran `cron/daily` at 13:30
 * Kuwait time (birthday, civil ID expired today) and the mid-month and end-of-month jobs on the 15th
 * and 28th (civil ID expiring within 25 days, and missing bank details, legacy
 * `Candidate::notifyMissingBankInfo`). The email delivery job checks on every run; each
 * kind is queued once per Kuwait day from 13:30, by a worker that can deliver.
 */
export type PersonReminderKind = "birthday" | "civil_id_expired" | "civil_id_expiring" | "bank_details_missing";
export interface PersonRemindersPort { sendDay(kind: PersonReminderKind, day: string, at: Date): Promise<number | null> }
export const PERSON_REMINDER_MINUTE = 13 * 60 + 30;
export const CIVIL_ID_EXPIRING_DAYS_OF_MONTH: readonly number[] = [15, 28];

/** Minutes since midnight in Kuwait, 0 to 1439. */
export function kuwaitMinute(at: Date): number {
  const parts = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuwait", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(at);
  const n = (type: string) => Number(parts.find(p => p.type === type)!.value);
  return n("hour") * 60 + n("minute");
}

/** The kinds due on this Kuwait day at this time, in the order they are queued. */
export function dueReminderKinds(now: Date): { readonly day: string; readonly kinds: readonly PersonReminderKind[] } {
  const day = kuwaitDay(now);
  if (kuwaitMinute(now) < PERSON_REMINDER_MINUTE) return { day, kinds: [] };
  const kinds: PersonReminderKind[] = ["birthday", "civil_id_expired"];
  if (CIVIL_ID_EXPIRING_DAYS_OF_MONTH.includes(Number(day.slice(8, 10)))) kinds.push("civil_id_expiring", "bank_details_missing");
  return { day, kinds };
}

/**
 * Queues every reminder kind that is due, then delivers. Each kind is tried even if another failed;
 * a failure never holds back delivery, and the first one is raised after it, so the job records a
 * failure and the next run retries that kind (a kind that did queue is not queued again).
 */
export async function queuePersonRemindersThenDeliver(port: PersonRemindersPort, deliver: () => Promise<number>, now: () => Date = () => new Date()): Promise<number> {
  let failure: unknown, failed = false;
  const at = now(), { day, kinds } = dueReminderKinds(at);
  for (const kind of kinds) {
    try { await port.sendDay(kind, day, at); } catch (error) { if (!failed) { failed = true; failure = error; } }
  }
  const sent = await deliver();
  if (failed) throw failure;
  return sent;
}
