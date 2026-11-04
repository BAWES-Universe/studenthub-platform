import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("../../../", import.meta.url)));
const read = path => readFileSync(resolve(root, path), "utf8");
const runbooks = ["deploy.md", "rollback.md", "incident.md", "secret-rotation.md", "alerts.md", "on-call.md"];
const sectionNames = ["Purpose", "When to use", "Who does it", "Before you start (checks)", "Steps", "How to verify", "If it goes wrong", "Related"];

function sectionErrors(text) {
  let cursor = -1;
  const errors = [];
  for (const name of sectionNames) {
    const next = text.indexOf(`## ${name}`);
    if (next < 0) errors.push(`missing ${name}`);
    else if (next <= cursor) errors.push(`out of order ${name}`);
    cursor = next;
  }
  if (!/## Steps\n[\s\S]*?\n1\. /.test(text)) errors.push("Steps is not numbered");
  return errors;
}

function alertCodes(source = read("packages/observability/src/alerts.ts")) {
  const match = source.match(/code:\s*([^;]+);/);
  assert.ok(match, "Alert code union is readable");
  return [...match[1].matchAll(/'([a-z_]+)'/g)].map(item => item[1]);
}

function alertRows(text = read("docs/runbooks/alerts.md")) {
  return [...text.matchAll(/^\| \[([a-z_]+)\]\(#\1\) \| ([^|]+) \| (SEV-[123]) \| ([^|]+) \| ([^|]+) \|$/gm)]
    .map(match => ({ code: match[1], owner: match[2].trim(), severity: match[3], action: match[4].trim(), escalation: match[5].trim() }));
}

const suspicious = [
  /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  /\b(?:sk_|ghp_)[A-Za-z0-9_-]+/,
  /https?:\/\/[^\s/:]+:[^\s/@]+@/,
  /\b[a-f0-9]{40,}\b/i,
  /\b(?=[A-Za-z0-9+/]{32,}={0,2}\b)(?=[A-Za-z0-9+/]*[A-Z])(?=[A-Za-z0-9+/]*[a-z])(?=[A-Za-z0-9+/]*\d)[A-Za-z0-9+/]+={0,2}\b/,
];
function secretErrors(text) { return suspicious.filter(pattern => pattern.test(text)).map(pattern => pattern.source); }

test("SHU215_SECTIONS runbooks have ordered operator sections, an index, and valid cited repository paths", () => {
  for (const file of runbooks) assert.deepEqual(sectionErrors(read(`docs/runbooks/${file}`)), [], file);
  const index = read("docs/runbooks/README.md");
  for (const file of runbooks) assert.match(index, new RegExp(`\\(${file.replace(".", "\\.")}\\)`));
  for (const file of runbooks) {
    const text = read(`docs/runbooks/${file}`);
    for (const [, cited] of text.matchAll(/`((?:deploy|docs|packages|apps|\.github)\/[A-Za-z0-9_./-]+)`/g)) {
      assert.ok(existsSync(resolve(root, cited)), `${file} cites missing ${cited}`);
    }
  }
  const mutant = read("docs/runbooks/deploy.md").replace("## How to verify", "## Verification removed");
  assert.ok(sectionErrors(mutant).includes("missing How to verify"), "required-section mutant survived");
});

test("SHU215_ALERT_MAP source alert union, routing table, anchors, and emitted runbooks agree exactly", () => {
  const codes = alertCodes().sort();
  const rows = alertRows();
  assert.deepEqual(rows.map(row => row.code).sort(), codes);
  assert.equal(new Set(rows.map(row => row.code)).size, rows.length);
  for (const row of rows) {
    assert.equal(row.owner, "platform-on-call");
    assert.ok(row.action && row.escalation);
    assert.equal(read("docs/runbooks/alerts.md").split(`### ${row.code}`).length - 1, 1);
  }
  const alertsSource = read("packages/observability/src/alerts.ts");
  const jobsSource = read("packages/observability/src/jobs.ts");
  assert.match(alertsSource, /runbook: `docs\/runbooks\/alerts\.md#\$\{code\}`/);
  assert.match(jobsSource, /runbook:`docs\/runbooks\/alerts\.md#\$\{code\}`/);
  const mutant = read("docs/runbooks/alerts.md").replace(/^\| \[journey_failures\].*\n/m, "");
  assert.notDeepEqual(alertRows(mutant).map(row => row.code).sort(), codes, "dropped-alert mutant survived");
});

test("SHU215_SECRETS integration register sections and credential-name whitelist contain no secret-shaped values", () => {
  const register = JSON.parse(read("deploy/coolify/integration-register.json"));
  const manifest = JSON.parse(read("deploy/coolify/deployment-env-manifest.json"));
  const text = read("docs/runbooks/secret-rotation.md");
  const allowedNames = new Set([...manifest.required, ...register.integrations.flatMap(entry => entry.credential_names),
    ...register.integrations.map(entry => entry.rotation_state)]);
  for (const entry of register.integrations) {
    assert.equal(text.split(`### ${entry.id} —`).length - 1, 1, `${entry.id} section`);
    const start = text.indexOf(`### ${entry.id} —`);
    const end = text.indexOf("\n### ", start + 1);
    const section = text.slice(start, end < 0 ? text.indexOf("\n## How to verify", start) : end);
    for (const name of entry.credential_names) assert.ok(section.includes(`\`${name}\``), `${entry.id} omits ${name}`);
  }
  const mentioned = [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]).filter(value => !value.includes("/") && !value.endsWith(".json"));
  for (const name of mentioned) assert.ok(allowedNames.has(name), `unregistered secret name ${name}`);
  for (const file of runbooks) assert.deepEqual(secretErrors(read(`docs/runbooks/${file}`)), [], file);
  assert.notDeepEqual(secretErrors(`${text}\nsk_FAKEVALUEFORTESTONLY1234567890`), [], "fake-secret mutant survived");
});

test("SHU215_ROTA template fields are blank and block production go-no-go", () => {
  const text = read("docs/runbooks/on-call.md");
  for (const field of ["Cutover window", "Primary", "Backup"]) assert.match(text, new RegExp(`\\*\\*${field}:\\*\\* _{3,}`));
  assert.match(text, /Any blank cutover window, primary, or backup field blocks the production go\/no-go\./);
  assert.doesNotMatch(text, /[A-Z][a-z]+ [A-Z][a-z]+|\b[^\s@]+@[^\s@]+\.[^\s@]+\b|\+?\d[\d ()-]{7,}\d/);
});
