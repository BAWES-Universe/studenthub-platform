import { createServer, type OutgoingHttpHeaders, type Server } from "node:http";
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";

import {
  createHealthResponse,
  type McpAdapter,
  type McpToolCall,
  type McpToolResult,
} from "@studenthub/contracts";

import {
  authorizeRequest,
  createDenyAllAuthzMiddleware,
  type AuthzMiddleware,
} from "./authz-middleware.js";
import { createRuntimeLoginFromEnv } from "./login-runtime.js";
import {
  type BrowserLoginApplication, profileDocument, renderError, renderLanding,
  WEB_CSS, wantsHtml, writeHtml,
} from "./web-ui.js";

export * from "./authz-middleware.js";
export * from "./authz-audit.js";
export { createLoginApplication } from "./login-application.js";
export { createRuntimeLoginFromEnv } from "./login-runtime.js";

const DEFAULT_MCP_REQUEST_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_GATEWAY_PORT = 3000;
const DEFAULT_GATEWAY_HOST = "127.0.0.1";
const IMAGE_SOURCE_REVISION_PATH = "/image-source-revision";

export function readImageSourceRevision(path = IMAGE_SOURCE_REVISION_PATH): string | null {
  let revision: string;
  try {
    revision = readFileSync(path, "utf8").trim();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  if (!/^[0-9a-f]{40}$/i.test(revision)) {
    throw new Error("image source revision must be a 40-character Git commit SHA");
  }
  return revision;
}

type RequestBodyReadResult =
  | { readonly ok: true; readonly body: Buffer }
  | { readonly ok: false; readonly error: "request_too_large" | "request_stream_error" };

export async function readRequestBody(
  stream: AsyncIterable<Uint8Array | string>,
  maxRequestBytes: number,
): Promise<RequestBodyReadResult> {
  const chunks: Buffer[] = [];
  let receivedBytes = 0;

  try {
    for await (const chunk of stream) {
      const buffer = Buffer.from(chunk);
      receivedBytes += buffer.byteLength;
      if (receivedBytes > maxRequestBytes) return { ok: false, error: "request_too_large" };
      chunks.push(buffer);
    }
  } catch {
    return { ok: false, error: "request_stream_error" };
  }

  return { ok: true, body: Buffer.concat(chunks) };
}

function isMcpToolCall(value: unknown): value is McpToolCall {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;

  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.name === "string" &&
    candidate.name.length > 0 &&
    typeof candidate.arguments === "object" &&
    candidate.arguments !== null &&
    !Array.isArray(candidate.arguments)
  );
}

export function parseGatewayPort(value: string | undefined): number {
  if (value === undefined) return DEFAULT_GATEWAY_PORT;

  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new RangeError("PORT must be an integer between 1 and 65535");
  }
  return port;
}

export function parseGatewayHost(value: string | undefined): string {
  if (value === undefined) return DEFAULT_GATEWAY_HOST;
  if (value !== "127.0.0.1" && value !== "::1" && value !== "0.0.0.0") {
    throw new RangeError("HOST must be 127.0.0.1, ::1, or 0.0.0.0");
  }
  return value;
}

export function gatewayListenUrl(host: string, port: number): string {
  const urlHost = host.includes(":") ? `[${host}]` : host;
  return `http://${urlHost}:${port}`;
}

export class UnconfiguredMcpAdapter implements McpAdapter {
  async callTool(call: McpToolCall): Promise<McpToolResult> {
    return {
      ok: false,
      content: [{ type: "text", text: `Tool '${call.name}' is not configured` }],
    };
  }
}

export function createGatewayServer(
  adapter: McpAdapter = new UnconfiguredMcpAdapter(),
  maxRequestBytes = DEFAULT_MCP_REQUEST_LIMIT_BYTES,
  authz: AuthzMiddleware = createDenyAllAuthzMiddleware(),
  login?: BrowserLoginApplication,
  sourceRevision: string | null = readImageSourceRevision(),
): Server {
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) {
    throw new RangeError("maxRequestBytes must be a positive safe integer");
  }

  return createServer(async (request, response) => {
    const html = wantsHtml(request.headers.accept);
    if (request.method === "GET" && request.url?.split("?", 1)[0] === "/") {
      writeHtml(response, 200, renderLanding(login));
      return;
    }
    if (request.method === "GET" && request.url === "/assets/studenthub.css") {
      response.writeHead(200, {
        "content-type": "text/css; charset=utf-8", "cache-control": "no-cache",
        "x-content-type-options": "nosniff",
      });
      response.end(WEB_CSS);
      return;
    }
    if (!login && html && request.url && ["/profile", "/login/universe", "/login/callback", "/logout"].includes(requestPath(request.url))) {
      writeHtml(response, 503, renderError(503));
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(createHealthResponse("gateway", new Date(), sourceRevision)));
      return;
    }

    if (login && request.method === "GET" && request.url && requestPath(request.url) === "/login/universe") {
      const url = new URL(request.url, "http://gateway.invalid");
      const returnTo = url.searchParams.get("return_to");
      if (!returnTo) {
        if (html) { writeHtml(response, 400, renderError(400, login)); return; }
        writeBrowserResponseSafely(response, { status: 400, body: { error: "login_rejected" } });
        return;
      }
      const browserSessionId = cookieValue(request.headers.cookie, "__Host-studenthub_browser")
        ?? randomBytes(32).toString("base64url");
      let result: import("@studenthub/login-contract").BrowserResponse;
      try {
        result = await login.start({ browserSessionId, returnTo });
      } catch {
        result = { status: 503, body: { error: "login_unavailable" } };
      }
      if (html && result.status >= 400) { writeHtml(response, result.status, renderError(result.status, login)); return; }
      writeBrowserResponseSafely(response, result, result.status === 302
        ? `__Host-studenthub_browser=${browserSessionId}; Path=/; HttpOnly; Secure; SameSite=Lax`
        : undefined);
      return;
    }

    if (login && request.method === "GET" && request.url && requestPath(request.url) === "/login/callback") {
      const url = new URL(request.url, "http://gateway.invalid");
      const browserSessionId = cookieValue(request.headers.cookie, "__Host-studenthub_browser");
      const state = url.searchParams.get("state");
      const code = url.searchParams.get("code");
      if (!browserSessionId || !state || !code) {
        if (html) { writeHtml(response, 400, renderError(400, login)); return; }
        writeBrowserResponseSafely(response, { status: 400, body: { error: "login_rejected" } });
        return;
      }
      let result: import("@studenthub/login-contract").BrowserResponse;
      try {
        result = await login.callback({ browserSessionId, state, code });
      } catch {
        result = { status: 503, body: { error: "login_unavailable" } };
      }
      if (html && result.status >= 400) { writeHtml(response, result.status, renderError(result.status, login)); return; }
      writeBrowserResponseSafely(response, result);
      return;
    }

    if (login && request.method === "GET" && request.url && requestPath(request.url) === "/profile") {
      const url = new URL(request.url, "http://gateway.invalid");
      let result: import("@studenthub/login-contract").BrowserResponse;
      try {
        result = await login.profile({
          sessionId: cookieValue(request.headers.cookie, "__Host-studenthub_session"),
          personId: url.searchParams.get("person_id") ?? undefined,
        });
      } catch {
        result = { status: 503, body: { error: "login_unavailable" } };
      }
      if (html) {
        try {
          const page = await profileDocument(result, login);
          writeHtml(response, page.status, page.html);
        } catch {
          writeHtml(response, 503, renderError(503, login));
        }
        return;
      }
      writeBrowserResponseSafely(response, {
        ...result,
        headers: { ...result.headers, "cache-control": "no-store", vary: "Accept" },
      });
      return;
    }

    if (login && request.method === "POST" && request.url && requestPath(request.url) === "/logout") {
      // Native browser forms must prove the configured origin; Host and forwarded
      // headers are not authority. Preserve non-browser clients without Origin.
      const origin = request.headers.origin;
      if (request.headers["sec-fetch-site"] === "cross-site"
        || (origin !== undefined && origin !== login.web?.origin)
        || (html && (!origin || !login.web?.origin))) {
        if (html) writeHtml(response, 403, renderError(403, login));
        else writeBrowserResponseSafely(response, { status: 403, body: { error: "login_rejected" } });
        return;
      }
      let result: import("@studenthub/login-contract").BrowserResponse;
      try {
        result = await login.logout(cookieValue(request.headers.cookie, "__Host-studenthub_session"));
      } catch {
        result = { status: 503, body: { error: "login_unavailable" } };
      }
      if (html) {
        if (result.status === 204) {
          response.writeHead(303, { ...result.headers, location: "/", "cache-control": "no-store", vary: "Accept" });
          response.end();
        } else {
          writeHtml(response, result.status, renderError(result.status, login));
        }
        return;
      }
      writeBrowserResponseSafely(response, result);
      return;
    }

    if (request.method === "POST" && request.url === "/mcp/tools/call") {
      // Gate the call BEFORE reading the body. There is no unauthenticated
      // path: `authz` has no undefined case, and its default denies every
      // request. When it allows, the active context has been derived
      // server-side from grants — no client-supplied role is ever trusted.
      {
        const raw = request.headers["x-actor-assertion"];
        const assertionWire = Array.isArray(raw) ? raw[0] : raw;
        // authorizeRequest is awaited inside an async listener: an escaping
        // rejection would send no response and can terminate the process under
        // Node's default unhandled-rejection policy. Dependency failures become
        // 503 and still never reach the adapter.
        let decision: Awaited<ReturnType<typeof authorizeRequest>>;
        try {
          decision = await authorizeRequest(assertionWire, authz);
        } catch {
          response.writeHead(503, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: "authz_unavailable" }));
          return;
        }
        if (decision.kind === "deny") {
          const body =
            decision.status === 401
              ? { ok: false, error: "unauthorized", reason: decision.reason }
              : { ok: false, error: "forbidden", reason: decision.reason };
          response.writeHead(decision.status, { "content-type": "application/json" });
          response.end(JSON.stringify(body));
          return;
        }
      }

      const bodyRead = await readRequestBody(request, maxRequestBytes);
      if (!bodyRead.ok) {
        if (!response.headersSent && !response.destroyed) {
          const status = bodyRead.error === "request_too_large" ? 413 : 400;
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify({ ok: false, error: bodyRead.error }));
        }
        return;
      }

      let parsed: unknown;
      try {
        parsed = JSON.parse(bodyRead.body.toString("utf8")) as unknown;
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "invalid_request" }));
        return;
      }

      if (!isMcpToolCall(parsed)) {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "invalid_request" }));
        return;
      }

      try {
        const call = parsed;
        const result = await adapter.callTool(call);
        const status = result.ok ? 200 : adapter instanceof UnconfiguredMcpAdapter ? 501 : 502;
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch {
        response.writeHead(502, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "adapter_failure" }));
      }
      return;
    }

    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ ok: false, error: "not_found" }));
  });
}

function cookieValue(header: string | undefined, name: string): string | undefined {
  for (const item of header?.split(";") ?? []) {
    const [key, ...value] = item.trim().split("=");
    const candidate = value.join("=");
    if (key === name && /^[A-Za-z0-9_-]{43}$/.test(candidate)) return candidate;
  }
  return undefined;
}

function requestPath(raw: string): string {
  return new URL(raw, "http://gateway.invalid").pathname;
}

function writeBrowserResponse(
  response: import("node:http").ServerResponse,
  result: import("@studenthub/login-contract").BrowserResponse,
  additionalCookie?: string,
): void {
  const headers: OutgoingHttpHeaders = {
    "content-type": "application/json",
    ...result.headers,
  };
  if (additionalCookie) {
    const existing = result.headers?.["set-cookie"];
    headers["set-cookie"] = existing ? [existing, additionalCookie] : additionalCookie;
  }
  response.writeHead(result.status, headers);
  response.end(result.body === undefined ? undefined : JSON.stringify(result.body));
}

function writeBrowserResponseSafely(
  response: import("node:http").ServerResponse,
  result: import("@studenthub/login-contract").BrowserResponse,
  additionalCookie?: string,
): void {
  try {
    writeBrowserResponse(response, result, additionalCookie);
  } catch {
    response.destroy();
  }
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  const port = parseGatewayPort(process.env.PORT);
  const host = parseGatewayHost(process.env.HOST);
  const runtimeLogin = createRuntimeLoginFromEnv();
  const server = createGatewayServer(
    new UnconfiguredMcpAdapter(),
    DEFAULT_MCP_REQUEST_LIMIT_BYTES,
    createDenyAllAuthzMiddleware(),
    runtimeLogin?.application,
  );
  server.once("close", () => { void runtimeLogin?.close(); });
  server.listen(port, host, () => {
    process.stdout.write(`studenthub gateway listening on ${gatewayListenUrl(host, port)}\n`);
  });
}
