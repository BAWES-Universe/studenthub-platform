import assert from "node:assert/strict";
import test from "node:test";

import { PLATFORM_CONTRACT_VERSION } from "../../../packages/contracts/src/index.js";
import { createGatewayServer, type UnconfiguredMcpAdapter } from "../src/index.js";

async function listen(server: ReturnType<typeof createGatewayServer>): Promise<string> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return `http://127.0.0.1:${address.port}`;
}

test("GET /health exposes the shared versioned contract", async (context) => {
  const server = createGatewayServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  context.after(() => server.close());

  const address = server.address();
  assert.ok(address && typeof address !== "string");

  const response = await fetch(`http://127.0.0.1:${address.port}/health`);
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 200);
  assert.equal(body.status, "ok");
  assert.equal(body.component, "gateway");
  assert.equal(body.contractVersion, PLATFORM_CONTRACT_VERSION);
  assert.equal(typeof body.timestamp, "string");
});

test("POST /mcp/tools/call rejects oversized bodies before dispatch", async (context) => {
  let calls = 0;
  const adapter: UnconfiguredMcpAdapter = {
    async callTool() {
      calls += 1;
      return { ok: true, content: [] };
    },
  };
  const server = createGatewayServer(adapter, 32);
  const origin = await listen(server);
  context.after(() => server.close());

  const response = await fetch(`${origin}/mcp/tools/call`, {
    method: "POST",
    body: JSON.stringify({ name: "oversized", arguments: { value: "x".repeat(64) } }),
  });

  assert.equal(response.status, 413);
  assert.equal(calls, 0);
});

test("POST /mcp/tools/call rejects malformed calls before dispatch", async (context) => {
  let calls = 0;
  const adapter: UnconfiguredMcpAdapter = {
    async callTool() {
      calls += 1;
      return { ok: true, content: [] };
    },
  };
  const server = createGatewayServer(adapter);
  const origin = await listen(server);
  context.after(() => server.close());

  for (const body of ["not-json", "[]", "{}", JSON.stringify({ name: "missing-arguments" })]) {
    const response = await fetch(`${origin}/mcp/tools/call`, { method: "POST", body });
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test("POST /mcp/tools/call maps adapter rejection to 502", async (context) => {
  const server = createGatewayServer({
    async callTool() {
      throw new Error("adapter unavailable");
    },
  });
  const origin = await listen(server);
  context.after(() => server.close());

  const response = await fetch(`${origin}/mcp/tools/call`, {
    method: "POST",
    body: JSON.stringify({ name: "student.search", arguments: {} }),
  });
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 502);
  assert.equal(body.error, "adapter_failure");
});
