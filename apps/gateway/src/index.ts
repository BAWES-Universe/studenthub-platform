import { createServer, type Server } from "node:http";
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

export * from "./authz-middleware.js";

const DEFAULT_MCP_REQUEST_LIMIT_BYTES = 1024 * 1024;
const DEFAULT_GATEWAY_PORT = 3000;

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
): Server {
  if (!Number.isSafeInteger(maxRequestBytes) || maxRequestBytes <= 0) {
    throw new RangeError("maxRequestBytes must be a positive safe integer");
  }

  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(createHealthResponse("gateway")));
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

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  const port = parseGatewayPort(process.env.PORT);
  createGatewayServer().listen(port, "127.0.0.1", () => {
    process.stdout.write(`studenthub gateway listening on http://127.0.0.1:${port}\n`);
  });
}
