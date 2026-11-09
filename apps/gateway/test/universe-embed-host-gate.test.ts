import assert from "node:assert/strict";
import test from "node:test";
import type { IncomingMessage, ServerResponse } from "node:http";
import { request as httpRequest } from "node:http";
import { canonicalEmbedHost, createUniverseEmbedConfigFromEnv } from "../src/universe/embed-policy.js";

const { gateUniverseEmbedRequest } = await import(process.env.E1_HOST_GATE_MODULE ?? new URL("../src/universe/embed-host-gate.js", import.meta.url).href) as typeof import("../src/universe/embed-host-gate.js");
const { createGatewayServer } = await import(process.env.E1_GATEWAY_MODULE ?? new URL("../src/index.js", import.meta.url).href) as typeof import("../src/index.js");
const MAIN = "https://studenthub.test.invalid";
const ENV = { UNIVERSE_EMBED_ORIGIN: "https://embed.bawes.test" };
const enabled = { ...ENV, UNIVERSE_EMBED_ENABLED: "true", UNIVERSE_EMBED_ANCESTORS: "https://universe.bawes.test",
  UNIVERSE_EMBED_OIDC_CALLBACK_URL: "https://embed.bawes.test/login/callback" };

function call(rawHeaders: string[], config = createUniverseEmbedConfigFromEnv(ENV, MAIN),
  extra: Record<string, string> = {}) {
  let status = 0, body = "";
  const headers: Record<string, string> = {};
  const response = { removeHeader(name: string) { delete headers[name]; },
    writeHead(code: number, values: Record<string, string>) { status = code; Object.assign(headers, values); },
    end(value: string) { body = value; },
  } as unknown as ServerResponse;
  const request = { method: "GET", url: "/profile", rawHeaders,
    headers: { host: "main-host-decoy.invalid", ...extra } } as unknown as IncomingMessage;
  const handled = gateUniverseEmbedRequest(request, response, config);
  return { handled, status, body, headers };
}

test("E1_HOST_CANONICAL authority equivalence is exact and preserves nondefault ports", () => {
  for (const value of ["embed.bawes.test", "EMBED.BAWES.TEST", "Embed.Bawes.Test.", "embed.bawes.test:443", "EMBED.BAWES.TEST.:0443"]) {
    assert.equal(canonicalEmbedHost(value), "embed.bawes.test", value);
    assert.equal(call(["HoSt", value]).status, 404, "canonical embed spelling never reaches ordinary handlers");
  }
  assert.equal(canonicalEmbedHost("embed.bawes.test:8443"), "embed.bawes.test:8443");
  assert.equal(call(["Host", "embed.bawes.test:8443"]).handled, false);
  assert.equal(canonicalEmbedHost("localhost:80", "http:"), "localhost");
  assert.equal(canonicalEmbedHost("127.0.0.1.:443"), "127.0.0.1");
  assert.equal(canonicalEmbedHost("[2001:0db8:0:0:0:0:0:1]:443"), "[2001:db8::1]");
  assert.equal(canonicalEmbedHost("[::1]:8443"), "[::1]:8443");
});

test("E1_HOST_MALFORMED missing duplicate and malformed Host fail closed while reserved", () => {
  const invalid = ["", " embed.bawes.test", "embed.bawes.test ", "embed.bawes.test..", "embed.bawes.test...",
    "user@embed.bawes.test", "user:secret@embed.bawes.test", "https://embed.bawes.test", "embed.bawes.test/path",
    "embed.bawes.test?x", "embed.bawes.test#x", "embed.bawes.test\\", "embed.bawes.test%2e", "embed.bawes.test,main.test",
    "embed.bawes.test:", "embed.bawes.test:port", "embed.bawes.test:-1", "embed.bawes.test:0", "embed.bawes.test:65536",
    "embed.bawes.test:443:443", "a_b.test", "-a.test", "a-.test", "a..test", "*.test", "a\u0000.test", "é.test",
    "a".repeat(64) + ".test", Array(5).fill("a".repeat(63)).join("."), "[::1", "::1", "[invalid]", "[::1].", "127.1", "0x7f000001"];
  const cases = [[], ["Host", "embed.bawes.test", "HOST", "studenthub.test.invalid"],
    ["Host", "embed.bawes.test", "Host", "embed.bawes.test"], ...invalid.map((host) => ["Host", host])];
  for (const env of [ENV, enabled]) for (const raw of cases) {
    const result = call(raw, createUniverseEmbedConfigFromEnv(env, MAIN));
    assert.equal(result.handled, true, JSON.stringify(raw));
    assert.equal(result.status, 400, JSON.stringify(raw));
    assert.equal(result.headers["x-frame-options"], "DENY");
    assert.match(result.headers["content-security-policy"]!, /frame-ancestors 'none'/);
    assert.equal(result.body, '{"error":"bad_request"}');
  }
});

test("E1_HOST_ABSENT no reservation preserves existing handling even for unusual Host", () => {
  for (const rawHeaders of [[], ["Host", "malformed@@"], ["Host", "a", "Host", "b"]]) {
    const request = { rawHeaders } as IncomingMessage;
    const response = new Proxy({}, { get() { throw new Error("unreserved gate touched response"); } }) as ServerResponse;
    assert.equal(gateUniverseEmbedRequest(request, response), false);
  }
});

test("E1_HOST_FORWARDED ignores every forwarded substitute and only matches raw Host", () => {
  const forwarded = { "x-forwarded-host": "embed.bawes.test", forwarded: "host=embed.bawes.test;proto=https", ":authority": "embed.bawes.test" };
  assert.equal(call(["Host", "studenthub.test.invalid"], undefined, forwarded).handled, false);
  assert.equal(call(["Host", "embed.bawes.test"], undefined, { "x-forwarded-host": "studenthub.test.invalid" }).status, 404);
  assert.equal(call([], undefined, forwarded).status, 400);
});

test("E1_WIRE cookie-less probe and invalid Host use the real HTTP listener", async (t) => {
  for (const env of [enabled, ENV]) {
    const config = createUniverseEmbedConfigFromEnv(env, MAIN);
    const server = createGatewayServer(undefined, undefined, undefined, undefined, null, undefined,
      undefined, undefined, undefined, undefined, config);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    for (const hosts of [["Host", "EMBED.BAWES.TEST.:443"], [], ["Host", "embed.bawes.test", "Host", "studenthub.test.invalid"],
      ["Host", "user@embed.bawes.test"], ["Host", "embed.bawes.test:invalid"]]) {
      const probe = (method: "HEAD" | "GET") => new Promise<{ status: number; headers: IncomingMessage["headers"]; body: string }>((resolve, reject) => {
        const request = httpRequest({ hostname: "127.0.0.1", port: address.port, path: "/universe/embed",
          method, setHost: false, headers: [...hosts, "Connection", "close"] }, (response) => {
          let body = "";
          response.setEncoding("utf8");
          response.on("data", (chunk: string) => { body += chunk; });
          response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body }));
          response.on("error", reject);
        });
        request.setTimeout(3000, () => request.destroy(new Error("HTTP probe timed out")));
        request.on("error", reject);
        request.end();
      });
      // Match the real Universe EmbeddableWebsiteProbe's cookie-less HEAD-first
      // request. It does not retry GET on our previous 404 response.
      const response = await probe("HEAD");
      const valid = hosts.length === 2 && hosts[1] === "EMBED.BAWES.TEST.:443";
      assert.equal(response.status, valid ? config!.enabled ? 200 : 404 : 400, "HEAD-first Universe probe must reach the display policy");
      assert.equal(response.body, "", "HEAD sends no representation body");
      assert.equal(response.headers["cache-control"], "no-store");
      assert.equal(response.headers["set-cookie"], undefined);
      assert.equal(response.headers["x-frame-options"], valid && config!.enabled ? undefined : "DENY");
      assert.match(String(response.headers["content-security-policy"]), valid && config!.enabled
        ? /frame-ancestors https:\/\/universe.bawes.test/ : /frame-ancestors 'none'/);
      if (valid && config!.enabled) {
        const get = await probe("GET");
        const stable = (headers: IncomingMessage["headers"]) => Object.fromEntries(Object.entries(headers).filter(([key]) => key !== "date"));
        assert.equal(response.status, get.status);
        assert.deepEqual(stable(response.headers), stable(get.headers), "HEAD and GET expose identical response headers");
        assert.equal(Number(response.headers["content-length"]), Buffer.byteLength(get.body));
        assert.match(get.body, /not ready yet/);
      }
    }
  }
});
