import { kuwaitDay, validateTemplateParameters, type EmailTemplateParameters } from "../../notifications/src/index.js";
import { kuwaitHour } from "./morning-summary.js";
import { buildFiringHitMap, lastTwelveMonths, type FiringCompany, type FiringCount } from "./firing-hit-map.js";

/**
 * Staff statistics (contract P-3), slice 4: the firing spike email. Legacy's daily cron
 * (`FiringHitmap::updateHitMap`, `firingSpike`) emailed the operations mailbox when a company's
 * placements ended this month passed its 12-month average ("warning") or twice it ("danger"),
 * once per company and month (`is_alerted`), even if the month got worse later.
 *
 * Here the check runs once a Kuwait day from 08:00, from the email delivery job, like the
 * morning summary. Staff who turned the email on for themselves on the hit map page get it.
 * The levels are the hit map's, so the email and the page always agree.
 */
export const FIRING_SPIKE_HOUR = 8;
export interface FiringSpikeAlert {
  readonly orgId: string; readonly month: string;
  /** The email's closed parameters. */
  readonly parameters: EmailTemplateParameters["staff.firing_spike"];
}
export interface FiringSpikeStore {
  /**
   * Runs one day's check, once: reads the companies and counts for `months`, lets `decide` pick the
   * alerts, records each company and month that has not alerted yet, and queues its emails. Null
   * when the day already ran.
   */
  sendDay(day: string, months: readonly string[], at: Date,
    decide: (data: { readonly companies: readonly FiringCompany[]; readonly counts: readonly FiringCount[] }) => readonly FiringSpikeAlert[]): Promise<{ readonly alerts: number } | null>;
  isSubscribed(principalId: string): Promise<boolean>;
  setSubscribed(principalId: string, on: boolean, at: Date): Promise<void>;
}

/** This month's spikes on the hit map for `day`: one alert per company whose current month is marked. */
export function firingSpikes(day: string, companies: readonly FiringCompany[], counts: readonly FiringCount[]): FiringSpikeAlert[] {
  const map = buildFiringHitMap(day, companies, counts);
  return map.companies.flatMap(c => {
    const now = c.cells[0]!;
    if (!now.level) return [];
    // The name is cut to the template's limit rather than dropping the alert.
    const company = [...c.name.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")].slice(0, 200).join("").trim() || c.orgId;
    return [{ orgId: c.orgId, month: now.month, parameters: validateTemplateParameters("staff.firing_spike", { company, month: now.month, level: now.level, total: now.total, twelveMonthTotal: c.total }) }];
  });
}

export type FiringSpikeSend = { readonly status: "not_yet" | "already_ran"; readonly day: string } | { readonly status: "ran"; readonly day: string; readonly alerts: number };

/** Runs today's check if it is 08:00 or later in Kuwait and it has not run today. */
export async function sendFiringSpikesIfDue(store: Pick<FiringSpikeStore, "sendDay">, now: Date): Promise<FiringSpikeSend> {
  const day = kuwaitDay(now);
  if (kuwaitHour(now) < FIRING_SPIKE_HOUR) return { status: "not_yet", day };
  const result = await store.sendDay(day, lastTwelveMonths(day), now, ({ companies, counts }) => firingSpikes(day, companies, counts));
  return result ? { status: "ran", day, alerts: result.alerts } : { status: "already_ran", day };
}

/** For the email delivery job: run the check if due, then deliver whatever is due; a failed check never stops delivery. */
export async function queueFiringSpikesThenDeliver(store: Pick<FiringSpikeStore, "sendDay">, deliver: () => Promise<number>, now: () => Date = () => new Date()): Promise<number> {
  let failure: unknown, failed = false;
  try { await sendFiringSpikesIfDue(store, now()); } catch (error) { failed = true; failure = error; }
  const sent = await deliver();
  if (failed) throw failure;
  return sent;
}
