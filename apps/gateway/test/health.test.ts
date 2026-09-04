import assert from "node:assert/strict";
import test from "node:test";

import { PLATFORM_CONTRACT_VERSION } from "@studenthub/contracts";
import {
  createGatewayServer,
  parseGatewayPort,
  readRequestBody,
  type UnconfiguredMcpAdapter,
} from "../src/index.js";
import { createAuthzFixture } from "./helpers/authz.js";

/**
 * The gateway fails closed, so these body/adapter tests must authenticate. Each
 * builds its own fixture (fresh replay store) and mints a single-use assertion.
 */
async function authed(): Promise<{
  middleware: Awaited<ReturnType<typeof createAuthzFixture>>["middleware"];
  headers: () => Promise<Record<string, string>>;
}> {
  const fixture = await createAuthzFixture();
  return {
    middleware: fixture.middleware,
    headers: async () => ({ "x-actor-assertion": await fixture.mint() }),
  };
}

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
  const auth = await authed();
  const server = createGatewayServer(adapter, 32, auth.middleware);
  const origin = await listen(server);
  context.after(() => server.close());

  const response = await fetch(`${origin}/mcp/tools/call`, {
    method: "POST",
    headers: await auth.headers(),
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
  const auth = await authed();
  const server = createGatewayServer(adapter, undefined, auth.middleware);
  const origin = await listen(server);
  context.after(() => server.close());

  for (const body of ["not-json", "[]", "{}", JSON.stringify({ name: "missing-arguments" })]) {
    const response = await fetch(`${origin}/mcp/tools/call`, {
      method: "POST",
      headers: await auth.headers(),
      body,
    });
    assert.equal(response.status, 400);
  }
  assert.equal(calls, 0);
});

test("POST /mcp/tools/call maps adapter rejection to 502", async (context) => {
  const auth = await authed();
  const server = createGatewayServer(
    {
      async callTool() {
        throw new Error("adapter unavailable");
      },
    },
    undefined,
    auth.middleware,
  );
  const origin = await listen(server);
  context.after(() => server.close());

  const response = await fetch(`${origin}/mcp/tools/call`, {
    method: "POST",
    headers: await auth.headers(),
    body: JSON.stringify({ name: "student.search", arguments: {} }),
  });
  const body = (await response.json()) as Record<string, unknown>;

  assert.equal(response.status, 502);
  assert.equal(body.error, "adapter_failure");
});

test("request stream errors are contained", async () => {
  const failingStream = (async function* () {
    yield Buffer.from("partial");
    throw new Error("client disconnected");
  })();

  assert.deepEqual(await readRequestBody(failingStream, 1024), {
    ok: false,
    error: "request_stream_error",
  });
});

test("configured adapter failures do not return 501", async (context) => {
  const auth = await authed();
  const server = createGatewayServer(
    {
      async callTool() {
        return { ok: false, content: [{ type: "text", text: "tool failed" }] };
      },
    },
    undefined,
    auth.middleware,
  );
  const origin = await listen(server);
  context.after(() => server.close());

  const response = await fetch(`${origin}/mcp/tools/call`, {
    method: "POST",
    headers: await auth.headers(),
    body: JSON.stringify({ name: "student.search", arguments: {} }),
  });

  assert.equal(response.status, 502);
});

test("gateway port parsing rejects invalid configuration", () => {
  assert.equal(parseGatewayPort(undefined), 3000);
  assert.equal(parseGatewayPort("8080"), 8080);

  for (const value of ["not-a-port", "3000x", "0", "65536", "1.5"]) {
    assert.throws(() => parseGatewayPort(value), /PORT must be an integer/);
  }
});
