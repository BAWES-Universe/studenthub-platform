import assert from "node:assert/strict";
import test from "node:test";

import { PLATFORM_CONTRACT_VERSION } from "../../../packages/contracts/src/index.js";
import { createGatewayServer } from "../src/index.js";

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
