import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const routesSource = new URL("../../../dist/apps/gateway/src/routes/index.js", import.meta.url);
const contextSource = new URL("../../../dist/apps/gateway/src/routes/context.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/apps/gateway/test/routes-order.test.js", import.meta.url));
const routesOriginal = await readFile(routesSource, "utf8");
const contextOriginal = await readFile(contextSource, "utf8");
const mutations = [
  ["swap adjacent routes", "PREP_ORDER", "routes", "    payContractsRoute,\n    organizationBrandsRoute,", "    organizationBrandsRoute,\n    payContractsRoute,"],
  ["delete pay-contracts", "PREP_ORDER", "routes", "    payContractsRoute,\n", ""],
  ["continue after true", "PREP_FIRST_WINS", "context", "            return true;", "            continue;"],
  ["swallow thrown error", "PREP_FIRST_WINS", "context", "await route.handle(ctx)", "await route.handle(ctx).catch(() => false)"],
  ["copy route context", "PREP_FIRST_WINS", "context", "await route.handle(ctx)", "await route.handle({ ...ctx })"],
];

for (const [name, pattern, kind, from, to] of mutations) {
  const original = kind === "routes" ? routesOriginal : contextOriginal;
  assert.equal(original.split(from).length - 1, 1, `${name} binds once`);
  const target = new URL(`../../../dist/apps/gateway/src/routes/${kind}-mutation-${process.pid}.js`, import.meta.url);
  try {
    await writeFile(target, original.replace(from, to));
    const variable = kind === "routes" ? "SHU497_ROUTES_MODULE" : "SHU497_CONTEXT_MODULE";
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `--test-name-pattern=^${pattern} `, suite], {
      encoding: "utf8", env: { ...process.env, [variable]: `${target.href}?mutation=${encodeURIComponent(name)}` }, timeout: 30000,
    });
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name} survived\n${output}`);
    assert.match(output, new RegExp(`not ok \\d+ - ${pattern} `));
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/);
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
  } finally {
    await unlink(target).catch(() => undefined);
  }
}
process.stdout.write("5/5 SHU-497 mutations killed\n");
