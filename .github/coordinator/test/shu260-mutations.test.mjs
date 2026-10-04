import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COORDINATOR = path.resolve(HERE, "..");

const CASES = [
  {
    name: "M1 unknown-reason auto-routing",
    from: "  const policy = policies[event?.reason_code] ?? null;",
    to: "  const policy = policies[event?.reason_code] ?? policies.ambiguous_hold; // SHU260-M1",
    pattern: "unknown-reason auto-routing",
  },
  {
    name: "M2 product-decision leakage",
    from: "  if (!Array.isArray(policy.authorities) || policy.authorities.some((authority) => FORBIDDEN_AUTHORITIES.has(authority))) return false;",
    to: "  if (!Array.isArray(policy.authorities) || false) return false; // SHU260-M2",
    pattern: "product-decision leakage",
  },
  {
    name: "M3 same-family verifier",
    from: "  if (writerFamily === verifierFamily) return false;",
    to: "  if (false && writerFamily === verifierFamily) return false; // SHU260-M3",
    pattern: "same-family verifier",
  },
  {
    name: "M4 duplicate card identity",
    from: "  const digest = createHash(\"sha256\").update(`coordinator-repair\\0${eventId}`).digest(\"hex\").slice(0, 32);",
    to: "  const digest = createHash(\"sha256\").update(`coordinator-repair\\0${eventId}\\0${Math.random()}`).digest(\"hex\").slice(0, 32); // SHU260-M4",
    pattern: "duplicate card",
  },
  {
    name: "M5 lost response recovery",
    from: "  } catch { /* a committed create/update may have lost its response; verify below */ }",
    to: "  } catch { return { status: \"WAITING_CONFIRMATION\", resume: TRIAGE_RESUME_AUTHORITY }; } // SHU260-M5",
    pattern: "lost response",
  },
  {
    name: "M6 raw-text leakage",
    from: "    policy.scope_template,",
    to: "    policy.scope_template + String(event.raw_text ?? \"\"), // SHU260-M6",
    pattern: "raw-text leakage",
  },
  {
    name: "M7 missing incident evidence",
    from: "  if (!String(issue.description ?? \"\").includes(`<!-- coordinator-incident-event ${event.event_id} -->`)) return false;",
    to: "  if (false && !String(issue.description ?? \"\").includes(`<!-- coordinator-incident-event ${event.event_id} -->`)) return false; // SHU260-M7",
    pattern: "missing evidence",
  },
  {
    name: "M8 premature resume",
    from: "export const TRIAGE_RESUME_AUTHORITY = false;",
    to: "export const TRIAGE_RESUME_AUTHORITY = true; // SHU260-M8",
    pattern: "no premature resume",
  },
  {
    name: "M9 self-edit capability",
    from: "export const TRIAGE_EFFECTS = Object.freeze([\"linear-read\", \"linear-write\", \"github-read\"]);",
    to: "export const TRIAGE_EFFECTS = Object.freeze([\"linear-read\", \"linear-write\", \"github-read\", \"filesystem-write\"]); // SHU260-M9",
    pattern: "self-edit",
  },
];

for (const mutation of CASES) {
  test(`SHU-260 mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu260-mutation-"));
    try {
      fs.cpSync(COORDINATOR, root, { recursive: true });
      const target = path.join(root, "incident-triage.mjs");
      const source = fs.readFileSync(target, "utf8");
      assert.equal(source.split(mutation.from).length, 2, `${mutation.name}: mutation anchor must be unique`);
      fs.writeFileSync(target, source.replace(mutation.from, mutation.to));
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, [
        "--test",
        `--test-name-pattern=${mutation.pattern}`,
        path.join(root, "test", "shu260-incident-triage.test.mjs"),
      ], { cwd: root, env, encoding: "utf8", timeout: 20_000 });
      assert.equal(run.signal, null, `${mutation.name}: timeout/crash is not a mutation kill`);
      assert.equal(run.status, 1, `${mutation.name}: mutation survived\n${run.stdout}\n${run.stderr}`);
      assert.match(run.stdout + run.stderr, /AssertionError/, `${mutation.name}: must fail by assertion`);
      assert.match(run.stdout + run.stderr, new RegExp(mutation.pattern), `${mutation.name}: must fail its named test`);
      assert.doesNotMatch(run.stdout + run.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${mutation.name}: infrastructure crash is not a kill`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
