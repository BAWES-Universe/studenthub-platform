import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import test from "node:test";
import { handleMyWorkPages } from "../src/work/staff-time-pages.js";
import { handleStandupPages } from "../src/work/standup-pages.js";
import type { WorkHttpServices } from "../src/work/http.js";

const SESSION = "t".repeat(43), ORIGIN = "https://studenthub.test.invalid";
const NOW = new Date("2026-11-18T09:30:00Z");
const Q1 = "aaaaaaaa-0000-4000-8000-000000000001", Q2 = "aaaaaaaa-0000-4000-8000-000000000002";

interface World { open?: boolean; notStaff?: boolean; notAdmin?: boolean; next?: boolean; answered?: boolean; answerResult?: unknown; questionResult?: unknown; noStandup?: boolean }
function services(calls: unknown[][], world: World = {}): WorkHttpServices {
  const refused = (code = "forbidden") => ({ kind: "refused", code });
  const answer = (over: Record<string, unknown> = {}) => ({ id: "cccccccc-0000-4000-8000-000000000001", staffId: "actor", questionId: Q1, question: "Blockers <now>?", answer: "None & done", workDate: "2026-11-18", createdAt: "2026-11-18T06:15:00.000Z", ...over });
  const session = (over: Record<string, unknown> = {}) => ({ id: "s1", staffId: "actor", workDate: "2026-11-18", startedAt: "2026-11-18T05:00:00.000Z", endedAt: null, minutes: null, source: "timer", ...over });
  return {
    personFor: async (id: string) => id === SESSION ? "actor" : undefined,
    personNames: async (ids: readonly string[]) => new Map(ids.filter((i) => i !== "nameless").map((i) => [i, i === "actor" ? "Huda" : "Omar"])),
    staffTime: {
      today: async () => ({ kind: "today", workDate: "2026-11-18", sessions: world.open ? [session()] : [] }),
      days: async () => ({ kind: "days", days: [], next: null }),
    },
    ...(world.noStandup ? {} : { standup: {
      today: async (...a: unknown[]) => { calls.push(["today", ...a]); return world.notStaff ? refused() : { kind: "today", workDate: "2026-11-18", next: world.next === false ? null : { id: Q2, question: "Plans <today>?", createdAt: "x" }, answers: world.answered ? [answer()] : [] }; },
      answer: async (...a: unknown[]) => { calls.push(["answer", ...a]); return world.answerResult ?? { kind: "answered", workDate: "2026-11-18" }; },
      questions: async (...a: unknown[]) => { calls.push(["questions", ...a]); return world.notAdmin ? refused() : { kind: "questions", questions: [{ id: Q1, question: "Blockers <now>?", createdAt: "x" }] }; },
      addQuestion: async (...a: unknown[]) => { calls.push(["add", ...a]); return world.questionResult ?? { kind: "question", question: {} }; },
      editQuestion: async (...a: unknown[]) => { calls.push(["edit", ...a]); return world.questionResult ?? { kind: "question", question: {} }; },
      retireQuestion: async (...a: unknown[]) => { calls.push(["retire", ...a]); return world.questionResult ?? { kind: "retired" }; },
      answers: async (...a: unknown[]) => { calls.push(["answers", ...a]); return world.notAdmin ? refused() : (a[1] as string).length !== 10 ? refused("invalid_input")
        : { kind: "answers", workDate: a[1], answers: [answer(), answer({ id: "cccccccc-0000-4000-8000-000000000002", question: "Plans?", answer: "Interviews" }), answer({ staffId: "other", answer: "Calls" })],
          next: { staffId: "other", createdAt: "2026-11-18T06:15:00.000Z", id: "cccccccc-0000-4000-8000-000000000003" } }; },
      unanswered: async (...a: unknown[]) => { calls.push(["unanswered", ...a]); return world.notAdmin ? refused() : { kind: "unanswered", workDate: a[1], staffIds: ["nameless"] }; },
    } }),
  } as unknown as WorkHttpServices;
}

type Opt = { method?: string; body?: string; origin?: string; cookie?: string | null; service?: WorkHttpServices | undefined; world?: World; contentType?: string };
async function request(path: string, o: Opt = {}, calls: unknown[][] = []) {
  const req = Readable.from(o.body !== undefined ? [o.body] : []) as Readable & { method?: string; url?: string; headers: Record<string, string> };
  req.method = o.method ?? "GET"; req.url = path;
  req.headers = { ...(o.cookie === null ? {} : { cookie: `__Host-studenthub_session=${o.cookie ?? SESSION}` }),
    ...(o.body !== undefined ? { "content-type": o.contentType ?? "application/x-www-form-urlencoded", "content-length": String(Buffer.byteLength(o.body)) } : {}), ...(o.origin ? { origin: o.origin } : {}) };
  const res = new EventEmitter() as EventEmitter & { statusCode: number; headersSent: boolean; headers: Record<string, string>; chunks: string[]; writeHead(s: number, h: Record<string, string>): void; end(v?: unknown): void; destroy(): void };
  res.statusCode = 0; res.headers = {}; res.chunks = []; res.headersSent = false;
  res.writeHead = (s, h) => { res.statusCode = s; res.headers = h; res.headersSent = true; };
  res.end = (v) => { if (v !== undefined) res.chunks.push(String(v)); };
  res.destroy = () => {};
  const svc = Object.hasOwn(o, "service") ? o.service : services(calls, o.world);
  const handled = (await handleMyWorkPages(req as never, res as never, svc, ORIGIN)) || (await handleStandupPages(req as never, res as never, svc, ORIGIN, () => NOW));
  return { handled, status: res.statusCode, headers: res.headers, html: res.chunks.join("") };
}
const post = (path: string, extra: Opt = {}, calls: unknown[][] = []) => request(path, { method: "POST", origin: ORIGIN, body: "", ...extra }, calls);

test("STANDUP_PAGES /me/work asks the next question only while the day is in progress, and lists today's answers", async () => {
  const idle = await request("/me/work", { world: { answered: true } });
  assert.match(idle.html, /<h2 id="standup-heading">Stand-up<\/h2><p>Start your day to answer the stand-up\.<\/p>/);
  assert.match(idle.html, /Your answers today<\/h3><ul><li><p><strong>Blockers &lt;now&gt;\?<\/strong><\/p><p>None &amp; done<\/p><\/li>/);
  assert.ok(!idle.html.includes('action="/me/work/standup"'));
  const working = await request("/me/work", { world: { open: true } });
  assert.ok(working.html.includes(`<form method="post" action="/me/work/standup"><input type="hidden" name="question" value="${Q2}">`));
  assert.match(working.html, /<label for="standup-answer">Plans &lt;today&gt;\?<\/label><textarea id="standup-answer" name="answer" required maxlength="4000"/);
  assert.match((await request("/me/work", { world: { open: true, next: false, answered: true } })).html, /You've answered every stand-up question today\./);
  assert.match((await request("/me/work", { world: { open: true, next: false } })).html, /There are no stand-up questions yet\./);
  // Not wired, or not staff for the stand-up: no card, the rest of the page as before.
  assert.ok(!(await request("/me/work", { world: { open: true, noStandup: true } })).html.includes("standup-heading"));
  assert.ok(!(await request("/me/work", { world: { open: true, notStaff: true } })).html.includes("standup-heading"));
});

test("STANDUP_PAGES an answer posts from the same origin and comes back to /me/work", async () => {
  const calls: unknown[][] = [];
  const saved = await post("/me/work/standup", { body: `question=${Q2}&answer=Interviews+%26+calls` }, calls);
  assert.deepEqual([saved.status, saved.headers.location], [303, "/me/work?done=answered"]);
  assert.deepEqual(calls.filter((c) => c[0] === "answer"), [["answer", "actor", Q2, "Interviews & calls"]]);
  assert.match((await request("/me/work?done=answered")).html, /Answer saved\./);
  const twice = await post("/me/work/standup", { body: `question=${Q2}&answer=x`, world: { open: true, answerResult: { kind: "refused", code: "already_answered" } } });
  assert.equal(twice.status, 409);
  assert.match(twice.html, /You&#39;ve already answered that question today\./);
  const empty = await post("/me/work/standup", { body: `question=${Q2}&answer=`, world: { answerResult: { kind: "refused", code: "invalid_input" } } });
  assert.equal(empty.status, 400);
  assert.match(empty.html, /Write an answer of up to 4000 characters\./);
  assert.equal((await post("/me/work/standup", { body: `question=${Q2}&answer=x`, world: { answerResult: { kind: "refused", code: "forbidden" } } })).status, 403);
  const refusedCalls: unknown[][] = [];
  assert.equal((await post("/me/work/standup", { body: `question=${Q2}&answer=x`, origin: "https://evil.invalid" }, refusedCalls)).status, 403);
  assert.equal((await post("/me/work/standup", { body: `question=${Q2}&answer=x&extra=1` }, refusedCalls)).status, 400);
  assert.equal((await post("/me/work/standup", { body: `question=${Q2}&answer=x`, contentType: "application/json" }, refusedCalls)).status, 400);
  assert.equal((await post("/me/work/standup", { body: "x".repeat(4000 * 12 + 1025) }, refusedCalls)).status, 413);
  assert.equal(refusedCalls.filter((c) => c[0] === "answer").length, 0);
  assert.equal((await post("/me/work/standup", { body: `question=${Q2}&answer=x`, world: { noStandup: true } })).status, 503);
});

test("STANDUP_PAGES /work/standup: questions to keep, answers grouped by staff member and paged, and who answered nothing", async () => {
  const calls: unknown[][] = [];
  const page = await request("/work/standup?date=2026-11-17&staff=other", {}, calls);
  assert.equal(page.status, 200);
  assert.ok(page.html.includes(`<form method="post" action="/work/standup/questions/${Q1}" aria-label="Edit question"><label>Question<input name="question" value="Blockers &lt;now&gt;?" required maxlength="255">`));
  assert.ok(page.html.includes(`action="/work/standup/questions/${Q1}/retire"`));
  assert.ok(page.html.includes('action="/work/standup/questions" aria-label="Add question"'));
  assert.match(page.html, /<h3>Huda<\/h3><ul><li><p><strong>Blockers &lt;now&gt;\?<\/strong> <span>09:15<\/span><\/p><p>None &amp; done<\/p><\/li><li>[\s\S]*Interviews<\/p><\/li><\/ul><\/article><article><h3>Omar<\/h3>/);
  assert.ok(page.html.includes("href=\"/work/standup?date=2026-11-17&amp;staff=other&amp;after=other%7E2026-11-18T06%3A15%3A00.000Z%7Ecccccccc-0000-4000-8000-000000000003\">More answers"));
  assert.match(page.html, /No answer on Tuesday, 17 November 2026[\s\S]*<li>nameless<\/li>/);
  assert.deepEqual(calls.find((c) => c[0] === "answers"), ["answers", "actor", "2026-11-17", { staffId: "other", after: null }]);
  assert.deepEqual(calls.find((c) => c[0] === "unanswered"), ["unanswered", "actor", "2026-11-17"]);
  // Defaults to today in Kuwait; the cursor round-trips.
  const calls2: unknown[][] = [];
  await request("/work/standup?after=other~2026-11-18T06:15:00.000Z~cccccccc-0000-4000-8000-000000000003", {}, calls2);
  assert.deepEqual(calls2.find((c) => c[0] === "answers"), ["answers", "actor", "2026-11-18", { after: { staffId: "other", createdAt: "2026-11-18T06:15:00.000Z", id: "cccccccc-0000-4000-8000-000000000003" } }]);
  assert.equal((await request("/work/standup?after=broken")).status, 400);
  assert.equal((await request("/work/standup?date=2026-1-1")).status, 400);
  assert.equal((await request("/work/standup", { world: { notAdmin: true } })).status, 403);
});

test("STANDUP_PAGES question forms: add, reword and retire, from the same origin, admins only", async () => {
  const calls: unknown[][] = [];
  const added = await post("/work/standup/questions", { body: "question=Blockers%3F" }, calls);
  assert.deepEqual([added.status, added.headers.location], [303, "/work/standup?done=added"]);
  const edited = await post(`/work/standup/questions/${Q1}`, { body: "question=Anything+blocking%3F" }, calls);
  assert.deepEqual([edited.status, edited.headers.location], [303, "/work/standup?done=edited"]);
  const retired = await post(`/work/standup/questions/${Q1}/retire`, {}, calls);
  assert.deepEqual([retired.status, retired.headers.location], [303, "/work/standup?done=retired"]);
  assert.deepEqual(calls.filter((c) => ["add", "edit", "retire"].includes(c[0] as string)), [["add", "actor", "Blockers?"], ["edit", "actor", Q1, "Anything blocking?"], ["retire", "actor", Q1]]);
  assert.match((await request("/work/standup?done=retired")).html, /Question retired\./);
  const bad = await post("/work/standup/questions", { body: "question=", world: { questionResult: { kind: "refused", code: "invalid_input" } } });
  assert.equal(bad.status, 400);
  assert.match(bad.html, /Write a question of up to 255 characters\./);
  assert.equal((await post(`/work/standup/questions/${Q1}/retire`, { world: { questionResult: { kind: "refused", code: "not_found" } } })).status, 404);
  assert.equal((await post("/work/standup/questions", { body: "question=x", world: { questionResult: { kind: "refused", code: "forbidden" } } })).status, 403);
  const refusedCalls: unknown[][] = [];
  assert.equal((await post("/work/standup/questions", { body: "question=x", origin: "https://evil.invalid" }, refusedCalls)).status, 403);
  assert.equal((await post(`/work/standup/questions/${Q1}/retire`, { body: "question=x" }, refusedCalls)).status, 400);
  assert.equal((await request("/work/standup/questions", {}, refusedCalls)).status, 405);
  assert.equal((await post("/work/standup", { body: "" }, refusedCalls)).status, 405);
  assert.equal(refusedCalls.filter((c) => ["add", "edit", "retire"].includes(c[0] as string)).length, 0);
  for (const p of ["/work/standupx", "/work/standup/questions/nope", `/work/standup/questions/${Q1}/delete`]) assert.equal((await request(p)).handled, false, p);
  assert.equal((await request("/work/standup", { cookie: null })).status, 401);
  assert.equal((await request("/work/standup", { world: { noStandup: true } })).status, 503);
});
