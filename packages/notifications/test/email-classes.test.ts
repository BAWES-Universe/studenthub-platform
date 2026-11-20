import assert from "node:assert/strict";
import test from "node:test";
import { EMAIL_CLASSES, EMAIL_TEMPLATES, EMAIL_VOLUME_THRESHOLD, EmailOutboxService, FakeEmailPort, checkEmailVolume, deliverAndCheckVolume, kuwaitDay, validateTemplateParameters, volumeLevel,
  type ClaimedEmail, type EmailFailureCode, type EmailOutboxStore, type EmailVolumeCrossing, type EmailVolumeStore } from "../src/index.js";

test("COMMS_EMAIL_CLASSES the class table says which classes are transactional", () => {
  assert.deepEqual([...EMAIL_CLASSES], ["account.notice", "civil_id.result", "staff.morning_summary", "staff.firing_spike"]);
  assert.deepEqual(EMAIL_CLASSES.map(c => [c, EMAIL_TEMPLATES[c].required]), [["account.notice", false], ["civil_id.result", true], ["staff.morning_summary", false], ["staff.firing_spike", false]]);
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
  sent = new Map<string, number>(); recorded = new Map<string, EmailVolumeCrossing>(); alerted = new Set<string>(); calls: string[] = [];
  async recordVolumeCrossings(day: string, threshold: number): Promise<EmailVolumeCrossing[]> {
    this.calls.push(day);
    const n = this.sent.get(day) ?? 0;
    for (let level = 1; level <= volumeLevel(n, threshold); level++) if (!this.recorded.has(`${day}:${level}`)) this.recorded.set(`${day}:${level}`, { day, level, sentCount: n, threshold });
    return [...this.recorded.entries()].filter(([k, c]) => c.day === day && !this.alerted.has(k)).map(([, c]) => c).sort((a, b) => a.level - b.level);
  }
  async markVolumeAlerted(day: string, level: number) { this.alerted.add(`${day}:${level}`); }
}

test("COMMS_EMAIL_VOLUME each level alerts once a day and a new day starts again (legacy's date check assigned instead of comparing)", async () => {
  const store = new MemoryVolume(), alerts: EmailVolumeCrossing[] = [];
  const day1 = new Date("2026-11-18T09:00:00Z"), day2 = new Date("2026-11-19T09:00:00Z");
  const run = async (at: Date) => { await deliverAndCheckVolume(async () => 0, store, c => { alerts.push(c); }, () => at); };
  store.sent.set("2026-11-18", 501); await run(day1); await run(day1);
  store.sent.set("2026-11-18", 1001); await run(day1);
  store.sent.set("2026-11-19", 501); await run(day2);
  assert.deepEqual(alerts.map(a => [a.day, a.level]), [["2026-11-18", 1], ["2026-11-18", 2], ["2026-11-19", 1]]);
  assert.deepEqual(await checkEmailVolume(store, day2), []);
  // One run that jumps from level 1 to past 1500 alerts for 2 and 3, lowest first.
  store.sent.set("2026-11-19", 1501); await run(day2);
  assert.deepEqual(alerts.slice(3).map(a => [a.day, a.level]), [["2026-11-19", 2], ["2026-11-19", 3]]);
  await assert.rejects(checkEmailVolume(store, day2, 0), RangeError);
});

test("COMMS_EMAIL_VOLUME a failed delivery run still checks the volume, then reports its own failure", async () => {
  const store = new MemoryVolume(), alerts: EmailVolumeCrossing[] = [], at = new Date("2026-11-18T09:00:00Z");
  store.sent.set("2026-11-18", 600);
  await assert.rejects(deliverAndCheckVolume(async () => { throw Error("email delivery failed"); }, store, c => { alerts.push(c); }, () => at), /email delivery failed/);
  assert.equal(alerts.length, 1);
  const broken: EmailVolumeStore = { async recordVolumeCrossings() { throw Error("count failed"); }, async markVolumeAlerted() {} };
  await assert.rejects(deliverAndCheckVolume(async () => { throw Error("email delivery failed"); }, broken, () => {}, () => at), /email delivery failed/);
  await assert.rejects(deliverAndCheckVolume(async () => 3, broken, () => {}, () => at), /count failed/);
  assert.equal(await deliverAndCheckVolume(async () => 3, new MemoryVolume(), () => {}, () => at), 3);
});

test("COMMS_EMAIL_VOLUME a run that crosses Kuwait midnight checks the day its sends are stamped with", async () => {
  const store = new MemoryVolume(), alerts: EmailVolumeCrossing[] = [];
  const times = [new Date("2026-11-18T20:59:59Z"), new Date("2026-11-18T21:00:05Z")];
  store.sent.set("2026-11-18", 501);
  await deliverAndCheckVolume(async () => 0, store, c => { alerts.push(c); }, () => times.length > 1 ? times.shift()! : times[0]!);
  assert.deepEqual(alerts.map(a => [a.day, a.level]), [["2026-11-18", 1]]);
  assert.deepEqual(store.calls, ["2026-11-18", "2026-11-19"]);
});

test("COMMS_EMAIL_VOLUME a level whose alert fails stays due and is raised by the next run, then never again", async () => {
  const store = new MemoryVolume(), alerts: number[] = [], at = new Date("2026-11-18T09:00:00Z");
  store.sent.set("2026-11-18", 1001);
  let fail = true;
  await assert.rejects(deliverAndCheckVolume(async () => 0, store, c => { if (fail && c.level === 2) throw Error("alert sink down"); alerts.push(c.level); }, () => at), /alert sink down/);
  assert.deepEqual(alerts, [1]);
  fail = false;
  await deliverAndCheckVolume(async () => 0, store, c => { alerts.push(c.level); }, () => at);
  await deliverAndCheckVolume(async () => 0, store, c => { alerts.push(c.level); }, () => at);
  assert.deepEqual(alerts, [1, 2]);
});

test("COMMS_EMAIL_CLASSES the firing spike email takes a closed shape whose level matches its counts", () => {
  const ok = { company: "Acme", month: "2026-11", level: "danger" as "warning" | "danger", total: 3, twelveMonthTotal: 12 };
  assert.deepEqual(validateTemplateParameters("staff.firing_spike", ok), ok);
  assert.doesNotThrow(() => validateTemplateParameters("staff.firing_spike", { ...ok, level: "warning", total: 2 }));
  for (const bad of [{ ...ok, level: "warning" }, { ...ok, total: 1 }, { ...ok, total: 0, twelveMonthTotal: 0 }, { ...ok, twelveMonthTotal: 2 }, { ...ok, month: "2026-13" },
    { ...ok, company: "" }, { ...ok, company: "x".repeat(201) }, { ...ok, company: "A\nB" }, { ...ok, extra: 1 }, { ...ok, total: 2.5 }])
    assert.throws(() => validateTemplateParameters("staff.firing_spike", bad), TypeError, JSON.stringify(bad));
  const mail = EMAIL_TEMPLATES["staff.firing_spike"].render(ok);
  assert.equal(mail.subject, "Firing spike for Acme");
  assert.match(mail.body, /^Acme: 3 placements ended in November 2026 so far, more than twice its 12-month average of 1 a month\./);
  assert.match(EMAIL_TEMPLATES["staff.firing_spike"].render({ ...ok, level: "warning", total: 1, twelveMonthTotal: 7 }).body, /1 placement ended .* more than its 12-month average of 0\.58 a month/);
});
