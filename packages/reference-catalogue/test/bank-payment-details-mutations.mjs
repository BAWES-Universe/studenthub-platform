import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const detailsPath = new URL("../dist/bank-payment-details.js", import.meta.url);
const cataloguePath = new URL("../dist/catalogue.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/reference-catalogue/test/bank-payment-details.test.js", import.meta.url));
const files = new Map([[detailsPath, await readFile(detailsPath, "utf8")], [cataloguePath, await readFile(cataloguePath, "utf8")]]);
const mutations = [
  ["broad SWIFT shape", detailsPath, "/^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/", "/^[A-Z0-9]{8,11}$/", "SHU-320/AC-01 swift-shape"],
  ["open transfer type", detailsPath, "if (!BANK_TRANSFER_TYPES.includes(transferType))", "if (false && !BANK_TRANSFER_TYPES.includes(transferType))", "SHU-320/AC-02 transfer-type-closed"],
  ["staff bank writer", detailsPath, "return role === \"admin\";", "return role === \"admin\" || role === \"staff\";", "SHU-320/AC-03 admin-only"],
  ["inactive bank write", cataloguePath, "if (bank?.status !== \"active\")", "if (false && bank?.status !== \"active\")", "SHU-320/AC-04 active-bank-only"],
  ["open input object", detailsPath, "if (keys.join(\",\") !== \"abkCode,ibanBankCode,swiftCode,transferType\"", "if (false && keys.join(\",\") !== \"abkCode,ibanBankCode,swiftCode,transferType\"", "SHU-320/AC-05 closed-input"],
];

try {
  for (const [name, path, from, to, assertionName] of mutations) {
    const original = files.get(path);
    assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
    await writeFile(path, original.replace(from, to));
    const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap", `--test-name-pattern=^${assertionName} `, suite], { encoding: "utf8", timeout: 30_000 });
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
process.stdout.write("5/5 SHU-320 mutations killed\n");
