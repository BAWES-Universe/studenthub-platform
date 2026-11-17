import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkContract, idsIn, parseContract } from "../src/contract.js";
import { CONTRACT_PATH, loadContract, loadInventory, loadMatrix, repoRoot } from "../src/files.js";
import { blockers, checkInventory, checkMatrix, mobileKey, type Matrix, type MobileInventory } from "../src/matrix.js";
import { laneForOwner, seedMatrix } from "../src/seed.js";
import { isEntryPoint, renderReport } from "../src/cli.js";

const root = repoRoot();
const markdown = readFileSync(path.join(root, CONTRACT_PATH), "utf8");
const rules = (issues: readonly { rule: string }[]): string[] => [...new Set(issues.map((issue) => issue.rule))].sort();
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

test("the screen contract ledger is a complete, gap-free partition of the five appendices", () => {
  const contract = parseContract(markdown);
  assert.deepEqual(contract.declaredTotals, { ADM: 105, MOB: 66, WEB: 69, EMP: 51, STAFF: 91 });
  assert.equal([...contract.targets.values()].filter((t) => t.kind === "screen").length, 77);
  assert.equal([...contract.targets.values()].filter((t) => t.kind === "exclusion").length, 7);
  assert.deepEqual(checkContract(contract), []);
});

test("deleting one legacy ordinal from the ledger fails before any browser run (SHU-235 section 7)", () => {
  const mutated = markdown.replace("| MOB-B021 | activity | `U-04` |\n", "");
  assert.notEqual(mutated, markdown);
  const issues = checkContract(parseContract(mutated));
  assert.deepEqual(rules(issues), ["contract.partition.gap"]);
  assert.match(issues[0]!.detail, /MOB-B021/);
});

test("duplicating one legacy ordinal fails", () => {
  const mutated = markdown.replace("| MOB-B021 | activity | `U-04` |", "| MOB-B021 | activity | `U-04` |\n| MOB-B021 | activity again | `U-04` |");
  assert.deepEqual(rules(checkContract(parseContract(mutated))), ["contract.partition.duplicate"]);
});

test("widening a range past the declared total, or naming an unknown target, fails", () => {
  const overflow = markdown.replace("| STAFF-B091 | wildcard |", "| STAFF-B091..092 | wildcard |");
  assert.deepEqual(rules(checkContract(parseContract(overflow))), ["contract.partition.overflow"]);
  const unknown = markdown.replace("| MOB-B021 | activity | `U-04` |", "| MOB-B021 | activity | `U-09` |");
  assert.deepEqual(rules(checkContract(parseContract(unknown))), ["contract.ledger.unknownTarget"]);
  const silent = markdown.replace("| MOB-B021 | activity | `U-04` |", "| MOB-B021 | activity | dropped |");
  assert.deepEqual(rules(checkContract(parseContract(silent))), ["contract.ledger.noDisposition"]);
});

test("id ranges expand, including two-letter prefixes", () => {
  assert.deepEqual(idsIn("`C-01..03` and EX-05, A-24..25"), ["C-01", "C-02", "C-03", "EX-05", "A-24", "A-25"]);
});

test("owner cells map to lanes", () => {
  assert.equal(laneForOwner("S1 / SHU-92"), "people");
  assert.equal(laneForOwner("I1/I3/I4, coordinated by SHU-91"), "access");
  assert.equal(laneForOwner("SHU-91 app shell; P1/P2 provide cards"), "shell");
  assert.equal(laneForOwner("W3 / SHU-171 (P1/F4 dependencies)"), "work");
  assert.equal(laneForOwner("SHU-234"), "recruit");
});

test("the mobile inventory names a known target, a source line and a reason for every non-served route", () => {
  const contract = loadContract(root);
  const inventory = loadInventory(root);
  assert.equal(inventory.source.revision, "de3ac8c");
  assert.equal(inventory.endpoints.length, 120);
  assert.deepEqual(checkInventory(inventory, contract), []);
  const signIn = inventory.endpoints.find((e) => mobileKey(e) === "GET /auth/login");
  assert.equal(signIn?.disposition, "open");
});

test("an inventory that serves an exclusion, retires a screen, or drops its reason fails", () => {
  const contract = loadContract(root);
  const inventory = clone(loadInventory(root)) as { endpoints: MobileInventory["endpoints"][number][] } & MobileInventory;
  const wallet = inventory.endpoints.find((e) => e.path === "/balance/payable-list")!;
  Object.assign(wallet, { disposition: "serve" });
  const profile = inventory.endpoints.find((e) => mobileKey(e) === "GET /account/profile")!;
  Object.assign(profile, { disposition: "retire", note: "x" });
  const aws = inventory.endpoints.find((e) => e.path === "/aws/config")!;
  delete (aws as { note?: string }).note;
  assert.deepEqual(rules(checkInventory(inventory, contract)), [
    "mobile.noteRequired",
    "mobile.retireNeedsExclusion",
    "mobile.serveNeedsScreen",
  ]);
});

test("the committed matrix covers exactly the contract and the inventory", () => {
  const contract = loadContract(root);
  const inventory = loadInventory(root);
  const matrix = loadMatrix(root);
  assert.deepEqual(checkMatrix(matrix, contract, inventory), []);
  assert.deepEqual(seedMatrix(contract, inventory, matrix), matrix, "matrix.json is stale: run cli.js seed");
});

test("a missing row, an unknown row, or a closed gate without evidence fails the check", () => {
  const contract = loadContract(root);
  const inventory = loadInventory(root);
  const base = loadMatrix(root);

  const missing = clone(base) as { screens: Record<string, unknown> } & Matrix;
  delete missing.screens["C-11"];
  assert.deepEqual(rules(checkMatrix(missing, contract, inventory)), ["matrix.screens.missing"]);

  const extra = clone(base) as { mobile: Record<string, unknown> } & Matrix;
  extra.mobile["GET /made-up"] = clone(base.mobile["GET /chats"]);
  assert.deepEqual(rules(checkMatrix(extra, contract, inventory)), ["matrix.mobile.unknown"]);

  const done = clone(base);
  (done.screens["C-11"]!.gates as Record<string, unknown>).built = { state: "done", evidence: "" };
  (done.imports["M-1"]!.gates as Record<string, unknown>).dryRun = { state: "waived", decision: " " };
  (done.release["K-1"]!.gates as Record<string, unknown>).done = { state: "closed" };
  assert.deepEqual(rules(checkMatrix(done, contract, inventory)), [
    "matrix.gate.badState",
    "matrix.gate.doneWithoutEvidence",
    "matrix.gate.waivedWithoutDecision",
  ]);

  const gateless = clone(base);
  delete (gateless.screens["C-11"]!.gates as Record<string, unknown>).verified;
  assert.deepEqual(rules(checkMatrix(gateless, contract, inventory)), ["matrix.gate.missing"]);

  const lane = clone(base);
  (lane.screens["C-11"] as { lane: string }).lane = "nobody";
  assert.deepEqual(rules(checkMatrix(lane, contract, inventory)), ["matrix.lane.unknown"]);
});

test("blockers count every open gate and every open mobile disposition; evidence closes a gate", () => {
  const inventory = loadInventory(root);
  const base = loadMatrix(root);
  const before = blockers(base, inventory);
  const openDispositions = inventory.endpoints.filter((e) => e.disposition === "open").length;
  assert.ok(openDispositions > 0);
  assert.equal(before.filter((b) => b.gate === "disposition").length, openDispositions);

  const closed = clone(base);
  (closed.screens["C-11"]!.gates as Record<string, unknown>).built = { state: "done", evidence: "PR #999 at abc12345" };
  assert.equal(blockers(closed, inventory).length, before.length - 1);
  assert.match(renderReport(before, 10), /\| cutover \| .*mobile/);
});

test("seeding keeps recorded evidence and adds rows the contract gains", () => {
  const contract = loadContract(root);
  const inventory = loadInventory(root);
  const previous = clone(loadMatrix(root));
  (previous.screens["U-01"]!.gates as Record<string, unknown>).built = { state: "done", evidence: "PR #1 at 0123abcd" };
  delete (previous.screens as Record<string, unknown>)["U-02"];
  const seeded = seedMatrix(contract, inventory, previous);
  assert.deepEqual(seeded.screens["U-01"]!.gates.built, { state: "done", evidence: "PR #1 at 0123abcd" });
  assert.deepEqual(seeded.screens["U-02"]!.gates.built, { state: "open" });
});

test("the CLI recognises itself as the entry point through a symlink or a path with spaces", async () => {
  const { mkdtempSync, symlinkSync, rmSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { pathToFileURL, fileURLToPath } = await import("node:url");
  const cli = new URL("../src/cli.js", import.meta.url);
  const dir = mkdtempSync(path.join(tmpdir(), "release matrix "));
  try {
    const link = path.join(dir, "cli link.js");
    symlinkSync(fileURLToPath(cli), link);
    assert.equal(isEntryPoint(cli.href, link), true);
    assert.equal(isEntryPoint(pathToFileURL(link).href, fileURLToPath(cli)), true);
    assert.equal(isEntryPoint(cli.href, path.join(dir, "missing.js")), false);
    assert.equal(isEntryPoint(cli.href, undefined), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
