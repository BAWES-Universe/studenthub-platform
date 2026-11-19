import assert from "node:assert/strict";
import test from "node:test";
import { EMAIL_TEMPLATES, validateTemplateParameters } from "../../notifications/src/index.js";
import { MORNING_SUMMARY_COUNTERS, MORNING_SUMMARY_KEYS, MorningSummaryService, completeCounts, kuwaitHour, queueMorningSummaryThenDeliver, sendMorningSummaryIfDue,
  type MorningSummaryCounts, type MorningSummaryStore } from "../src/index.js";

const AVAILABLE = ["interviewScheduledToday", "activeRequests", "assignedExpiredCivilID"];
const RAW = { interviewScheduledToday: 2, activeRequests: 7, assignedExpiredCivilID: 1 };

test("REPORTS_MORNING_SUMMARY_REGISTRY the twelve legacy counters in email order, and only landed sources are available", () => {
  assert.deepEqual(MORNING_SUMMARY_KEYS, ["interviewScheduledToday", "companyMoreThen40DaysWithoutPayment", "totalExpiredCards", "id_need_generated", "activeRequests",
    "last40daysNoRequest", "requireFollowup", "missingBankInfo", "assignedExpiredCivilID", "assignedIdleCandidates", "incompleteAssignedToWork", "profileApprovalRequire"]);
  assert.deepEqual(MORNING_SUMMARY_COUNTERS.filter(c => c.source.kind === "available").map(c => c.key), AVAILABLE);
  for (const c of MORNING_SUMMARY_COUNTERS) if (c.source.kind === "missing") assert.ok(c.source.waitsOn.length > 0, c.key);
});

test("REPORTS_MORNING_SUMMARY_REGISTRY a missing source is null, never 0, and an available counter without a number is an error", () => {
  const counts = completeCounts({ ...RAW, missingBankInfo: 0 });
  assert.deepEqual(Object.entries(counts).filter(([, v]) => v !== null).map(([k]) => k), AVAILABLE);
  assert.equal(counts.missingBankInfo, null, "a number for a missing source is ignored");
  assert.equal(counts.activeRequests, 7);
  assert.throws(() => completeCounts({ interviewScheduledToday: 2, activeRequests: 7 }), /assignedExpiredCivilID/);
  assert.throws(() => completeCounts({ ...RAW, activeRequests: -1 }), /activeRequests/);
  assert.throws(() => completeCounts({ ...RAW, activeRequests: 1.5 }), /activeRequests/);
});

const counts = (over: Partial<Record<string, number | null>> = {}) => ({ ...completeCounts(RAW), ...over }) as MorningSummaryCounts;

test("REPORTS_MORNING_SUMMARY_EMAIL parameters are closed: a real day and every counter, each a count or null", () => {
  const ok = { day: "2026-11-19", counters: counts() };
  assert.deepEqual(validateTemplateParameters("staff.morning_summary", ok), ok);
  const { activeRequests: _drop, ...short } = counts();
  for (const bad of [{ ...ok, extra: 1 }, { day: ok.day }, { ...ok, day: "2026-02-30" }, { ...ok, day: "19-11-2026" }, { ...ok, counters: short },
    { ...ok, counters: { ...counts(), extra: 1 } }, { ...ok, counters: counts({ activeRequests: -1 }) }, { ...ok, counters: counts({ activeRequests: 0.5 }) },
    { ...ok, counters: { ...counts(), activeRequests: "7" } }, { ...ok, counters: [] }, null, []])
    assert.throws(() => validateTemplateParameters("staff.morning_summary", bad), /closed/, JSON.stringify(bad));
  assert.equal(EMAIL_TEMPLATES["staff.morning_summary"].required, false);
});

test("REPORTS_MORNING_SUMMARY_EMAIL legacy's subject, one line per counter, \"not available\" for a missing source, and the interview row only above 0", () => {
  const mail = EMAIL_TEMPLATES["staff.morning_summary"].render({ day: "2026-11-19", counters: counts() });
  assert.equal(mail.subject, "Morning Report for November 19, 2026");
  assert.match(mail.body, /Interviews scheduled today: organise the meeting between the company and the candidates: 2/);
  assert.match(mail.body, /Active requests that need an update: 7/);
  assert.match(mail.body, /Assigned candidates with an expired civil ID: 1/);
  assert.match(mail.body, /Candidates missing bank info: not available/);
  assert.match(mail.body, /Urgent: companies with assigned staff that have not made a payment in 40 days: not available/);
  assert.equal(mail.body.match(/without ID cards/g)?.length, 1, "legacy's duplicated row is listed once");
  const quiet = EMAIL_TEMPLATES["staff.morning_summary"].render({ day: "2026-11-19", counters: counts({ interviewScheduledToday: 0, activeRequests: 0, companyMoreThen40DaysWithoutPayment: 0 }) });
  assert.doesNotMatch(quiet.body, /Interviews scheduled today/);
  assert.doesNotMatch(quiet.body, /payment in 40 days/);
  assert.match(quiet.body, /Active requests that need an update: 0/, "other rows show 0");
});

class MemoryStore implements MorningSummaryStore {
  sent = new Map<string, unknown>(); subscribed = new Set<string>(); raw: Record<string, number> = { ...RAW }; fail = false;
  async counts() { return this.raw; }
  async sendDay(day: string, _at: Date, build: (raw: Readonly<Record<string, number>>) => unknown) {
    if (this.fail) throw Error("store down");
    if (this.sent.has(day)) return null;
    this.sent.set(day, build(this.raw)); return { recipients: this.subscribed.size };
  }
  async isSubscribed(id: string) { return this.subscribed.has(id); }
  async setSubscribed(id: string, on: boolean) { if (on) this.subscribed.add(id); else this.subscribed.delete(id); }
}

test("REPORTS_MORNING_SUMMARY_SEND from 08:00 Kuwait time, once per Kuwait day", async () => {
  assert.equal(kuwaitHour(new Date("2026-11-19T04:59:59Z")), 7);
  assert.equal(kuwaitHour(new Date("2026-11-19T05:00:00Z")), 8);
  assert.equal(kuwaitHour(new Date("2026-11-18T21:00:00Z")), 0);
  const store = new MemoryStore();
  store.subscribed.add("staff-1");
  assert.deepEqual(await sendMorningSummaryIfDue(store, new Date("2026-11-19T04:59:59Z")), { status: "not_yet", day: "2026-11-19" });
  assert.equal(store.sent.size, 0);
  assert.deepEqual(await sendMorningSummaryIfDue(store, new Date("2026-11-19T05:00:00Z")), { status: "sent", day: "2026-11-19", recipients: 1 });
  assert.deepEqual(await sendMorningSummaryIfDue(store, new Date("2026-11-19T20:59:59Z")), { status: "already_sent", day: "2026-11-19" });
  // 21:00Z is midnight in Kuwait: a new day, not due until its 08:00.
  assert.deepEqual(await sendMorningSummaryIfDue(store, new Date("2026-11-19T21:00:00Z")), { status: "not_yet", day: "2026-11-20" });
  assert.deepEqual(store.sent.get("2026-11-19"), { day: "2026-11-19", counters: counts() });
  // A store answer without an available counter sends nothing.
  store.raw = { interviewScheduledToday: 1, activeRequests: 1 };
  await assert.rejects(sendMorningSummaryIfDue(store, new Date("2026-11-20T06:00:00Z")), /assignedExpiredCivilID/);
});

test("REPORTS_MORNING_SUMMARY_SEND the delivery job still delivers when the summary fails, then reports the failure", async () => {
  const store = new MemoryStore(), at = () => new Date("2026-11-19T06:00:00Z");
  let delivered = 0;
  assert.equal(await queueMorningSummaryThenDeliver(store, async () => { delivered++; return 3; }, at), 3);
  assert.ok(store.sent.has("2026-11-19"), "the summary is queued before delivery, so it goes out in the same run");
  store.fail = true;
  await assert.rejects(queueMorningSummaryThenDeliver(store, async () => { delivered++; return 0; }, at), /store down/);
  assert.equal(delivered, 2);
  await assert.rejects(queueMorningSummaryThenDeliver(new MemoryStore(), async () => { throw Error("delivery down"); }, at), /delivery down/);
});

test("REPORTS_MORNING_SUMMARY_PAGE staff see today's counters with the email's values and turn the email on for themselves; nobody else can", async () => {
  const store = new MemoryStore(), service = new MorningSummaryService(store, { async isStaff(id) { return id === "staff-1"; } });
  const now = new Date("2026-11-19T03:00:00Z");
  assert.equal(await service.today("person-1", now), undefined);
  assert.equal(await service.subscribe("person-1", true, now), false);
  assert.equal(store.subscribed.size, 0);
  const page = await service.today("staff-1", now);
  assert.equal(page?.day, "2026-11-19");
  assert.equal(page?.subscribed, false);
  assert.deepEqual(page?.rows.map(r => r.key), MORNING_SUMMARY_KEYS);
  assert.deepEqual(Object.fromEntries(page!.rows.map(r => [r.key, r.value])), counts());
  assert.match(page?.rows.find(r => r.key === "missingBankInfo")?.waitsOn ?? "", /pay lane/);
  assert.equal(page?.rows.find(r => r.key === "activeRequests")?.waitsOn, null);
  assert.equal(await service.subscribe("staff-1", true, now), true);
  assert.equal((await service.today("staff-1", now))?.subscribed, true);
  await service.subscribe("staff-1", false, now);
  assert.equal(store.subscribed.size, 0);
});
