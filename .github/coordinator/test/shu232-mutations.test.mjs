import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

const CASES = [
  {
    name: "M1 remove envelope persistence",
    file: "adapters/claude-code.mjs",
    from: "    envelope = persistEnvelopeImpl({",
    to: "    envelope = { link: \"\" }; if (false) persistEnvelopeImpl({",
    pattern: "SHU-232 B1",
  },
  {
    name: "M2 persist only on the structured-success path",
    file: "adapters/claude-code.mjs",
    from: "  try {\n    envelope = persistEnvelopeImpl({",
    to: "  if (parseClaudeCallback(result.stdout).callback) try {\n    envelope = persistEnvelopeImpl({",
    pattern: "SHU-232 B2",
  },
  {
    name: "M3 collapse binding failures into NO_STRUCTURED_OUTPUT",
    file: "adapters/claude-code.mjs",
    from: "      reason_code: \"CALLBACK_BINDING_INVALID\",\n      reason: \"CALLBACK_BINDING_INVALID — structured callback failed attempt/head/stage/evidence binding\"",
    to: "      reason_code: \"NO_STRUCTURED_OUTPUT\",\n      reason: \"NO_STRUCTURED_OUTPUT — collapsed mutation\"",
    pattern: "SHU-232 B3",
  },
  {
    name: "M4 make envelope write failure fatal to the valid result",
    file: "adapters/claude-code.mjs",
    from: "  } catch (error) {\n    const note = `review envelope retention: ENVELOPE_RETENTION_FAILED",
    to: "  } catch (error) {\n    return { stage: \"FAILED\", error_code: \"ENVELOPE_RETENTION_FAILED\", ok: false };\n    const note = `review envelope retention: ENVELOPE_RETENTION_FAILED",
    pattern: "SHU-232 B4",
  },
  {
    name: "M5 persist the supplied environment with stdout",
    file: "adapters/claude-code.mjs",
    from: "  const bytes = Buffer.from(String(stdout ?? \"\"));",
    to: "  const bytes = Buffer.from(JSON.stringify({ stdout: String(stdout ?? \"\"), env }));",
    pattern: "SHU-232 B5",
  },
  {
    name: "M5b stop treating prompt context as sensitive envelope material",
    file: "adapters/claude-code.mjs",
    from: "SHU_REVIEW_PROMPT_SECRET: task_context",
    to: "SHU_REVIEW_PROMPT_CONTEXT: task_context",
    pattern: "SHU-232 B5",
  },
  {
    name: "M6 restore a posture where execution is never evidenced",
    file: "review-execution.mjs",
    from: "    const executed = probeOk && report?.tests?.executed === true;",
    to: "    const executed = false && probeOk && report?.tests?.executed === true;",
    pattern: "SHU-232 B6",
  },
  {
    name: "M7 allow PASS without a confined-execution evidence link",
    file: "adapters/claude-code.mjs",
    from: "  if (reviewEvidence?.executed !== true || !reviewEvidence.evidence_link) {",
    to: "  if (false) {",
    pattern: "SHU-232 B7",
  },
  {
    name: "M8 accept a fixture lane with no seed marker",
    file: "fixture-seed.mjs",
    from: "  if (start < 0 || start !== normalized.indexOf(CANONICAL_SEED) || start + CANONICAL_SEED.length !== normalized.length) {",
    to: "  if (false) {",
    pattern: "SHU-232 B8",
  },
  {
    name: "M9 allow the configured execution identity to own the B-ii workspace",
    file: "review-execution.mjs",
    from: "  const trustedOwner = stat.uid === 0 || stat.uid === ownUid;\n  const expectedKind = kind === \"file\" ? stat.isFile() : stat.isDirectory();\n  return expectedKind\n    && !stat.isSymbolicLink()\n    && trustedOwner\n    && stat.uid !== expectedUid",
    to: "  const trustedOwner = stat.uid === expectedUid || stat.uid === 0 || stat.uid === ownUid;\n  const expectedKind = kind === \"file\" ? stat.isFile() : stat.isDirectory();\n  return expectedKind\n    && !stat.isSymbolicLink()\n    && trustedOwner\n    && true",
    pattern: "SHU-232 B10",
  },
];

for (const mutation of CASES) {
  test(`SHU-232 mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu232-mutation-"));
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
        path.join(root, "test/reviewer-evidence.test.mjs"),
      ], { cwd: root, env: childEnv, encoding: "utf8", timeout: 30_000 });
      assert.equal(run.status, 1, `${mutation.name} survived or did not run:\n${run.stdout}\n${run.stderr}`);
      assert.match(run.stdout + run.stderr, /AssertionError/, `${mutation.name} must fail a named assertion`);
      assert.doesNotMatch(run.stdout + run.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${mutation.name} must not crash the suite`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
