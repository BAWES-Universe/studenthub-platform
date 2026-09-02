import { createServer, type Server } from "node:http";
import { pathToFileURL } from "node:url";

import {
  createHealthResponse,
  type McpAdapter,
  type McpToolCall,
  type McpToolResult,
} from "../../../packages/contracts/src/index.js";

export class UnconfiguredMcpAdapter implements McpAdapter {
  async callTool(call: McpToolCall): Promise<McpToolResult> {
    return {
      ok: false,
      content: [{ type: "text", text: `Tool '${call.name}' is not configured` }],
    };
  }
}

export function createGatewayServer(adapter: McpAdapter = new UnconfiguredMcpAdapter()): Server {
  return createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify(createHealthResponse("gateway")));
      return;
    }

    if (request.method === "POST" && request.url === "/mcp/tools/call") {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));

      try {
        const call = JSON.parse(Buffer.concat(chunks).toString("utf8")) as McpToolCall;
        const result = await adapter.callTool(call);
        response.writeHead(result.ok ? 200 : 501, { "content-type": "application/json" });
        response.end(JSON.stringify(result));
      } catch {
        response.writeHead(400, { "content-type": "application/json" });
        response.end(JSON.stringify({ ok: false, error: "invalid_request" }));
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
