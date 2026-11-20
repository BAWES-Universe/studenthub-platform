// The daily stand-up screens (legacy daily_standup_question/answer):
// - on /me/work, while the day is in progress, the next question the staff
//   member hasn't answered today, and what they answered today (the stand-up
//   part of A-14; legacy's staff home asked it beside the session timer);
// - /work/standup: operator admins keep the questions and read the answers by
//   date and staff member, with who answered nothing that day (legacy admin
//   question list and form, answer list and list-inactive).
// Same pattern as the other work screens: server-rendered, same-origin form
// posts, the actor from the session cookie, every rule in StandupService.

import type { IncomingMessage, ServerResponse } from "node:http";
import { kuwaitDate, STANDUP_ANSWER_MAX, STANDUP_QUESTION_MAX, type StandupAnswer, type StandupAnswerCursor } from "../../../../packages/work/src/index.js";
import type { WorkHttpServices } from "./http.js";
import { clock, esc, longDate, notice, plain, readForm, redirect, sessionCookie, tooLarge, write } from "./pages.js";
import { pageDocument } from "../web-ui.js";

export const STANDUP_PAGE = "/work/standup";
const QUESTION_PATH = /^\/work\/standup\/questions(?:\/([0-9a-fA-F-]{36})(?:\/(retire))?)?$/;
/** A form field of up to `max` characters, each up to 12 bytes once percent-encoded, plus room for the rest. */
export const STANDUP_FORM_LIMIT = STANDUP_ANSWER_MAX * 12 + 1024;

function shell(title: string, body: string): string {
  return pageDocument(title, `<main id="main" class="profile-ui"><div class="p-shell"><div class="p-main p-stack"><header class="p-header"><h1>${esc(title)}</h1></header>${body}</div></div></main>`);
}

const answerItem = (a: StandupAnswer) => `<li><p><strong>${esc(a.question)}</strong></p><p>${esc(a.answer)}</p></li>`;

/**
 * The stand-up card for /me/work; empty when the stand-up isn't wired or the
 * actor isn't staff. The question is asked only while the day is in progress,
 * as legacy did.
 */
export async function standupCard(services: WorkHttpServices, actor: string, dayInProgress: boolean): Promise<string> {
  if (!services.standup) return "";
  const today = await services.standup.today(actor);
  if (today.kind === "refused") return "";
  const ask = !dayInProgress ? "<p>Start your day to answer the stand-up.</p>"
    : today.next ? `<form method="post" action="/me/work/standup"><input type="hidden" name="question" value="${esc(today.next.id)}">
<label for="standup-answer">${esc(today.next.question)}</label><textarea id="standup-answer" name="answer" required maxlength="${STANDUP_ANSWER_MAX}" rows="4"></textarea>
<button class="p-button" type="submit">Save answer</button></form>`
    : today.answers.length ? "<p>You've answered every stand-up question today.</p>" : "<p>There are no stand-up questions yet.</p>";
  const given = today.answers.length ? `<h3>Your answers today</h3><ul>${today.answers.map(answerItem).join("")}</ul>` : "";
  return `<section class="p-card" aria-labelledby="standup-heading"><h2 id="standup-heading">Stand-up</h2>${ask}${given}</section>`;
}

/** Message for a refused answer on /me/work. */
export const STANDUP_REFUSED: Readonly<Record<string, string>> = {
  invalid_input: `Write an answer of up to ${STANDUP_ANSWER_MAX} characters.`,
  already_answered: "You've already answered that question today.",
  not_found: "That question is no longer asked. Here is the next one.",
  not_working: "Start your day to answer the stand-up.",
  out_of_order: "Answer the stand-up questions one at a time, in order. Here is the next one.",
};

/** `~` separates the parts; encodeURIComponent leaves a `~` in a staff id as it is, so it is escaped too. */
function cursorText(c: StandupAnswerCursor): string { return `${encodeURIComponent(c.staffId).replace(/~/g, "%7E")}~${c.createdAt}~${c.id}`; }
function parseCursorText(value: string | null): StandupAnswerCursor | null | undefined {
  if (value === null || value === "") return null;
  const parts = value.split("~");
  if (parts.length !== 3) return undefined;
  try { return { staffId: decodeURIComponent(parts[0]!), createdAt: parts[1]!, id: parts[2]! }; } catch { return undefined; }
}

const DONE: Readonly<Record<string, string>> = { added: "Question added.", edited: "Question saved.", retired: "Question retired. It's no longer asked; its answers stay." };

export async function renderStandup(services: WorkHttpServices, actor: string, query: URLSearchParams, now: Date, message: { kind: "success" | "error"; text: string } | null = null): Promise<{ status: number; html: string }> {
  const standup = services.standup!;
  const date = query.get("date") || kuwaitDate(now);
  const staffId = query.get("staff") || undefined;
  const after = parseCursorText(query.get("after"));
  if (after === undefined) return { status: 400, html: plain(400, "Filters not valid", "That page link is broken. Start again from the first page.")[1] };
  const [questions, page, unanswered] = await Promise.all([standup.questions(actor), standup.answers(actor, date, { ...(staffId ? { staffId } : {}), after }), standup.unanswered(actor, date)]);
  if (questions.kind === "refused") return { status: 403, html: plain(403, "Admins only", "Only StudentHub admins keep the stand-up.")[1] };
  if (page.kind === "refused" || unanswered.kind === "refused") return { status: 400, html: plain(400, "Filters not valid", "Choose a real date and staff member.")[1] };
  const ids = new Set([...page.answers.map((a) => a.staffId), ...unanswered.staffIds]);
  const names = ids.size && services.personNames ? await services.personNames([...ids]) : new Map<string, string>();
  const who = (id: string) => esc(names.get(id) ?? id);
  const field = (name: string, value: string, label: string) => `<label>${label}<input name="${name}" value="${esc(value)}" required maxlength="${STANDUP_QUESTION_MAX}"></label>`;
  const questionList = questions.questions.length === 0 ? "<p>No questions yet. Staff aren't asked anything until you add one.</p>"
    : `<ol>${questions.questions.map((q) => `<li><form method="post" action="${STANDUP_PAGE}/questions/${esc(q.id)}" aria-label="Edit question">${field("question", q.question, "Question")}<button type="submit">Save</button></form>
<form method="post" action="${STANDUP_PAGE}/questions/${esc(q.id)}/retire" aria-label="Retire question"><button type="submit">Stop asking</button></form></li>`).join("")}</ol>`;
  const add = `<form method="post" action="${STANDUP_PAGE}/questions" aria-label="Add question">${field("question", "", "New question")}<button type="submit">Add question</button></form>`;
  const filter = `<form method="get" action="${STANDUP_PAGE}" aria-label="Filter"><label>Date<input type="date" name="date" value="${esc(date)}" required></label><label>Staff member's StudentHub ID (optional)<input name="staff" value="${esc(staffId ?? "")}" maxlength="200"></label><button type="submit">Show</button></form>`;
  // Grouped by staff member, as legacy's answer list was.
  const groups = new Map<string, StandupAnswer[]>();
  for (const a of page.answers) groups.set(a.staffId, [...(groups.get(a.staffId) ?? []), a]);
  const answers = groups.size === 0 ? "<p>No answers on this date.</p>"
    : [...groups].map(([id, list]) => `<article><h3>${who(id)}</h3><ul>${list.map((a) => `<li><p><strong>${esc(a.question)}</strong> <span>${esc(clock(a.createdAt))}</span></p><p>${esc(a.answer)}</p></li>`).join("")}</ul></article>`).join("");
  const more = page.next ? `<nav><a href="${STANDUP_PAGE}?${esc(new URLSearchParams({ date, ...(staffId ? { staff: staffId } : {}), after: cursorText(page.next) }).toString())}">More answers</a></nav>` : "";
  const absent = `<section class="p-card" aria-labelledby="unanswered-heading"><h2 id="unanswered-heading">No answer on ${esc(longDate(unanswered.workDate))}</h2>
${unanswered.staffIds.length ? `<ul>${unanswered.staffIds.map((id) => `<li>${who(id)}</li>`).join("")}</ul>` : "<p>Every staff member answered that day.</p>"}</section>`;
  return { status: 200, html: shell("Stand-up", `${message ? notice(message.kind, message.text) : ""}<section class="p-card" aria-labelledby="questions-heading"><h2 id="questions-heading">Questions</h2><p>Staff are asked these in order while their day is in progress, one at a time, once a day.</p>${questionList}${add}</section>
<section class="p-card" aria-labelledby="answers-heading"><h2 id="answers-heading">Answers on ${esc(longDate(page.workDate))}</h2>${filter}${answers}${more}</section>${absent}
<nav class="p-card"><a href="/work/staff-time">Staff time</a></nav>`) };
}

/** Handles /work/standup and its question forms; false for any other path. */
export async function handleStandupPages(req: IncomingMessage, res: ServerResponse, services: WorkHttpServices | undefined, origin: string | undefined, now: () => Date = () => new Date()): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://invalid");
  const match = QUESTION_PATH.exec(url.pathname);
  if (url.pathname !== STANDUP_PAGE && !match) return false;
  try {
    if (!services?.standup || !origin) { req.resume(); write(res, ...plain(503, "Work is unavailable", "The stand-up isn't switched on here yet.")); return true; }
    const sessionId = sessionCookie(req.headers.cookie);
    const actor = sessionId ? await services.personFor(sessionId) : undefined;
    if (!actor) { req.resume(); write(res, ...plain(401, "Sign in", "Sign in to keep the stand-up.")); return true; }
    if (!match) {
      if (req.method !== "GET") { req.resume(); write(res, ...plain(405, "Not allowed", "This page can't do that.")); return true; }
      const done = url.searchParams.get("done");
      const { status, html } = await renderStandup(services, actor, url.searchParams, now(), done && DONE[done] ? { kind: "success", text: DONE[done]! } : null);
      write(res, status, html);
      return true;
    }
    if (req.method !== "POST") { req.resume(); write(res, ...plain(405, "Not allowed", "This page can't do that.")); return true; }
    if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); write(res, ...plain(403, "Request refused", "We could not verify this request.")); return true; }
    const [, id, retire] = match;
    const form = await readForm(req, retire ? [] : ["question"], STANDUP_QUESTION_MAX * 12 + 1024);
    if (!form) { write(res, ...plain(400, "Request not valid", "That form isn't one this page sends.")); return true; }
    const result = retire ? await services.standup.retireQuestion(actor, id)
      : id ? await services.standup.editQuestion(actor, id, form.question) : await services.standup.addQuestion(actor, form.question);
    if (result.kind !== "refused") { redirect(res, `${STANDUP_PAGE}?done=${retire ? "retired" : id ? "edited" : "added"}`); return true; }
    if (result.code === "forbidden") { write(res, ...plain(403, "Admins only", "Only StudentHub admins keep the stand-up.")); return true; }
    const text = result.code === "not_found" ? "That question is no longer asked." : `Write a question of up to ${STANDUP_QUESTION_MAX} characters.`;
    const { html } = await renderStandup(services, actor, new URLSearchParams(), now(), { kind: "error", text });
    write(res, result.code === "not_found" ? 404 : 400, html);
  } catch (error) {
    if (!res.headersSent) write(res, ...(tooLarge(error) ?? plain(503, "Work is unavailable", "Something went wrong. Try again in a moment."))); else res.destroy();
  }
  return true;
}
