// Each mutant breaks one work-lane rule; the named test must fail.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const placement = "packages/work/src/placement.js", sessions = "packages/work/src/sessions.js", common = "packages/work/src/common.js";
const placementSuite = "packages/work/test/placement.test.js", sessionSuite = "packages/work/test/sessions.test.js";
const decisions = "packages/work/src/decisions.js", views = "packages/work/src/views.js", decisionSuite = "packages/work/test/decisions.test.js";
const appeals = "packages/work/src/appeals.js", appealSuite = "packages/work/test/appeals.test.js";
const pages = "apps/gateway/src/work/pages.js", pagesSuite = "apps/gateway/test/work-pages.test.js";
const staffPages = "apps/gateway/src/work/staff-pages.js", staffSuite = "apps/gateway/test/work-staff-pages.test.js";
const review = "apps/gateway/src/work/review-pages.js", reviewSuite = "apps/gateway/test/work-review-pages.test.js";
const legacy = "packages/work/src/legacy.js", legacySuite = "packages/work/test/legacy.test.js";
const staffTime = "packages/work/src/staff-time.js", staffTimeSuite = "packages/work/test/staff-time.test.js";
const staffTimePages = "apps/gateway/src/work/staff-time-pages.js", staffTimePagesSuite = "apps/gateway/test/work-staff-time-pages.test.js";
const standup = "packages/work/src/standup.js", standupSuite = "packages/work/test/standup.test.js";
const standupPages = "apps/gateway/src/work/standup-pages.js", standupPagesSuite = "apps/gateway/test/work-standup-pages.test.js";
const copyFile = "apps/gateway/src/work/copy.js", teamCopyFile = "apps/gateway/src/work/team-copy.js";
const exportsFile = "apps/gateway/src/work/exports.js", exportsSuite = "apps/gateway/test/work-exports.test.js";
const mutations = [
  ["the person's screens follow their saved language", "c = await workCopyFor(services.language, person, req);", "c = await workCopyFor(undefined, person, req);", "WORK_PAGES in Arabic", pages, pagesSuite],
  ["company and store screens follow the actor's saved language", "c = await workCopyFor(services.language, actor, req);", "c = await workCopyFor(undefined, actor, req);", "WORK_REVIEW in Arabic", review, reviewSuite],
  ["staff screens follow the staff member's saved language", "c = await workCopyFor(services.language, actor, req);", "c = await workCopyFor(undefined, actor, req);", "WORK_STAFF in Arabic", staffPages, staffSuite],
  ["/me/work follows the staff member's saved language", "t.staffTime.signInMine, c));\n            return true;\n        }\n        c = await workCopyFor(services.language, actor, req);", "t.staffTime.signInMine, c));\n            return true;\n        }\n        c = await workCopyFor(undefined, actor, req);", "STAFF_TIME_PAGES in Arabic", staffTimePages, staffTimePagesSuite],
  ["the stand-up admin page follows the admin's saved language", "c = await workCopyFor(services.language, actor, req);", "c = await workCopyFor(undefined, actor, req);", "STANDUP_PAGES in Arabic", standupPages, standupPagesSuite],
  ["without a saved language, the browser's Arabic is used", 'return first?.tag.startsWith("ar") ? "ar" : "en";', 'return "en";', "WORK_PAGES in Arabic", copyFile, pagesSuite],
  ["stand-up answers are operator staff only", "async #staff(actorId) { return isOperatorStaff(await this.#grants.listGrantsForPrincipal(actorId)); }", "async #staff(actorId) { return true; }", "STANDUP", standup, standupSuite],
  ["stand-up questions are operator admins only", "async #admin(actorId) { return isOperatorAdmin(await this.#grants.listGrantsForPrincipal(actorId)); }", "async #admin(actorId) { return true; }", "STANDUP", standup, standupSuite],
  ["today lists only their own answers", "staffId: actorId, limit: STANDUP_ANSWER_PAGE_SIZE }", "limit: STANDUP_ANSWER_PAGE_SIZE }", "STANDUP", standup, standupSuite],
  ["a question is answered once a day", 'return refused("already_answered");', "return { kind: \"answered\", workDate };", "STANDUP", standup, standupSuite],
  ["an answer needs the day in progress", 'if (result === "not_working")', "if (false)", "STANDUP", standup, standupSuite],
  ["an answer must be the next question", 'if (result === "out_of_order")', "if (false)", "STANDUP", standup, standupSuite],
  ["a refused answer says why on /me/work", 'not_working: () => "Start your day to answer the stand-up.",', "", "STANDUP_PAGES", teamCopyFile, standupPagesSuite],
  ["unanswered leaves out who answered", "!answered.has(id)", "true", "STANDUP", standup, standupSuite],
  ["stand-up answers page", "next: rows.length > STANDUP_ANSWER_PAGE_SIZE && last ?", "next: false ?", "STANDUP", standup, standupSuite],
  ["the question is asked only while the day is in progress", "const ask = !dayInProgress ?", "const ask = false ?", "STANDUP_PAGES", standupPages, standupPagesSuite],
  ["question forms need the same origin", "if (req.headers.origin !== origin ||", "if (false ||", "STANDUP_PAGES", standupPages, standupPagesSuite],
  ["staff time is operator staff only", "async #staff(actorId) { return isOperatorStaff(await this.#grants.listGrantsForPrincipal(actorId)); }", "async #staff(actorId) { return true; }", "STAFF_TIME", staffTime, staffTimeSuite],
  ["end closes today's session only", "const open = await this.#store.openSession(actorId, kuwaitDate(now));", "const open = this.#store.sessions?.find((s) => s.staffId === actorId && s.endedAt === null);", "STAFF_TIME", staffTime, staffTimeSuite],
  ["a staff member reads only their own days", "const staffId = admin ? options.staffId : actorId;", "const staffId = options.staffId;", "STAFF_TIME_LIST", staffTime, staffTimeSuite],
  ["inactive list is for admins", "if (!(await this.#admin(actorId)))\n            return refused(\"forbidden\");\n        const [everyone", "const [everyone", "STAFF_TIME_INACTIVE", staffTime, staffTimeSuite],
  ["inactive leaves out who started", "!active.has(id)", "true", "STAFF_TIME_INACTIVE", staffTime, staffTimeSuite],
  ["/me/work lists only their own days", "today.workDate, { staffId: actor })", "today.workDate)", "STAFF_TIME_PAGES", staffTimePages, staffTimePagesSuite],
  ["start and end need the same origin", 'if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") {', "if (false) {", "STAFF_TIME_PAGES", staffTimePages, staffTimePagesSuite],
  ["history is operator staff only", "if (!isOperatorStaff(await this.#grants.listGrantsForPrincipal(actorId)))", "if (false)", "W1_HISTORY", placement, placementSuite],
  ["history refuses a reversed range", "|| range.from > range.to)", ")", "W1_HISTORY", placement, placementSuite],
  ["history pages", "next: rows.length > HISTORY_PAGE_SIZE && last ?", "next: false ?", "W1_HISTORY", placement, placementSuite],
  ["company export authorised", 'return !("kind" in page);', "return true;", "WORK_EXPORT", exportsFile, exportsSuite],
  ["history export authorised", "(await services.placements.history(actor, parsed)) !== undefined", "true", "WORK_EXPORT", exportsFile, exportsSuite],
  ["open hours count nowhere", "if (s.endedAt === null)\n                    continue;", "", "WORK_EXPORT", exportsFile, exportsSuite],
  ["staff export authorised", 'return page.kind === "days";', "return true;", "WORK_EXPORT", exportsFile, exportsSuite],
  ["a day not ended adds the hours per day", "t.open * Math.round((perDay.get(id) ?? 0) * 60)", "0", "WORK_EXPORT", exportsFile, exportsSuite],
  ["history export stops past the cap", "if (++count > EXPORT_ROW_CAP)", "if (++count < 0)", "WORK_EXPORT", exportsFile, exportsSuite],
  ["staff hours export stops past the cap", "if (!page.next || totals.size > EXPORT_ROW_CAP)", "if (!page.next)", "WORK_EXPORT", exportsFile, exportsSuite],
  ["detailed export stops past the cap", "if (rows.length > EXPORT_ROW_CAP)", "if (false)", "WORK_EXPORT", exportsFile, exportsSuite],
  ["staff-only placement", "store.ancestors))\n            return { kind: \"refused\", code: \"forbidden\" };\n        return this.#store.transaction((tx) => this.#place(tx, actorId, input, store, STAFF_ORIGIN));", "store.ancestors))\n            ;\n        return this.#store.transaction((tx) => this.#place(tx, actorId, input, store, STAFF_ORIGIN));", "W1_PLACE", placement, placementSuite],
  ["paused people aren't placed", "if (await tx.lockPersonPaused(input.personId))", "if (false)", "W1_PAUSED", placement, placementSuite],
  ["paused people hidden from a company's request", "|| await this.#isPaused(input.personId))", ")", "W1_PAUSED", placement, placementSuite],
  ["civil ID inclusive", "civilId.expiry < startDate", "civilId.expiry <= startDate", "W1_WARN", placement, placementSuite],
  ["ambiguous contract", "if (matches.length > 1)\n", "if (matches.length > 9)\n", "W1_CONTRACT", placement, placementSuite],
  ["open session blocks ending", "ending && (await tx.openSessionCount(current.id)) > 0", "false", "W1_END", placement, placementSuite],
  ["request list scoped in the query", "...(storeIds ? { storeIds } : {})", "...{}", "W1_REQUEST_LIST", placement, placementSuite],
  ["request scope", "isCompanyFor(grants, store.orgId, store.ancestors) || isStaffFor(grants, store.orgId, store.ancestors)", "grants.length > 0", "W1_REQUEST", placement, placementSuite],
  ["kuwait date", 'timeZone: WORK_TIME_ZONE', 'timeZone: "UTC"', "W1_DATES", common, placementSuite],
  ["location required on start", "async start(personId, location) {\n        if (!location)", "async start(personId, location) {\n        if (false)", "W3_CLOCK", sessions, sessionSuite],
  ["stop keeps start location", "const session = await tx.close(open.id, endedAt, location);", "const session = { ...(await tx.close(open.id, endedAt, location)), startLocation: location };", "W3_CLOCK", sessions, sessionSuite],
  ["manual end after start", "if (endedAt.getTime() <= startedAt.getTime())", "if (endedAt.getTime() < startedAt.getTime())", "W3_MANUAL", sessions, sessionSuite],
  ["manual flagged late", 'flags: ["late_entry"]', "flags: []", "W3_MANUAL", sessions, sessionSuite],
  ["day decides pending only", 'const pending = sessions.filter((s) => s.status === "pending");', "const pending = sessions;", "W4_DAY", decisions, decisionSuite],
  ["decision scope", "if (!s || s.deletedAt !== null || !(await scope.covers(actorId, s.orgId, s.storeId)))\n                    return { kind: \"refused\", code: \"session_not_found\", index };", "if (!s || s.deletedAt !== null)\n                    return { kind: \"refused\", code: \"session_not_found\", index };", "W4_SCOPE", decisions, decisionSuite],
  ["manager stays in own store", "if (actor.managed.has(storeId))", "if (actor.managed.size > 0)", "W4_SCOPE", decisions, decisionSuite],
  ["open session not decided", 'if (s.endedAt === null)\n                    return { kind: "refused", code: "session_open", index };', "", "W4_BULK", decisions, decisionSuite],
  ["rating range", "value < 1 || value > 5", "value < 1 || value > 6", "W4_PARSE", decisions, decisionSuite],
  ["re-decision withdraws the earlier notice", 'if (s.status !== "pending" && s.decisionId !== null)\n                    await tx.notify(undoneNotice(s, s.decisionId));', "", "W4_NOTIFY", decisions, decisionSuite],
  ["appeal own session only", "if (!s || s.personId !== personId || s.deletedAt !== null)", "if (!s || s.deletedAt !== null)", "W6_RAISE", appeals, appealSuite],
  ["appeal on ended hours only", 'if (s.endedAt === null)\n                return { kind: "refused", code: "session_open" };\n            if (await tx.isReplaced(s.id))', "if (await tx.isReplaced(s.id))", "W6_RAISE", appeals, appealSuite],
  ["appeal on hours in force only", "if (await tx.isReplaced(s.id))", "if (false)", "W6_RAISE", appeals, appealSuite],
  ["appeal on rejected hours only", 'if (s.status !== "rejected")', "if (false)", "W6_RAISE", appeals, appealSuite],
  ["one open appeal per session", "if (await tx.hasOpenAppeal(s.id))", "if (false)", "W6_RAISE", appeals, appealSuite],
  ["appeal answered by staff only", "if (!appeal || !(await scope.isStaff(actorId, appeal.orgId)))", "if (!appeal)", "W6_STAFF", appeals, appealSuite],
  ["correction by staff only", "!(await scope.isStaff(actorId, original.orgId))", "false", "W6_CORRECT", appeals, appealSuite],
  ["replaced session not corrected twice", "if (await tx.isReplaced(original.id))", "if (false)", "W6_CORRECT", appeals, appealSuite],
  ["correction replaces, added time doesn't", 'source: correctsSessionId ? "correction" : "manual"', 'source: "correction"', "W6_ADD", appeals, appealSuite],
  ["self-scoped grant stays out of sub-companies", 'return covering.length > 0 ? "self" : "none";', 'return covering.length > 0 ? "subtree" : "none";', "W5_VIEWS", common, decisionSuite],
  ["legacy times are Kuwait", "+03:00`", "Z`", "LEGACY_TIME", legacy, legacySuite],
  ["legacy total_time is checked", "Number(row.total_time) !== seconds", "false", "LEGACY_HOUR", legacy, legacySuite],
  ["legacy day counts are counts", '["approved_count", n(row.total_approved), h.approvedCount]', '["approved_count", n(row.total_approved), h.approvedSeconds]', "LEGACY_RECONCILE", legacy, legacySuite],
  ["screens refuse cross-origin posts", 'if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") {', 'if (false) {', "WORK_PAGES", pages, pagesSuite],
  ["manual times are Kuwait time", ":00+03:00`", ":00Z`", "WORK_PAGES", pages, pagesSuite],
  ["screen script needs the nonce", "`; script-src 'nonce-${nonce}'`", "`; script-src 'unsafe-inline'`", "WORK_PAGES", pages, pagesSuite],
  ["someone else's appeal gets the staff view, not the person's", "if (detail.appeal.personId !== person) {", "if (false) {", "WORK_PAGES", pages, pagesSuite],
  ["review posts return to their own screen", "if (value === place.base || value.startsWith(`${place.base}?`))", "if (true)", "WORK_REVIEW", review, reviewSuite],
  ["review refuses cross-origin posts", 'return true;\n        }\n        if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") {', 'return true;\n        }\n        if (false) {', "WORK_REVIEW", review, reviewSuite],
  ["staff removal refuses cross-origin posts", 'return;\n    }\n    if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") {', 'return;\n    }\n    if (false) {', "WORK_REVIEW staff remove closed hours", review, reviewSuite],
  ["open hours can't be selected", 'const box = open ? "" :', 'const box = false ? "" :', "WORK_REVIEW", review, reviewSuite],
  ["only staff correct hours from the logs", "const correct = staff && !open ?", "const correct = !open ?", "WORK_REVIEW", review, reviewSuite],
  ["staff screens refuse cross-origin posts", 'if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") {', 'if (false) {', "WORK_STAFF", staffPages, staffSuite],
  ["staff placement input is checked", "result = input ? await services.placements.place(actor, input)", "result = true ? await services.placements.place(actor, input)", "WORK_STAFF", staffPages, staffSuite],
  ["the appeal form's lookup is one session, not the day's first", "{ personId, sessionIds: [sessionId.toLowerCase()], ", "{ personId, ", "W5_VIEWS", views, decisionSuite],
  ["the correction form's lookup is one session, not the day's first", "{ sessionIds: [sessionId.toLowerCase()], ", "{ ", "W5_VIEWS", views, decisionSuite],
  ["staff correction times are Kuwait time", "const local = new Date(new Date(iso).getTime() + 3 * 3600_000)", "const local = new Date(new Date(iso).getTime())", "WORK_STAFF", staffPages, staffSuite],
  ["a manager lists their own store's requests", "storeIds = storeId === undefined ? managed : managed.filter((s) => s === storeId);", "storeIds = storeId === undefined ? undefined : [storeId];", "W1_REQUEST_LIST", placement, placementSuite],
  ["a manager's store is in the request's company", "m.storeId === store.id && m.orgId === store.orgId", "m.storeId === store.id", "W1_REQUEST_LIST", placement, placementSuite],
  ["correction links its own company's appeal", "appeal.personId !== original.personId || appeal.orgId !== original.orgId", "appeal.personId !== original.personId", "W6_CORRECT", appeals, appealSuite],
  ["a day named twice is decided once", "[`${k.personId}|${k.storeId}|${k.workDate}`, k]", "[Math.random(), k]", "W4_DAY", decisions, decisionSuite],
  ["the shared scope keeps no grants", "this.#cache = options.perOperation === true ? new Map() : undefined;", "this.#cache = new Map();", "W5_VIEWS", decisions, decisionSuite],
  ["stale stop refused", 'if (open.id !== sessionId.toLowerCase())\n                return { kind: "refused", code: "session_changed" };\n            const now', "const now", "W3_CLOCK", sessions, sessionSuite],
  ["stale discard refused", 'if (open.id !== sessionId.toLowerCase())\n                return { kind: "refused", code: "session_changed" };\n            await tx.softDelete', "await tx.softDelete", "W3_CLOCK", sessions, sessionSuite],
  ["end date never before recorded hours", "if (shortening && (await tx.sessionsAfter(current.id, endDate)) > 0)", "if (false)", "W1_END", placement, placementSuite],
  ["reopening keeps one open appeal", "if (await tx.hasOpenAppeal(appeal.sessionId, appeal.id))", "if (false)", "W6_RAISE", appeals, appealSuite],
  ["days lock in one order", ".sort((x, y) => dayLockKey(x.key) < dayLockKey(y.key) ? -1 : dayLockKey(x.key) > dayLockKey(y.key) ? 1 : 0)", ".sort(() => 0)", "W4_DAY", decisions, decisionSuite],
  ["ancestry read on the transaction client", "scopeFor((orgId) => tx.organizationAncestors(orgId))", "scopeFor((orgId) => this.#store.organizationAncestors(orgId))", "W4_DAY", decisions, decisionSuite],
  ["correction lookup is staff only", "if (!isIsoDate(date) || !isUuid(sessionId) || !(await this.#scope.isOperatorStaff(actorId)))", "if (!isIsoDate(date) || !isUuid(sessionId))", "W5_VIEWS", views, decisionSuite],
  ["an entry page needs the store in the actor's scope", "if (!(await this.#scope.covers(actorId, orgId, store)))", "if (false)", "W5_VIEWS", views, decisionSuite],
  ["an entry page reads that store only", "storeIds: [store], sessionIds: [sessionId.toLowerCase()],", "sessionIds: [sessionId.toLowerCase()],", "W5_VIEWS", views, decisionSuite],
  ["a decision goes back only to an entry on this store's page", "return back.startsWith(`${place.base}/${id}?`) && url.pathname", "return url.pathname", "WORK_REVIEW M-03 entry page: a decision goes back", review, reviewSuite],
  ["only staff over the company remove hours", "if (!session || !(await scope.isStaff(actorId, session.orgId)))\n                return { kind: \"refused\", code: \"session_not_found\" };\n            if (session.deletedAt !== null)\n                return { kind: \"refused\", code: \"already_deleted\" };", "if (!session)\n                return { kind: \"refused\", code: \"session_not_found\" };\n            if (session.deletedAt !== null)\n                return { kind: \"refused\", code: \"already_deleted\" };", "W6_REMOVE staff remove", appeals, appealSuite],
  ["a corrected session can't be removed", "if (await tx.isReplaced(session.id))", "if (false)", "W6_REMOVE a corrected session", appeals, appealSuite],
  ["a stale correction stays out", "if (session.correctsSessionId !== null && (await tx.isReplaced(session.correctsSessionId)))", "if (false)", "W6_REMOVE a corrected session", appeals, appealSuite],
  ["removal is on the staff logs only", "const remove = staff && !open ?", "const remove = !open ?", "WORK_REVIEW staff remove closed hours", review, reviewSuite],
  ["private note hidden", "note: d.notePublic ? d.note : null", "note: d.note", "W5_PRIVATE", views, decisionSuite],
  ["stable paging cursor", "next: sessions.length > filter.limit && last ? { workDate: last.workDate, id: last.id } : null", "next: null", "W5_PAGING", views, decisionSuite],
];

const root = new URL("../../../", import.meta.url);
// Every suite must pass unmutated first, or a failing suite would count as kills.
{
  const dir = await mkdtemp(new URL("./node_modules/.work-mutation-", root).pathname);
  try {
    await cp(new URL("./dist/", root), dir, { recursive: true });
    await writeFile(join(dir, "package.json"), '{"type":"module"}');
    for (const suite of new Set(mutations.map((m) => m[5]))) {
      const run = spawnSync(process.execPath, ["--test", suite], { cwd: dir, encoding: "utf8", timeout: 30000 });
      assert.equal(run.status, 0, `${suite} fails before any mutation:\n${run.stdout}${run.stderr}`);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
let killed = 0;
for (const [name, from, to, token, file, suite] of mutations) {
  const dir = await mkdtemp(new URL("./node_modules/.work-mutation-", root).pathname);
  try {
    await cp(new URL("./dist/", root), dir, { recursive: true });
    await writeFile(join(dir, "package.json"), '{"type":"module"}');
    const target = join(dir, file), source = await readFile(target, "utf8");
    assert.equal(source.split(from).length - 1, 1, `${name} binds once`);
    await writeFile(target, source.replace(from, to));
    const run = spawnSync(process.execPath, ["--test", suite], { cwd: dir, encoding: "utf8", timeout: 30000 });
    assert.equal(run.error, undefined, `${name}: ${run.error}`);
    assert.notEqual(run.status, 0, `${name} survived`);
    assert.match(run.stdout + run.stderr, new RegExp(`not ok \\d+ - ${token}`), `${name} killed by ${token}`);
    killed++;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
process.stdout.write(`${killed}/${mutations.length} work lane mutations killed\n`);
