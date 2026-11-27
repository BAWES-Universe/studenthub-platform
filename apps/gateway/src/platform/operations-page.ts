import type { AuthzStore } from "@studenthub/contracts";
import type { SessionStore } from "@studenthub/login-contract";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import { isJobMissed, type Job, type JobName, type JobOutcome, type JobRunsStore } from "../../../../packages/observability/src/jobs.js";
import type { EmailDeliverySummary } from "../../../../packages/db/src/postgres-email-outbox-store.js";
import type { GatewayRouteContext } from "../routes/context.js";
import { wantsHtml } from "../web-ui.js";

/**
 * Platform operations (release matrix A-28; legacy admin cron and mail logs): one page where a
 * StudentHub admin sees whether the platform's background work is healthy. Each scheduled job's
 * last run, outcome and whether it is late (the same rule as `/admin/jobs`), and email delivery:
 * messages waiting, how many are overdue, and the last 24 hours of delivery attempts by outcome
 * (the messages themselves are listed at `/admin/outbox`). Read-only: no action, and no cache
 * flush (the legacy HTTP cache flush is not rebuilt). Counts and job names only; no address,
 * recipient or message content is read.
 *
 * Only an admin at an operator organization is answered, checked on every request; anyone else,
 * signed out included, gets the gateway's unknown-path answer (the handler returns false).
 */
export const PLATFORM_OPERATIONS_PATH = "/platform/operations";

export interface OperationsJob {
  readonly name: JobName;
  readonly lastRun: null | { readonly startedAt: string; readonly durationMs: number; readonly outcome: JobOutcome };
  readonly late: boolean;
}
export interface PlatformOperationsView {
  readonly checkedAt: string;
  /** Late jobs, plus one for overdue email and one for failed delivery attempts in the last 24 hours. */
  readonly needsAttention: number;
  readonly jobs: readonly OperationsJob[];
  readonly email: { readonly waiting: number; readonly overdue: number; readonly oldestWaitingSince: string | null;
    readonly last24Hours: EmailDeliverySummary["last24Hours"] };
}
export interface PlatformOperations {
  /** The view for an admin at an operator organization; null for anyone else. */
  open(sessionId: string | undefined): Promise<PlatformOperationsView | null>;
}

export function createPlatformOperations(deps: {
  readonly sessions: Pick<SessionStore, "get">;
  readonly authz: Pick<AuthzStore, "listGrantsForPrincipal">;
  readonly jobRuns: Pick<JobRunsStore, "latest" | "lastSuccesses">;
  readonly jobs: readonly Pick<Job, "name" | "intervalMs">[];
  readonly email: { deliverySummary(now: Date): Promise<EmailDeliverySummary> };
  readonly now?: () => Date;
}): PlatformOperations {
  const now = deps.now ?? (() => new Date());
  return {
    async open(sessionId) {
      const session = sessionId ? await deps.sessions.get(sessionId) : undefined;
      if (!session) return null;
      const grants = await deps.authz.listGrantsForPrincipal(session.personId);
      if (!grants.some(g => g.role === "admin" && (DEFAULT_OPERATOR_ORG_IDS as readonly string[]).includes(g.orgId))) return null;
      const at = now();
      const [latest, successes, email] = await Promise.all([deps.jobRuns.latest(), deps.jobRuns.lastSuccesses(), deps.email.deliverySummary(at)]);
      const byName = new Map(latest.map(run => [run.jobName, run]));
      const jobs = deps.jobs.map(job => {
        const run = byName.get(job.name);
        return { name: job.name, late: isJobMissed(job, successes.get(job.name), at),
          lastRun: run ? { startedAt: run.startedAt.toISOString(), durationMs: run.durationMs, outcome: run.outcome } : null };
      });
      const needsAttention = jobs.filter(j => j.late).length + (email.overdue > 0 ? 1 : 0) + (email.last24Hours.failed > 0 ? 1 : 0);
      return { checkedAt: at.toISOString(), needsAttention, jobs,
        email: { waiting: email.waiting, overdue: email.overdue, oldestWaitingSince: email.oldestWaitingSince?.toISOString() ?? null, last24Hours: { ...email.last24Hours } } };
    },
  };
}

const escapeHtml = (v: string) => v.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const JOB_LABELS: Readonly<Record<JobName, string>> = { heartbeat: "Worker heartbeat", missed_run_check: "Late job check", email_delivery: "Email delivery" };
const OUTCOME_LABELS: Readonly<Record<JobOutcome, string>> = { succeeded: "Succeeded", failed: "Failed", refused_overlap: "Skipped: the previous run was still going" };
const kuwait = (iso: string) => `${new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Kuwait", dateStyle: "medium", timeStyle: "short" }).format(new Date(iso))} Kuwait time`;
const plural = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

function render(v: PlatformOperationsView): string {
  const e = escapeHtml;
  const status = v.needsAttention === 0
    ? `<p class="status-ok" role="status">Everything is running.</p>`
    : `<p class="status-warn" role="status">${e(plural(v.needsAttention, "thing needs", "things need"))} attention.</p>`;
  const jobRows = v.jobs.map(j => `<tr><th scope="row">${e(JOB_LABELS[j.name])}</th><td>${j.lastRun ? e(kuwait(j.lastRun.startedAt)) : "Never run"}</td><td>${j.lastRun ? e(OUTCOME_LABELS[j.lastRun.outcome]) : "None"}</td><td>${j.late ? "<strong>Late</strong>" : "On time"}</td></tr>`).join("");
  const m = v.email, a = m.last24Hours;
  return `<main id="main" class="profile-main"><h1>Operations</h1>${status}<p class="field-meta">Checked ${e(kuwait(v.checkedAt))}.</p>
    <h2>Scheduled jobs</h2><table><caption>Each job's last run</caption><thead><tr><th scope="col">Job</th><th scope="col">Last run</th><th scope="col">Outcome</th><th scope="col">Schedule</th></tr></thead><tbody>${jobRows}</tbody></table>
    <p>A job is late when it has not succeeded for one and a half of its intervals. <a class="text-link" href="/admin/jobs">Job details</a></p>
    <h2>Email delivery</h2><dl class="profile-fields">
      <div><dt>Waiting to send</dt><dd>${e(String(m.waiting))}${m.oldestWaitingSince ? `, the oldest queued ${e(kuwait(m.oldestWaitingSince))}` : ""}</dd></div>
      <div><dt>Overdue</dt><dd>${m.overdue > 0 ? `<strong>${e(String(m.overdue))}</strong>` : "0"}</dd></div>
    </dl>
    <table><caption>Delivery attempts in the last 24 hours</caption><thead><tr><th scope="col">Sent</th><th scope="col">Failed</th><th scope="col">Not sent</th><th scope="col">Suppressed</th></tr></thead>
      <tbody><tr><td>${a.sent}</td><td>${a.failed > 0 ? `<strong>${a.failed}</strong>` : "0"}</td><td>${a.not_sent}</td><td>${a.suppressed}</td></tr></tbody></table>
    <p>A failed attempt is tried again until its retry limit. Not sent means the person turned that email off or has no address; suppressed means it was no longer needed. <a class="text-link" href="/admin/outbox">Email messages</a></p></main>`;
}

const sessionCookie = (header: string | undefined) => {
  for (const item of header?.split(";") ?? []) {
    const [key, ...value] = item.trim().split("=");
    const candidate = value.join("=");
    if (key === "__Host-studenthub_session" && /^[A-Za-z0-9_-]{43}$/.test(candidate)) return candidate;
  }
  return undefined;
};

/** Handles GET and HEAD /platform/operations; false (the unknown-path answer) for anything else and for anyone but an operator admin. */
export async function handlePlatformOperations(ctx: GatewayRouteContext): Promise<boolean> {
  const { request, response } = ctx;
  if (request.method !== "GET" && request.method !== "HEAD") return false;
  const url = new URL(request.url ?? "/", "http://gateway.invalid");
  if (url.pathname !== PLATFORM_OPERATIONS_PATH) return false;
  const service = ctx.login?.platformOperations;
  if (!service) return false;
  const view = await service.open(sessionCookie(request.headers.cookie));
  if (!view) return false;
  if (wantsHtml(request.headers.accept)) { ctx.writeHtml(response, 200, ctx.pageDocument("Operations", render(view)), { "cache-control": "no-store", vary: "Accept" }); return true; }
  response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept" });
  response.end(request.method === "HEAD" ? undefined : JSON.stringify({ status: "ok", ...view }));
  return true;
}
