import type { IncomingMessage, ServerResponse } from "node:http";
import { WEB_CSS } from "../web-ui.js";
import { handleEmbedRuntime } from "./embed-service.js";
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
  // E2: with a complete runtime, the same closed manifest is served for real.
  // HEAD (the Universe probe), the stylesheet and unknown routes keep E1 behaviour.
  if (config.runtime && route !== "HEAD /universe/embed" && route !== "GET /assets/studenthub.css"
    && (route === "GET /universe/embed" || route === "GET /universe/embed/embed.js"
      || JSON_ROUTES.has(route) || TOP_LEVEL_ROUTES.has(route))) {
    const runtime = config.runtime;
    void handleEmbedRuntime(request, response, config, runtime, route).then((handled) => {
      if (!handled) writeEmbedResponse(response, 404, '{"error":"not_found"}', "application/json");
    }, () => {
      if (response.headersSent) { response.destroy(); return; }
      writeEmbedResponse(response, 503, '{"error":"unavailable"}', "application/json");
    });
    return;
  }
  if (route === "GET /universe/embed" || route === "HEAD /universe/embed") {
    const html = NOT_READY.replace("</head>", '<script src="/universe/embed/embed.js" defer></script></head>');
    // Universe probes HEAD first and only retries GET after a 405. The probe
    // must see the display policy, without receiving the body or creating state.
    writeEmbedResponse(response, 200, request.method === "HEAD" ? "" : html,
      "text/html; charset=utf-8", universeEmbedPolicy(config), { "content-length": String(Buffer.byteLength(html)) });
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
