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
import { docLanguage, esc, notice, plain, readForm, redirect, sessionCookie, tooLarge, write } from "./pages.js";
import { pageDocument } from "../web-ui.js";
import { WORK_COPY, workCopyFor, type WorkCopy } from "./copy.js";
import { teamCopy } from "./team-copy.js";

export const STANDUP_PAGE = "/work/standup";
const QUESTION_PATH = /^\/work\/standup\/questions(?:\/([0-9a-fA-F-]{36})(?:\/(retire))?)?$/;
/** A form field of up to `max` characters, each up to 12 bytes once percent-encoded, plus room for the rest. */
export const STANDUP_FORM_LIMIT = STANDUP_ANSWER_MAX * 12 + 1024;

function shell(title: string, body: string, c: WorkCopy): string {
  return pageDocument(title, `<main id="main" class="profile-ui"><div class="p-shell"><div class="p-main p-stack"><header class="p-header"><h1>${esc(title)}</h1></header>${body}</div></div></main>`, docLanguage(c));
}

const answerItem = (a: StandupAnswer) => `<li><p><strong>${esc(a.question)}</strong></p><p>${esc(a.answer)}</p></li>`;

/**
 * The stand-up card for /me/work; empty when the stand-up isn't wired or the
 * actor isn't staff. The question is asked only while the day is in progress,
 * as legacy did.
 */
export async function standupCard(services: WorkHttpServices, actor: string, dayInProgress: boolean, c: WorkCopy = WORK_COPY.en): Promise<string> {
  if (!services.standup) return "";
  const today = await services.standup.today(actor);
  if (today.kind === "refused") return "";
  const t = teamCopy(c).standup;
  const ask = !dayInProgress ? `<p>${esc(t.startDay)}</p>`
    : today.next ? `<form method="post" action="/me/work/standup"><input type="hidden" name="question" value="${esc(today.next.id)}">
<label for="standup-answer">${esc(today.next.question)}</label><textarea id="standup-answer" name="answer" required maxlength="${STANDUP_ANSWER_MAX}" rows="4"></textarea>
<button class="p-button" type="submit">${esc(t.save)}</button></form>`
    : `<p>${esc(today.answers.length ? t.allAnswered : t.noQuestions)}</p>`;
  const given = today.answers.length ? `<h3>${esc(t.yourAnswers)}</h3><ul>${today.answers.map(answerItem).join("")}</ul>` : "";
  return `<section class="p-card" aria-labelledby="standup-heading"><h2 id="standup-heading">${esc(t.heading)}</h2>${ask}${given}</section>`;
}

/** Message for a refused answer on /me/work; undefined for a code with no message of its own. */
export function standupRefused(code: string, c: WorkCopy = WORK_COPY.en): string | undefined {
  return teamCopy(c).standup.refused[code]?.(STANDUP_ANSWER_MAX);
}

/** `~` separates the parts; encodeURIComponent leaves a `~` in a staff id as it is, so it is escaped too. */
function cursorText(c: StandupAnswerCursor): string { return `${encodeURIComponent(c.staffId).replace(/~/g, "%7E")}~${c.createdAt}~${c.id}`; }
function parseCursorText(value: string | null): StandupAnswerCursor | null | undefined {
  if (value === null || value === "") return null;
  const parts = value.split("~");
  if (parts.length !== 3) return undefined;
  try { return { staffId: decodeURIComponent(parts[0]!), createdAt: parts[1]!, id: parts[2]! }; } catch { return undefined; }
}

export async function renderStandup(services: WorkHttpServices, actor: string, query: URLSearchParams, now: Date, message: { kind: "success" | "error"; text: string } | null = null, c: WorkCopy = WORK_COPY.en): Promise<{ status: number; html: string }> {
  const standup = services.standup!;
  const tc = teamCopy(c), t = tc.standup;
  const date = query.get("date") || kuwaitDate(now);
  const staffId = query.get("staff") || undefined;
  const after = parseCursorText(query.get("after"));
  if (after === undefined) return { status: 400, html: plain(400, ...t.brokenLink, c)[1] };
  const [questions, page, unanswered] = await Promise.all([standup.questions(actor), standup.answers(actor, date, { ...(staffId ? { staffId } : {}), after }), standup.unanswered(actor, date)]);
  if (questions.kind === "refused") return { status: 403, html: plain(403, ...t.adminsOnly, c)[1] };
  if (page.kind === "refused" || unanswered.kind === "refused") return { status: 400, html: plain(400, ...t.badFilters, c)[1] };
  const ids = new Set([...page.answers.map((a) => a.staffId), ...unanswered.staffIds]);
  const names = ids.size && services.personNames ? await services.personNames([...ids]) : new Map<string, string>();
  const who = (id: string) => esc(names.get(id) ?? id);
  const field = (name: string, value: string, label: string) => `<label>${esc(label)}<input name="${name}" value="${esc(value)}" required maxlength="${STANDUP_QUESTION_MAX}"></label>`;
  const questionList = questions.questions.length === 0 ? `<p>${esc(t.noneYet)}</p>`
    : `<ol>${questions.questions.map((q) => `<li><form method="post" action="${STANDUP_PAGE}/questions/${esc(q.id)}" aria-label="${esc(t.editLabel)}">${field("question", q.question, t.question)}<button type="submit">${esc(t.save2)}</button></form>
<form method="post" action="${STANDUP_PAGE}/questions/${esc(q.id)}/retire" aria-label="${esc(t.retireLabel)}"><button type="submit">${esc(t.retire)}</button></form></li>`).join("")}</ol>`;
  const add = `<form method="post" action="${STANDUP_PAGE}/questions" aria-label="${esc(t.addLabel)}">${field("question", "", t.newQuestion)}<button type="submit">${esc(t.add)}</button></form>`;
  const filter = `<form method="get" action="${STANDUP_PAGE}" aria-label="${esc(tc.common.filter)}"><label>${esc(t.date)}<input type="date" name="date" value="${esc(date)}" required></label><label>${esc(t.staffIdOptional)}<input name="staff" value="${esc(staffId ?? "")}" maxlength="200"></label><button type="submit">${esc(tc.common.show)}</button></form>`;
  // Grouped by staff member, as legacy's answer list was.
  const groups = new Map<string, StandupAnswer[]>();
  for (const a of page.answers) groups.set(a.staffId, [...(groups.get(a.staffId) ?? []), a]);
  const answers = groups.size === 0 ? `<p>${esc(t.noAnswers)}</p>`
    : [...groups].map(([id, list]) => `<article><h3>${who(id)}</h3><ul>${list.map((a) => `<li><p><strong>${esc(a.question)}</strong> <span>${esc(c.clock(a.createdAt))}</span></p><p>${esc(a.answer)}</p></li>`).join("")}</ul></article>`).join("");
  const more = page.next ? `<nav><a href="${STANDUP_PAGE}?${esc(new URLSearchParams({ date, ...(staffId ? { staff: staffId } : {}), after: cursorText(page.next) }).toString())}">${esc(t.more)}</a></nav>` : "";
  const absent = `<section class="p-card" aria-labelledby="unanswered-heading"><h2 id="unanswered-heading">${esc(t.noAnswerOn(c.longDate(unanswered.workDate)))}</h2>
${unanswered.staffIds.length ? `<ul>${unanswered.staffIds.map((id) => `<li>${who(id)}</li>`).join("")}</ul>` : `<p>${esc(t.everyoneAnswered)}</p>`}</section>`;
  return { status: 200, html: shell(t.heading, `${message ? notice(message.kind, message.text) : ""}<section class="p-card" aria-labelledby="questions-heading"><h2 id="questions-heading">${esc(t.questionsHeading)}</h2><p>${esc(t.questionsIntro)}</p>${questionList}${add}</section>
<section class="p-card" aria-labelledby="answers-heading"><h2 id="answers-heading">${esc(t.answersOn(c.longDate(page.workDate)))}</h2>${filter}${answers}${more}</section>${absent}
<nav class="p-card"><a href="/work/staff-time">${esc(t.staffTime)}</a></nav>`, c) };
}

/** Handles /work/standup and its question forms; false for any other path. */
export async function handleStandupPages(req: IncomingMessage, res: ServerResponse, services: WorkHttpServices | undefined, origin: string | undefined, now: () => Date = () => new Date()): Promise<boolean> {
  const url = new URL(req.url ?? "/", "http://invalid");
  const match = QUESTION_PATH.exec(url.pathname);
  if (url.pathname !== STANDUP_PAGE && !match) return false;
  // The browser's language until the actor is known, then theirs.
  let c = await workCopyFor(undefined, undefined, req);
  let t = teamCopy(c);
  try {
    if (!services?.standup || !origin) { req.resume(); write(res, ...plain(503, t.common.unavailable[0], t.standup.off, c)); return true; }
    const sessionId = sessionCookie(req.headers.cookie);
    const actor = sessionId ? await services.personFor(sessionId) : undefined;
    if (!actor) { req.resume(); write(res, ...plain(401, t.common.signIn, t.standup.signIn, c)); return true; }
    c = await workCopyFor(services.language, actor, req);
    t = teamCopy(c);
    if (!match) {
      if (req.method !== "GET") { req.resume(); write(res, ...plain(405, ...t.common.notAllowed, c)); return true; }
      const done = url.searchParams.get("done");
      const { status, html } = await renderStandup(services, actor, url.searchParams, now(), done && t.standup.done[done] ? { kind: "success", text: t.standup.done[done]! } : null, c);
      write(res, status, html);
      return true;
    }
    if (req.method !== "POST") { req.resume(); write(res, ...plain(405, ...t.common.notAllowed, c)); return true; }
    if (req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") { req.resume(); write(res, ...plain(403, ...t.common.refused, c)); return true; }
    const [, id, retire] = match;
    const form = await readForm(req, retire ? [] : ["question"], STANDUP_QUESTION_MAX * 12 + 1024);
    if (!form) { write(res, ...plain(400, ...t.standup.badForm, c)); return true; }
    const result = retire ? await services.standup.retireQuestion(actor, id)
      : id ? await services.standup.editQuestion(actor, id, form.question) : await services.standup.addQuestion(actor, form.question);
    if (result.kind !== "refused") { redirect(res, `${STANDUP_PAGE}?done=${retire ? "retired" : id ? "edited" : "added"}`); return true; }
    if (result.code === "forbidden") { write(res, ...plain(403, ...t.standup.adminsOnly, c)); return true; }
    const text = result.code === "not_found" ? t.standup.questionNotFound : t.standup.questionTooLong(STANDUP_QUESTION_MAX);
    const { html } = await renderStandup(services, actor, new URLSearchParams(), now(), { kind: "error", text }, c);
    write(res, result.code === "not_found" ? 404 : 400, html);
  } catch (error) {
    if (!res.headersSent) write(res, ...(tooLarge(error, c) ?? plain(503, ...t.common.unavailable, c))); else res.destroy();
  }
  return true;
}
