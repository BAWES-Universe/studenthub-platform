import assert from "node:assert/strict";
import test from "node:test";
import { OperationsService, type OperationsSources } from "../src/index.js";

const TOTALS = { placements: 1, requests: 2, suggestions: 3, notes: 4, invitations: 5, invitationsAccepted: 1, invitationsDeclined: 0 };
function rig(over: Partial<OperationsSources> = {}) {
  const calls: string[] = [];
  const sources: OperationsSources = {
    async summary(viewer) { calls.push(`summary ${viewer}`); return { day: "2026-11-23", rows: [{ key: "activeRequests", label: "Active requests", value: 4, waitsOn: null }] }; },
    async team(viewer, day) { calls.push(`team ${viewer} ${day}`); return { totals: TOTALS, staff: ["a", "b"] }; },
    async isOperatorAdmin(viewer) { return viewer === "boss"; },
    ...over,
  };
  return { service: new OperationsService(sources, { isStaff: async id => id === "staff" || id === "boss" }), calls };
}

test("REPORTS_OPERATIONS staff get today's attention counters and the team's totals for the summary's day", async () => {
  const x = rig();
  assert.deepEqual(await x.service.page("staff"), { day: "2026-11-23", attention: [{ key: "activeRequests", label: "Active requests", value: 4, waitsOn: null }], team: { staff: 2, totals: TOTALS }, operatorAdmin: false });
  assert.deepEqual(x.calls, ["summary staff", "team staff 2026-11-23"], "the team's day is the summary's");
  assert.equal((await x.service.page("boss"))!.operatorAdmin, true, "the work lane's operator admin check, passed through");
});

test("REPORTS_OPERATIONS anyone else gets nothing, and nothing is read", async () => {
  const x = rig();
  assert.equal(await x.service.page("alia"), undefined);
  assert.deepEqual(x.calls, []);
});

test("REPORTS_OPERATIONS a source that does not answer for the viewer gives nothing; a refused day is an error", async () => {
  assert.equal(await rig({ async summary() { return undefined; } }).service.page("staff"), undefined);
  assert.equal(await rig({ async team() { return undefined; } }).service.page("staff"), undefined);
  await assert.rejects(rig({ async team() { return { refused: "to" }; } }).service.page("staff"), /refused/);
});
