import assert from "node:assert/strict";
import { test } from "node:test";
import { dueReminderKinds, kuwaitMinute, queuePersonRemindersThenDeliver, type PersonReminderKind } from "../src/person-reminders.js";

test("COMMS_PERSON_REMINDERS schedule: from 13:30 Kuwait time; the expiring and missing bank details reminders only on the 15th and 28th", () => {
  assert.equal(kuwaitMinute(new Date("2031-05-15T10:30:00Z")), 13 * 60 + 30);
  assert.deepEqual(dueReminderKinds(new Date("2031-05-15T10:29:59Z")), { day: "2031-05-15", kinds: [] });
  assert.deepEqual(dueReminderKinds(new Date("2031-05-15T10:30:00Z")), { day: "2031-05-15", kinds: ["birthday", "civil_id_expired", "civil_id_expiring", "bank_details_missing"] });
  assert.deepEqual(dueReminderKinds(new Date("2031-05-28T20:59:00Z")), { day: "2031-05-28", kinds: ["birthday", "civil_id_expired", "civil_id_expiring", "bank_details_missing"] });
  assert.deepEqual(dueReminderKinds(new Date("2031-05-16T12:00:00Z")), { day: "2031-05-16", kinds: ["birthday", "civil_id_expired"] });
  // 21:00 UTC on the 14th is already the 15th in Kuwait, but before 13:30 there.
  assert.deepEqual(dueReminderKinds(new Date("2031-05-14T21:00:00Z")), { day: "2031-05-15", kinds: [] });
});

test("COMMS_PERSON_REMINDERS a failed kind does not stop the others or delivery; the first error is reported after", async () => {
  const calls: string[] = [], boom = new Error("birthday failed");
  const port = { async sendDay(kind: PersonReminderKind, day: string) { calls.push(`${kind} ${day}`); if (kind === "birthday") throw boom; if (kind === "civil_id_expired") throw new Error("second"); return 1; } };
  await assert.rejects(queuePersonRemindersThenDeliver(port, async () => { calls.push("deliver"); return 2; }, () => new Date("2031-05-15T11:00:00Z")), (e) => e === boom);
  assert.deepEqual(calls, ["birthday 2031-05-15", "civil_id_expired 2031-05-15", "civil_id_expiring 2031-05-15", "bank_details_missing 2031-05-15", "deliver"]);
  calls.length = 0;
  assert.equal(await queuePersonRemindersThenDeliver({ async sendDay(kind) { calls.push(kind); return null; } }, async () => 7, () => new Date("2031-05-16T11:00:00Z")), 7);
  assert.deepEqual(calls, ["birthday", "civil_id_expired"]);
});
