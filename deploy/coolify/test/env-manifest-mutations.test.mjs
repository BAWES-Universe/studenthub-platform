import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = new URL("../../..", import.meta.url);
const cases = [
  {
    name: "drop runtime derivation",
    file: "deployment-env-manifest.mjs",
    from: "  ...REQUIRED_DEPLOYMENT_ENV,",
    to: "",
    pattern: "SHU-243 manifest derives",
  },
  {
    name: "remove missing-key comparison",
    file: "check-env-manifest.mjs",
    from: "  const missing = missingOrEmptyRequiredEnv(entries, manifest.required);",
    to: "  const missing = [];",
    pattern: "SHU-243 missing key fails",
  },
  {
    name: "treat empty as present",
    file: "check-env-manifest.mjs",
    from: "return required.filter((key) => !deployed.has(key) || deployed.get(key).trim().length === 0);",
    to: "return required.filter((key) => !deployed.has(key));",
    pattern: "SHU-243 present-but-empty key fails",
  },
];

for (const mutation of cases) {
  test(`SHU-243 mutation kills ${mutation.name}`, () => {
    const root = mkdtempSync(join(tmpdir(), "shu243-mutation-"));
    try {
      cpSync(new URL("../", import.meta.url), root, { recursive: true });
      const target = join(root, mutation.file);
      const original = readFileSync(target, "utf8");
      assert.equal(original.split(mutation.from).length - 1, 1, `${mutation.name}: mutation anchor must be unique`);
      writeFileSync(target, original.replace(mutation.from, mutation.to));
      const run = spawnSync(process.execPath, [
        "--test",
        `--test-name-pattern=${mutation.pattern}`,
        join(root, "test", "env-manifest.test.mjs"),
      ], {
        cwd: fileURLToPath(repositoryRoot),
        encoding: "utf8",
        env: Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== "NODE_TEST_CONTEXT")),
        timeout: 30_000,
      });
      const output = run.stdout + run.stderr;
      assert.equal(run.status, 1, `${mutation.name} survived or did not run:\n${output}`);
      assert.match(output, /AssertionError/, `${mutation.name} must fail a named assertion:\n${output}`);
      assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${mutation.name} must not crash the suite:\n${output}`);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
