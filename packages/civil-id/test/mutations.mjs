import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Each guard is removed in the actual built module (or source migration).
// Assert the named test fails by assertion; restore bytes even on failure.
const root = new URL("../../../", import.meta.url);
const source = (name) => new URL(`dist/packages/civil-id/src/${name}.js`, root);
const unit = new URL("dist/packages/civil-id/test/civil-id.test.js", root);
const postgres = new URL("dist/packages/civil-id/test/civil-id-postgres.test.js", root);
const migration = new URL("packages/db/migrations/0190_civil_id_verification.sql", root);
const mutations = [
  ["deleted rows hold the number", "SHU-146/AC-01 reregister-after-delete", source("fixtures"),
    "!other.candidateDeleted && !row.candidateDeleted", "!row.candidateDeleted"],
  ["remove job dedupe", "SHU-146/AC-02 job-idempotent", source("verification"), "if (prior) {", "if (false) {"],
  ["OCR/manual omit review flag", "SHU-146/AC-03 ocr-sets-need-verification", source("verification"),
    "needVerification: true, source", "needVerification: false, source"],
  ["expiry not inclusive", "SHU-146/AC-04 expiry-boundary", source("expiry-gate"),
    "return expiryDate >= today;", "return expiryDate > today;"],
  ["UTC expiry instead of configured zone", "SHU-146/AC-04 expiry-boundary", source("expiry-gate"),
    'timeZone, calendar: "gregory"', 'timeZone: "UTC", calendar: "gregory"'],
  ["format accepts any string", "SHU-146/AC-05 format-server-side", source("format"),
    "if (!/^[0-9]+$/.test(number) || number.length !== CIVIL_ID_DECISIONS.digitCounts[countryCode])", "if (false)"],
  ["staff self scope is enough", "SHU-146/AC-06 staff-confirm-scope", source("verification"),
    'result.kind === "authorized" && result.context.scope === "subtree"', 'result.kind === "authorized"'],
  ["staff role anywhere is enough", "SHU-146/AC-06 staff-confirm-scope", source("verification"),
    'for (const orgId of CIVIL_ID_DECISIONS.operatorOrgIds) {',
    'const principal = await resolvePrincipalId(identity, deps.authz); if (principal && (await deps.authz.listGrantsForPrincipal(principal)).some(g => g.role === "staff")) return principal;\n    for (const orgId of CIVIL_ID_DECISIONS.operatorOrgIds) {'],
  ["error leaks a fixture number", "SHU-146/AC-07 no-number-in-logs", source("format"),
    "super(code);", 'super(code + " 289010112345");'],
  ["failed job not persisted", "SHU-146/AC-08 ocr-failure-explicit", source("verification"),
    "await tx.writeJob(job);", "if (code === null) await tx.writeJob(job);"],
  ["drop explicit provider failure", "SHU-146/AC-08 ocr-failure-explicit", source("verification"),
    'code = "civil_id_ocr_failed";', 'code = null;'],
  ["confirm a stale review", "SHU-146/AC-03 ocr-sets-need-verification", source("verification"),
    "if (row.revision !== request.expectedRevision)", "if (false)"],
];
const dbMutations = [
  ["DB lookup includes deleted rows", "SHU-146/parity-contract", source("postgres-civil-id-store"),
    "AND NOT candidate_deleted LIMIT 1", "LIMIT 1"],
  ["DB deleted rows hold the number", "SHU-146/parity-contract", migration,
    "ON candidate_civil_id (country_code, civil_id_number) WHERE NOT candidate_deleted;",
    "ON candidate_civil_id (country_code, civil_id_number);"],
  ["DB allows active duplicates", "SHU-146/parity-contract", migration,
    "CREATE UNIQUE INDEX candidate_civil_id_active_number\n  ON candidate_civil_id (country_code, civil_id_number) WHERE NOT candidate_deleted;", ""],
  ["DB retry rewrites the ID", "SHU-146/parity-contract", source("verification"), "if (prior) {", "if (false) {"],
];
function run(suite, title) {
  const result = spawnSync(process.execPath, ["--test", "--test-reporter=tap",
    ...(title ? [`--test-name-pattern=^${title}$`] : []), fileURLToPath(suite)],
  { encoding: "utf8", timeout: 90_000, cwd: fileURLToPath(root), env: process.env });
  return { ...result, output: (result.stdout ?? "") + (result.stderr ?? "") };
}
async function battery(suite, cases) {
  const baseline = run(suite);
  assert.equal(baseline.status, 0, `baseline must pass\n${baseline.output}`);
  for (const [name, title, file, from, to] of cases) {
    const original = await readFile(file, "utf8");
    assert.equal(original.split(from).length - 1, 1, `mutation binds once: ${name}`);
    try {
      await writeFile(file, original.replace(from, to));
      const result = run(suite, title);
      assert.equal(result.error, undefined, `${name}: infrastructure failure`);
      assert.notEqual(result.status, 0, `${name}: survived\n${result.output}`);
      assert.ok(result.output.split("\n").some((line) => /^not ok [0-9]+ - /.test(line) && line.endsWith(`- ${title}`)), `${name}: named test did not fail\n${result.output}`);
      assert.match(result.output, /code: 'ERR_ASSERTION'/, `${name}: must fail by assertion\n${result.output}`);
      assert.doesNotMatch(result.output, /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/, `${name}: import/syntax failure`);
      process.stdout.write(`KILLED ${name} -> ${title}\n`);
    } finally { await writeFile(file, original); }
    const restored = run(suite);
    assert.equal(restored.status, 0, `${name}: restored suite must pass\n${restored.output}`);
  }
  process.stdout.write(`${cases.length}/${cases.length} SHU-146 ${suite === unit ? "unit" : "PostgreSQL"} mutations killed\n`);
}
await battery(unit, mutations);
if (process.env.DATABASE_URL) await battery(postgres, dbMutations);
else process.stdout.write("PostgreSQL mutations NOT RUN: supply a scratch DATABASE_URL; unit mutation results do not establish DB acceptance.\n");
