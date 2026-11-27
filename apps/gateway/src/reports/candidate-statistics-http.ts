import type { IncomingMessage, ServerResponse } from "node:http";
import type { CandidateStatistics } from "../../../../packages/reports/src/candidate-statistics.js";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";

/**
 * A person's own statistics (legacy candidate app `Statistic` list): GET /profile/statistics, as a
 * page or as JSON. Only the signed-in person's own figures; there is no parameter for anyone
 * else's. Signed out gets 401, any other method 405.
 */
export interface CandidateStatisticsHttpService { own(personId: string): Promise<CandidateStatistics> }

export const CANDIDATE_STATISTICS_PATH = "/profile/statistics";
const esc = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const NO_STORE = { "cache-control": "no-store" };

function json(res: ServerResponse, status: number, body: unknown): true {
  res.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(body)); return true;
}
const plural = (n: number | string, one: string, many: string) => `${n} ${String(n) === "1" ? one : many}`;

function page(s: CandidateStatistics): string {
  const w = s.worked;
  const worked = `${plural(w.hours, "hour", "hours")}, ${plural(w.minutes, "minute", "minutes")}, ${plural(w.seconds, "second", "seconds")}`;
  const money = s.money.length
    ? `<table><thead><tr><th>Currency</th><th>Paid</th><th>Bonus</th><th>Earnings</th></tr></thead><tbody>${s.money.map(m =>
      `<tr><td>${esc(m.currency)}</td><td>${esc(m.paid)}</td><td>${esc(m.bonus)}</td><td>${esc(m.earnings)}</td></tr>`).join("")}</tbody></table>
      <p>Earnings is what was paid out to you: your pay plus your bonus after commission. <a class="text-link" href="/pay">See each payment</a>.</p>`
    : `<p>Nothing has been paid out to you yet. <a class="text-link" href="/pay">Your pay history</a> lists each payment once it is made.</p>`;
  return `<main id="main" class="profile-main"><h1>Your statistics</h1>
    <h2>Time worked</h2><p>${esc(worked)}</p><p>Counted from your pay periods that StudentHub has locked. <a class="text-link" href="/work/history">Your work history</a> shows each session.</p>
    <h2>Pay</h2>${money}
    <h2>Interviews</h2><p>${esc(plural(s.upcomingInterviews, "upcoming interview", "upcoming interviews"))}. <a class="text-link" href="/recruit/my-interviews">Your interviews</a></p></main>`;
}

/** Handles /profile/statistics; false for any other path. `viewer` is the signed-in person, if any. */
export async function handleCandidateStatistics(req: IncomingMessage, res: ServerResponse, service: CandidateStatisticsHttpService | undefined, path: string,
  viewer: () => Promise<string | undefined>): Promise<boolean> {
  if (path !== CANDIDATE_STATISTICS_PATH) return false;
  req.resume();
  if (!service) {
    if (wantsHtml(req.headers.accept)) { writeHtml(res, 404, pageDocument("Not found", `<main><h1>Not found</h1><p>The page could not be found.</p></main>`), NO_STORE); return true; }
    return json(res, 404, { status: "not_found" });
  }
  if (req.method !== "GET") { res.writeHead(405, { allow: "GET" }); res.end(); return true; }
  const person = await viewer();
  if (!person) {
    if (wantsHtml(req.headers.accept)) { writeHtml(res, 401, pageDocument("Sign in", `<main><h1>Sign in</h1><p>Sign in to see your statistics.</p><p><a href="/profile">Go to your profile</a></p></main>`), NO_STORE); return true; }
    return json(res, 401, { status: "unauthenticated" });
  }
  const s = await service.own(person);
  if (!wantsHtml(req.headers.accept)) return json(res, 200, { status: "ok", worked: s.worked, money: s.money, upcomingInterviews: s.upcomingInterviews });
  writeHtml(res, 200, pageDocument("Your statistics", page(s)), NO_STORE);
  return true;
}
