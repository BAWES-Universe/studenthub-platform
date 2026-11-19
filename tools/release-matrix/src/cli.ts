/**
 * node dist/tools/release-matrix/src/cli.js check     structural check (every PR)
 * node dist/tools/release-matrix/src/cli.js report    markdown summary of open gates
 * node dist/tools/release-matrix/src/cli.js release [candidate|cutover|retired]
 *                                                   fails while a gate due by that checkpoint
 *                                                   is open (default candidate, the 17 Dec test)
 * node dist/tools/release-matrix/src/cli.js seed      rewrite matrix.json from sources
 */
import { existsSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { checkContract, type ContractIssue, type ParsedContract } from "./contract.js";
import { MATRIX_PATH, jsonIssues, loadContract, loadInventory, loadMatrix, repoRoot } from "./files.js";
import { blockers, checkInventory, checkMatrix, PHASES, type Blocker, type Matrix, type MobileInventory, type Phase } from "./matrix.js";
import { seedMatrix } from "./seed.js";

/**
 * Seeds from valid sources only: a mistyped id would otherwise drop its row and the
 * evidence recorded on it. The previous matrix is not checked, so stale rows still
 * regenerate from valid sources.
 */
export function seedIfValid(contract: ParsedContract, inventory: MobileInventory, previous?: Matrix): { readonly issues: ContractIssue[]; readonly matrix?: Matrix } {
  const issues = [...checkContract(contract), ...checkInventory(inventory, contract)];
  return issues.length > 0 ? { issues } : { issues, matrix: seedMatrix(contract, inventory, previous) };
}

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

function main(command: string | undefined, phaseArg?: string): number {
  const root = repoRoot();
  const contract = loadContract(root);
  const inventory = loadInventory(root);
  // JSON.parse keeps only the last of two equal keys, so a duplicate is refused before
  // anything reads either file: seed would otherwise drop the other row's evidence.
  const duplicates = jsonIssues(root);

  if (command === "seed") {
    const previous = existsSync(path.join(root, MATRIX_PATH)) ? loadMatrix(root) : undefined;
    const seeded = seedIfValid(contract, inventory, previous);
    for (const issue of [...duplicates, ...seeded.issues]) console.error(`${issue.rule}: ${issue.detail}`);
    if (!seeded.matrix || duplicates.length > 0) return 1;
    writeFileSync(path.join(root, MATRIX_PATH), `${JSON.stringify(seeded.matrix, null, 2)}\n`);
    return 0;
  }

  const matrix = loadMatrix(root);
  const issues = [...duplicates, ...checkContract(contract), ...checkInventory(inventory, contract), ...checkMatrix(matrix, contract, inventory)];
  for (const issue of issues) console.error(`${issue.rule}: ${issue.detail}`);
  if (issues.length > 0) return 1;

  const phase = (phaseArg ?? "candidate") as Phase;
  if (command === "release" && !PHASES.includes(phase)) {
    console.error(`usage: cli.js release [${PHASES.join("|")}]`);
    return 2;
  }
  const open = blockers(matrix, inventory, command === "release" ? phase : "retired");
  const rows = [matrix.screens, matrix.exclusions, matrix.mobile, matrix.imports, matrix.release]
    .reduce((sum, section) => sum + Object.keys(section).length, 0);
  if (command === "report" || command === "release") process.stdout.write(renderReport(open, rows));
  if (command === "release") {
    console.log(`release-matrix: ${open.length} gates open for the ${phase} checkpoint`);
    return open.length === 0 ? 0 : 1;
  }
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

/** True when this module is the entry point, however the path is spelled (spaces, symlinks). */
export function isEntryPoint(moduleUrl: string, argv1: string | undefined): boolean {
  if (!argv1) return false;
  try {
    return realpathSync(fileURLToPath(moduleUrl)) === realpathSync(path.resolve(argv1));
  } catch {
    return false;
  }
}

if (isEntryPoint(import.meta.url, process.argv[1])) process.exitCode = main(process.argv[2], process.argv[3]);
