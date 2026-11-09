import assert from "node:assert/strict";
import test from "node:test";
import type { ServerResponse } from "node:http";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { writeHtml } from "../src/web-ui.js";

const policy = await import(process.env.E1_POLICY_MODULE ?? new URL("../src/universe/embed-policy.js", import.meta.url).href) as typeof import("../src/universe/embed-policy.js");
const MAIN = "https://studenthub.test.invalid";
const ENV = {
  UNIVERSE_EMBED_ORIGIN: "https://embed.bawes.test",
  UNIVERSE_EMBED_ENABLED: "true",
  UNIVERSE_EMBED_ANCESTORS: "https://universe.bawes.test,https://dev.bawes.test:8443",
  UNIVERSE_EMBED_OIDC_CALLBACK_URL: "https://embed.bawes.test/login/callback",
};
const CSP = "default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; form-action 'self'";

function capture() {
  let status = 0, body = "";
  const headers: Record<string, string> = {};
  const response = {
    removeHeader(name: string) { delete headers[name.toLowerCase()]; },
    writeHead(code: number, values: Record<string, string>) { status = code; Object.assign(headers, values); },
    end(value: string) { body = value; },
  } as unknown as ServerResponse;
  return { response, headers, value: () => ({ status, body, headers }) };
}

test("E1_CONFIG absent stays off; reservation is independent of enablement and immutable", () => {
  assert.equal(policy.createUniverseEmbedConfigFromEnv({}), undefined);
  assert.equal(policy.createUniverseEmbedConfigFromEnv({ OTHER: "unused" }, "invalid"), undefined);
  for (const enabled of [undefined, "false"]) {
    const config = policy.createUniverseEmbedConfigFromEnv({ UNIVERSE_EMBED_ORIGIN: ENV.UNIVERSE_EMBED_ORIGIN,
      ...(enabled === undefined ? {} : { UNIVERSE_EMBED_ENABLED: enabled }) }, MAIN)!;
    assert.equal(config.enabled, false);
    assert.equal(config.host, "embed.bawes.test");
    assert.deepEqual(config.ancestors, []);
    assert.throws(() => policy.universeEmbedPolicy(config), /Invalid Universe embed configuration/);
    assert.ok(Object.isFrozen(config));
    assert.ok(Object.isFrozen(config.ancestors));
  }
  const config = policy.createUniverseEmbedConfigFromEnv({ ...ENV,
    UNIVERSE_EMBED_ORIGIN: "HTTPS://Embed.Bawes.Test.:0443",
    UNIVERSE_EMBED_ANCESTORS: "https://UNIVERSE.bawes.test.:443, https://dev.bawes.test:8443,https://universe.bawes.test",
  }, MAIN)!;
  assert.equal(config.origin, "https://embed.bawes.test");
  assert.equal(config.mainOrigin, MAIN);
  assert.equal(config.callbackUrl, ENV.UNIVERSE_EMBED_OIDC_CALLBACK_URL);
  assert.equal(config.enabled, true);
  assert.deepEqual(config.ancestors, ["https://universe.bawes.test", "https://dev.bawes.test:8443"]);
});

test("E1_CONFIG_FAIL invalid or partial settings refuse startup without leaking values", () => {
  for (const env of [
    { UNIVERSE_EMBED_ENABLED: "true" }, { UNIVERSE_EMBED_ENABLED: "false" },
    { UNIVERSE_EMBED_ANCESTORS: ENV.UNIVERSE_EMBED_ANCESTORS },
    { UNIVERSE_EMBED_OIDC_CALLBACK_URL: ENV.UNIVERSE_EMBED_OIDC_CALLBACK_URL },
    { UNIVERSE_EMBED_ORIGIN: ENV.UNIVERSE_EMBED_ORIGIN, UNIVERSE_EMBED_ENABLED: "true" },
    { ...ENV, UNIVERSE_EMBED_ANCESTORS: undefined }, { ...ENV, UNIVERSE_EMBED_OIDC_CALLBACK_URL: undefined },
    ...["", "TRUE", "1", "yes", " false"].map((value) => ({ ...ENV, UNIVERSE_EMBED_ENABLED: value })),
    ...["", "http://embed.bawes.test", "https://embed.bawes.test/", "https://embed.bawes.test/path", "https://embed.bawes.test?x", "https://secret:password@embed.bawes.test", "https://embed.bawes.test..", "https://embed.bawes.test:65536", "https://*.bawes.test", "https://embed.bawes.test\\other"].map((value) => ({ ...ENV, UNIVERSE_EMBED_ORIGIN: value })),
    ...["", "'self'", "https:", "*", "https://*.bawes.test", "https://universe.bawes.test/", "https://universe.bawes.test/path", "https://universe.bawes.test#x", "http://universe.bawes.test", "https://universe.bawes.test,", "https://user:password@universe.bawes.test"].map((value) => ({ ...ENV, UNIVERSE_EMBED_ANCESTORS: value })),
    ...["", "http://embed.bawes.test/login/callback", "https://other.bawes.test/login/callback", "https://embed.bawes.test", "https://embed.bawes.test/login/callback?code=secret", "https://embed.bawes.test/login/callback#secret", "https://embed.bawes.test/login\\callback", "https://user:secret@embed.bawes.test/login/callback"].map((value) => ({ ...ENV, UNIVERSE_EMBED_OIDC_CALLBACK_URL: value })),
    { ...ENV, UNIVERSE_EMBED_ENABLED: "false", UNIVERSE_EMBED_ANCESTORS: "*" },
  ]) {
    assert.throws(() => policy.createUniverseEmbedConfigFromEnv(env, MAIN),
      { message: "Invalid Universe embed configuration" }, JSON.stringify(env));
  }
  for (const mainOrigin of [undefined, "", "not-an-origin", "https://EMBED.BAWES.TEST.:443", "http://embed.bawes.test:80", "http://embed.bawes.test:443"]) {
    assert.throws(() => policy.createUniverseEmbedConfigFromEnv(ENV, mainOrigin), /Invalid Universe embed configuration/);
  }
  assert.doesNotThrow(() => policy.createUniverseEmbedConfigFromEnv(ENV, "https://embed.bawes.test:8443"));
});

test("E1_STARTUP executable validates configuration before listening", () => {
  const entry = fileURLToPath(process.env.E1_GATEWAY_MODULE ?? new URL("../src/index.js", import.meta.url));
  const child = spawnSync(process.execPath, [entry], { encoding: "utf8", timeout: 5000,
    env: { PATH: process.env.PATH, HOST: "127.0.0.1", UNIVERSE_EMBED_ENABLED: "true" },
  });
  assert.equal(child.error, undefined, "invalid startup must exit rather than listen");
  assert.notEqual(child.status, 0);
  assert.match(child.stderr, /Invalid Universe embed configuration/);
  assert.doesNotMatch(child.stdout, /listening/);
});

test("E1_APP_POLICY equals today's default HTML protection and cannot frame app pages", () => {
  const app = capture(), baseline = capture();
  policy.writeEmbedResponse(app.response, 404, "not found", "text/html; charset=utf-8");
  writeHtml(baseline.response, 404, "not found");
  assert.deepEqual(app.value(), baseline.value(), "reserved-host app policy equals existing main HTML policy");
  assert.equal(app.headers["x-frame-options"], "DENY");
  assert.equal(app.headers["content-security-policy"], `${CSP}; frame-ancestors 'none'`);
});

test("E1_EMBED_POLICY preserves every directive and only display may omit XFO", () => {
  const config = policy.createUniverseEmbedConfigFromEnv(ENV, MAIN)!;
  const display = capture();
  policy.writeEmbedResponse(display.response, 200, "ready later", "text/html; charset=utf-8", policy.universeEmbedPolicy(config));
  assert.equal(display.headers["content-security-policy"], `${CSP}; frame-ancestors https://universe.bawes.test https://dev.bawes.test:8443; script-src 'self'; connect-src 'self'`, "all original CSP directives must remain");
  assert.equal(display.headers["x-frame-options"], undefined);
  assert.equal(display.headers["cache-control"], "no-store");
  assert.equal(display.headers["referrer-policy"], "same-origin");
  assert.equal(display.headers["x-content-type-options"], "nosniff");
  assert.equal(display.headers.vary, "Accept");
  assert.doesNotMatch(display.headers["content-security-policy"]!, /unsafe-inline|unsafe-eval|\*/);
  assert.ok(Object.isFrozen(policy.universeEmbedPolicy(config).headers));
});

test("E1_HEADER_PRECEDENCE caller headers cannot weaken security or add XFO to display", () => {
  const config = policy.createUniverseEmbedConfigFromEnv(ENV, MAIN)!;
  for (const selected of [policy.APP_POLICY, policy.universeEmbedPolicy(config)]) {
    const output = capture();
    output.headers["x-frame-options"] = "SAMEORIGIN";
    policy.writeEmbedResponse(output.response, 200, "safe", "text/html; charset=utf-8", selected, {
      "Content-Security-Policy": "default-src *; frame-ancestors *", "X-Frame-Options": "SAMEORIGIN",
      "Cache-Control": "public", "Referrer-Policy": "unsafe-url", "X-Content-Type-Options": "unsafe",
      "Content-Type": "text/plain", "Vary": "Cookie", "x-test": "kept",
    });
    assert.equal(output.headers["content-security-policy"], selected.headers["content-security-policy"], "policy wins over caller headers");
    assert.equal(output.headers["x-frame-options"], selected.headers["x-frame-options"]);
    assert.equal(output.headers["cache-control"], "no-store");
    assert.equal(output.headers["referrer-policy"], "same-origin");
    assert.equal(output.headers["content-type"], "text/html; charset=utf-8");
    assert.equal(output.headers["x-test"], "kept");
  }
});
