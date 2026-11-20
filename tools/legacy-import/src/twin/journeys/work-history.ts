/**
 * Journey `work-history` (screen C-12): a candidate's hours for one month.
 *
 * Legacy: the candidate app listed days from `candidate_working_hour` grouped by its
 * `date` column, summing `total_time` (seconds), with a status per session (0 pending,
 * 1 approved, 2 rejected) and open sessions having no `end_time`
 * (studenthub candidate/modules/v1/controllers/CandidateWorkingHourController.php,
 * actionListDate and actionStats).
 *
 * New: `/work/history?month=YYYY-MM` shows the month's approved, waiting and rejected
 * totals and, per day, the session count, each status's time and whether one is open.
 *
 * Facts, all in whole minutes as the page shows them:
 *   month.approvedMinutes | month.waitingMinutes | month.rejectedMinutes | month.truncated
 *   day[YYYY-MM-DD].sessions | .approvedMinutes | .waitingMinutes | .rejectedMinutes | .open
 * A day shows a status's minutes only when that status has time, so a zero part is absent
 * on both sides rather than 0 on one.
 */

import { minutes, parseDuration, SheetBuilder, type FactSheet } from "../facts.js";
import { parseHtml, query, queryAll, textOf } from "../html.js";
import { monthBounds, type Journey, type JourneyContext, type LegacyReader } from "../journey.js";

type Status = "approved" | "waiting" | "rejected";
const LEGACY_STATUS: Readonly<Record<string, Status>> = { "0": "waiting", "1": "approved", "2": "rejected" };

interface Day { sessions: number; open: number; seconds: Record<Status, number> }

export const workHistory: Journey = {
  id: "work-history",
  screens: ["C-12"],
  persona: "candidate",

  async people(legacy: LegacyReader, ctx: JourneyContext, limit: number) {
    const { first, last } = monthBounds(ctx.month);
    const rows = await legacy.rows(
      "SELECT JSON_OBJECT('id', candidate_id) FROM candidate_working_hour WHERE `date` BETWEEN ? AND ? AND end_time IS NOT NULL GROUP BY candidate_id ORDER BY candidate_id LIMIT ?",
      [{ date: first }, { date: last }, limit]);
    return rows.map((r) => String(r.id));
  },

  async legacySheet(legacy: LegacyReader, legacyId: string, ctx: JourneyContext): Promise<FactSheet> {
    const { first, last } = monthBounds(ctx.month);
    const rows = await legacy.rows(
      "SELECT JSON_OBJECT('date', DATE_FORMAT(`date`, '%Y-%m-%d'), 'status', status, 'open', end_time IS NULL, 'seconds', total_time) FROM candidate_working_hour WHERE candidate_id = ? AND `date` BETWEEN ? AND ?",
      [Number(legacyId), { date: first }, { date: last }]);
    const days = new Map<string, Day>();
    const month: Record<Status, number> = { approved: 0, waiting: 0, rejected: 0 };
    for (const r of rows) {
      const date = String(r.date);
      const day = days.get(date) ?? { sessions: 0, open: 0, seconds: { approved: 0, waiting: 0, rejected: 0 } };
      day.sessions++;
      if (r.open === 1 || r.open === true) day.open++;
      else {
        const status = LEGACY_STATUS[String(r.status)];
        if (!status) throw new Error("twin.legacy.badStatus");
        const seconds = Number(r.seconds ?? 0);
        day.seconds[status] += Number.isFinite(seconds) ? seconds : 0;
        month[status] += Number.isFinite(seconds) ? seconds : 0;
      }
      days.set(date, day);
    }
    const sheet = new SheetBuilder()
      .set("month.approvedMinutes", minutes(month.approved))
      .set("month.waitingMinutes", minutes(month.waiting))
      .set("month.rejectedMinutes", minutes(month.rejected))
      .set("month.truncated", false);
    for (const [date, d] of days) {
      sheet.set(`day[${date}].sessions`, d.sessions).set(`day[${date}].open`, d.open > 0);
      for (const s of ["approved", "waiting", "rejected"] as const) if (d.seconds[s] > 0) sheet.set(`day[${date}].${s}Minutes`, minutes(d.seconds[s]));
    }
    return sheet.build();
  },

  pages: (ctx: JourneyContext) => [`/work/history?month=${ctx.month}`],

  newSheet(html: readonly string[]): FactSheet {
    const doc = parseHtml(html[0] ?? "");
    const ar = query(doc, "html")?.attrs.get("lang") === "ar";
    const words = ar ? AR : EN;
    const summary = query(doc, "section[aria-labelledby=\"month-heading\"]");
    if (!summary) throw new Error("twin.page.noSummary");
    const totals = new Map<string, number>();
    for (const row of queryAll(summary, "dl > div")) {
      const label = textOf(query(row, "dt") ?? ""), value = textOf(query(row, "dd") ?? "");
      totals.set(label, parseDuration(value));
    }
    const sheet = new SheetBuilder();
    for (const [status, label] of [["approved", words.approved], ["waiting", words.waiting], ["rejected", words.rejected]] as const) {
      const v = totals.get(label);
      if (v === undefined) throw new Error("twin.page.noTotal");
      sheet.set(`month.${status}Minutes`, v);
    }
    const daysSection = query(doc, "section[aria-labelledby=\"days-heading\"]");
    sheet.set("month.truncated", daysSection ? textOf(daysSection).includes(words.truncated) : false);
    for (const li of daysSection ? queryAll(daysSection, "ul > li") : []) {
      const href = query(li, "a[href^=\"/work/history/\"]")?.attrs.get("href") ?? "";
      const date = /^\/work\/history\/(\d{4}-\d{2}-\d{2})$/.exec(href)?.[1];
      if (!date) throw new Error("twin.page.badDay");
      const anchorText = textOf(query(li, "a")!);
      const rest = textOf(li).slice(anchorText.length).replace(/^\s*:\s*/, "");
      const parts = rest.split(words.separator).map((p) => p.trim()).filter((p) => p.length > 0);
      const count = words.sessions(parts.shift() ?? "");
      if (count === undefined) throw new Error("twin.page.badCount");
      sheet.set(`day[${date}].sessions`, count);
      let open = false;
      for (const part of parts) {
        if (part === words.inProgress) { open = true; continue; }
        const hit = (["approved", "waiting", "rejected"] as const).find((s) => part.endsWith(` ${words.part[s]}`));
        if (!hit) throw new Error("twin.page.badPart");
        sheet.set(`day[${date}].${hit}Minutes`, parseDuration(part.slice(0, -(words.part[hit].length + 1))));
      }
      sheet.set(`day[${date}].open`, open);
    }
    return sheet.build();
  },
};

interface Words {
  readonly approved: string; readonly waiting: string; readonly rejected: string; readonly truncated: string;
  readonly separator: string; readonly inProgress: string;
  readonly part: Readonly<Record<Status, string>>;
  sessions(text: string): number | undefined;
}

// The gateway's copy (apps/gateway/src/work/copy.ts, `history`), read back.
const EN: Words = {
  approved: "Approved", waiting: "Waiting for approval", rejected: "Rejected", truncated: "Only the first part of this month is shown.",
  separator: ",", inProgress: "in progress", part: { approved: "approved", waiting: "waiting", rejected: "rejected" },
  sessions: (t) => { const m = /^(\d+) sessions?$/.exec(t); return m ? Number(m[1]) : undefined; },
};
const AR: Words = {
  approved: "تمت الموافقة", waiting: "بانتظار الموافقة", rejected: "مرفوضة", truncated: "يظهر الجزء الأول فقط من هذا الشهر.",
  separator: "،", inProgress: "جارية", part: { approved: "تمت الموافقة عليها", waiting: "بالانتظار", rejected: "مرفوضة" },
  sessions: (t) => { if (t === "جلسة واحدة") return 1; if (t === "جلستان") return 2; const m = /^(\d+) جلسات$/.exec(t); return m ? Number(m[1]) : undefined; },
};
