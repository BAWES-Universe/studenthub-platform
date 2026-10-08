import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// The suite imports the root build of ../src, so the mutations target that build.
const at = (file) => new URL(`../../../dist/packages/pay-contracts/src/${file}`, import.meta.url);
const contractsPath = at("contracts.js");
const resolutionPath = at("resolution.js");
const bankPath = at("bank.js");
const storePath = at("memory-store.js");
const bankWritePath = at("bank-write.js");
const suiteAt = (file) => fileURLToPath(new URL(`../../../dist/packages/pay-contracts/test/${file}`, import.meta.url));
const contractsSuite = suiteAt("contracts.test.js");
const bankWriteSuite = suiteAt("bank-write.test.js");
const gatewayPath = new URL("../../../dist/apps/gateway/src/bank-details.js", import.meta.url);
const httpSuite = fileURLToPath(new URL("../../../dist/apps/gateway/test/bank-details-http.test.js", import.meta.url));
const files = new Map(await Promise.all([contractsPath, resolutionPath, bankPath, storePath, bankWritePath, gatewayPath].map(async (path) => [path, await readFile(path, "utf8")])));
const mutations = [
  ["overlap check dropped", contractsPath,
    "c.status !== \"deleted\" && c.id !== candidate.id && overlaps(c, candidate)",
    "false && overlaps(c, candidate)", "SHU182_OVERLAP_REFUSED"],
  ["rate returned without its resolution record", resolutionPath,
    "const base = { version: RATE_RESOLUTION_VERSION, steps: Object.freeze(steps),",
    "const base = { version: RATE_RESOLUTION_VERSION, steps: Object.freeze([]),", "SHU182_RESOLUTION_RECORDED"],
  ["mod-97 check skipped", bankPath,
    "return ibanChecksumValid(iban) ? iban : undefined;",
    "return iban;", "SHU182_IBAN_MOD97"],
  ["ambiguity resolved to the newest instead of refused", resolutionPath,
    "if (matches.length > 1)",
    "if (false)", "SHU182_AMBIGUOUS_REJECTED"],
  ["explicit filter allowed to fall through to manual pay", resolutionPath,
    "if (matches.length === 0 && (input.contractId !== undefined ||",
    "if (false && (input.contractId !== undefined ||", "SHU182_FILTER_NOT_BYPASS"],
  ["unregistered IBAN country accepted", bankPath,
    "if (iban.length !== IBAN_LENGTHS[iban.slice(0, 2)])",
    "if (IBAN_LENGTHS[iban.slice(0, 2)] !== undefined && iban.length !== IBAN_LENGTHS[iban.slice(0, 2)])", "SHU182_IBAN_MOD97"],
  ["impossible period dates accepted by shape alone", resolutionPath,
    "return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value && !value.startsWith(\"0000\");",
    "return true;", "SHU182_PERIOD_SELECTION"],
  ["contract write moved outside the audit's transaction", storePath,
    "if (rows.has(contract.id))",
    "this.#rows.set(contract.id, contract); if (rows.has(contract.id))", "SHU182_AUDIT_ATOMIC"],
  ["bank details previewed without the catalogue check", bankWritePath,
    "await checked(request) ? implementation.preview(request)",
    "true ? implementation.preview(request)", "SHU182_BANK_VALUE_CHECKED", bankWriteSuite],
  ["bank details confirmed without re-checking the catalogue", bankWritePath,
    "await checked(request) ? implementation.confirm(request)",
    "true ? implementation.confirm(request)", "SHU182_BANK_VALUE_CHECKED", bankWriteSuite],
  ["non-canonical bank details value accepted", bankWritePath,
    "return bankDetailsValue(details) === value ? Object.freeze(details) : undefined;",
    "return Object.freeze(details);", "SHU182_BANK_CANONICAL", bankWriteSuite],
  ["any grant may keep bank details", bankWritePath,
    "rows.some((row) => row.role === \"candidate\")",
    "rows.some((row) => true)", "SHU182_BANK_OWNER", bankWriteSuite],
  ["beneficiary name counted in UTF-16 units", bankPath,
    "const length = [...cleaned].length;", "const length = cleaned.length;", "SHU182_BANK_CANONICAL", bankWriteSuite],
  ["bank details accepted from any origin", gatewayPath,
    "if (request.headers.origin !== origin || request.headers[\"sec-fetch-site\"] === \"cross-site\")",
    "if (false)", "SHU182_BANK_HTTP_BOUNDARY", httpSuite],
  ["preview serves the full IBAN", gatewayPath,
    "ibanMasked: `${parsed.iban.slice(0, 4)}${\"•\".repeat(parsed.iban.length - 8)}${parsed.iban.slice(-4)}`",
    "ibanMasked: parsed.iban", "SHU182_BANK_HTTP_FLOW", httpSuite],
  ["unknown body keys accepted", gatewayPath,
    "if (!exactKeys(body, DETAIL_KEYS))", "if (false)", "SHU182_BANK_HTTP_INPUT", httpSuite],
];

try {
  for (const [name, path, from, to, assertionName, suite = contractsSuite] of mutations) {
    const original = files.get(path);
    assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
    await writeFile(path, original.replace(from, to));
    // The suite runs in this child process itself, not behind a `--test` file wrapper, so its own test names reach the TAP output.
    const result = spawnSync(process.execPath, ["--test-reporter=tap", `--test-name-pattern=^${assertionName} `, suite], { encoding: "utf8", timeout: 30_000 });
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `${name}: mutation survived`);
    assert.match(output, new RegExp(`not ok \\d+ - ${assertionName} `), `${name}: named assertion did not fail\n${output}`);
    assert.match(output, /AssertionError/, `${name}: did not die by assertion\n${output}`);
    process.stdout.write(`KILLED ${name} -> ${assertionName}\n`);
    await writeFile(path, original);
  }
} finally {
  for (const [path, original] of files) await writeFile(path, original);
}
process.stdout.write(`${mutations.length}/${mutations.length} SHU-182 mutations killed\n`);
