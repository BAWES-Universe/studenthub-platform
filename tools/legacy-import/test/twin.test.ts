import assert from "node:assert/strict";
import test from "node:test";
import { renderDay, renderHistory } from "../../../apps/gateway/src/work/pages.js";
import { WORK_COPY } from "../../../apps/gateway/src/work/copy.js";
import type { WorkHttpServices } from "../../../apps/gateway/src/work/http.js";
import { compareSheets, validateExplanations, type Explanation } from "../src/twin/compare.js";
import { parseDuration, SheetBuilder, type FactSheet } from "../src/twin/facts.js";
import { parseHtml, query, queryAll, textOf } from "../src/twin/html.js";
import type { LegacyParam, LegacyReader, OpenedPage } from "../src/twin/journey.js";
import { workHistory } from "../src/twin/journeys/work-history.js";
import { assertPrivate, closeVerified, MINIMUM_PEOPLE_FLOOR, verdictOf, type TwinReport } from "../src/twin/report.js";
import { walkedRevisionMatchesTree } from "../src/twin/cli.js";
import { JOURNEYS } from "../src/twin/journeys/index.js";
import { bind, parseRows, stagingApp, STAGING_ORIGIN, type BrowserLike } from "../src/twin/staging.js";
import { walk, WalkFailure, type NewApp } from "../src/twin/walk.js";

const REVISION = "a".repeat(40);
const MONTH = "2026-10";
const sheet = (entries: Record<string, string | number | boolean | null>): FactSheet => {
  const b = new SheetBuilder();
  for (const [k, v] of Object.entries(entries)) b.set(k, v);
  return b.build();
};

// ---- page reader -------------------------------------------------------------------------

test("the page reader finds elements by simple selectors and reads text as a person sees it", () => {
  const doc = parseHtml(`<!DOCTYPE html><html lang="ar"><body><main id="main"><section class="p-card x" aria-labelledby="h"><h2 id="h">Days &amp; hours</h2>
<ul><li><a href="/work/history/2026-10-02">Fri</a>: 1 session<script>var hidden = "<li>no</li>";</script></li><li hidden>gone</li></ul><input type="hidden" value="v"><br/>
<p>a&nbsp;&#x41;&#66;<!-- comment --> b</p></section></main></body></html>`);
  assert.equal(query(doc, "html")?.attrs.get("lang"), "ar");
  assert.equal(textOf(query(doc, "#h")!), "Days & hours");
  assert.equal(queryAll(doc, "section[aria-labelledby=\"h\"] ul > li").length, 2);
  assert.equal(textOf(query(doc, "ul")!), "Fri: 1 session", "scripts and hidden elements are not read");
  assert.equal(query(doc, "a[href^=\"/work/history/\"]")?.attrs.get("href"), "/work/history/2026-10-02");
  assert.equal(textOf(query(doc, "section.p-card.x > p")!), "a AB b".replace(/\s+/g, " "));
  assert.throws(() => queryAll(doc, "li:first-child"), /unsupported selector/);
  const links = parseHtml('<p><a class="x" href="/help.html#top">Help</a></p>');
  assert.equal(query(links, 'a[href="/help.html#top"]')?.attrs.get("class"), "x", "a dot or hash inside an attribute value is not a class or id");
  assert.equal(query(links, 'a.x[href^="/help.html"]') !== undefined, true);
});

// ---- facts -------------------------------------------------------------------------------

test("fact paths are built from words, dates and ids only, so a value can never become a path", () => {
  const b = new SheetBuilder();
  b.set("day[2026-10-02].sessions", 1).set("month.approvedMinutes", 0).set("person[candidate:42].open", false)
    .set("row[aaaaaaaa-0000-4000-8000-000000000001].x", null);
  assert.throws(() => b.set("day[2026-10-02].sessions", 2), /twin.fact.duplicatePath/);
  for (const bad of ["name[Fatima].x", "profile.first name", "day[2026-10-02] .x", "Profile.name", "x[1;drop]", "x.", "x[]"]) {
    assert.throws(() => new SheetBuilder().set(bad, 1), /twin.fact.badPath/, bad);
  }
  assert.throws(() => new SheetBuilder().set("x", Number.NaN), /twin.fact.badNumber/);
});

test("durations read back as the gateway shows them, in English and Arabic", () => {
  for (const seconds of [0, 59, 60, 3599, 3600, 9000, 86400 + 61]) {
    const minutes = Math.floor(seconds / 60);
    assert.equal(parseDuration(WORK_COPY.en.duration(seconds)), minutes);
    assert.equal(parseDuration(WORK_COPY.ar.duration(seconds)), minutes);
  }
  for (const bad of ["", "2 hours", "h", "1h 2m 3s", "٢ س"]) assert.throws(() => parseDuration(bad), /twin.fact.badDuration/, bad);
});

// ---- comparison --------------------------------------------------------------------------

const EXPLAINED: Explanation = { journey: "work-history", path: "day[*].rejectedMinutes", kinds: ["missing"], decision: "contracts/decisions-2026-10-27.md" };

test("a comparison counts matches, and lists explained differences and regressions by path only", () => {
  const legacy = sheet({ "a.x": 1, "day[2026-10-02].rejectedMinutes": 5, "day[2026-10-03].rejectedMinutes": 5, "b.only": true });
  const next = sheet({ "a.x": 1, "day[2026-10-03].rejectedMinutes": 6, "c.new": 0 });
  const c = compareSheets("work-history", legacy, next, [EXPLAINED]);
  assert.deepEqual(c, {
    matched: 1,
    explained: [{ path: "day[2026-10-02].rejectedMinutes", kind: "missing", decision: EXPLAINED.decision }],
    regressions: [{ path: "b.only", kind: "missing" }, { path: "c.new", kind: "extra" }, { path: "day[2026-10-03].rejectedMinutes", kind: "differs" }],
  });
  assert.equal(compareSheets("other", legacy, next, [EXPLAINED]).explained.length, 0, "an explanation covers its own journey only");
  assert.equal(compareSheets("work-history", sheet({ "a.x": 0 }), sheet({ "a.x": false }), []).regressions.length, 1, "0 and false differ");
});

test("an explanation must cite a decision record or a desk comment, as a whole citation", () => {
  assert.deepEqual(validateExplanations([EXPLAINED, { ...EXPLAINED, path: "month.truncated", decision: "PR #393 comment 6951406632" }], ["work-history"]), []);
  const bad: Explanation[] = [
    { ...EXPLAINED, path: "z", decision: "agreed in chat" },
    { ...EXPLAINED, path: "a", decision: "contracts/decisions-2026-10-27.md because Fatima said so" },
    { ...EXPLAINED, path: "b", journey: "nope" },
    { ...EXPLAINED, path: "c", kinds: [] },
    { ...EXPLAINED, path: "name[Fatima]" },
    EXPLAINED, EXPLAINED,
  ];
  const problems = validateExplanations(bad, ["work-history"]);
  assert.deepEqual(problems.map((p) => p.replace(/^explanation \d+: /, "")),
    ["cites no decision record", "cites no decision record", "unknown journey", "bad kinds", "bad path", "duplicate path for journey"]);
});

// ---- work history journey ----------------------------------------------------------------

/**
 * Legacy rows for one candidate: two days, every status, an open session, a null total, a
 * manual log. Times are Kuwait wall time, as legacy wrote them.
 */
const LEGACY_ROWS = [
  { date: "2026-10-02", status: 1, open: 0, seconds: 9000, start: "2026-10-02 08:00:00", end: "2026-10-02 10:30:00", late: 0 },
  { date: "2026-10-02", status: 0, open: 0, seconds: 1830, start: "2026-10-02 11:00:00", end: "2026-10-02 11:30:30", late: 1 },
  { date: "2026-10-02", status: 2, open: 0, seconds: 600, start: "2026-10-02 13:00:00", end: "2026-10-02 13:10:00", late: 0 },
  { date: "2026-10-15", status: 1, open: 0, seconds: 3600, start: "2026-10-15 09:00:00", end: "2026-10-15 10:00:00", late: 0 },
  { date: "2026-10-15", status: 0, open: 1, seconds: null, start: "2026-10-15 14:00:00", end: null, late: 0 },
];

function reader(rows: readonly Record<string, unknown>[], calls: { sql: string; params: readonly LegacyParam[] }[] = []): LegacyReader {
  return { rows: async (sql, params) => { calls.push({ sql, params }); bind(sql, params); return rows; } };
}

/** The same hours as the new app holds them after the M-5 import, stored in another order. */
function newSessions(over: Partial<Record<number, Record<string, unknown>>> = {}) {
  const base = [
    { workDate: "2026-10-15", status: "pending", durationSeconds: null, startedAt: "2026-10-15T11:00:00.000Z", endedAt: null, source: "timer" },
    { workDate: "2026-10-02", status: "rejected", durationSeconds: 600, startedAt: "2026-10-02T10:00:00.000Z", endedAt: "2026-10-02T10:10:00.000Z", source: "timer" },
    { workDate: "2026-10-02", status: "approved", durationSeconds: 9000, startedAt: "2026-10-02T05:00:00.000Z", endedAt: "2026-10-02T07:30:00.000Z", source: "timer" },
    { workDate: "2026-10-02", status: "pending", durationSeconds: 1830, startedAt: "2026-10-02T08:00:00.000Z", endedAt: "2026-10-02T08:30:30.000Z", source: "manual" },
    { workDate: "2026-10-15", status: "approved", durationSeconds: 3600, startedAt: "2026-10-15T06:00:00.000Z", endedAt: "2026-10-15T07:00:00.000Z", source: "timer" },
  ];
  return base.map((s, i) => ({ id: `aaaaaaaa-0000-4000-8000-00000000000${i}`, storeId: "store-1", flags: [] as string[], note: null, ...s, ...(over[i] ?? {}) }));
}
type NewSession = ReturnType<typeof newSessions>[number];

function views(sessions: readonly NewSession[]): WorkHttpServices {
  const mine = async (_person: string, range: { from: string; to: string }) => {
    const inRange = sessions.filter((s) => s.workDate >= range.from && s.workDate <= range.to);
    const totals = { approvedSeconds: 0, pendingSeconds: 0, rejectedSeconds: 0, open: 0 };
    for (const s of inRange) {
      if (s.endedAt === null) totals.open++;
      else totals[`${s.status as "approved" | "pending" | "rejected"}Seconds`] += s.durationSeconds ?? 0;
    }
    return { rows: inRange.map((session) => ({ session, decision: null })), totals, next: null };
  };
  return { views: { mine } } as unknown as WorkHttpServices;
}

async function historyPage(sessions: readonly NewSession[], language: "en" | "ar" = "en"): Promise<string> {
  return renderHistory(views(sessions), "person", MONTH, "2026-11", WORK_COPY[language]);
}

/** What the walk opens for one person: the month page and each legacy day's page. */
async function walkedPages(legacy: FactSheet, sessions: readonly NewSession[], language: "en" | "ar" = "en"): Promise<OpenedPage[]> {
  const out: OpenedPage[] = [];
  for (const path of workHistory.pages({ month: MONTH }, legacy)) {
    const day = /^\/work\/history\/(\d{4}-\d{2}-\d{2})$/.exec(path)?.[1];
    out.push({ path, html: day ? await renderDay(views(sessions), undefined, "person", day, null, WORK_COPY[language]) : await historyPage(sessions, language) });
  }
  return out;
}

test("work history: the legacy month and days and the new pages read to the same sheet, in English and Arabic", async () => {
  const calls: { sql: string; params: readonly LegacyParam[] }[] = [];
  const legacy = await workHistory.legacySheet(reader(LEGACY_ROWS, calls), "42", { month: MONTH });
  assert.deepEqual(calls[0]!.params, [42, { date: "2026-10-01" }, { date: "2026-10-31" }]);
  assert.deepEqual(workHistory.pages({ month: MONTH }, legacy), ["/work/history?month=2026-10", "/work/history/2026-10-02", "/work/history/2026-10-15"]);
  const facts = Object.fromEntries(legacy);
  assert.deepEqual(Object.fromEntries(Object.entries(facts).filter(([k]) => !k.startsWith("dayDetail"))), {
    "day[2026-10-02].approvedMinutes": 150, "day[2026-10-02].open": false, "day[2026-10-02].rejectedMinutes": 10,
    "day[2026-10-02].sessions": 3, "day[2026-10-02].waitingMinutes": 30,
    "day[2026-10-15].approvedMinutes": 60, "day[2026-10-15].open": true, "day[2026-10-15].sessions": 2,
    "month.approvedMinutes": 210, "month.rejectedMinutes": 10, "month.truncated": false, "month.waitingMinutes": 30,
  });
  assert.deepEqual(Object.fromEntries(Object.entries(facts).filter(([k]) => k.startsWith("dayDetail[2026-10-15]"))), {
    "dayDetail[2026-10-15].approvedMinutes": 60, "dayDetail[2026-10-15].rejectedMinutes": 0, "dayDetail[2026-10-15].sessions": 2,
    "dayDetail[2026-10-15].truncated": false, "dayDetail[2026-10-15].waitingMinutes": 0,
    "dayDetail[2026-10-15].session[1].end": "10:00", "dayDetail[2026-10-15].session[1].late": false, "dayDetail[2026-10-15].session[1].minutes": 60,
    "dayDetail[2026-10-15].session[1].start": "09:00", "dayDetail[2026-10-15].session[1].status": "approved",
    "dayDetail[2026-10-15].session[2].end": null, "dayDetail[2026-10-15].session[2].late": false, "dayDetail[2026-10-15].session[2].minutes": null,
    "dayDetail[2026-10-15].session[2].start": "14:00", "dayDetail[2026-10-15].session[2].status": "open",
  });
  assert.equal(facts["dayDetail[2026-10-02].session[2].late"], true);
  for (const language of ["en", "ar"] as const) {
    const next = workHistory.newSheet(await walkedPages(legacy, newSessions(), language), { month: MONTH });
    assert.deepEqual(compareSheets("work-history", legacy, next, []), { matched: legacy.size, explained: [], regressions: [] }, language);
  }
});

test("work history: a session whose status changed in the import is a regression at that day's paths", async () => {
  const legacy = await workHistory.legacySheet(reader(LEGACY_ROWS), "42", { month: MONTH });
  const next = workHistory.newSheet(await walkedPages(legacy, newSessions({ 1: { status: "approved" } })), { month: MONTH });
  assert.deepEqual(compareSheets("work-history", legacy, next, []).regressions, [
    { path: "dayDetail[2026-10-02].approvedMinutes", kind: "differs" },
    { path: "dayDetail[2026-10-02].rejectedMinutes", kind: "differs" },
    { path: "dayDetail[2026-10-02].session[3].status", kind: "differs" },
    { path: "day[2026-10-02].approvedMinutes", kind: "differs" },
    { path: "day[2026-10-02].rejectedMinutes", kind: "missing" },
    { path: "month.approvedMinutes", kind: "differs" },
    { path: "month.rejectedMinutes", kind: "differs" },
  ]);
  const dropped = workHistory.newSheet(await walkedPages(legacy, newSessions().slice(1)), { month: MONTH });
  const lost = compareSheets("work-history", legacy, dropped, []).regressions;
  assert.ok(lost.some((r) => r.path === "dayDetail[2026-10-15].session[2].start" && r.kind === "missing"), "the open session is missing on the day page");
  assert.ok(lost.some((r) => r.path === "dayDetail[2026-10-15].sessions" && r.kind === "differs"));
});

test("work history: the day page shows each session's own time, end, duration and manual mark", async () => {
  const legacy = await workHistory.legacySheet(reader(LEGACY_ROWS), "42", { month: MONTH });
  for (const [over, path] of [
    [{ 2: { startedAt: "2026-10-02T05:01:00.000Z" } }, "dayDetail[2026-10-02].session[1].start"],
    [{ 2: { endedAt: "2026-10-02T07:31:00.000Z" } }, "dayDetail[2026-10-02].session[1].end"],
    [{ 3: { source: "timer" } }, "dayDetail[2026-10-02].session[2].late"],
    [{ 1: { source: "manual" } }, "dayDetail[2026-10-02].session[3].late"],
  ] as const) {
    for (const language of ["en", "ar"] as const) {
      const next = workHistory.newSheet(await walkedPages(legacy, newSessions(over), language), { month: MONTH });
      assert.deepEqual(compareSheets("work-history", legacy, next, []).regressions, [{ path, kind: "differs" }], `${path} ${language}`);
    }
  }
  // A day cut short by paging reads as truncated, never as a full day.
  const cut = (await walkedPages(legacy, newSessions())).map((p) => p.path.endsWith("2026-10-02")
    ? { ...p, html: p.html.replace("</section>", '<p><a href="/work/history/2026-10-02?after=x">Later sessions on this day</a></p></section>') } : p);
  assert.deepEqual(compareSheets("work-history", legacy, workHistory.newSheet(cut, { month: MONTH }), []).regressions,
    [{ path: "dayDetail[2026-10-02].truncated", kind: "differs" }]);
});

test("work history: an empty month reads as zero totals on both sides; a page it cannot read fails", async () => {
  const legacy = await workHistory.legacySheet(reader([]), "42", { month: MONTH });
  assert.deepEqual(workHistory.pages({ month: MONTH }, legacy), ["/work/history?month=2026-10"]);
  const next = workHistory.newSheet(await walkedPages(legacy, []), { month: MONTH });
  assert.deepEqual(compareSheets("work-history", legacy, next, []).regressions, []);
  const month = { path: "/work/history?month=2026-10", html: await historyPage([]) };
  assert.throws(() => workHistory.newSheet([{ ...month, html: "<html><main>Sign in</main></html>" }], { month: MONTH }), /twin.page.noSummary/);
  assert.throws(() => workHistory.newSheet([{ ...month, path: "/work/history?month=2026-09" }], { month: MONTH }), /twin.page.notMonth/);
  assert.throws(() => workHistory.newSheet([month, { path: "/work/history/2026-09-30", html: "" }], { month: MONTH }), /twin.page.notDay/);
  assert.throws(() => workHistory.newSheet([month, { path: "/work/history/2026-10-02", html: "<html><main>Sign in</main></html>" }], { month: MONTH }), /twin.page.noDayTotals/);
  await assert.rejects(workHistory.legacySheet(reader([{ ...LEGACY_ROWS[0], status: 7 }]), "42", { month: MONTH }), /twin.legacy.badStatus/);
});

// ---- walk, report and gates --------------------------------------------------------------

function app(pages: (personId: string, paths: readonly string[]) => Promise<readonly string[]>, linked = (id: string) => (id === "404" ? undefined : `p-${id}`)): NewApp {
  return { personFor: async (id) => linked(id), open: async (personId, paths) => pages(personId, paths) };
}

test("a walk records each person's outcome, and failures as fixed codes that never carry a value", async () => {
  const people = ["1", "2", "3", "404", "5"];
  const legacy: LegacyReader = { rows: async (sql) => (sql.includes("GROUP BY candidate_id") ? people.map((id) => ({ id })) : LEGACY_ROWS) };
  const people6 = [...people, "6"];
  const legacy6: LegacyReader = { rows: async (sql, params) => (sql.includes("GROUP BY candidate_id") ? people6.map((id) => ({ id })) : legacy.rows(sql, params)) };
  const legacySheet = await workHistory.legacySheet(reader(LEGACY_ROWS), "1", { month: MONTH });
  const same = await walkedPages(legacySheet, newSessions());
  const changed = await walkedPages(legacySheet, newSessions({ 2: { durationSeconds: 9060 } }));
  const report = await walk([workHistory], legacy6, app(async (p, paths) => {
    if (p === "p-3") throw new Error("Fatima Al-Sabah's page timed out");
    if (p === "p-5") throw new WalkFailure("sign_in_failed");
    assert.deepEqual(paths, same.map((x) => x.path));
    if (p === "p-6") return [same[0]!.html];
    return (p === "p-2" ? changed : same).map((x) => x.html);
  }), { month: MONTH }, { revision: REVISION, limit: 10, minimumPeople: 1, explanations: [], now: () => new Date("2026-11-20T00:00:00Z") });
  const outcomes = report.journeys[0]!.people.map((p) => [p.legacyId, p.outcome, "code" in p ? p.code : p.regressions.length]);
  assert.deepEqual(outcomes, [["1", "match", 0], ["2", "regression", 4], ["3", "error", "page_failed"], ["404", "error", "persona_unlinked"], ["5", "error", "sign_in_failed"],
    ["6", "error", "page_failed"]]);
  assert.ok(!JSON.stringify(report).includes("Fatima"), "no error text reaches the report");
  assert.deepEqual(verdictOf(report.journeys[0]!, 1), { verdict: "open", reason: "regression", walked: 2 });
});

const person = (legacyId: string, outcome: "match" | "explained" | "regression" = "match") => ({
  legacyId, outcome, matched: 3,
  explained: outcome === "explained" ? [{ path: "a.x", kind: "differs" as const, decision: "contracts/decisions-2026-10-27.md" }] : [],
  regressions: outcome === "regression" ? [{ path: "a.y", kind: "missing" as const }] : [],
});
function report(journeys: TwinReport["journeys"], minimumPeople = 2): TwinReport {
  return { schemaVersion: 1, revision: REVISION, startedAt: "2026-11-20T00:00:00.000Z", finishedAt: "2026-11-20T00:10:00.000Z", minimumPeople, journeys };
}

test("a journey is verified only with enough people walked, no regression and no failed walk", () => {
  const j = (people: TwinReport["journeys"][number]["people"]) => ({ journey: "work-history", screens: ["C-12"], people });
  assert.deepEqual(verdictOf(j([person("1"), person("2", "explained")]), 2), { verdict: "verified", walked: 2 });
  assert.deepEqual(verdictOf(j([person("1")]), 2), { verdict: "open", reason: "too_few_people", walked: 1 });
  assert.deepEqual(verdictOf(j([person("1"), person("2"), { legacyId: "3", outcome: "error", code: "persona_unlinked" }]), 2), { verdict: "open", reason: "error", walked: 2 });
  assert.deepEqual(verdictOf(j([person("1"), person("2", "regression")]), 1), { verdict: "open", reason: "regression", walked: 2 });
  assert.deepEqual(verdictOf(j([]), 1), { verdict: "open", reason: "too_few_people", walked: 0 });
});

test("the privacy check refuses any report field that could carry a value", () => {
  const ok = report([{ journey: "work-history", screens: ["C-12"], people: [person("1"), person("2", "explained"), person("3", "regression")] }]);
  assertPrivate(ok);
  const breaks: [string, (r: Record<string, any>) => void][] = [
    ["legacyId", (r) => { r.journeys[0].people[0].legacyId = "fatima@example.com"; }],
    ["regression.path", (r) => { r.journeys[0].people[2].regressions[0].path = "name[Fatima]"; }],
    ["explained.decision", (r) => { r.journeys[0].people[1].explained[0].decision = "contracts/decisions-2026-10-27.md: salary 450"; }],
    ["code", (r) => { r.journeys[0].people[0] = { legacyId: "1", outcome: "error", code: "timeout: 12 Salmiya" }; }],
    ["person.value", (r) => { r.journeys[0].people[0].value = "x"; }],
    ["report.note", (r) => { r.note = "x"; }],
    ["outcome", (r) => { r.journeys[0].people[2].outcome = "match"; }],
    ["revision", (r) => { r.revision = "main"; }],
    ["screens", (r) => { r.journeys[0].screens = ["C-12 /work"]; }],
  ];
  for (const [field, mutate] of breaks) {
    const copy = JSON.parse(JSON.stringify(ok));
    mutate(copy);
    assert.throws(() => assertPrivate(copy), new RegExp(`twin.report.notPrivate: ${field.replace(".", "\\.")}$`), field);
  }
});

const REGISTRY = [
  { id: "work-history", screens: ["C-12", "C-11"] },
  { id: "approvals", screens: ["M-03"] },
  { id: "staff-logs", screens: ["A-12"] },
  { id: "staff-logs-two", screens: ["A-12"] },
];
const RULES = { registry: REGISTRY, revision: REVISION, minimumPeople: 2 };
const EVIDENCE = "PR #600 comment 7000000001";
const gates = (built: string) => ({ gates: { built: built === "done" ? { state: "done", evidence: "PR #588 at 4581829" } : { state: "open" }, verified: { state: "open" } } });
const SCREENS = { "C-12": gates("done"), "C-11": gates("open"), "M-03": gates("done"), "A-12": gates("done") };
const FULL = () => report([
  { journey: "work-history", screens: ["C-12", "C-11"], people: [person("1"), person("2")] },
  { journey: "approvals", screens: ["M-03"], people: [person("1")] },
  { journey: "staff-logs", screens: ["A-12"], people: [person("1"), person("2", "explained")] },
  { journey: "staff-logs-two", screens: ["A-12"], people: [person("1"), person("2", "regression")] },
]);

test("closing gates: only built screens of verified journeys close, citing the published report", () => {
  const r = FULL();
  assert.throws(() => closeVerified(SCREENS, r, "the walk on staging", RULES), /twin.gate.evidenceUnsourced/);
  const { screens: out, changes } = closeVerified(SCREENS, r, EVIDENCE, RULES);
  assert.deepEqual(changes.map((c) => `${c.screen} ${c.journey} ${c.change}`), [
    "C-12 work-history closed", "C-11 work-history built_open", "M-03 approvals not_verified", "A-12 staff-logs not_verified", "A-12 staff-logs-two not_verified",
  ]);
  assert.deepEqual(out["C-12"]!.gates.verified, { state: "done", evidence: `legacy twin walk at ${REVISION.slice(0, 12)}: work-history (2 people); ${EVIDENCE}` });
  assert.deepEqual(SCREENS["C-12"].gates.verified, { state: "open" }, "the input is not changed");
  assert.equal(closeVerified(out, r, EVIDENCE, RULES).changes[0]!.change, "already_closed");
});

test("closing gates: a report is checked against the code's journeys, revision and floor, not trusted to describe itself", () => {
  const without = (id: string) => ({ ...FULL(), journeys: FULL().journeys.filter((j) => j.journey !== id) });
  const passingTwo = { ...FULL(), journeys: FULL().journeys.map((j) => j.journey === "staff-logs-two" ? { ...j, people: [person("1"), person("2")] } : j) };
  const cases: [string, TwinReport, RegExp][] = [
    ["unknown journey", { ...FULL(), journeys: [...FULL().journeys, { journey: "made-up", screens: ["C-12"], people: [person("1"), person("2")] }] }, /twin.gate.unknownJourney/],
    ["altered mapping (extra screen)", { ...FULL(), journeys: FULL().journeys.map((j) => j.journey === "approvals" ? { ...j, screens: ["M-03", "A-12"] } : j) }, /twin.gate.screensMismatch/],
    ["altered mapping (screen dropped)", { ...FULL(), journeys: FULL().journeys.map((j) => j.journey === "work-history" ? { ...j, screens: ["C-12"] } : j) }, /twin.gate.screensMismatch/],
    ["duplicate journey", { ...FULL(), journeys: [...FULL().journeys, FULL().journeys[0]!] }, /twin.gate.duplicateJourney/],
    ["omitted co-owner", without("staff-logs-two"), /twin.gate.coOwnerMissing/],
    ["stale revision", { ...FULL(), revision: "b".repeat(40) }, /twin.gate.staleRevision/],
    ["minimum below the floor", { ...FULL(), minimumPeople: 1 }, /twin.gate.minimumTooLow/],
  ];
  for (const [name, r, error] of cases) assert.throws(() => closeVerified(SCREENS, r, EVIDENCE, RULES), error, name);
  assert.throws(() => closeVerified(SCREENS, FULL(), EVIDENCE, { ...RULES, revision: "main" }), /twin.gate.staleRevision/);
  // With both co-owners in the report and verified, the shared screen closes, naming both.
  const both = closeVerified(SCREENS, passingTwo, EVIDENCE, RULES);
  assert.match(String((both.screens["A-12"]!.gates.verified as { evidence?: string }).evidence), /staff-logs \(2 people\), staff-logs-two \(2 people\)/);
  // A journey the report leaves out entirely is fine when it shares no screen with the ones present.
  assert.equal(closeVerified(SCREENS, without("approvals"), EVIDENCE, RULES).changes.some((c) => c.screen === "M-03"), false);
});

test("the walker registry maps each journey to screens the release matrix knows", () => {
  for (const j of JOURNEYS) {
    assert.ok(j.screens.length > 0 && j.screens.every((s) => /^[A-Z]-\d{2}$/.test(s)), j.id);
    assert.deepEqual(validateExplanations([], [j.id]), []);
  }
  assert.equal(new Set(JOURNEYS.map((j) => j.id)).size, JOURNEYS.length, "journey ids are unique");
  assert.ok(MINIMUM_PEOPLE_FLOOR >= 5);
  assert.equal(walkedRevisionMatchesTree("main", () => 0), false, "a revision must be a full commit");
  assert.equal(walkedRevisionMatchesTree(REVISION, (args) => (args[0] === "merge-base" ? 1 : 0)), false, "not in this tree");
  assert.equal(walkedRevisionMatchesTree(REVISION, (args) => (args[0] === "diff" ? 1 : 0)), false, "walker changed since");
  assert.equal(walkedRevisionMatchesTree(REVISION, () => 0), true);
});

// ---- staging adapters --------------------------------------------------------------------

test("legacy queries bind integers and real ISO dates only, and are single SELECT JSON_OBJECT statements", () => {
  assert.equal(bind("SELECT JSON_OBJECT('d', DATE_FORMAT(d, '%Y-%m-%d')) FROM t WHERE a = ? AND d BETWEEN ? AND ?", [7, { date: "2026-10-01" }, { date: "2026-10-31" }]),
    "SELECT JSON_OBJECT('d', DATE_FORMAT(d, '%Y-%m-%d')) FROM t WHERE a = 7 AND d BETWEEN '2026-10-01' AND '2026-10-31'");
  const sql = "SELECT JSON_OBJECT('a', a) FROM t WHERE a = ?";
  for (const p of [1.5, Number.MAX_SAFE_INTEGER + 2, { date: "2026-02-30" }, { date: "2026-10-01' OR '1" }, "1" as unknown as number]) {
    assert.throws(() => bind(sql, [p as LegacyParam]), /twin.legacy.badParam/);
  }
  assert.throws(() => bind(sql, []), /twin.legacy.badParam/);
  assert.throws(() => bind(sql, [1, 2]), /twin.legacy.paramCount/);
  for (const bad of ["DELETE FROM t", "SELECT a FROM t", "SELECT JSON_OBJECT('a', a) FROM t; DROP TABLE t", "SELECT JSON_OBJECT('a', a) FROM t -- x", "SELECT JSON_OBJECT('a', a) FROM t /* x */"]) {
    assert.throws(() => bind(bad, []), /twin.legacy.unsafeSql/, bad);
  }
  assert.deepEqual(parseRows('{"a":1,"b":"x\\ny"}\n{"a":2}\n'), [{ a: 1, b: "x\ny" }, { a: 2 }]);
  assert.throws(() => parseRows("[1]\n"), /twin.legacy.badRow/);
});

function fakeBrowser(responses: Record<string, { status: number; finalPath?: string; html?: string }>, log: string[]): BrowserLike {
  return {
    newContext: async () => ({
      addCookies: async (cookies) => { log.push(`cookie ${cookies[0]!.name} ${cookies[0]!.domain} secure=${cookies[0]!.secure}`); },
      newPage: async () => {
        let at = "";
        return {
          goto: async (url: string) => { at = url; const r = responses[new URL(url).pathname]; log.push(`goto ${new URL(url).pathname}`); if (!r) throw new Error("net"); at = r.finalPath?.startsWith("https://") ? r.finalPath : `${STAGING_ORIGIN}${r.finalPath ?? new URL(url).pathname}`; return { status: () => r.status }; },
          content: async () => responses[new URL(at).pathname]?.html ?? "<html></html>",
          url: () => at,
        };
      },
      close: async () => { log.push("close"); },
    }),
  };
}

test("the staging app signs one person in for their pages only, and always removes the session", async () => {
  const log: string[] = [];
  const sessions = { put: async (r: { id: string; personId: string }) => { log.push(`put ${r.personId}`); }, delete: async () => { log.push("delete"); } };
  assert.throws(() => stagingApp(fakeBrowser({}, log), sessions, async () => "p", "https://studenthub.co"), /twin.app.notStaging/);
  const staging = stagingApp(fakeBrowser({ "/work/history": { status: 200, html: "<html>ok</html>" }, "/expired": { status: 200, finalPath: "/login/universe" }, "/missing": { status: 404 }, "/away": { status: 200, finalPath: "https://elsewhere.example/page" } }, log), sessions, async () => "p");
  assert.deepEqual(await staging.open("p-1", ["/work/history"]), ["<html>ok</html>"]);
  assert.deepEqual(log, ["put p-1", "cookie __Host-studenthub_session staging.studenthub.co secure=true", "goto /work/history", "close", "delete"]);
  for (const [path, code] of [["/expired", "sign_in_failed"], ["/missing", "page_failed"], ["/timeout", "timeout"], ["//evil.example", "page_failed"], ["/away", "page_failed"]] as const) {
    log.length = 0;
    await assert.rejects(staging.open("p-1", [path]), (e: unknown) => e instanceof WalkFailure && e.code === code, path);
    assert.deepEqual(log.slice(-2), ["close", "delete"], `${path}: session removed`);
  }
  log.length = 0;
  const broken: BrowserLike = { newContext: async () => { throw new Error("browser gone"); } };
  await assert.rejects(stagingApp(broken, sessions, async () => "p").open("p-1", ["/work/history"]), (e: unknown) => e instanceof WalkFailure && e.code === "page_failed");
  assert.deepEqual(log, ["put p-1", "delete"], "a session is removed even when no browser context could be made");
});
