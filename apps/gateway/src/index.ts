import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";

import {
  createHealthResponse,
  type McpAdapter,
  type McpToolCall,
  type McpToolResult,
} from "@studenthub/contracts";

const DEFAULT_MCP_REQUEST_LIMIT_BYTES = 1024 * 1024;

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
  const port = Number.parseInt(process.env.PORT ?? "3000", 10);
  createGatewayServer().listen(port, "127.0.0.1", () => {
    process.stdout.write(`studenthub gateway listening on http://127.0.0.1:${port}\n`);
  });
}
