#!/usr/bin/env node
import { checkRestore, formatRestoreCheckSummary } from "./restore-check.js";

function value(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index < 0 ? undefined : process.argv[index + 1];
}

async function main(): Promise<void> {
  const source = value("--source") ?? process.env.RESTORE_CHECK_SOURCE_URL;
  const restored = value("--restored") ?? process.env.RESTORE_CHECK_RESTORED_URL;
  if (!source || !restored) throw new Error("provide --source and --restored, or RESTORE_CHECK_SOURCE_URL and RESTORE_CHECK_RESTORED_URL");
  const report = await checkRestore(source, restored, { scratchSuffix: value("--scratch-suffix") ?? "_restore_check" });
  if (process.argv.includes("--text")) console.log(formatRestoreCheckSummary(report));
  else console.log(JSON.stringify(report, null, 2));
  if (!report.ok) process.exitCode = 1;
}

main().catch((error: unknown) => {
  console.error(`restore check failed: ${error instanceof Error ? error.message : "unknown error"}`);
  process.exitCode = 1;
});
