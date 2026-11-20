import assert from "node:assert/strict";
import { test } from "node:test";
import { StandupService, STANDUP_ANSWER_PAGE_SIZE, type StandupAnswer, type StandupStore, type WorkGrant } from "../src/index.js";

const Q1 = "aaaaaaaa-0000-4000-8000-000000000001", Q2 = "aaaaaaaa-0000-4000-8000-000000000002";

class Memory implements StandupStore {
  questionsAll: { id: string; question: string; createdAt: string; retired: boolean }[] = [];
  answersAll: StandupAnswer[] = [];
  staff = ["admin", "staff", "staff-2"];
  /** "staffId|date" of days with no session in progress; every other day is in progress. */
  closedDays = new Set<string>();
  async questions() { return this.questionsAll.filter((q) => !q.retired).map(({ retired: _, ...q }) => q); }
  async insertQuestion(q: { id: string; question: string; createdBy: string }) {
    const row = { id: q.id, question: q.question, createdAt: `2026-11-18T05:00:0${this.questionsAll.length}.000Z`, retired: false };
    this.questionsAll.push(row);
    return { id: row.id, question: row.question, createdAt: row.createdAt };
  }
  async editQuestion(id: string, question: string) {
    const q = this.questionsAll.find((x) => x.id === id && !x.retired);
    if (!q) return undefined;
    q.question = question;
    return { id: q.id, question: q.question, createdAt: q.createdAt };
  }
  async retireQuestion(id: string) {
    const q = this.questionsAll.find((x) => x.id === id && !x.retired);
    if (!q) return false;
    q.retired = true;
    return true;
  }
  async nextQuestion(staffId: string, workDate: string) {
    return (await this.questions()).find((q) => !this.answersAll.some((a) => a.questionId === q.id && a.staffId === staffId && a.workDate === workDate));
  }
  async insertAnswer(a: { id: string; staffId: string; questionId: string; answer: string; workDate: string }) {
    if (this.closedDays.has(`${a.staffId}|${a.workDate}`)) return "not_working" as const;
    const q = this.questionsAll.find((x) => x.id === a.questionId && !x.retired);
    if (!q) return "gone" as const;
    if (this.answersAll.some((x) => x.questionId === a.questionId && x.staffId === a.staffId && x.workDate === a.workDate)) return "exists" as const;
    if ((await this.nextQuestion(a.staffId, a.workDate))?.id !== a.questionId) return "out_of_order" as const;
    this.answersAll.push({ id: a.id, staffId: a.staffId, questionId: a.questionId, question: q.question, answer: a.answer, workDate: a.workDate, createdAt: `2026-11-18T06:00:00.${String(this.answersAll.length).padStart(3, "0")}Z` });
    return "inserted" as const;
  }
  async answers(f: { workDate: string; staffId?: string; after?: { staffId: string; createdAt: string; id: string }; limit: number }) {
    const key = (a: { staffId: string; createdAt: string; id: string }) => `${a.staffId}|${a.createdAt}|${a.id}`;
    return this.answersAll.filter((a) => a.workDate === f.workDate && (!f.staffId || a.staffId === f.staffId) && (!f.after || key(a) > key(f.after)))
      .sort((a, b) => key(a).localeCompare(key(b))).slice(0, f.limit);
  }
  async operatorStaff() { return this.staff; }
  async staffWithAnswerOn(date: string) { return new Set(this.answersAll.filter((a) => a.workDate === date).map((a) => a.staffId)); }
}

const GRANTS: Record<string, WorkGrant[]> = {
  admin: [{ orgId: "root", role: "admin", scope: "subtree" }],
  staff: [{ orgId: "root", role: "staff", scope: "subtree" }],
  "staff-2": [{ orgId: "root", role: "staff", scope: "subtree" }],
  owner: [{ orgId: "company", role: "org-owner", scope: "self" }],
};
function service(now: { value: Date }, store = new Memory()) {
  const ids = [Q1, Q2];
  let n = 0;
  return { store, svc: new StandupService({ store, grants: { listGrantsForPrincipal: async (id) => GRANTS[id] ?? [] }, newId: () => ids.shift() ?? `bbbbbbbb-0000-4000-8000-${String(++n).padStart(12, "0")}`, now: () => now.value }) };
}

test("STANDUP admins keep the questions; staff are asked them in order, once a Kuwait day each", async () => {
  // 21:30Z on the 17th is 00:30 on the 18th in Kuwait.
  const now = { value: new Date("2026-11-17T21:30:00Z") };
  const { store, svc } = service(now);
  assert.deepEqual(await svc.today("staff"), { kind: "today", workDate: "2026-11-18", next: null, answers: [] }, "no questions yet");
  const first = await svc.addQuestion("admin", "  What did you do yesterday?  ");
  assert.equal(first.kind === "question" && first.question.question, "What did you do yesterday?", "trimmed");
  await svc.addQuestion("admin", "What will you do today?");
  const asked = await svc.today("staff");
  assert.equal(asked.kind === "today" && asked.next?.id, Q1);
  assert.deepEqual(await svc.answer("staff", Q1.toUpperCase(), " Interviews "), { kind: "answered", workDate: "2026-11-18" });
  const next = await svc.today("staff");
  assert.equal(next.kind === "today" && next.next?.id, Q2);
  assert.deepEqual(next.kind === "today" && next.answers.map((a) => [a.question, a.answer]), [["What did you do yesterday?", "Interviews"]]);
  assert.deepEqual(await svc.answer("staff", Q1, "Again"), { kind: "refused", code: "already_answered" });
  // Someone else's answer isn't among theirs.
  assert.equal((await svc.answer("staff-2", Q1, "Calls")).kind, "answered");
  assert.deepEqual(((await svc.today("staff")) as { answers: readonly { answer: string }[] }).answers.map((a) => a.answer), ["Interviews"]);
  // The next day starts over.
  assert.equal(((await svc.today("staff-2")) as { next: { id: string } }).next.id, Q2);
  now.value = new Date("2026-11-18T21:30:00Z");
  assert.equal(((await svc.today("staff")) as { next: { id: string } }).next.id, Q1);
  assert.equal(store.answersAll.length, 2);
});

test("STANDUP a reworded question keeps the answered wording; a retired one is no longer asked and refuses answers", async () => {
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { store, svc } = service(now);
  await svc.addQuestion("admin", "Blockers?");
  await svc.addQuestion("admin", "Plans?");
  await svc.answer("staff", Q1, "None");
  assert.equal((await svc.editQuestion("admin", Q1, "Anything blocking you?")).kind, "question");
  assert.equal(store.answersAll[0]!.question, "Blockers?");
  assert.deepEqual(await svc.retireQuestion("admin", Q2), { kind: "retired" });
  assert.deepEqual(await svc.retireQuestion("admin", Q2), { kind: "refused", code: "not_found" });
  assert.deepEqual(await svc.editQuestion("admin", Q2, "Plans today?"), { kind: "refused", code: "not_found" });
  assert.deepEqual(await svc.answer("staff", Q2, "Ship it"), { kind: "refused", code: "not_found" });
  assert.equal(((await svc.today("staff")) as { next: unknown }).next, null);
  assert.deepEqual((await svc.questions("admin")), { kind: "questions", questions: [{ id: Q1, question: "Anything blocking you?", createdAt: "2026-11-18T05:00:00.000Z" }] });
});

test("STANDUP who may do what, and bad input never reaches the store", async () => {
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { store, svc } = service(now);
  await svc.addQuestion("admin", "Blockers?");
  for (const actor of ["owner", "stranger"]) {
    assert.deepEqual(await svc.today(actor), { kind: "refused", code: "forbidden" });
    assert.deepEqual(await svc.answer(actor, Q1, "x"), { kind: "refused", code: "forbidden" });
  }
  for (const actor of ["staff", "owner"]) {
    assert.deepEqual(await svc.questions(actor), { kind: "refused", code: "forbidden" });
    assert.deepEqual(await svc.addQuestion(actor, "Q"), { kind: "refused", code: "forbidden" });
    assert.deepEqual(await svc.editQuestion(actor, Q1, "Q"), { kind: "refused", code: "forbidden" });
    assert.deepEqual(await svc.retireQuestion(actor, Q1), { kind: "refused", code: "forbidden" });
    assert.deepEqual(await svc.answers(actor, "2026-11-18"), { kind: "refused", code: "forbidden" });
    assert.deepEqual(await svc.unanswered(actor, "2026-11-18"), { kind: "refused", code: "forbidden" });
  }
  for (const [q, a] of [[Q1, ""], [Q1, "   "], [Q1, "x".repeat(4001)], [Q1, "bell\u0007"], ["nope", "x"], [Q1, 5]] as const) assert.deepEqual(await svc.answer("staff", q, a), { kind: "refused", code: "invalid_input" }, `${q} ${String(a).slice(0, 5)}`);
  assert.equal((await svc.answer("staff", Q1, "x".repeat(4000))).kind, "answered");
  for (const q of ["", " ", "x".repeat(256), 7]) assert.deepEqual(await svc.addQuestion("admin", q), { kind: "refused", code: "invalid_input" });
  assert.deepEqual(await svc.editQuestion("admin", "nope", "Q"), { kind: "refused", code: "invalid_input" });
  assert.deepEqual(await svc.retireQuestion("admin", "nope"), { kind: "refused", code: "invalid_input" });
  assert.deepEqual(await svc.answers("admin", "2026-13-01"), { kind: "refused", code: "invalid_input" });
  assert.deepEqual(await svc.answers("admin", "2026-11-18", { staffId: "x".repeat(201) }), { kind: "refused", code: "invalid_input" });
  assert.deepEqual(await svc.answers("admin", "2026-11-18", { after: { staffId: "staff", createdAt: "soon", id: Q1 } }), { kind: "refused", code: "invalid_input" });
  assert.deepEqual(await svc.unanswered("admin", "18/11/2026"), { kind: "refused", code: "invalid_input" });
  assert.equal(store.questionsAll.length, 1);
});

test("STANDUP admins read the answers on a date page by page, and who answered nothing", async () => {
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const store = new Memory();
  const { svc } = service(now, store);
  await svc.addQuestion("admin", "Blockers?");
  for (let i = 0; i < STANDUP_ANSWER_PAGE_SIZE + 2; i++) store.answersAll.push({ id: `cccccccc-0000-4000-8000-${String(i).padStart(12, "0")}`, staffId: "staff", questionId: Q1, question: "Blockers?", answer: `a${i}`, workDate: "2026-11-18", createdAt: `2026-11-18T06:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}.000Z` });
  const first = await svc.answers("admin", "2026-11-18");
  assert.equal(first.kind === "answers" && first.answers.length, STANDUP_ANSWER_PAGE_SIZE);
  const next = first.kind === "answers" ? first.next : null;
  assert.ok(next);
  const second = await svc.answers("admin", "2026-11-18", { after: next });
  assert.deepEqual(second.kind === "answers" && [second.answers.map((a) => a.answer), second.next], [["a100", "a101"], null]);
  const one = await svc.answers("admin", "2026-11-18", { staffId: "staff-2" });
  assert.deepEqual(one.kind === "answers" && one.answers, []);
  assert.deepEqual(await svc.unanswered("admin", "2026-11-18"), { kind: "unanswered", workDate: "2026-11-18", staffIds: ["admin", "staff-2"] });
});

test("STANDUP an answer is refused when the day isn't in progress, or when it skips ahead of the next question", async () => {
  const now = { value: new Date("2026-11-18T06:00:00Z") };
  const { store, svc } = service(now);
  await svc.addQuestion("admin", "Blockers?");
  await svc.addQuestion("admin", "Plans?");
  store.closedDays.add("staff|2026-11-18");
  assert.deepEqual(await svc.answer("staff", Q1, "None"), { kind: "refused", code: "not_working" });
  store.closedDays.clear();
  assert.deepEqual(await svc.answer("staff", Q2, "Ship it"), { kind: "refused", code: "out_of_order" });
  assert.equal((await svc.answer("staff", Q1, "None")).kind, "answered");
  assert.equal((await svc.answer("staff", Q2, "Ship it")).kind, "answered");
  assert.deepEqual(store.answersAll.map((a) => a.questionId), [Q1, Q2]);
});
