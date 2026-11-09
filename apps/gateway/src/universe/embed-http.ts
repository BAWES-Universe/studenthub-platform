import type { IncomingMessage, ServerResponse } from "node:http";
import { WEB_CSS } from "../web-ui.js";
import { APP_POLICY, universeEmbedPolicy, writeEmbedResponse, type UniverseEmbedConfig } from "./embed-policy.js";

/** E1 is deliberately inert: no login, cookies, identity, storage or profile IO. */
export const UNIVERSE_EMBED_SCRIPT = '"use strict";\ndocument.documentElement.dataset.universeEmbed = "not-ready";\n';

const NOT_READY = `<!doctype html><html lang="en" dir="ltr"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta name="robots" content="noindex, nofollow"><title>StudentHub in Universe</title><link rel="stylesheet" href="/assets/studenthub.css"></head><body><main id="main" class="profile-main"><h1>StudentHub in Universe</h1><p role="status">StudentHub in Universe is not ready yet. Please try again later.</p></main></body></html>`;

// A closed method + path manifest. Future E2 handlers must remain inside this
// boundary; these stubs must never delegate to the ordinary login or profile.
const JSON_ROUTES = new Set([
  "GET /universe/embed/status", "GET /universe/embed/profile",
  "POST /universe/embed/challenge", "POST /universe/embed/identity",
]);
const TOP_LEVEL_ROUTES = new Set([
  "GET /login/universe", "GET /login/callback", "POST /universe/embed/connect",
  "GET /universe/embed/done", "POST /logout",
]);

export function handleUniverseEmbed(request: IncomingMessage, response: ServerResponse,
  config: UniverseEmbedConfig): void {
  // Do not normalize or decode paths into the manifest. Only the exact route
  // spelling (with an ignored query string) can match; query values do nothing.
  const path = request.url?.split("?", 1)[0];
  const route = `${request.method} ${path}`;
  if (route === "GET /universe/embed") {
    const html = NOT_READY.replace("</head>", '<script src="/universe/embed/embed.js" defer></script></head>');
    writeEmbedResponse(response, 200, html, "text/html; charset=utf-8", universeEmbedPolicy(config));
  } else if (route === "GET /universe/embed/embed.js") {
    writeEmbedResponse(response, 200, UNIVERSE_EMBED_SCRIPT, "text/javascript; charset=utf-8");
  } else if (route === "GET /assets/studenthub.css") {
    writeEmbedResponse(response, 200, WEB_CSS, "text/css; charset=utf-8");
  } else if (JSON_ROUTES.has(route)) {
    writeEmbedResponse(response, 503, '{"error":"not_ready"}', "application/json");
  } else if (TOP_LEVEL_ROUTES.has(route)) {
    writeEmbedResponse(response, 503, NOT_READY, "text/html; charset=utf-8", APP_POLICY);
  } else {
    writeEmbedResponse(response, 404, '{"error":"not_found"}', "application/json");
  }
}
