import assert from "node:assert/strict";
import test from "node:test";
import { EMAIL_CLASSES, EMAIL_TEMPLATES, EMAIL_VOLUME_THRESHOLD, EmailOutboxService, FakeEmailPort, checkEmailVolume, deliverAndCheckVolume, kuwaitDay, validateTemplateParameters, volumeLevel,
  type ClaimedEmail, type EmailFailureCode, type EmailOutboxStore, type EmailVolumeCrossing, type EmailVolumeStore } from "../src/index.js";

test("COMMS_EMAIL_CLASSES the class table says which classes are transactional", () => {
  assert.deepEqual([...EMAIL_CLASSES], ["account.notice", "civil_id.result"]);
  assert.deepEqual(EMAIL_CLASSES.map(c => [c, EMAIL_TEMPLATES[c].required]), [["account.notice", false], ["civil_id.result", true]]);
});

test("COMMS_EMAIL_CIVIL_ID_RESULT parameters are closed and follow the staff decision rule", () => {
  assert.deepEqual(validateTemplateParameters("civil_id.result", { decision: "confirmed" }), { decision: "confirmed" });
  assert.deepEqual(validateTemplateParameters("civil_id.result", { decision: "rejected", reason: "Photo is blurred" }), { decision: "rejected", reason: "Photo is blurred" });
  for (const bad of [{ decision: "confirmed", reason: "x" }, { decision: "rejected" }, { decision: "rejected", reason: "" }, { decision: "rejected", reason: "a".repeat(301) },
    { decision: "rejected", reason: "line\nbreak" }, { decision: "approved" }, { decision: "rejected", reason: 5 }, null, [], "confirmed"])
    assert.throws(() => validateTemplateParameters("civil_id.result", bad), /closed/, JSON.stringify(bad));
  assert.deepEqual(validateTemplateParameters("civil_id.result", { decision: "rejected", reason: "😀".repeat(300) }), { decision: "rejected", reason: "😀".repeat(300) });
  assert.throws(() => validateTemplateParameters("account.notice", { decision: "confirmed" }), /closed/);
});

test("COMMS_EMAIL_CIVIL_ID_RESULT the email says the outcome, and a rejection says why and what to do", () => {
  const ok = EMAIL_TEMPLATES["civil_id.result"].render({ decision: "confirmed" });
  assert.equal(ok.subject, "Your civil ID is confirmed");
  const no = EMAIL_TEMPLATES["civil_id.result"].render({ decision: "rejected", reason: "The back is missing" });
  assert.equal(no.subject, "We could not confirm your civil ID");
  assert.match(no.body, /Reason: The back is missing/);
  assert.match(no.body, /Upload new photos/);
});

class OneRowStore implements EmailOutboxStore {
  completed: { outcome: string; code: EmailFailureCode | null }[] = [];
  constructor(private rows: ClaimedEmail[]) {}
  async claim() { return this.rows.splice(0); }
  async complete(_id: string, _c: string, _a: number, outcome: "sent" | "failed" | "not_sent" | "suppressed", code: EmailFailureCode | null) { this.completed.push({ outcome, code }); }
}

test("COMMS_EMAIL_CIVIL_ID_RESULT a transactional email is sent even when the stored preference is off", async () => {
  const store = new OneRowStore([{ id: "m", emailClass: "civil_id.result", recipientPrincipalId: "p", parameters: { decision: "confirmed" }, attempt: 1, preferenceEnabled: false, address: "p@example.invalid" }]);
  const port = new FakeEmailPort();
  await new EmailOutboxService(store, port, true, true).processDue();
  assert.deepEqual(store.completed, [{ outcome: "sent", code: null }]);
  assert.equal(port.sent[0]?.subject, "Your civil ID is confirmed");
  const optional = new OneRowStore([{ id: "n", emailClass: "account.notice", recipientPrincipalId: "p", parameters: { heading: "H", message: "M" }, attempt: 1, preferenceEnabled: false, address: "p@example.invalid" }]);
  await new EmailOutboxService(optional, port, true, true).processDue();
  assert.deepEqual(optional.completed, [{ outcome: "suppressed", code: null }]);
});

test("COMMS_EMAIL_VOLUME levels follow legacy's raised threshold: past 500, past 1000, past 1500", () => {
  assert.equal(EMAIL_VOLUME_THRESHOLD, 500);
  assert.deepEqual([0, 1, 500, 501, 1000, 1001, 1500, 1501].map(n => volumeLevel(n, 500)), [0, 0, 0, 1, 1, 2, 2, 3]);
  assert.throws(() => volumeLevel(1, 0), RangeError);
  assert.throws(() => volumeLevel(1, 1.5), RangeError);
});

test("COMMS_EMAIL_VOLUME the day is the Kuwait calendar day", () => {
  assert.equal(kuwaitDay(new Date("2026-11-18T20:59:59Z")), "2026-11-18");
  assert.equal(kuwaitDay(new Date("2026-11-18T21:00:00Z")), "2026-11-19");
});

class MemoryVolume implements EmailVolumeStore {
  sent = new Map<string, number>(); recorded = new Set<string>(); calls: string[] = [];
  async recordVolumeCrossing(day: string, threshold: number): Promise<EmailVolumeCrossing | null> {
    this.calls.push(day);
    const n = this.sent.get(day) ?? 0, level = volumeLevel(n, threshold);
    if (!level || this.recorded.has(`${day}:${level}`)) return null;
    this.recorded.add(`${day}:${level}`);
    return { day, level, sentCount: n, threshold };
  }
}

test("COMMS_EMAIL_VOLUME each level alerts once a day and a new day starts again (legacy's date check assigned instead of comparing)", async () => {
  const store = new MemoryVolume(), alerts: EmailVolumeCrossing[] = [];
  const day1 = new Date("2026-11-18T09:00:00Z"), day2 = new Date("2026-11-19T09:00:00Z");
  const run = async (at: Date) => { await deliverAndCheckVolume(async () => 0, store, c => { alerts.push(c); }, () => at); };
  store.sent.set("2026-11-18", 501); await run(day1); await run(day1);
  store.sent.set("2026-11-18", 1001); await run(day1);
  store.sent.set("2026-11-19", 501); await run(day2);
  assert.deepEqual(alerts.map(a => [a.day, a.level]), [["2026-11-18", 1], ["2026-11-18", 2], ["2026-11-19", 1]]);
  assert.equal(await checkEmailVolume(store, day2), null);
  await assert.rejects(checkEmailVolume(store, day2, 0), RangeError);
});

test("COMMS_EMAIL_VOLUME a failed delivery run still checks the volume, then reports its own failure", async () => {
  const store = new MemoryVolume(), alerts: EmailVolumeCrossing[] = [], at = new Date("2026-11-18T09:00:00Z");
  store.sent.set("2026-11-18", 600);
  await assert.rejects(deliverAndCheckVolume(async () => { throw Error("email delivery failed"); }, store, c => { alerts.push(c); }, () => at), /email delivery failed/);
  assert.equal(alerts.length, 1);
  const broken: EmailVolumeStore = { async recordVolumeCrossing() { throw Error("count failed"); } };
  await assert.rejects(deliverAndCheckVolume(async () => { throw Error("email delivery failed"); }, broken, () => {}, () => at), /email delivery failed/);
  await assert.rejects(deliverAndCheckVolume(async () => 3, broken, () => {}, () => at), /count failed/);
  assert.equal(await deliverAndCheckVolume(async () => 3, new MemoryVolume(), () => {}, () => at), 3);
});
