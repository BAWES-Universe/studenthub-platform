import { kuwaitDay, validateTemplateParameters, type EmailTemplateParameters } from "../../notifications/src/index.js";
import { MORNING_SUMMARY_COUNTERS, type MorningSummaryCounts } from "./morning-summary-counters.js";

/**
 * The staff morning summary (contract P-2, legacy `CronController::actionSummary`, cron
 * `0 8 * * *`). Staff see today's counters on their page at any time; the email goes once per
 * Asia/Kuwait day, from 08:00, to every staff member who turned it on and is still staff when
 * it is sent. The email delivery job calls `queueMorningSummaryThenDeliver` on every run, so a run after 08:00
 * sends the day and every later run finds it already sent.
 */
export const MORNING_SUMMARY_HOUR = 8;
export interface MorningSummaryStore {
  counts(day: string): Promise<Readonly<Record<string, number>>>;
  sendDay(day: string, at: Date, build: (counts: Readonly<Record<string, number>>) => unknown): Promise<{ readonly recipients: number } | null>;
  isSubscribed(principalId: string): Promise<boolean>;
  setSubscribed(principalId: string, on: boolean, at: Date): Promise<void>;
}
export interface MorningSummaryRow { readonly key: string; readonly label: string; readonly value: number | null; readonly waitsOn: string | null }
export interface MorningSummaryToday { readonly day: string; readonly rows: readonly MorningSummaryRow[] }
export type MorningSummarySend = { readonly status: "not_yet"; readonly day: string } | { readonly status: "already_sent"; readonly day: string } | { readonly status: "sent"; readonly day: string; readonly recipients: number };

/** Hour of the day in Kuwait, 0 to 23. */
export function kuwaitHour(at: Date): number {
  return Number(new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuwait", hour: "2-digit", hourCycle: "h23" }).format(at));
}

/**
 * Every counter in registry order: the store's number for an available counter, null for one
 * whose source is missing. An available counter the store did not answer is an error, never 0.
 */
export function completeCounts(raw: Readonly<Record<string, number>>): MorningSummaryCounts {
  const out: Record<string, number | null> = {};
  for (const c of MORNING_SUMMARY_COUNTERS) {
    if (c.source.kind === "missing") { out[c.key] = null; continue; }
    const n = raw[c.key];
    if (!Number.isSafeInteger(n) || (n as number) < 0) throw new TypeError(`morning summary counter ${c.key} has no value`);
    out[c.key] = n as number;
  }
  return out as MorningSummaryCounts;
}

/** Sends the day's summary if it is 08:00 or later in Kuwait and the day has not been sent. */
export async function sendMorningSummaryIfDue(store: Pick<MorningSummaryStore, "sendDay">, now = new Date()): Promise<MorningSummarySend> {
  const day = kuwaitDay(now);
  if (kuwaitHour(now) < MORNING_SUMMARY_HOUR) return { status: "not_yet", day };
  const sent = await store.sendDay(day, now, raw => MorningSummaryService.parameters(day, raw));
  return sent ? { status: "sent", day, recipients: sent.recipients } : { status: "already_sent", day };
}

/**
 * The email delivery job's work with the summary in front: queue the summary if due, then
 * deliver, so a queued summary goes out in the same run. A summary failure does not hold back
 * delivery; it is raised after it, so the job still records a failure and the next run retries.
 */
export async function queueMorningSummaryThenDeliver(store: Pick<MorningSummaryStore, "sendDay">, deliver: () => Promise<number>, now: () => Date = () => new Date()): Promise<number> {
  let failure: unknown, failed = false;
  try { await sendMorningSummaryIfDue(store, now()); } catch (error) { failed = true; failure = error; }
  const sent = await deliver();
  if (failed) throw failure;
  return sent;
}

export class MorningSummaryService {
  constructor(private readonly store: MorningSummaryStore, private readonly authority: { isStaff(principalId: string): Promise<boolean> }) {}

  /** Parameters for one day's email, checked against the template's closed shape. */
  static parameters(day: string, raw: Readonly<Record<string, number>>): EmailTemplateParameters["staff.morning_summary"] {
    return validateTemplateParameters("staff.morning_summary", { day, counters: completeCounts(raw) });
  }

  /** Today's counters for a staff member's page, with the same values the email would carry; undefined for anyone else. */
  async today(viewer: string, now = new Date()): Promise<(MorningSummaryToday & { readonly subscribed: boolean }) | undefined> {
    if (!(await this.authority.isStaff(viewer))) return undefined;
    const day = kuwaitDay(now);
    const [raw, subscribed] = await Promise.all([this.store.counts(day), this.store.isSubscribed(viewer)]);
    const counts = MorningSummaryService.parameters(day, raw).counters;
    return { day, subscribed, rows: MORNING_SUMMARY_COUNTERS.map(c => ({ key: c.key, label: c.label, value: counts[c.key], waitsOn: c.source.kind === "missing" ? c.source.waitsOn : null })) };
  }

  /** Turns the email on or off for the staff member themself; false for anyone else. */
  async subscribe(viewer: string, on: boolean, now = new Date()): Promise<boolean> {
    if (!(await this.authority.isStaff(viewer))) return false;
    await this.store.setSubscribed(viewer, on, now);
    return true;
  }
}
