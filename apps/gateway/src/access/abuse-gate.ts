import type { IncomingMessage, ServerResponse } from "node:http";
import type { BlockList } from "node:net";
import type { SessionStore } from "@studenthub/login-contract";
import {
  PERSON_LIMITS,
  REASON_MAX,
  blockListOf,
  clientAddress,
  decideLimit,
  limitKind,
  listed,
  mayManageBlocks,
  parseBlockChange,
  parseCidr,
  windowStart,
  type AbuseStore,
  type AccessReadStore,
  type IpBlockRow,
} from "../../../../packages/access/src/index.js";
import { escapeHtml, readForm, sessionCookie } from "./admin-access.js";

/**
 * Access lane A8: runs before every other route.
 *
 * GET  /admin/ip-blocks   the live block list (operator admins only)
 * POST /admin/ip-blocks   block or unblock an address or network, with a reason
 *
 * A blocked address gets a refusal page for every path but /health. A signed-in
 * person past their write or upload limit gets a 429 page with Retry-After;
 * the count is kept per person in Postgres, so it is shared by all their
 * sessions and every gateway process. A failed count lets the request through
 * (the limit is a brake, not a gate); a failed block-list refresh keeps the
 * last list it read.
 */
export interface AbuseGatePorts {
  readonly sessions: Pick<SessionStore, "get">;
  readonly store: AbuseStore;
  readonly reads: Pick<AccessReadStore, "callerGrants">;
  readonly trustedProxies: BlockList;
  readonly operatorOrgIds?: readonly string[];
  readonly nowEpochSeconds?: () => number;
  /** How long a read block list is used before it is read again (default 15 s). */
  readonly blockListSeconds?: number;
}

export type AbusePageWriter = (status: number, title: string, body: string, headers?: Record<string, string>) => void;

interface HeldList { readonly list: BlockList; readonly rows: readonly IpBlockRow[]; readonly readAt: number; readonly generation: number }
interface ListState { held?: HeldList; inflight?: { readonly generation: number; readonly read: Promise<HeldList | undefined> }; generation: number; failedAt?: number }

const states = new WeakMap<AbuseGatePorts, ListState>();
/** How long a request waits for a block-list read before using the last list (or none). */
const REFRESH_DEADLINE_MS = 2_000;
/** After a failed read, the last list is used this long before reading again. */
const RETRY_SECONDS = 5;

function deadline<T>(work: Promise<T>, ms: number): Promise<T | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => { timer = setTimeout(() => resolve(undefined), ms); timer.unref?.(); });
  return Promise.race([work, late]).finally(() => clearTimeout(timer));
}

/**
 * The block list, read at most once per refresh window per gateway: concurrent
 * requests share one read, a failed read is retried only after RETRY_SECONDS,
 * and a read never replaces a list read after a later change (fresh = true
 * starts a new generation, so a read that began before a block change can't
 * restore the old list). A slow read is waited on for REFRESH_DEADLINE_MS at
 * most; the request then goes on with the last list.
 */
async function blockList(ports: AbuseGatePorts, now: number, fresh = false): Promise<HeldList | undefined> {
  let state = states.get(ports);
  if (!state) { state = { generation: 0 }; states.set(ports, state); }
  const { held } = state;
  if (!fresh) {
    if (held && now - held.readAt < (ports.blockListSeconds ?? 15)) return held;
    if (state.failedAt !== undefined && now - state.failedAt < RETRY_SECONDS) return held;
  }
  if (fresh) state.generation += 1;
  const generation = state.generation;
  let inflight = state.inflight;
  if (!inflight || inflight.generation < generation) {
    const s = state;
    const read = ports.store.blocks().then((rows) => {
      const next: HeldList = { rows, list: blockListOf(rows.map((row) => parseCidr(row.cidr)).filter((cidr) => cidr !== undefined)), readAt: now, generation };
      if (!s.held || s.held.generation <= generation) { s.held = next; s.failedAt = undefined; }
      return next;
    }, () => { s.failedAt = now; return undefined; }).finally(() => { if (s.inflight?.read === read) s.inflight = undefined; });
    inflight = { generation, read };
    state.inflight = inflight;
  }
  const read = fresh ? await inflight.read : await deadline(inflight.read, REFRESH_DEADLINE_MS);
  return read ?? (fresh ? undefined : state.held);
}

const brand = `<a class="brand" href="/" aria-label="StudentHub home"><span class="brand-mark" aria-hidden="true">s</span>studenthub<span class="brand-dot" aria-hidden="true">.</span></a>`;
const refusal = (heading: string, text: string) =>
  `<header class="topbar">${brand}</header><main id="main" class="error-page"><div class="eyebrow">STUDENTHUB</div><h1>${heading}</h1><p>${text}</p></main>`;

export function renderBlocked(): string {
  return refusal("We can’t accept requests from your network.", "Access to StudentHub from this network address is blocked. If you think this is a mistake, contact StudentHub support from another network.");
}

export function renderLimited(retryAfterSeconds: number): string {
  const minutes = Math.max(1, Math.ceil(retryAfterSeconds / 60));
  return refusal("Please slow down.", `You’ve made a lot of changes in a short time, so we’ve paused changes from your account for about ${minutes} minute${minutes === 1 ? "" : "s"}. Nothing you sent this time was saved. You can keep reading in the meantime.`);
}

export function renderIpBlocks(rows: readonly IpBlockRow[], notice?: string): string {
  const e = escapeHtml;
  const reason = (id: string) => `<label for="${id}">Reason (shown to administrators only)</label><textarea id="${id}" name="reason" minlength="3" maxlength="${REASON_MAX}" required></textarea>`;
  const list = rows.length === 0 ? `<p class="empty-contexts" role="status">No address is blocked.</p>`
    : `<div class="directory-table"><table><caption>Blocked addresses (${rows.length})</caption><thead><tr><th>Address or network</th><th>Blocked by</th><th>When</th><th>Reason</th><th>Unblock</th></tr></thead><tbody>${rows.map((row, index) =>
      `<tr><th scope="row">${e(row.cidr)}</th><td>${e(row.createdBy.displayName ?? "Unknown")}</td><td>${e(row.createdAt.slice(0, 10))}</td><td>${e(row.reason)}</td><td><form method="post" action="/admin/ip-blocks"><input type="hidden" name="action" value="unblock"><input type="hidden" name="cidr" value="${e(row.cidr)}">${reason(`unblock-reason-${index}`)}<button class="sign-out" type="submit">Unblock</button></form></td></tr>`).join("")}</tbody></table></div>`;
  const add = `<form method="post" action="/admin/ip-blocks"><input type="hidden" name="action" value="block"><label for="block-cidr">Address or network (for example 203.0.113.7 or 203.0.113.0/24)</label><input id="block-cidr" name="cidr" maxlength="64" required>${reason("block-reason")}<button class="sign-out" type="submit">Block</button></form>`;
  return `<header class="topbar">${brand}<form action="/logout" method="post"><button class="sign-out" type="submit">Sign out</button></form></header><div class="workspace"><aside class="sidebar"><div class="eyebrow">YOUR WORKSPACE</div><nav aria-label="Workspace"><a class="nav-item" href="/admin/access">Access</a><a class="nav-item active" href="/admin/ip-blocks" aria-current="page">Blocked addresses</a></nav></aside><main id="main" class="profile-main"><div class="profile-heading"><h1>Blocked addresses<span class="accent">.</span></h1></div><p>Requests from a blocked address are refused on every page. Changes apply within 15 seconds on every server.</p>${notice ? `<section class="notice context-notice" role="status"><strong>${e(notice)}</strong></section>` : ""}<section><h2>Block an address</h2>${add}</section><section><h2>Blocked now</h2>${list}</section></main></div>`;
}

const REFUSALS: Readonly<Record<string, [number, string]>> = Object.freeze({
  invalid_request: [400, "Enter an address or network and a reason of 3 to 500 characters. A network must start at its first address, and be /8 or narrower (/16 for IPv6)."],
  already_blocked: [409, "This address or network is already blocked."],
  not_blocked: [409, "This address or network isn’t blocked."],
  own_address: [409, "This would block your own address. Ask another administrator, from another network, if you mean it."],
  unavailable: [503, "Blocked addresses are unavailable right now. Please try again in a moment."],
});

export async function handleAbuseGate(
  req: IncomingMessage,
  res: ServerResponse,
  ports: AbuseGatePorts | undefined,
  origin: string | undefined,
  html: boolean,
  write: AbusePageWriter,
): Promise<boolean> {
  if (!ports) return false;
  const path = new URL(req.url ?? "/", "http://gateway.invalid").pathname;
  if (path === "/health") return false;
  const now = (ports.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1000)))();
  const address = clientAddress(req.socket.remoteAddress, req.headers["x-forwarded-for"], ports.trustedProxies);
  const blocks = await blockList(ports, now);
  if (address && blocks && listed(blocks.list, address)) {
    req.resume();
    if (html) write(403, "Blocked", renderBlocked(), { "cache-control": "no-store" });
    else { res.writeHead(403, { "content-type": "application/json", "cache-control": "no-store" }); res.end(JSON.stringify({ error: "blocked" })); }
    return true;
  }

  // Signing out is never limited: a limited person must still be able to end their session.
  const kind = path === "/logout" ? undefined : limitKind(req.method, req.headers["content-type"]);
  const session = sessionCookie(req.headers.cookie);
  let person: string | undefined;
  if ((kind || path === "/admin/ip-blocks") && session) {
    // A failed lookup skips the count (a brake, not a gate); the admin page
    // then answers as an unknown path, and every other route keeps its own
    // authentication.
    try { person = (await ports.sessions.get(session))?.personId; } catch { person = undefined; }
  }
  if (kind && person) {
    const limit = PERSON_LIMITS[kind];
    let decision: ReturnType<typeof decideLimit> = { kind: "allow" };
    try {
      const count = await ports.store.hit(person, kind, windowStart(now, limit));
      // Retry-After counts from when the answer is sent, to the end of the window charged.
      decision = decideLimit(count, now, limit);
      if (decision.kind === "limited") {
        const sent = (ports.nowEpochSeconds ?? (() => Math.floor(Date.now() / 1000)))();
        decision = { kind: "limited", retryAfterSeconds: Math.max(1, windowStart(now, limit) + limit.windowSeconds - sent) };
      }
    } catch { /* the limit is a brake, not a gate */ }
    if (decision.kind === "limited") {
      req.resume();
      const headers = { "retry-after": String(decision.retryAfterSeconds), "cache-control": "no-store" };
      if (html) write(429, "Please slow down", renderLimited(decision.retryAfterSeconds), headers);
      else { res.writeHead(429, { "content-type": "application/json", ...headers }); res.end(JSON.stringify({ error: "rate_limited" })); }
      return true;
    }
  }

  if (path !== "/admin/ip-blocks") return false;
  if (!person || (req.method !== "GET" && req.method !== "POST")) return false;
  if (!mayManageBlocks(await ports.reads.callerGrants(person), ports.operatorOrgIds)) return false;
  if (req.method === "GET") {
    const fresh = await blockList(ports, now, true);
    if (!fresh) { write(503, "Blocked addresses", refusal("Nothing was changed.", REFUSALS.unavailable![1])); return true; }
    const done = new URL(req.url ?? "/", "http://gateway.invalid").searchParams.get("done");
    write(200, "Blocked addresses", renderIpBlocks(fresh.rows, done === "blocked" ? "The address was blocked." : done === "unblocked" ? "The address was unblocked." : undefined), { "cache-control": "no-store" });
    return true;
  }
  const refuse = (key: keyof typeof REFUSALS) => {
    const [status, text] = REFUSALS[key]!;
    write(status, "Blocked addresses", `${refusal("Nothing was changed.", escapeHtml(text))}<p><a class="button primary" href="/admin/ip-blocks">Back</a></p>`);
    return true;
  };
  if (!origin || req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") {
    req.resume();
    return refuse("invalid_request");
  }
  const form = await readForm(req);
  const request = form && Object.keys(form).every((key) => key === "action" || key === "cidr" || key === "reason") ? parseBlockChange(form) : undefined;
  if (!request) return refuse("invalid_request");
  if (request.action === "block" && address && listed(blockListOf([request.cidr]), address)) return refuse("own_address");
  try {
    const outcome = await ports.store.changeBlock(person, request);
    if (outcome.kind === "refused") return refuse(outcome.reason);
    await blockList(ports, now, true);
    res.writeHead(303, { location: `/admin/ip-blocks?done=${outcome.kind}`, "cache-control": "no-store" });
    res.end();
    return true;
  } catch {
    return refuse("unavailable");
  }
}
