import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
const detailsPath = new URL("../dist/currency-details.js", import.meta.url); const cataloguePath = new URL("../dist/catalogue.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/reference-catalogue/test/currency-details.test.js", import.meta.url));
const files = new Map([[detailsPath, await readFile(detailsPath, "utf8")], [cataloguePath, await readFile(cataloguePath, "utf8")]]);
const mutations = [
  ["open input object", detailsPath, 'if (keys.join(",") !== "decimalPlaces,symbol")', 'if (false && keys.join(",") !== "decimalPlaces,symbol")', "SHU344_CLOSED_INPUT"],
  ["longer symbol", detailsPath, "[...symbol].length > 8", "[...symbol].length > 16", "SHU344_SYMBOL"],
  ["any decimal count", detailsPath, "!Number.isInteger(decimalPlaces)", "false && !Number.isInteger(decimalPlaces)", "SHU344_DECIMALS"],
  ["staff currency writer", detailsPath, 'return role === "admin";', 'return role === "admin" || role === "staff";', "SHU344_ADMIN_ONLY"],
  ["inactive currency write", cataloguePath, 'if (currency?.status !== "active" || currency.type !== "currency")', 'if (false && (currency?.status !== "active" || currency.type !== "currency"))', "SHU344_ACTIVE_ONLY"],
];
try { for (const [name, path, from, to, assertionName] of mutations) { const original = files.get(path); assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`); await writeFile(path, original.replace(from, to)); const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `--test-name-pattern=^${assertionName} `, suite], { encoding: "utf8", timeout: 30_000 }); const output = result.stdout + result.stderr; assert.notEqual(result.status, 0, `${name}: mutation survived`); assert.match(output, new RegExp(`not ok \\d+ - ${assertionName} `)); assert.match(output, /AssertionError/); process.stdout.write(`KILLED ${name} -> ${assertionName}\n`); await writeFile(path, original); } } finally { for (const [path, original] of files) await writeFile(path, original); }
process.stdout.write("5/5 SHU-344 mutations killed\n");
