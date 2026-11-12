import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../../../.github/workflows/ci.yml", import.meta.url), "utf8");
// This contract deliberately accepts only the workflow's simple two-space job
// layout. A different YAML shape needs an explicit contract update, not a skip.
const jobs = Object.fromEntries([...workflow.matchAll(/^  ([\w-]+):\n((?:(?!^  [\w-]+:).|\n)*)/gm)]
  .filter(([,, body]) => /^    runs-on:/m.test(body))
  .map(([, name, body]) => [name, body]));
const runLines = (body) => [...body.matchAll(/^      - run: (.+)$/gm)].map(([, command]) => command);

function aggregateScript() {
  const match = jobs["fast-checks"].match(/^        run: \|\n((?:          .*\n)+)/m);
  assert.ok(match, "CI_GATE: aggregate must contain an executable shell body");
  return match[1].replace(/^          /gm, "");
}
function runGate(application, coordinator) {
  const env = { ...process.env };
  delete env.APPLICATION_RESULT;
  delete env.COORDINATOR_RESULT;
  if (application !== undefined) env.APPLICATION_RESULT = application;
  if (coordinator !== undefined) env.COORDINATOR_RESULT = coordinator;
  return spawnSync("bash", ["--noprofile", "--norc", "-e", "-o", "pipefail", "-c", aggregateScript()], {
    env, encoding: "utf8", timeout: 5000,
  });
}

test("CI_SPLIT required fast-checks always aggregates both independent suites", () => {
  assert.deepEqual(Object.keys(jobs), ["coordinator-future-clock", "coordinator-git243", "application-checks",
    "fast-checks", "coordinator-tests", "image-smoke"]);
  const gate = jobs["fast-checks"];
  assert.match(gate, /^    needs: \[application-checks, coordinator-tests\]$/m);
  assert.match(gate, /^    if: \$\{\{ always\(\) \}\}$/m);
  assert.match(gate, /^          APPLICATION_RESULT: \$\{\{ needs\.application-checks\.result \}\}$/m);
  assert.match(gate, /^          COORDINATOR_RESULT: \$\{\{ needs\.coordinator-tests\.result \}\}$/m);
  assert.match(gate, /^        shell: bash$/m);
  assert.doesNotMatch(gate, /^    name:/m, "CI_GATE: required check name must stay fast-checks");
  assert.doesNotMatch(workflow, /continue-on-error:|\bpaths(?:-ignore)?:/);
  for (const name of ["application-checks", "coordinator-tests"]) {
    assert.doesNotMatch(jobs[name], /^    (?:needs|if):/m, `${name} must start independently on every run`);
    assert.doesNotMatch(jobs[name], /^        if:/m, `${name} must not skip steps`);
  }
  assert.doesNotMatch(gate, /^        if:/m, "CI_GATE: the gate step must not be conditional");
});

test("CI_APPLICATION application, PostgreSQL and build checks retain their order", () => {
  const app = jobs["application-checks"];
  assert.deepEqual(runLines(app), ["npm ci --ignore-scripts", "npm run typecheck", "npm test",
    "npm run test:db", "npm run build"]);
  assert.match(app, /^          cache: npm$/m);
  assert.match(app, /^        image: postgres:17-alpine$/m);
  assert.match(app, /^          POSTGRES_DB: studenthub_authz$/m);
  assert.match(app, /^          - 55432:5432$/m);
  assert.match(app, /^      DATABASE_URL: postgres:\/\/postgres:ci-only-placeholder@localhost:55432\/studenthub_authz$/m);
  assert.match(app, /^        run: docker compose -f deploy\/coolify\/compose.yaml config --quiet$/m);
  assert.ok(app.indexOf("npm run build") < app.indexOf("Validate Coolify Compose package"));
  assert.doesNotMatch(app, /npm run test:coordinator|systemd-analyze/);
});

test("CI_COORDINATOR ordinary coordinator suite keeps its prerequisite and placement", () => {
  const coordinator = jobs["coordinator-tests"];
  assert.ok(workflow.indexOf("  fast-checks:") < workflow.indexOf("  coordinator-tests:"));
  assert.match(coordinator, /^      - uses: actions\/checkout@v4$/m);
  assert.match(coordinator, /^          persist-credentials: false$/m);
  assert.match(coordinator, /^      - uses: actions\/setup-node@v4$/m);
  assert.match(coordinator, /^          node-version: 22$/m);
  assert.match(coordinator, /sudo ln -sfn "\$runner_node" \/usr\/bin\/node/);
  assert.match(coordinator, /test "\$\(\/usr\/bin\/node -p 'process.execPath'\)" = "\$\(node -p 'process.execPath'\)"/);
  assert.match(coordinator, /systemd-analyze --version && test -x \/usr\/bin\/flock/);
  assert.deepEqual(runLines(coordinator), ["npm run test:coordinator"]);
  assert.ok(coordinator.indexOf("systemd-analyze --version") < coordinator.indexOf("run: npm run test:coordinator"));
  assert.doesNotMatch(coordinator, /SHU_TEST_CLOCK_OFFSET_MS|NODE_OPTIONS|services:|npm ci|npm run build/);
  assert.equal((workflow.match(/^-?\s*- run: npm run test:coordinator$/gm) ?? []).length, 1);
});

test("CI_EXISTING future-clock, Git compatibility and image smoke suites remain", () => {
  const future = jobs["coordinator-future-clock"];
  assert.match(future, /SHU_TEST_CLOCK_OFFSET_MS: '31536000000'/);
  assert.match(future, /export NODE_OPTIONS="--import=\$\{GITHUB_WORKSPACE\}\/\.github\/coordinator\/test\/fixture\/shift-wall-clock.mjs"\n          npm run test:coordinator/);
  assert.match(future, /systemd-analyze --version && test -x \/usr\/bin\/flock/);
  const compatibility = jobs["coordinator-git243"];
  assert.match(compatibility, /test "\$\(git --version\)" = "git version 2.43.0"/);
  assert.match(compatibility, /setpriv --reuid=65534 --regid=65534 --clear-groups id -u/);
  assert.match(compatibility, /run: node --test \.github\/coordinator\/test\/attempt-workspace.test.mjs \.github\/coordinator\/test\/workspace-result.test.mjs \.github\/coordinator\/test\/workspace-result-mutations.test.mjs \.github\/coordinator\/test\/shu241-scoped-build.test.mjs \.github\/coordinator\/test\/shu241-mutations.test.mjs/);
  assert.match(jobs["image-smoke"], /^    name: gateway-image-smoke$/m);
  assert.match(jobs["image-smoke"], /run: bash deploy\/coolify\/image-smoke.sh gateway-image-smoke/);
});

test("CI_GATE actual aggregate shell rejects failed, cancelled and skipped needs", () => {
  for (const application of ["success", "failure", "cancelled", "skipped"]) {
    for (const coordinator of ["success", "failure", "cancelled", "skipped"]) {
      const result = runGate(application, coordinator);
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, application === "success" && coordinator === "success" ? 0 : 1,
        `CI_GATE: application=${application}, coordinator=${coordinator}: ${result.stderr}`);
    }
  }
});

test("CI_GATE missing, empty and unknown dependency results also fail closed", () => {
  for (const invalid of [undefined, "", "pending", "SUCCESS", "success\nfailure"]) {
    for (const [application, coordinator] of [[invalid, "success"], ["success", invalid], [invalid, invalid]]) {
      const result = runGate(application, coordinator);
      assert.ifError(result.error);
      assert.equal(result.signal, null);
      assert.equal(result.status, 1, `CI_GATE: unexpected result accepted: ${result.stderr}`);
    }
  }
});
