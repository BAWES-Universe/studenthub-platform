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
  // package.json and dist are required runner inputs. Reading them here makes a
  // broken checkout/build fail before Node can fall back to implicit discovery.
  JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
  await readdir(path.join(root, "dist"));
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

  const privilegedSourceTest = (file) =>
    file.startsWith("tools/test-runner/test/") ||
    file.startsWith("packages/private-documents/test/");
  const sourceNodeTests = source.filter((file) =>
    /^(apps|packages)\/.+\/test\/.+\.test\.mjs$/.test(file) &&
    !file.startsWith("packages/db/test/") &&
    !privilegedSourceTest(file));
  const mutationFile = (file) => /\/test\/[^/]*mutations[^/]*\.mjs$/.test(file);

  const discovered = {
    runnerTests: sorted(tools.filter((file) => /^tools\/test-runner\/test\/.+\.test\.mjs$/.test(file))),
    runnerMutationTests: sorted(tools.filter((file) => /^tools\/test-runner\/test\/.+-mutations\.mjs$/.test(file))),
    assertionTests: sorted(source.filter((file) => /^packages\/actor-assertion\/test\/.+\.test\.ts$/.test(file))),
    exerciseTests: sorted(tools.filter((file) => file === "tools/observability/synthetic-exercise.mjs")),
    dbDocumentTests: sorted(source.filter((file) => file === "packages/private-documents/test/r2-postgres.test.mjs")),
    nodeTests: sorted([...compiledTests.filter((file) =>
      !file.startsWith("dist/packages/db/test/") &&
      file !== "dist/packages/actor-assertion/test/actor-assertion.test.js" &&
      file !== "dist/packages/search/test/typesense-integration.test.js"), ...sourceNodeTests]),
    mutationTests: sorted(source.filter((file) =>
      /^(apps|packages)\/.+\/test\//.test(file) && mutationFile(file) &&
      !file.startsWith("packages/db/test/") &&
      !file.startsWith("tools/test-runner/test/"))),
    documentTests: sorted(source.filter((file) =>
      /^packages\/private-documents\/test\/.+\.test\.mjs$/.test(file) &&
      !file.endsWith("r2-postgres.test.mjs"))),
    deploymentTests: sorted(deploy.filter((file) => file.endsWith(".test.mjs"))),
    dbTests: sorted(compiledTests.filter((file) =>
      file.startsWith("dist/packages/db/test/postgres-") && file.endsWith(".test.js"))),
    dbNodeTests: sorted([...compiledTests.filter((file) =>
      file.startsWith("dist/packages/db/test/") &&
      !file.startsWith("dist/packages/db/test/postgres-")), ...source.filter((file) =>
      /^packages\/db\/test\/.+\.test\.mjs$/.test(file))]),
    dbMutationTests: sorted(source.filter((file) =>
      file.startsWith("packages/db/test/") && mutationFile(file))),
  };
  assertRunnableDiscovery(discovered);
  return discovered;
}

export function assertRunnableDiscovery(discovered) {
  const files = Object.values(discovered).flat();
  if (files.length === 0) throw new Error("test discovery was empty");
  const seen = new Set();
  for (const file of files) {
    if (seen.has(file)) throw new Error(`test discovered in multiple lanes: ${file}`);
    seen.add(file);
  }
}

export function formatRun(command, args) {
  return `test-runner: ${command} ${args.join(" ")}`;
}

export async function discoverMigrations(root = process.cwd()) {
  return (await filesBelow(root, "packages/db/migrations"))
    .filter((file) => file.endsWith(".sql"))
    .map((file) => path.basename(file, ".sql"))
    .sort();
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
