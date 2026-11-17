// Each mutant breaks one work-lane rule; the named test must fail.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

const placement = "packages/work/src/placement.js", sessions = "packages/work/src/sessions.js", common = "packages/work/src/common.js";
const placementSuite = "packages/work/test/placement.test.js", sessionSuite = "packages/work/test/sessions.test.js";
const decisions = "packages/work/src/decisions.js", views = "packages/work/src/views.js", decisionSuite = "packages/work/test/decisions.test.js";
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
  ["private note hidden", "note: d.notePublic ? d.note : null", "note: d.note", "W5_PRIVATE", views, decisionSuite],
  ["stable paging cursor", "next: sessions.length > filter.limit && last ? { workDate: last.workDate, id: last.id } : null", "next: null", "W5_PAGING", views, decisionSuite],
];

const root = new URL("../../../", import.meta.url);
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
