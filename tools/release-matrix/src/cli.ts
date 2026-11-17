/**
 * node dist/tools/release-matrix/src/cli.js check     structural check (every PR)
 * node dist/tools/release-matrix/src/cli.js report    markdown summary of open gates
 * node dist/tools/release-matrix/src/cli.js release   fails while anything is open
 * node dist/tools/release-matrix/src/cli.js seed      rewrite matrix.json from sources
 */
import { existsSync, writeFileSync } from "node:fs";
import path from "node:path";

import { checkContract } from "./contract.js";
import { MATRIX_PATH, loadContract, loadInventory, loadMatrix, repoRoot } from "./files.js";
import { blockers, checkInventory, checkMatrix, type Blocker } from "./matrix.js";
import { seedMatrix } from "./seed.js";

export function renderReport(open: readonly Blocker[], totalRows: number): string {
  const byLane = new Map<string, Map<string, number>>();
  for (const blocker of open) {
    const sections = byLane.get(blocker.lane) ?? new Map<string, number>();
    sections.set(blocker.section, (sections.get(blocker.section) ?? 0) + 1);
    byLane.set(blocker.lane, sections);
  }
  const lines = [
    `# Release matrix: ${open.length} open gates across ${totalRows} rows`,
    "",
    "| Lane | Open gates by section |",
    "|---|---|",
  ];
  for (const lane of [...byLane.keys()].sort()) {
    const parts = [...byLane.get(lane)!.entries()].sort().map(([section, count]) => `${section} ${count}`);
    lines.push(`| ${lane} | ${parts.join(", ")} |`);
  }
  return `${lines.join("\n")}\n`;
}

function main(command: string | undefined): number {
  const root = repoRoot();
  const contract = loadContract(root);
  const inventory = loadInventory(root);

  if (command === "seed") {
    const previous = existsSync(path.join(root, MATRIX_PATH)) ? loadMatrix(root) : undefined;
    writeFileSync(path.join(root, MATRIX_PATH), `${JSON.stringify(seedMatrix(contract, inventory, previous), null, 2)}\n`);
    return 0;
  }

  const matrix = loadMatrix(root);
  const issues = [...checkContract(contract), ...checkInventory(inventory, contract), ...checkMatrix(matrix, contract, inventory)];
  for (const issue of issues) console.error(`${issue.rule}: ${issue.detail}`);
  if (issues.length > 0) return 1;

  const open = blockers(matrix, inventory);
  const rows = [matrix.screens, matrix.exclusions, matrix.mobile, matrix.imports, matrix.release]
    .reduce((sum, section) => sum + Object.keys(section).length, 0);
  if (command === "report" || command === "release") process.stdout.write(renderReport(open, rows));
  if (command === "release") return open.length === 0 ? 0 : 1;
  if (command === "check") {
    console.log(`release-matrix: ${rows} rows consistent with the contract and the mobile inventory; ${open.length} gates open`);
    return 0;
  }
  if (command !== "report") {
    console.error("usage: cli.js check|report|release|seed");
    return 2;
  }
  return 0;
}

if (import.meta.url === `file://${process.argv[1]}`) process.exitCode = main(process.argv[2]);
