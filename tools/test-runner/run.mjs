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
  await run(process.execPath, ["--test", ...discovered.nodeTests]);
  for (const file of discovered.mutationTests) await run(process.execPath, [file]);
  await run("npx", ["--no-install", "vitest", "run", ...discovered.assertionTests]);
  await run(process.execPath, ["--test", ...discovered.deploymentTests]);
  await run(process.execPath, ["--test", ...discovered.documentTests]);
  for (const file of discovered.exerciseTests) await run(process.execPath, [file]);
}
