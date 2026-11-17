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
const mutations = [
  ["staff-only placement", "store.ancestors))\n            return { kind: \"refused\", code: \"forbidden\" };\n        return this.#store.transaction((tx) => this.#place(tx, actorId, input, store, STAFF_ORIGIN));", "store.ancestors))\n            ;\n        return this.#store.transaction((tx) => this.#place(tx, actorId, input, store, STAFF_ORIGIN));", "W1_PLACE", placement, placementSuite],
  ["civil ID inclusive", "civilId.expiry < startDate", "civilId.expiry <= startDate", "W1_WARN", placement, placementSuite],
  ["ambiguous contract", "if (matches.length > 1)\n", "if (matches.length > 9)\n", "W1_CONTRACT", placement, placementSuite],
  ["open session blocks ending", "ending && (await tx.openSessionCount(current.id)) > 0", "false", "W1_END", placement, placementSuite],
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
  ["appeal answered by staff only", "if (!appeal || !(await this.#scope.isStaff(actorId, appeal.orgId)))", "if (!appeal)", "W6_STAFF", appeals, appealSuite],
  ["correction by staff only", "!(await this.#scope.isStaff(actorId, original.orgId))", "false", "W6_CORRECT", appeals, appealSuite],
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
  ["review posts return to their own screen", "(value === place.base || value.startsWith(`${place.base}?`))", "true", "WORK_REVIEW", review, reviewSuite],
  ["review refuses cross-origin posts", 'if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") {', 'if (false) {', "WORK_REVIEW", review, reviewSuite],
  ["open hours can't be selected", 'const box = open ? "" :', 'const box = false ? "" :', "WORK_REVIEW", review, reviewSuite],
  ["only staff correct hours from the logs", "const correct = staff && !open ?", "const correct = !open ?", "WORK_REVIEW", review, reviewSuite],
  ["staff screens refuse cross-origin posts", 'if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") {', 'if (false) {', "WORK_STAFF", staffPages, staffSuite],
  ["staff placement input is checked", "result = input ? await services.placements.place(actor, input)", "result = true ? await services.placements.place(actor, input)", "WORK_STAFF", staffPages, staffSuite],
  ["staff correction times are Kuwait time", "const localValue = (iso) => new Date(new Date(iso).getTime() + 3 * 3600_000)", "const localValue = (iso) => new Date(new Date(iso).getTime())", "WORK_STAFF", staffPages, staffSuite],
  ["a manager lists their own store's requests", "(stores === null || (r.orgId === orgId && stores.has(r.storeId)))", "true", "W1_REQUEST_LIST", placement, placementSuite],
  ["a manager's store is in the request's company", "m.storeId === store.id && m.orgId === store.orgId", "m.storeId === store.id", "W1_REQUEST_LIST", placement, placementSuite],
  ["correction links its own company's appeal", "appeal.personId !== original.personId || appeal.orgId !== original.orgId", "appeal.personId !== original.personId", "W6_CORRECT", appeals, appealSuite],
  ["a day named twice is decided once", "[`${k.personId}|${k.storeId}|${k.workDate}`, k]", "[Math.random(), k]", "W4_DAY", decisions, decisionSuite],
  ["the shared scope keeps no grants", "this.#cache = options.perOperation === true ? new Map() : undefined;", "this.#cache = new Map();", "W5_VIEWS", decisions, decisionSuite],
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
