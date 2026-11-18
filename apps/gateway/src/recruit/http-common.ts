import type { IncomingMessage, ServerResponse } from "node:http";

// Shared plumbing for the recruit HTTP modules: session cookie, bounded JSON or
// form bodies, JSON answers, and the same-origin rule for every write.

export type RecruitPageWriter = (status: number, title: string, body: string) => void;
export type RecruitErr = { status: 400 | 401 | 404 | 409 | 503; body: { error: string; [key: string]: unknown } };
export type RecruitResult<T> = { status: 200; body: T } | RecruitErr;

export const BAD: RecruitErr = { status: 400, body: { error: "invalid_request" } };
export const UNAUTHORIZED: RecruitErr = { status: 401, body: { error: "unauthorized" } };
export const NOT_FOUND: RecruitErr = { status: 404, body: { error: "not_found" } };

export const html = (value: string): string => value.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const when = (value: string | Date) => (value instanceof Date ? value : new Date(value)).toISOString().slice(0, 16).replace("T", " ");
export const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function sessionCookie(header: string | undefined): string | undefined {
  for (const item of header?.split(";") ?? []) {
    const [k, ...v] = item.trim().split("=");
    if (k === "__Host-studenthub_session" && /^[A-Za-z0-9_-]{43}$/.test(v.join("="))) return v.join("=");
  }
}

/** A JSON or urlencoded body up to `limit` bytes; a repeated form key is refused. */
export async function readBody(req: IncomingMessage, limit = 16384): Promise<{ form: boolean; value: unknown } | undefined> {
  const type = req.headers["content-type"] ?? "";
  const form = type.startsWith("application/x-www-form-urlencoded");
  if ((!form && type !== "application/json") || Number(req.headers["content-length"]) > limit) { req.resume(); return undefined; }
  const chunks: Buffer[] = [];
  let n = 0;
  for await (const c of req.iterator({ destroyOnReturn: false })) {
    const b = Buffer.from(c);
    if ((n += b.length) > limit) { req.resume(); return undefined; }
    chunks.push(b);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  if (!form) { try { return { form, value: JSON.parse(text) as unknown }; } catch { return undefined; } }
  const out: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(text)) { if (Object.hasOwn(out, key)) return undefined; out[key] = value; }
  return { form, value: out };
}

export function sendJson(res: ServerResponse, r: { status: number; body: unknown }): void {
  res.writeHead(r.status, { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", vary: "Accept" });
  res.end(JSON.stringify(r.body));
}

export function redirect(res: ServerResponse, location: string): void {
  res.writeHead(303, { location, "cache-control": "no-store" });
  res.end();
}

/** Same-origin writes only; a refused origin answers 403 before the body is read. */
export function sameOrigin(req: IncomingMessage, origin: string): boolean {
  return req.headers.origin === origin && req.headers["sec-fetch-site"] !== "cross-site";
}

export function errorPage(write: RecruitPageWriter, status: number, back: { href: string; label: string }): void {
  const message = status === 404 ? "This isn’t available to you." : status === 409 ? "That change isn’t allowed any more." : status === 400 ? "Some details were missing or not valid." : "This service is unavailable. Please try again in a moment.";
  write(status, "Recruit", status === 401 ? "" : `<main id="main" class="error-page"><h1>${message}</h1><p><a class="text-link" href="${html(back.href)}">${html(back.label)}</a></p></main>`);
}

export function decodeSegment(match: RegExpExecArray): string {
  try { return decodeURIComponent(match[1]!); } catch { return ""; }
}
