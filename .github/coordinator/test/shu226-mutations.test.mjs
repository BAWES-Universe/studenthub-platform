import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COORDINATOR = path.join(HERE, "..");

const CASES = [
  {
    name: "M1 bypass the existing deterministic identity guard",
    from: "    if (!existing) {",
    to: "    if (true) { // SHU226-M1",
    pattern: "replay does not duplicate",
    named: /replay does not duplicate/,
  },
  {
    name: "M2 report a generic refused activation",
    from: '  if (activation.state === "refused" && !REPORTING_EXCEPTIONS.has(activation.reporting_exception)) return null;',
    to: '  if (false && activation.state === "refused" && !REPORTING_EXCEPTIONS.has(activation.reporting_exception)) return null; // SHU226-M2',
    pattern: "a refused activation still writes zero$",
    named: /a refused activation still writes zero/,
  },
  {
    name: "M3 ignore disabled reporting authority",
    from: '  if (!authorized || !event || !UUID_RE.test(targetLinearId ?? "") || !token || typeof sendLinear !== "function") return { status: "not_authorized" };',
    to: '  if (false || !event || !UUID_RE.test(targetLinearId ?? "") || !token || typeof sendLinear !== "function") return { status: "not_authorized" }; // SHU226-M3',
    pattern: "disabled means disabled: zero writes",
    named: /disabled means disabled: zero writes/,
  },
  {
    name: "M4 let reporting failure control the stop result",
    from: '    return { status: exhausted ? "exhausted" : "pending", event_id: event.event_id };',
    to: '    return { status: "blocked_on_reporting", event_id: event.event_id }; // SHU226-M4',
    pattern: "a failed card write never prevents the stop",
    named: /a failed card write never prevents the stop/,
  },
  {
    name: "M5 append an environment value to the card body",
    from: "    event.explanation,",
    to: '    event.explanation + (process.env.SHU226_MUTATION_SECRET ?? ""), // SHU226-M5',
    pattern: "the card carries no secrets",
    named: /the card carries no secrets/,
  },
  {
    name: "M6 file in a pickable state",
    from: 'export const INCIDENT_STATE_NAME = "Triage";',
    to: 'export const INCIDENT_STATE_NAME = "Todo"; // SHU226-M6',
    pattern: "an incident card is filed in Triage, never pickable",
    named: /an incident card is filed in Triage, never pickable/,
  },
  {
    name: "M7 treat pending as delivered",
    from: '  if (markers.some((marker) => marker.status === "confirmed")) return { status: "confirmed", event_id: event.event_id };',
    to: '  if (markers.some((marker) => marker.status === "confirmed" || marker.status === "pending")) return { status: "confirmed", event_id: event.event_id }; // SHU226-M7',
    pattern: "an unconfirmed report is never treated as delivered",
    named: /an unconfirmed report is never treated as delivered/,
  },
  {
    name: "M8 regenerate event identity on restart",
    from: '  const digest = createHash("sha256").update(`${activationId}\\0${reasonCode}`).digest("hex").slice(0, 32);',
    to: '  const digest = createHash("sha256").update(`${activationId}\\0${reasonCode}\\0${Math.random()}`).digest("hex").slice(0, 32); // SHU226-M8',
    pattern: "restart keeps the same event identity",
    named: /restart keeps the same event identity/,
  },
  {
    name: "M9 let reporting-only authority launch",
    from: "export function reportingExceptionAllowsLaunch(_activation) {\n  return false;\n}",
    to: "export function reportingExceptionAllowsLaunch(_activation) {\n  return true; // SHU226-M9\n}",
    pattern: "reporting a spent or expired proven episode can never launch",
    named: /reporting a spent episode can never launch/,
  },
  {
    name: "M10 remove durable launch proof",
    from: "  if (!launched) return null;",
    to: "  if (false && !launched) return null; // SHU226-M10",
    pattern: "an unproven episode never writes$",
    named: /an unproven episode never writes/,
  },
  {
    name: "M11 forward a raw receipt into the rendered attempt",
    from: "  const attempts = event.attempts.map(sanitizedAttempt);",
    to: "  const attempts = event.attempts.map((receipt) => ({ ...sanitizedAttempt(receipt), result_sha: JSON.stringify(receipt) })); // SHU226-M11",
    pattern: "no raw evidence in reporting output",
    named: /no raw evidence in reporting output|the card carries no secrets/,
  },
  {
    name: "M12 remove the injected timeout bound",
    from: '      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("bounded timeout"), { code: "INCIDENT_TIMEOUT" })), timeoutMs); }),',
    to: '      new Promise((_, reject) => { timer = setTimeout(() => reject(Object.assign(new Error("unbounded mutation"), { code: "INCIDENT_TIMEOUT" })), 1000); }), // SHU226-M12',
    pattern: "reporting is bounded",
    named: /reporting is bounded/,
  },
];

for (const mutation of CASES) {
  test(`SHU-226 mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu226-mutation-"));
    try {
      fs.cpSync(COORDINATOR, root, { recursive: true });
      const target = path.join(root, "incident-reporting.mjs");
      const source = fs.readFileSync(target, "utf8");
      assert.equal(source.split(mutation.from).length, 2, `${mutation.name}: mutation anchor must be unique`);
      fs.writeFileSync(target, source.replace(mutation.from, mutation.to));
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, [
        "--test",
        `--test-name-pattern=${mutation.pattern}`,
        path.join(root, "test", "shu226-incident-reporting.test.mjs"),
      ], { cwd: root, env: childEnv, encoding: "utf8", timeout: 15_000 });
      assert.equal(run.signal, null, `${mutation.name}: a timeout or crash is not a mutation kill`);
      assert.equal(run.status, 1, `${mutation.name}: mutation survived\n${run.stdout}\n${run.stderr}`);
      assert.match(run.stdout + run.stderr, /AssertionError/, `${mutation.name}: must fail by assertion`);
      assert.match(run.stdout + run.stderr, mutation.named, `${mutation.name}: must fail its named test`);
      assert.doesNotMatch(run.stdout + run.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${mutation.name}: infrastructure crashes do not count`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
