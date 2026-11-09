import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const root = new URL("../../../dist/apps/gateway/", import.meta.url);
const definitions = {
  policy: { source: "src/universe/embed-policy.js", test: "test/universe-embed-policy.test.js", variable: "E1_POLICY_MODULE" },
  gate: { source: "src/universe/embed-host-gate.js", test: "test/universe-embed-host-gate.test.js", variable: "E1_HOST_GATE_MODULE" },
  gateway: { source: "src/index.js", test: "test/universe-embed-http.test.js", variable: "E1_GATEWAY_MODULE" },
  startup: { source: "src/index.js", test: "test/universe-embed-policy.test.js", variable: "E1_GATEWAY_MODULE" },
  wire: { source: "src/index.js", test: "test/universe-embed-host-gate.test.js", variable: "E1_GATEWAY_MODULE" },
};
const mutations = [
  ["caller replaces security headers", "policy", "E1_HEADER_PRECEDENCE", "...additional, ...policy.headers", "...policy.headers, ...additional"],
  ["app becomes frameable", "policy", "E1_APP_POLICY", "`${BASE_CSP}; frame-ancestors 'none'`", "`${BASE_CSP}; frame-ancestors https://universe.bawes.test`"],
  ["preserved CSP directive removed", "policy", "E1_EMBED_POLICY", "; base-uri 'none'", ""],
  ["partial enablement admitted", "policy", "E1_CONFIG_FAIL", 'if (enabled === "true" && (ancestors.length === 0 || callbackUrl === undefined))', "if (false)"],
  ["disabled hostname released", "gate", "E1_HOST_CANONICAL", "if (!config)", "if (!config || !config.enabled)"],
  ["duplicate Host admitted", "gate", "E1_HOST_MALFORMED", "hosts.length === 1", "hosts.length >= 1"],
  ["canonical Host comparison removed", "gate", "E1_HOST_CANONICAL", "canonicalEmbedHost(hosts[0])", "hosts[0]"],
  ["terminal host gate removed", "gateway", "E1 terminal gate", "if (gateUniverseEmbedRequest(request, response, universeEmbed))", "if (false)"],
  ["runtime configuration ignored", "startup", "E1_STARTUP", "createUniverseEmbedConfigFromEnv(process.env, runtimeLogin?.application.web?.origin)", "undefined"],
  ["missing Host bypasses response policy", "wire", "E1_WIRE", "requireHostHeader: universeEmbed === undefined", "requireHostHeader: true"],
];

for (const [name, kind, pattern, from, to] of mutations) {
  const definition = definitions[kind];
  const source = new URL(definition.source, root);
  const original = await readFile(source, "utf8");
  assert.equal(original.split(from).length - 1, 1, `${name}: mutation binds exactly once`);
  const suite = fileURLToPath(new URL(definition.test, root));
  const args = ["--test", "--test-reporter=tap", `--test-name-pattern=^${pattern}`, suite];
  const control = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 15000 });
  assert.equal(control.error, undefined, `${name}: control execution error`);
  assert.equal(control.status, 0, `${name}: control failed\n${control.stdout}${control.stderr}`);
  const target = new URL(`e1-mutant-${process.pid}-${kind}.js`, source);
  try {
    await writeFile(target, original.replace(from, to));
    const syntax = spawnSync(process.execPath, ["--check", fileURLToPath(target)], { encoding: "utf8" });
    assert.equal(syntax.status, 0, `${name}: syntax must remain valid`);
    const result = spawnSync(process.execPath, args, { encoding: "utf8", timeout: 15000,
      env: { ...process.env, [definition.variable]: target.href },
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, `${name}: mutant execution error`);
    assert.equal(result.status, 1, `${name}: mutant must fail at its assertion\n${output}`);
    assert.match(output, new RegExp(`not ok \\d+ - ${pattern}`));
    assert.match(output, /ERR_ASSERTION/);
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/);
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
  } finally {
    await unlink(target).catch(() => undefined);
  }
}
process.stdout.write(`${mutations.length}/${mutations.length} Universe embed mutations killed\n`);
