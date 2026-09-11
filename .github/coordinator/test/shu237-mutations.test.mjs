import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CASES = [
  {
    name: "M1 bypass canonicalization",
    file: "review-execution.mjs",
    from: "    resolved = fsImpl.realpathSync(file);",
    to: "    resolved = file;",
    testFile: "shu237-portability.test.mjs",
    pattern: "SHU-237 A1/A2/A5",
  },
  {
    name: "M2 execute the unresolved alias after validation",
    file: "review-execution.mjs",
    from: "  const normalized = [executable, ...wrapper.slice(1)];",
    to: "  const normalized = [wrapper[0], ...wrapper.slice(1)];",
    testFile: "shu237-portability.test.mjs",
    pattern: "SHU-237 A1/A2/A5",
  },
  {
    name: "M2b pass sudo the unresolved sandbox alias",
    file: "review-execution.mjs",
    from: "    normalized[2] = trustedRootPath(wrapper[2], fsImpl);",
    to: "    normalized[2] = wrapper[2];",
    testFile: "shu237-portability.test.mjs",
    pattern: "SHU-237 A1/A2/A5|SHU-237 A3/A4",
  },
  {
    name: "M3 accept a non-root canonical target",
    file: "review-execution.mjs",
    from: "target.uid !== 0 || (target.mode & 0o022) !== 0",
    to: "false || (target.mode & 0o022) !== 0",
    testFile: "shu237-portability.test.mjs",
    pattern: "SHU-237 A3/A4",
  },
  {
    name: "M3b accept a non-regular canonical target",
    file: "review-execution.mjs",
    from: "if (!target.isFile() || target.isSymbolicLink()",
    to: "if (false || target.isSymbolicLink()",
    testFile: "shu237-portability.test.mjs",
    pattern: "SHU-237 A3/A4",
  },
  {
    name: "M3c accept a still-symbolic canonical target",
    file: "review-execution.mjs",
    from: "!target.isFile() || target.isSymbolicLink()",
    to: "!target.isFile() || false",
    testFile: "shu237-portability.test.mjs",
    pattern: "SHU-237 A3/A4",
  },
  {
    name: "M4 accept a writable canonical target",
    file: "review-execution.mjs",
    from: "(target.mode & 0o022) !== 0 || (target.mode & 0o111) === 0",
    to: "false || (target.mode & 0o111) === 0",
    testFile: "shu237-portability.test.mjs",
    pattern: "SHU-237 A3/A4",
  },
  {
    name: "M5 accept a writable canonical directory",
    file: "review-execution.mjs",
    from: "stat.uid !== 0 || (stat.mode & 0o022) !== 0",
    to: "stat.uid !== 0 || false",
    testFile: "shu237-portability.test.mjs",
    pattern: "SHU-237 A3/A4",
  },
  {
    name: "M4b accept a non-executable canonical target",
    file: "review-execution.mjs",
    from: "(target.mode & 0o111) === 0",
    to: "false",
    testFile: "shu237-portability.test.mjs",
    pattern: "SHU-237 A3/A4",
  },
  {
    name: "M6 accept a non-root canonical directory",
    file: "review-execution.mjs",
    from: "stat.uid !== 0 || (stat.mode & 0o022) !== 0",
    to: "false || (stat.mode & 0o022) !== 0",
    testFile: "shu237-portability.test.mjs",
    pattern: "SHU-237 A3/A4",
  },
  {
    name: "M7 fail open when canonical resolution errors",
    file: "review-execution.mjs",
    from: "  } catch {\n    throw new Error(\"review execution wrapper path must resolve to a trusted host file\");\n  }",
    to: "  } catch {\n    resolved = \"/usr/lib/cargo/bin/sudo\";\n  }",
    testFile: "shu237-portability.test.mjs",
    pattern: "SHU-237 A3/A4",
  },
  {
    name: "M7b forget that a canonical target with another basename is still configured sudo",
    file: "review-execution.mjs",
    from: "path.basename(wrapper[0]) === \"sudo\" || path.basename(executable) === \"sudo\"",
    to: "path.basename(executable) === \"sudo\"",
    testFile: "shu237-portability.test.mjs",
    pattern: "SHU-237 A3/A4",
  },
  {
    name: "M8 revert root-owned control-plane acceptance",
    file: "review-execution.mjs",
    from: "  const trustedOwner = stat.uid === 0 || stat.uid === ownUid;",
    to: "  const trustedOwner = stat.uid === ownUid;",
    testFile: "shu237-portability.test.mjs",
    pattern: "SHU-237 A6",
  },
  {
    name: "M9 accept reviewer and unrelated ownership",
    file: "review-execution.mjs",
    from: "  const trustedOwner = stat.uid === 0 || stat.uid === ownUid;",
    to: "  const trustedOwner = true;",
    testFile: "shu237-portability.test.mjs",
    pattern: "SHU-237 A7",
  },
  {
    name: "M10 accept writable control-plane objects",
    file: "review-execution.mjs",
    from: "    && (stat.mode & 0o022) === 0;",
    to: "    && true;",
    testFile: "shu237-portability.test.mjs",
    pattern: "SHU-237 A7",
  },
  {
    name: "M11 stop the B7 wrapper before the active child probe",
    file: "test/reviewer-evidence.test.mjs",
    from: "exec \"$@\"\\n`, { mode: 0o700 });",
    to: "exit 70\\n`, { mode: 0o700 });",
    testFile: "reviewer-evidence.test.mjs",
    pattern: "SHU-232 B7: an actual",
  },
  {
    name: "M12 restore B7's host-dependent /usr/bin/env premise",
    file: "test/reviewer-evidence.test.mjs",
    from: "SHU_REVIEW_EXEC_WRAPPER_JSON: JSON.stringify([unconfinedWrapper]),",
    to: "SHU_REVIEW_EXEC_WRAPPER_JSON: JSON.stringify([\"/usr/bin/env\"]),",
    testFile: "reviewer-evidence.test.mjs",
    pattern: "SHU-232 B7: an actual",
  },
];

for (const mutation of CASES) {
  test(`SHU-237 mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu237-mutation-"));
    try {
      fs.cpSync(new URL("../", import.meta.url), root, { recursive: true });
      const target = path.join(root, mutation.file);
      const original = fs.readFileSync(target, "utf8");
      assert.equal(original.split(mutation.from).length, 2, `${mutation.name}: mutation anchor must be unique`);
      fs.writeFileSync(target, original.replace(mutation.from, mutation.to));
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, [
        "--test",
        `--test-name-pattern=${mutation.pattern}`,
        path.join(root, "test", mutation.testFile),
      ], { cwd: root, env: childEnv, encoding: "utf8", timeout: 30_000 });
      assert.equal(run.status, 1, `${mutation.name} survived or did not run:\n${run.stdout}\n${run.stderr}`);
      assert.match(run.stdout + run.stderr, /AssertionError/, `${mutation.name} must fail a named assertion`);
      assert.doesNotMatch(run.stdout + run.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${mutation.name} must not crash the suite`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
