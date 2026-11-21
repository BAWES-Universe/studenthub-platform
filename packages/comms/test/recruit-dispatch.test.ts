import assert from "node:assert/strict";
import { test } from "node:test";
import { RECRUIT_DISPATCH_BATCH, dispatchRecruitThenDeliver } from "../src/recruit-dispatch.js";

test("COMMS_RECRUIT_DISPATCH dispatches one batch at the run's time, then delivers, and returns what delivery sent", async () => {
  const calls: string[] = [], at = new Date("2026-11-20T08:00:00Z");
  const sent = await dispatchRecruitThenDeliver(
    { async dispatch(limit, when) { calls.push(`dispatch ${limit} ${when.toISOString()}`); return 3; } },
    async () => { calls.push("deliver"); return 5; }, () => at);
  assert.equal(sent, 5);
  assert.deepEqual(calls, [`dispatch ${RECRUIT_DISPATCH_BATCH} ${at.toISOString()}`, "deliver"]);
});

test("COMMS_RECRUIT_DISPATCH a failed dispatch still lets delivery run, then the original dispatch error is reported", async () => {
  const boom = new Error("dispatch failed"), calls: string[] = [];
  await assert.rejects(dispatchRecruitThenDeliver(
    { async dispatch() { calls.push("dispatch"); throw boom; } },
    async () => { calls.push("deliver"); return 4; }), (error) => error === boom);
  assert.deepEqual(calls, ["dispatch", "deliver"], "delivery ran after the failed dispatch");
});

test("COMMS_RECRUIT_DISPATCH a delivery failure is reported as itself, after a successful dispatch", async () => {
  const deliveryError = new Error("delivery failed");
  await assert.rejects(dispatchRecruitThenDeliver({ async dispatch() { return 1; } }, async () => { throw deliveryError; }), (error) => error === deliveryError);
});
