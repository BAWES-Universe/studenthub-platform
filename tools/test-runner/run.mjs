#!/usr/bin/env node
import { spawn } from "node:child_process";
import { assertBaseline, discover, formatRun, loadBaseline } from "./discover.mjs";

const root = process.cwd();

async function run(command, args) {
  console.log(formatRun(command, args));
  const code = await new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: root, stdio: "inherit" });
    child.once("error", reject);
    child.once("exit", (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1));
  });
  if (code !== 0) throw new Error(`${command} exited with code ${code}`);
}

const discovered = await discover(root);
assertBaseline(discovered, await loadBaseline(root));

if (process.argv.includes("--db")) {
  await run(process.execPath, ["--test", "--test-concurrency=1", ...discovered.dbTests]);
  await run(process.execPath, ["--test", ...discovered.dbNodeTests]);
  for (const file of discovered.dbMutationTests) await run(process.execPath, [file]);
  await run(process.execPath, ["--test", ...discovered.dbDocumentTests]);
} else {
  await run(process.execPath, ["--test", ...discovered.runnerTests]);
  for (const file of discovered.runnerMutationTests) await run(process.execPath, [file]);
  const webTests = new Set([
    "dist/apps/gateway/test/web-ui.test.js",
    "dist/apps/gateway/test/context-navigation.test.js",
    "dist/apps/gateway/test/company-directory.test.js",
  ]);
  const observabilityTest = "dist/packages/observability/test/observability.test.js";
  const webMutations = (file) => file === "apps/gateway/test/context-navigation-mutations.mjs" ||
    file === "apps/gateway/test/company-directory-mutations.mjs";
  const documentMutation = (file) => file.startsWith("packages/private-documents/test/");
  const observabilityMutation = (file) => file === "packages/observability/test/mutations.mjs";
  const lateDocumentTest = (file) => file.endsWith("candidate-lifecycle.test.mjs") ||
    file.endsWith("r2-lifecycle.test.mjs");
  const lateDocumentMutation = (file) => file.endsWith("candidate-lifecycle-mutations.mjs");

  await run(process.execPath, ["--test", ...discovered.nodeTests.filter((file) =>
    !webTests.has(file) && file !== observabilityTest)]);
  for (const file of discovered.mutationTests.filter((file) =>
    !webMutations(file) && !documentMutation(file) && !observabilityMutation(file))) {
    await run(process.execPath, [file]);
  }
  await run("npx", ["--no-install", "vitest", "run", ...discovered.assertionTests]);
  await run(process.execPath, ["--test", ...discovered.deploymentTests]);
  await run(process.execPath, ["--test", ...discovered.nodeTests.filter((file) => webTests.has(file))]);
  for (const file of discovered.mutationTests.filter(webMutations)) await run(process.execPath, [file]);
  await run(process.execPath, ["--test", ...discovered.documentTests.filter((file) => !lateDocumentTest(file))]);
  for (const file of discovered.mutationTests.filter((file) =>
    documentMutation(file) && !lateDocumentMutation(file))) await run(process.execPath, [file]);
  await run(process.execPath, ["--test", ...discovered.nodeTests.filter((file) => file === observabilityTest)]);
  for (const file of discovered.mutationTests.filter(observabilityMutation)) await run(process.execPath, [file]);
  for (const file of discovered.exerciseTests) await run(process.execPath, [file]);
  await run(process.execPath, ["--test", ...discovered.documentTests.filter(lateDocumentTest)]);
  for (const file of discovered.mutationTests.filter(lateDocumentMutation)) await run(process.execPath, [file]);
}
