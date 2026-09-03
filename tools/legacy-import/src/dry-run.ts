import { pathToFileURL } from "node:url";

import { generateDataset } from "../../fixtures/src/generate.js";
import type { FixtureDataset } from "../../fixtures/src/types.js";
import { reconcile, type ReconciliationReport } from "../../reconciliation/src/reconcile.js";
import { ImportStore, runImport, type ImportResult } from "./import.js";

export interface FullImportDryRunResult {
  readonly seed: string;
  readonly import: ImportResult;
  readonly reconciliation: ReconciliationReport;
  readonly ok: boolean;
}

/** Runs the complete synthetic import path and returns publishable, redacted evidence. */
export function runFullImportDryRun(
  seed = "shu-0032",
  source: FixtureDataset = generateDataset(seed),
): FullImportDryRunResult {
  const store = new ImportStore();
  const importResult = runImport(store, source);
  const target = store.toDataset(source.seed);
  const reconciliation = reconcile(source, target);

  return {
    seed,
    import: importResult,
    reconciliation,
    ok: importResult.ok && reconciliation.clean,
  };
}

function main(): void {
  const result = runFullImportDryRun(process.argv[2]);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  if (!result.ok) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
