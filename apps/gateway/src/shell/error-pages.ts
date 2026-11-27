import type { IncomingMessage, ServerResponse } from "node:http";
import { pageDocument, wantsHtml, writeHtml } from "../web-ui.js";

/**
 * Shared failure states (matrix row U-07; legacy apps' offline, server, not-found and app-error
 * routes and their wildcard). `/error/<kind>` shows one of them; the gateway's last-resort 404
 * and unhandled-failure 503 show the same pages when a browser asks for HTML, while API
 * callers keep the JSON they had. No session is read and nothing about the account is shown,
 * so a page is the same for everyone. Starting again goes to `/`, which resolves the person's
 * context afresh.
 */
export const ERROR_KINDS = ["not-found", "server", "app-error", "offline"] as const;
export type ErrorKind = typeof ERROR_KINDS[number];

const PAGES: Readonly<Record<ErrorKind, { readonly status: number; readonly code: string; readonly title: string; readonly message: string }>> = {
  "not-found": { status: 404, code: "not_found", title: "We can’t find that page.", message: "The link may be old or mistyped. Nothing about your account is shown here." },
  server: { status: 503, code: "service_unavailable", title: "StudentHub isn’t responding right now.", message: "Nothing you saved has been changed. Please try again in a moment." },
  "app-error": { status: 500, code: "app_error", title: "Something went wrong on this page.", message: "Nothing you saved has been changed. Start again from StudentHub to carry on." },
  offline: { status: 503, code: "offline", title: "You seem to be offline.", message: "Check your connection, then try again. Nothing you saved has been changed." },
};
const ERROR_PATH = /^\/error\/([^/]+)$/;
const isKind = (v: string): v is ErrorKind => (ERROR_KINDS as readonly string[]).includes(v);

/** The page for a failure state, with its status. */
export function errorPage(kind: ErrorKind): { readonly status: number; readonly html: string } {
  const p = PAGES[kind];
  return { status: p.status, html: pageDocument(p.title, `<header class="topbar"><a class="brand" href="/" aria-label="StudentHub home"><span class="brand-mark" aria-hidden="true">s</span>studenthub<span class="brand-dot" aria-hidden="true">.</span></a></header><main id="main" class="error-page"><div class="eyebrow">STUDENTHUB</div><h1>${p.title}</h1><p>${p.message}</p><a class="button primary" href="/">Start again from StudentHub <span aria-hidden="true">→</span></a></main>`) };
}

/**
 * Answers a failure state as a page for a browser and as JSON for anyone else, with `status`
 * (the kind's own status unless given).
 */
export function writeFailure(request: IncomingMessage, response: ServerResponse, kind: ErrorKind, status = PAGES[kind].status): void {
  const p = PAGES[kind];
  if (wantsHtml(request.headers.accept)) { writeHtml(response, status, errorPage(kind).html); return; }
  response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store", vary: "Accept" });
  response.end(JSON.stringify({ ok: false, error: p.code }));
}

/**
 * The gateway's not-found answer, shared by the wildcard and by every route that hides a refusal
 * as a missing page, so the two stay byte-for-byte the same. It depends only on what the caller
 * accepts, never on the method, so a refused write and an unknown path still look alike: a browser
 * gets the not-found page, anyone else the JSON the gateway has always sent.
 */
export function writeNotFound(request: IncomingMessage, response: ServerResponse): void {
  if (wantsHtml(request.headers.accept)) { const page = errorPage("not-found"); writeHtml(response, page.status, page.html); return; }
  response.writeHead(404, { "content-type": "application/json" });
  response.end(JSON.stringify({ ok: false, error: "not_found" }));
}

/**
 * Handles `/error/<kind>`; false for any other path. An unknown kind is the not-found page (404).
 * A known failure kind is shown with 200: it is a page the person was sent to, and the failure
 * itself was already answered, with its own status and telemetry, on the request that failed, so
 * opening the page must not count as another server failure.
 */
export function handleErrorPage(request: IncomingMessage, response: ServerResponse, path: string): boolean {
  const match = ERROR_PATH.exec(path);
  if (!match) return false;
  if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { allow: "GET, HEAD" }); response.end(); return true; }
  const kind = isKind(match[1]!) ? match[1] : "not-found";
  writeFailure(request, response, kind, kind === "not-found" ? 404 : 200);
  return true;
}
