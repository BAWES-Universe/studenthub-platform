import { readdir, readFile } from "node:fs/promises";
import path from "node:path";

const posix = (value) => value.split(path.sep).join("/");

async function filesBelow(root, directory) {
  const absolute = path.join(root, directory);
  let entries;
  try {
    entries = await readdir(absolute, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const files = [];
  for (const entry of entries) {
    const relative = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await filesBelow(root, relative));
    else if (entry.isFile()) files.push(posix(relative));
  }
  return files;
}

const sorted = (values) => [...values].sort((a, b) => a.localeCompare(b));

export async function discover(root = process.cwd()) {
  const [dist, apps, packages, tools, deploy] = await Promise.all([
    filesBelow(root, "dist"),
    filesBelow(root, "apps"),
    filesBelow(root, "packages"),
    filesBelow(root, "tools"),
    filesBelow(root, "deploy/coolify/test"),
  ]);
  const source = [...apps, ...packages, ...tools];
  const compiledTests = dist.filter((file) =>
    /^dist\/(apps|packages|tools)\/.+\/test\/.+\.test\.js$/.test(file));

  return {
    runnerTests: sorted(tools.filter((file) => /^tools\/test-runner\/test\/.+\.test\.mjs$/.test(file))),
    runnerMutationTests: sorted(tools.filter((file) => /^tools\/test-runner\/test\/.+-mutations\.mjs$/.test(file))),
    assertionTests: sorted(source.filter((file) => /^packages\/actor-assertion\/test\/.+\.test\.ts$/.test(file))),
    exerciseTests: sorted(tools.filter((file) => file === "tools/observability/synthetic-exercise.mjs")),
    dbDocumentTests: sorted(source.filter((file) => file === "packages/private-documents/test/r2-postgres.test.mjs")),
    nodeTests: sorted(compiledTests.filter((file) =>
      !file.startsWith("dist/packages/db/test/") &&
      file !== "dist/packages/actor-assertion/test/actor-assertion.test.js" &&
      file !== "dist/packages/search/test/typesense-integration.test.js")),
    mutationTests: sorted(source.filter((file) =>
      /^(apps|packages)\/.+\/test\/(?:.+-)?mutations\.mjs$/.test(file) &&
      !file.startsWith("packages/db/test/"))),
    documentTests: sorted(source.filter((file) =>
      /^packages\/private-documents\/test\/.+\.test\.mjs$/.test(file) &&
      !file.endsWith("r2-postgres.test.mjs"))),
    deploymentTests: sorted(deploy.filter((file) => file.endsWith(".test.mjs"))),
    dbTests: sorted(compiledTests.filter((file) =>
      file.startsWith("dist/packages/db/test/postgres-") && file.endsWith(".test.js"))),
    dbNodeTests: sorted(compiledTests.filter((file) =>
      file.startsWith("dist/packages/db/test/") &&
      !file.startsWith("dist/packages/db/test/postgres-"))),
    dbMutationTests: sorted(source.filter((file) =>
      /^packages\/db\/test\/(?:.+-)?mutations\.mjs$/.test(file))),
  };
}

export async function discoverMigrations(root = process.cwd()) {
  return sorted((await filesBelow(root, "packages/db/migrations"))
    .filter((file) => file.endsWith(".sql"))
    .map((file) => path.basename(file, ".sql")));
}

export async function loadBaseline(root = process.cwd()) {
  return JSON.parse(await readFile(path.join(root, "tools/test-runner/baseline.json"), "utf8"));
}

export function assertBaseline(discovered, baseline) {
  for (const [group, required] of Object.entries(baseline)) {
    if (!Array.isArray(discovered[group])) throw new Error(`unknown baseline group: ${group}`);
    const actual = new Set(discovered[group]);
    const missing = required.filter((file) => !actual.has(file));
    if (missing.length) throw new Error(`baseline tests missing from ${group}: ${missing.join(", ")}`);
  }
}
