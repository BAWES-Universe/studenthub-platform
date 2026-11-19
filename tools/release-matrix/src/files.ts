import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseContract, type ParsedContract } from "./contract.js";
import type { Matrix, MobileInventory } from "./matrix.js";

export const CONTRACT_PATH = "docs/parity/target-screen-navigation-contract.md";
export const MATRIX_PATH = "tools/release-matrix/matrix.json";
export const MOBILE_PATH = "tools/release-matrix/data/mobile-endpoints.json";

/** The repository root, found from this file whether it runs from source or dist. */
export function repoRoot(start = path.dirname(fileURLToPath(import.meta.url))): string {
  let dir = start;
  for (;;) {
    if (existsSync(path.join(dir, CONTRACT_PATH)) && existsSync(path.join(dir, "package.json"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) throw new Error(`release-matrix: no repository root above ${start}`);
    dir = parent;
  }
}

const read = (root: string, file: string): string => readFileSync(path.join(root, file), "utf8");

export function loadContract(root = repoRoot()): ParsedContract {
  return parseContract(read(root, CONTRACT_PATH));
}

export function loadInventory(root = repoRoot()): MobileInventory {
  return JSON.parse(read(root, MOBILE_PATH)) as MobileInventory;
}

export function loadMatrix(root = repoRoot()): Matrix {
  return JSON.parse(read(root, MATRIX_PATH)) as Matrix;
}
