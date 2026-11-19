import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseContract, type ContractIssue, type ParsedContract } from "./contract.js";
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

/**
 * Paths of object keys that appear more than once in a JSON text. JSON.parse keeps the
 * last value and drops the rest silently, so a reader of the file and the checker would
 * see different rows; these are reported instead. The text must already be valid JSON.
 */
export function duplicateJsonKeys(text: string): string[] {
  const found: string[] = [];
  // One frame per open container: keys seen so far (null for arrays) and the path to it.
  const stack: { keys: Set<string> | null; path: string; expectKey: boolean; lastKey: string }[] = [];
  const childPath = () => {
    const top = stack[stack.length - 1];
    if (!top) return "";
    return top.keys ? `${top.path}${top.path ? "." : ""}${top.lastKey}` : `${top.path}[]`;
  };
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (ch === '"') {
      let j = i + 1;
      while (text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top?.keys && top.expectKey) {
        const key = JSON.parse(text.slice(i, j + 1)) as string;
        if (top.keys.has(key)) found.push(`${top.path}${top.path ? "." : ""}${key}`);
        top.keys.add(key);
        top.lastKey = key;
        top.expectKey = false;
      }
      i = j;
    } else if (ch === "{" || ch === "[") {
      const path = childPath();
      stack.push({ keys: ch === "{" ? new Set() : null, path, expectKey: ch === "{", lastKey: "" });
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    } else if (ch === ",") {
      const top = stack[stack.length - 1];
      if (top?.keys) top.expectKey = true;
    }
  }
  return found;
}

/** Duplicate-key issues for the matrix (when it exists) and the mobile inventory. */
export function jsonIssues(root = repoRoot()): ContractIssue[] {
  const issues: ContractIssue[] = [];
  for (const file of [MATRIX_PATH, MOBILE_PATH]) {
    if (!existsSync(path.join(root, file))) continue;
    for (const key of duplicateJsonKeys(read(root, file))) {
      issues.push({ rule: "json.duplicateKey", detail: `${file} defines ${key} more than once` });
    }
  }
  return issues;
}
