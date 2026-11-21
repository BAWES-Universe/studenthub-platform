/**
 * Journey `work-history` (screen C-12): a candidate's hours for one month.
 *
 * Legacy: the candidate app listed days from `candidate_working_hour` grouped by its
 * `date` column, summing `total_time` (seconds), with a status per session (0 pending,
 * 1 approved, 2 rejected) and open sessions having no `end_time`
 * (studenthub candidate/modules/v1/controllers/CandidateWorkingHourController.php,
 * actionListDate and actionStats).
 *
 * Legacy's day screen listed that day's sessions (actionListHour with `date`, ordered by
 * `created_at`): start and end time, duration, status, and whether it was a manual log.
 *
 * New: `/work/history?month=YYYY-MM` shows the month's approved, waiting and rejected
 * totals and, per day, the session count, each status's time and whether one is open.
 * `/work/history/YYYY-MM-DD` shows the day's totals and each session. The walk opens the
 * month page and the day page of every day legacy shows; a day only the new side has is
 * still caught on the month page (an extra `day[...]` path).
 *
 * Facts, all in whole minutes as the page shows them:
 *   month.approvedMinutes | month.waitingMinutes | month.rejectedMinutes | month.truncated
 *   day[YYYY-MM-DD].sessions | .approvedMinutes | .waitingMinutes | .rejectedMinutes | .open
 * A day shows a status's minutes only when that status has time, so a zero part is absent
 * on both sides rather than 0 on one.
 *   dayDetail[YYYY-MM-DD].sessions | .truncated | .approvedMinutes | .waitingMinutes | .rejectedMinutes
 *   dayDetail[YYYY-MM-DD].session[n].start | .end | .minutes | .status | .late
 * Sessions are numbered from 1 in order of start, then end, so both sides number them the
 * same whatever order they were stored in. Times are Kuwait `HH:MM`; an open session has
 * end and minutes null and status `open`; `late` is a manual log ("entered late").
 */

import { kuwaitClock, minutes, parseDuration, SheetBuilder, type FactSheet } from "../facts.js";
import { parseHtml, query, queryAll, textOf } from "../html.js";
import { monthBounds, type Journey, type JourneyContext, type LegacyReader, type OpenedPage } from "../journey.js";

type Status = "approved" | "waiting" | "rejected";
const LEGACY_STATUS: Readonly<Record<string, Status>> = { "0": "waiting", "1": "approved", "2": "rejected" };

interface Session { readonly start: string; readonly end: string | null; readonly minutes: number | null; readonly status: Status | "open"; readonly late: boolean }
interface Day { sessions: number; open: number; seconds: Record<Status, number>; list: Session[] }

const MONTH_PATH = "/work/history?month=";
const DAY_PATH = /^\/work\/history\/(\d{4}-\d{2}-\d{2})$/;

/** Both sides number a day's sessions in this order, so storage order never matters. */
function ordered(list: readonly Session[]): Session[] {
  const key = (s: Session) => `${s.start}|${s.end ?? "~"}|${String(s.minutes ?? -1).padStart(6, "0")}|${s.status}|${s.late ? 1 : 0}`;
  return [...list].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

function setDayDetail(sheet: SheetBuilder, date: string, totals: Record<Status, number>, list: readonly Session[], truncated: boolean): void {
  sheet.set(`dayDetail[${date}].sessions`, list.length).set(`dayDetail[${date}].truncated`, truncated);
  for (const s of ["approved", "waiting", "rejected"] as const) sheet.set(`dayDetail[${date}].${s}Minutes`, totals[s]);
  ordered(list).forEach((x, i) => {
    const at = `dayDetail[${date}].session[${i + 1}]`;
    sheet.set(`${at}.start`, x.start).set(`${at}.end`, x.end).set(`${at}.minutes`, x.minutes).set(`${at}.status`, x.status).set(`${at}.late`, x.late);
  });
}

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
      "SELECT JSON_OBJECT('date', DATE_FORMAT(`date`, '%Y-%m-%d'), 'status', status, 'open', end_time IS NULL, 'seconds', total_time, "
        + "'start', DATE_FORMAT(start_time, '%Y-%m-%d %H:%i:%s'), 'end', DATE_FORMAT(end_time, '%Y-%m-%d %H:%i:%s'), 'late', via = 'Manual Log') "
        + "FROM candidate_working_hour WHERE candidate_id = ? AND `date` BETWEEN ? AND ?",
      [Number(legacyId), { date: first }, { date: last }]);
    const days = new Map<string, Day>();
    const month: Record<Status, number> = { approved: 0, waiting: 0, rejected: 0 };
    for (const r of rows) {
      const date = String(r.date);
      const day = days.get(date) ?? { sessions: 0, open: 0, seconds: { approved: 0, waiting: 0, rejected: 0 }, list: [] };
      day.sessions++;
      const start = kuwaitClock(String(r.start ?? ""));
      const late = r.late === 1 || r.late === true;
      if (r.open === 1 || r.open === true) {
        day.open++;
        day.list.push({ start, end: null, minutes: null, status: "open", late });
      } else {
        const status = LEGACY_STATUS[String(r.status)];
        if (!status) throw new Error("twin.legacy.badStatus");
        const raw = Number(r.seconds ?? 0);
        const seconds = Number.isFinite(raw) ? raw : 0;
        day.seconds[status] += seconds;
        month[status] += seconds;
        day.list.push({ start, end: kuwaitClock(String(r.end)), minutes: minutes(seconds), status, late });
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
      const totals = { approved: minutes(d.seconds.approved), waiting: minutes(d.seconds.waiting), rejected: minutes(d.seconds.rejected) };
      setDayDetail(sheet, date, totals, d.list, false);
    }
    return sheet.build();
  },

  pages(ctx: JourneyContext, legacy: FactSheet) {
    const days = [...legacy.keys()].map((k) => /^day\[(\d{4}-\d{2}-\d{2})\]\.sessions$/.exec(k)?.[1]).filter((d): d is string => d !== undefined);
    return [`${MONTH_PATH}${ctx.month}`, ...days.sort().map((d) => `/work/history/${d}`)];
  },

  newSheet(pages: readonly OpenedPage[], ctx: JourneyContext): FactSheet {
    const [monthPage, ...dayPages] = pages;
    if (!monthPage || monthPage.path !== `${MONTH_PATH}${ctx.month}`) throw new Error("twin.page.notMonth");
    const sheet = new SheetBuilder();
    readMonth(monthPage.html, sheet);
    for (const page of dayPages) {
      const date = DAY_PATH.exec(page.path)?.[1];
      if (!date || !date.startsWith(`${ctx.month}-`)) throw new Error("twin.page.notDay");
      readDay(page.html, date, sheet);
    }
    return sheet.build();
  },
};

function wordsOf(doc: ReturnType<typeof parseHtml>): Words {
  return query(doc, "html")?.attrs.get("lang") === "ar" ? AR : EN;
}

function readMonth(html: string, sheet: SheetBuilder): void {
  const doc = parseHtml(html);
  const words = wordsOf(doc);
  const summary = query(doc, "section[aria-labelledby=\"month-heading\"]");
  if (!summary) throw new Error("twin.page.noSummary");
  const totals = new Map<string, number>();
  for (const row of queryAll(summary, "dl > div")) {
    const label = textOf(query(row, "dt") ?? ""), value = textOf(query(row, "dd") ?? "");
    totals.set(label, parseDuration(value));
  }
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
}

/** The day page (gateway `renderDay`): a totals line, then one card per session. */
function readDay(html: string, date: string, sheet: SheetBuilder): void {
  const doc = parseHtml(html);
  const words = wordsOf(doc);
  const totalsText = textOf(query(doc, "section.p-card > p") ?? "");
  const t = words.dayTotals.exec(totalsText);
  if (!t) throw new Error("twin.page.noDayTotals");
  const totals = { approved: parseDuration(t[1]!), waiting: parseDuration(t[2]!), rejected: parseDuration(t[3]!) };
  const list: Session[] = [];
  for (const li of queryAll(doc, "ul.p-stack > li.p-card")) {
    const time = textOf(query(li, "h3") ?? "");
    const line = queryAll(li, "p").find((p) => query(p, "strong") !== undefined);
    if (!line) throw new Error("twin.page.badSession");
    const shown = textOf(query(line, "strong")!);
    const status = Object.hasOwn(words.status, shown) ? words.status[shown] : undefined;
    if (!status) throw new Error("twin.page.badStatus");
    const tail = textOf(line).split(" · ");
    const marks = tail.length > 2 ? tail[tail.length - 1]!.split(words.list).map((m) => m.trim()) : [];
    const late = marks.includes(words.enteredLate);
    const open = words.toNow.exec(time);
    if (open) {
      if (status !== "open") throw new Error("twin.page.badSession");
      list.push({ start: open[1]!, end: null, minutes: null, status, late });
      continue;
    }
    const range = words.range.exec(time);
    if (!range || status === "open") throw new Error("twin.page.badSession");
    list.push({ start: range[1]!, end: range[2]!, minutes: parseDuration(range[3]!), status, late });
  }
  const truncated = query(doc, `a[href^="/work/history/${date}?after="]`) !== undefined;
  if (list.length === 0 && !query(doc, "div.p-empty")) throw new Error("twin.page.noSessions");
  setDayDetail(sheet, date, totals, list, truncated);
}

interface Words {
  readonly approved: string; readonly waiting: string; readonly rejected: string; readonly truncated: string;
  readonly separator: string; readonly inProgress: string;
  readonly part: Readonly<Record<Status, string>>;
  sessions(text: string): number | undefined;
  // The day page.
  readonly dayTotals: RegExp; readonly toNow: RegExp; readonly range: RegExp;
  readonly status: Readonly<Record<string, Status | "open">>; readonly enteredLate: string; readonly list: string;
}

// The gateway's copy (apps/gateway/src/work/copy.ts: `history`, `day`, `session`, `status`), read back.
const EN: Words = {
  approved: "Approved", waiting: "Waiting for approval", rejected: "Rejected", truncated: "Only the first part of this month is shown.",
  separator: ",", inProgress: "in progress", part: { approved: "approved", waiting: "waiting", rejected: "rejected" },
  sessions: (t) => { const m = /^(\d+) sessions?$/.exec(t); return m ? Number(m[1]) : undefined; },
  dayTotals: /^Approved (.+) · Waiting (.+) · Rejected (.+)$/, toNow: /^(\d{2}:\d{2}) to now$/, range: /^(\d{2}:\d{2}) to (\d{2}:\d{2}) \((.+)\)$/,
  status: { Approved: "approved", "Waiting for approval": "waiting", Rejected: "rejected", "In progress": "open" }, enteredLate: "entered late", list: ",",
};
const AR: Words = {
  approved: "تمت الموافقة", waiting: "بانتظار الموافقة", rejected: "مرفوضة", truncated: "يظهر الجزء الأول فقط من هذا الشهر.",
  separator: "،", inProgress: "جارية", part: { approved: "تمت الموافقة عليها", waiting: "بالانتظار", rejected: "مرفوضة" },
  sessions: (t) => { if (t === "جلسة واحدة") return 1; if (t === "جلستان") return 2; const m = /^(\d+) جلسات$/.exec(t); return m ? Number(m[1]) : undefined; },
  dayTotals: /^تمت الموافقة (.+) · بالانتظار (.+) · مرفوضة (.+)$/, toNow: /^(\d{2}:\d{2}) حتى الآن$/, range: /^(\d{2}:\d{2}) إلى (\d{2}:\d{2}) \((.+)\)$/,
  status: { "تمت الموافقة": "approved", "بانتظار الموافقة": "waiting", "مرفوضة": "rejected", "جارية": "open" }, enteredLate: "أُدخلت متأخرة", list: "،",
};
