#!/usr/bin/env node
import { spawn } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { assertBaseline, assertRunnableDiscovery, discover, formatRun, loadBaseline } from "./discover.mjs";

// Planning is pure: callers can verify every filtered lane without invoking Node.
export function buildRunPlan(discovered, { db = false } = {}) {
  const plan = [];
  const add = (command, args) => plan.push({ command, args });
  const nodeTests = (files, flags = []) => {
    if (files.length === 0) return;
    add(process.execPath, ["--test", ...flags, ...files]);
  };
  if (db) {
    nodeTests(discovered.dbTests, ["--test-concurrency=1"]);
    nodeTests(discovered.dbNodeTests);
    for (const file of discovered.dbMutationTests) add(process.execPath, [file]);
    nodeTests(discovered.dbDocumentTests);
  } else {
    nodeTests(discovered.runnerTests);
    for (const file of discovered.runnerMutationTests) add(process.execPath, [file]);
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

    nodeTests(discovered.nodeTests.filter((file) =>
      !webTests.has(file) && file !== observabilityTest));
    for (const file of discovered.mutationTests.filter((file) =>
      !webMutations(file) && !documentMutation(file) && !observabilityMutation(file))) {
      add(process.execPath, [file]);
    }
    if (discovered.assertionTests.length) add("npx", ["--no-install", "vitest", "run", ...discovered.assertionTests]);
    nodeTests(discovered.deploymentTests);
    nodeTests(discovered.nodeTests.filter((file) => webTests.has(file)));
    for (const file of discovered.mutationTests.filter(webMutations)) add(process.execPath, [file]);
    nodeTests(discovered.documentTests.filter((file) => !lateDocumentTest(file)));
    for (const file of discovered.mutationTests.filter((file) =>
      documentMutation(file) && !lateDocumentMutation(file))) add(process.execPath, [file]);
    nodeTests(discovered.nodeTests.filter((file) => file === observabilityTest));
    for (const file of discovered.mutationTests.filter(observabilityMutation)) add(process.execPath, [file]);
    for (const file of discovered.exerciseTests) add(process.execPath, [file]);
    nodeTests(discovered.documentTests.filter(lateDocumentTest));
    for (const file of discovered.mutationTests.filter(lateDocumentMutation)) add(process.execPath, [file]);
  }

  return plan;
}

export async function runDiscovered(discovered, baseline, {
  root = process.cwd(), db = false, spawnImpl = spawn, log = console.log,
} = {}) {
  // Always enforce invariants before an empty optional lane can be skipped.
  assertRunnableDiscovery(discovered);
  assertBaseline(discovered, baseline);
  for (const { command, args } of buildRunPlan(discovered, { db })) {
    log(formatRun(command, args));
    const code = await new Promise((resolve, reject) => {
      const child = spawnImpl(command, args, { cwd: root, stdio: "inherit" });
      child.once("error", reject);
      child.once("exit", (exitCode, signal) => resolve(signal ? 1 : exitCode ?? 1));
    });
    if (code !== 0) throw new Error(`${command} exited with code ${code}`);
  }
}

export async function runTests({ root = process.cwd(), ...options } = {}) {
  const discovered = await discover(root);
  await runDiscovered(discovered, await loadBaseline(root), { root, ...options });
}

// Importing the runner for tests never starts a subprocess.
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await runTests({ db: process.argv.includes("--db") });
}
