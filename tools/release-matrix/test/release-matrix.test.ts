import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import test from "node:test";

import { checkContract, idsIn, parseContract } from "../src/contract.js";
import { CONTRACT_PATH, duplicateJsonKeys, jsonIssues, loadContract, loadInventory, loadMatrix, repoRoot } from "../src/files.js";
import { blockers, checkInventory, checkMatrix, citesDecision, citesEvidence, GATES, isSourceLine, mobileKey, type Matrix, type MobileInventory } from "../src/matrix.js";
import { laneForOwner, seedMatrix } from "../src/seed.js";
import { isEntryPoint, renderReport, seedIfValid } from "../src/cli.js";

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
  // The pinned snapshot has the sign-in route; its disposition is a live decision.
  assert.ok(inventory.endpoints.some((e) => mobileKey(e) === "GET /auth/login"));
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

  const unsourced = clone(base);
  (unsourced.screens["C-11"]!.gates as Record<string, unknown>).built = { state: "done", evidence: "not-real" };
  (unsourced.screens["C-12"]!.gates as Record<string, unknown>).built = { state: "done", evidence: "merged and verified on staging last week" };
  (unsourced.imports["M-1"]!.gates as Record<string, unknown>).dryRun = { state: "waived", decision: "Khalid said it is fine" };
  assert.deepEqual(rules(checkMatrix(unsourced, contract, inventory)), ["matrix.gate.decisionUnsourced", "matrix.gate.evidenceUnsourced"]);

  const sourced = clone(base);
  (sourced.screens["C-11"]!.gates as Record<string, unknown>).built = { state: "done", evidence: "PR #512 at 1a2b3c4d" };
  (sourced.screens["C-12"]!.gates as Record<string, unknown>).built = {
    state: "done",
    evidence: "journey walked; run https://github.com/BAWES-Universe/studenthub-platform/actions/runs/44245285345",
  };
  (sourced.imports["M-1"]!.gates as Record<string, unknown>).dryRun = { state: "waived", decision: "contracts/decisions-2026-10-27.md, Added 2026-11-17" };
  assert.deepEqual(rules(checkMatrix(sourced, contract, inventory)), []);

  const gateless = clone(base);
  delete (gateless.screens["C-11"]!.gates as Record<string, unknown>).verified;
  assert.deepEqual(rules(checkMatrix(gateless, contract, inventory)), ["matrix.gate.missing"]);

  const lane = clone(base);
  (lane.screens["C-11"] as { lane: string }).lane = "nobody";
  assert.deepEqual(rules(checkMatrix(lane, contract, inventory)), ["matrix.lane.unknown"]);
});

test("evidence must name a PR at a head, a run or a run report; a waiver must name its decision", () => {
  for (const good of ["PR #512 at 1a2b3c4", "PR #504 comment 6954521676", "run https://github.com/o/r/actions/runs/1"]) assert.equal(citesEvidence(good), true, good);
  for (const bad of ["not-real", "PR #512", "PR #512 at main", "PR #512 at 1a2b3c", "https://example.com/actions/runs/1", "run 12345678"]) {
    assert.equal(citesEvidence(bad), false, bad);
  }
  // A citation is a whole token; it may sit inside text and end a sentence.
  for (const good of ["merged as PR #512 at 1a2b3c4.", "(PR #504 comment 6954521676)", "see run https://github.com/o/r/actions/runs/1, green"]) {
    assert.equal(citesEvidence(good), true, good);
  }
  for (const bad of ["PR #512 at 1a2b3c4-rc", "PR #512 at 1a2b3c4.bak", "XPR #512 at 1a2b3c4", "PR #504 comment 6954521676-draft", "run https://github.com/o/r/actions/runs/1-x"]) {
    assert.equal(citesEvidence(bad), false, bad);
  }
  assert.equal(citesDecision("contracts/decisions-2026-10-27.md.bak"), false);
  assert.equal(citesDecision("old/contracts/decisions-2026-10-27.md"), false);
  assert.equal(citesDecision("recorded in contracts/decisions-2026-10-27.md."), true);
  assert.equal(citesDecision("contracts/decisions-2026-10-27.md"), true);
  assert.equal(citesDecision("PR #393 comment 6951406632"), true);
  assert.equal(citesDecision("agreed on a call"), false);
});

test("blockers count every open gate and every open mobile disposition; evidence closes a gate", () => {
  // A freshly seeded matrix (every gate open), so the test does not depend on how far
  // the committed matrix has progressed.
  const base = seedMatrix(loadContract(root), loadInventory(root));
  // A fixture inventory with one open and one decided endpoint, independent of live decisions.
  const real = loadInventory(root);
  const [a, b] = real.endpoints;
  const fixture: MobileInventory = { source: real.source, endpoints: [{ ...a!, disposition: "open", note: "pending" }, { ...b!, disposition: "serve" }] };
  const before = blockers(base, fixture);
  assert.equal(before.filter((x) => x.gate === "disposition").length, 1);
  const decided: MobileInventory = { ...fixture, endpoints: fixture.endpoints.map((e) => ({ ...e, disposition: "serve" as const })) };
  assert.equal(blockers(base, decided).filter((x) => x.gate === "disposition").length, 0);

  const closed = clone(base);
  (closed.screens["C-11"]!.gates as Record<string, unknown>).built = { state: "done", evidence: "PR #999 at abc12345" };
  assert.equal(blockers(closed, fixture).length, before.length - 1);
  assert.match(renderReport(before, 10), /\| cutover \| .*mobile/);
});

test("the candidate checkpoint leaves cutover and retirement steps to their own checkpoints", () => {
  const inventory = loadInventory(root);
  const base = seedMatrix(loadContract(root), inventory);
  const ids = (phase: "candidate" | "cutover" | "retired") =>
    new Set(blockers(base, inventory, phase).filter((x) => x.section === "release").map((x) => x.id));
  const candidate = ids("candidate");
  for (const later of ["K-6", "K-7", "K-8", "PAY-SHADOW", "SWITCHES", "MOBILE-RETIRE"]) assert.equal(candidate.has(later), false, later);
  for (const now of ["K-1", "K-4", "K-5", "PAY-REPLAY", "REFRESH", "MOBILE-COMPAT"]) assert.equal(candidate.has(now), true, now);
  assert.equal(ids("cutover").has("K-7"), true);
  assert.equal(ids("cutover").has("K-8"), false);
  assert.equal(ids("retired").has("K-8"), true);
  assert.ok(blockers(base, inventory).length >= blockers(base, inventory, "candidate").length);
});

test("evidence recorded for an old route or disposition does not carry over, and check refuses stale rows", () => {
  const contract = loadContract(root);
  const inventory = loadInventory(root);
  const base = loadMatrix(root);
  const closedScreen = clone(base);
  (closedScreen.screens["U-04"]!.gates as Record<string, unknown>).verified = { state: "done", evidence: "PR #9 at abcdef1" };
  (closedScreen.screens["U-04"] as { subject: string }).subject = "/old-route";
  assert.deepEqual(rules(checkMatrix(closedScreen, contract, inventory)), ["matrix.row.stale"]);
  assert.deepEqual(seedMatrix(contract, inventory, closedScreen).screens["U-04"]!.gates.verified, { state: "open" });

  const retired = inventory.endpoints.find((e) => e.disposition === "retire")!;
  const key = mobileKey(retired);
  const closedMobile = clone(base);
  (closedMobile.mobile[key]!.gates as Record<string, unknown>).verified = { state: "done", evidence: "PR #9 at abcdef1" };
  const served = { ...inventory, endpoints: inventory.endpoints.map((e) => (mobileKey(e) === key ? { ...e, disposition: "open" as const } : e)) };
  assert.deepEqual(rules(checkMatrix(closedMobile, contract, served)), ["matrix.row.stale"]);
  assert.deepEqual(seedMatrix(contract, served, closedMobile).mobile[key]!.gates.verified, { state: "open" });
  assert.deepEqual(seedMatrix(contract, inventory, closedMobile).mobile[key]!.gates.verified, { state: "done", evidence: "PR #9 at abcdef1" });
});

test("the gate registry is canonical: dropping a required gate everywhere still fails", () => {
  const contract = loadContract(root);
  const inventory = loadInventory(root);
  const edited = clone(loadMatrix(root)) as Matrix & { gates: { screen: string[] } };
  edited.gates.screen = ["built"];
  for (const row of Object.values(edited.screens)) delete (row.gates as Record<string, unknown>).verified;
  assert.deepEqual(rules(checkMatrix(edited, contract, inventory)), ["matrix.gate.missing", "matrix.gates.notCanonical"]);
  assert.deepEqual(loadMatrix(root).gates, GATES);
});

test("a target id defined twice in the contract is reported with both lines", () => {
  const lines = markdown.split("\n");
  const at = lines.findIndex((line) => line.trim().startsWith("| `U-04`"));
  assert.ok(at > 0);
  const doubled = [...lines.slice(0, at + 1), lines[at]!.replace(/\| `U-04` \|([^|]*)\|/, "| `U-04` | /elsewhere |"), ...lines.slice(at + 1)].join("\n");
  const issues = checkContract(parseContract(doubled));
  assert.deepEqual(rules(issues), ["contract.target.duplicate"]);
  assert.match(issues[0]!.detail, new RegExp(`line ${at + 1} and again on line ${at + 2}`));
  assert.equal(parseContract(doubled).targets.get("U-04")!.route, parseContract(markdown).targets.get("U-04")!.route);
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

test("a gate that is not an object is a check failure, not a crash", () => {
  const contract = loadContract(root);
  const inventory = loadInventory(root);
  const nulled = clone(loadMatrix(root));
  (nulled.screens["C-11"]!.gates as Record<string, unknown>).built = null;
  assert.deepEqual(rules(checkMatrix(nulled, contract, inventory)), ["matrix.gate.badState"]);
  (nulled.screens["C-11"]!.gates as Record<string, unknown>).built = "done";
  assert.deepEqual(rules(checkMatrix(nulled, contract, inventory)), ["matrix.gate.badState"]);
});

test("the inventory refuses a mistyped method, a source citation that is not a normalized path:line, and a missing source pin", () => {
  const contract = loadContract(root);
  const real = loadInventory(root);
  const [first, ...rest] = real.endpoints;
  const typo: MobileInventory = { ...real, endpoints: [{ ...first!, method: "GTE" as "GET" }, ...rest] };
  assert.deepEqual(rules(checkInventory(typo, contract)), ["mobile.badMethod"]);
  for (const source of ["", "/etc/passwd:1", "src/app.ts:0", "../other/app.ts:3", "src/../app.ts:3", "./src/app.ts:3", "src//app.ts:3", "src\\app.ts:3", "src/app.ts", "src/app.ts:01", "C:/app.ts:3"]) {
    const bad: MobileInventory = { ...real, endpoints: [{ ...first!, sources: [source] }, ...rest] };
    assert.deepEqual(rules(checkInventory(bad, contract)), ["mobile.badSource"], source);
  }
  for (const source of ["src/app/providers/logged-in/account.service.ts:181", "README.md:1", ".github/workflows/ci.yml:12"]) {
    assert.equal(isSourceLine(source), true, source);
  }
  // Citations are relative to the pinned source repository and revision, which must be recorded.
  for (const source of [{}, { repository: "studenthub-candidate", revision: "de3ac8c" }, { repository: "BAWES-Universe/studenthub-candidate", revision: "main" }, { repository: "BAWES-Universe/studenthub-candidate", revision: "de3ac8" }]) {
    assert.deepEqual(rules(checkInventory({ ...real, source: source as MobileInventory["source"] }, contract)), ["mobile.badProvenance"], JSON.stringify(source));
  }
  assert.deepEqual(checkInventory(real, contract), []);
});

test("the contract parser refuses, by line, every markdown construct outside the subset it models", () => {
  const row = "| MOB-B021 | activity | `U-04` |\n";
  const after6 = (inserted: string) => markdown.replace(/(## 6\.[^\n]*\n)/, `$1\n${inserted}\n`);
  const cases: [string, string][] = [
    ["```\n", "code fence"],
    ["```foo`bar\n", "code fence"],
    ["````\n", "code fence"],
    ["~~~\n", "code fence"],
    ["    text\n", "indented line"],
    ["\ttext\n", "indented line"],
    [" ## 3. Example\n", "indented line"],
    ["- item\n  continued\n", "indented line"],
    ["<!--\n", "HTML block"],
    ["<details>\n", "HTML block"],
    ["text <!-- hidden --> text\n", "inline HTML"],
    ["text <span hidden>x</span>\n", "inline HTML"],
    ["> quoted\n", "block quote"],
    ["Heading\n---\n", "setext underline or thematic break"],
    ["Heading\n===\n", "setext underline or thematic break"],
    ["***\n", "setext underline or thematic break"],
    ["_ _ _\n", "setext underline or thematic break"],
    ['[x]: /a "complete, gap-free partition: MOB 1–1."\n', "link reference definition"],
    ["See <https://example.com>.\n", "inline HTML"],
    ["Partition &#49; text.\n", "HTML entity"],
    [`text\n${row}`, "pipe row outside a table"],
    [`| a | b |\n| -- | x |\n`, "pipe row outside a table"],
    [`| a | b |\n|---|---|---|\n`, "pipe row outside a table"],
    [`text\n| a | b |\n|---|---|\n`, "pipe row outside a table"],
  ];
  for (const [inserted, reason] of cases) {
    const issues = checkContract(parseContract(after6(inserted)));
    assert.deepEqual(rules(issues), ["contract.markdown.unsupported"], inserted);
    assert.ok(issues.every((issue) => issue.detail.endsWith(`: ${reason}`)), `${inserted}: ${issues.map((i) => i.detail).join("; ")}`);
  }
  // A link title is not shown, so a partition total written there does not count.
  const titled = 'See [the ledger](x "These ranges are a complete, gap-free partition: MOB 1–70.").\n\n' + markdown;
  assert.deepEqual(parseContract(titled).declaredTotals, parseContract(markdown).declaredTotals);
  assert.deepEqual(checkContract(parseContract(titled)), []);
  // Code spans are text, so a `<` inside one is not HTML.
  assert.deepEqual(checkContract(parseContract(after6("Text with `a <b> c` in it.\n"))), []);
});

test("a table row the parser cannot read the way GFM renders it is refused, and its ordinal is a gap", () => {
  const row = "| MOB-B021 | activity | `U-04` |\n";
  assert.ok(markdown.includes(row));
  const variants: [string, string][] = [
    ["| MOB-B021 | activity | `U-04` | extra |\n", "table row with 4 cells in a 3-column table"],
    ["| MOB-B021 | `act\\|ivity` | `U-04` |\n", "escaped pipe in a table row"],
    ["| MOB-B021 | act\\*ivity | `U-04` |\n", "backslash escape"],
    ["| MOB-B021 | activity &amp; more | `U-04` |\n", "HTML entity"],
    ["| MOB-B021 | activity | [`U-04`](x) |\n", "link or image in a table row"],
    ["   | MOB-B021 | activity | `U-04` |\n", "indented line"],
  ];
  for (const [replacement, reason] of variants) {
    const issues = checkContract(parseContract(markdown.replace(row, replacement)));
    assert.deepEqual(rules(issues), ["contract.markdown.unsupported", "contract.partition.gap"], replacement);
    assert.ok(issues.some((issue) => issue.detail.endsWith(`: ${reason}`)), replacement);
  }
  // Text straight after a table row would render as another row, so it is refused.
  const trailing = checkContract(parseContract(markdown.replace(row, `${row}trailing text\n`)));
  assert.deepEqual(rules(trailing), ["contract.markdown.unsupported"]);
  assert.match(trailing[0]!.detail, /text inside a table$/);
});

test("nothing inside a refused construct can hide a row: a duplicate after a fake fence is still caught", () => {
  const row = "| MOB-B021 | activity | `U-04` |\n";
  // ```foo`bar is not a fence in CommonMark; a parser that opened one here would skip the
  // duplicate table that follows.
  const fake = markdown.replace(/(## 6\.[^\n]*\n)/, `$1\n\`\`\`foo\`bar\n\n| Key | Group | Targets |\n|---|---|---|\n${row}\n`);
  assert.deepEqual(rules(checkContract(parseContract(fake))), ["contract.markdown.unsupported", "contract.partition.duplicate"]);
  // A partition total written inside a fake example is refused with its fence lines.
  const total = "```\nThese ranges are a complete, gap-free partition: MOB 1–70.\n```\n\n" + markdown;
  assert.ok(rules(checkContract(parseContract(total))).includes("contract.markdown.unsupported"));
});

test("an appendix total declared twice is reported, not silently replaced", () => {
  const doubled = markdown.replace(/(complete, gap-free partition:\s*)/, "$1MOB 1-66, ");
  assert.notEqual(doubled, markdown);
  assert.deepEqual(rules(checkContract(parseContract(doubled))), ["contract.partition.declaredTwice"]);
});

test("every partition declaration is read, so a second one in another paragraph is reported", () => {
  const second = (text: string) => markdown.replace(/(## 6\.[^\n]*\n)/, `$1\n${text}\n`);
  for (const text of [
    "These ranges are a complete, gap-free partition: MOB 1–70.",
    "These ranges are a complete, gap-free partition: ADM 1–105, MOB 1–66, WEB 1–69, EMP 1–51, STAFF 1–91.",
    "These ranges are a complete,\ngap-free partition: MOB 1–70.",
    "These ranges are a Complete, Gap-free Partition: MOB 1–70.",
    "A total no appendix uses is still a declaration: complete, gap-free partition: none.",
  ]) {
    const doubled = second(text);
    assert.notEqual(doubled, markdown);
    const found = rules(checkContract(parseContract(doubled)));
    assert.ok(found.includes("contract.partition.declaredTwice"), `${JSON.stringify(text)} gave ${found.join(", ")}`);
  }
  // The real contract declares it exactly once.
  assert.equal(parseContract(markdown).partitionDeclarations, 1);
});

test("a key written twice in matrix.json or the inventory is reported, since JSON.parse keeps only the last", () => {
  assert.deepEqual(duplicateJsonKeys('{"a": 1, "a": 2}'), ["a"]);
  assert.deepEqual(duplicateJsonKeys('{"screens": {"U-04": {}, "U-05": {}, "U-04": {"x": 1}}}'), ["screens.U-04"]);
  assert.deepEqual(duplicateJsonKeys('{"endpoints": [{"m": 1, "m": 2}, {"m": 3}]}'), ["endpoints[].m"]);
  // The same name in sibling objects, as a value, or inside a string is not a duplicate.
  assert.deepEqual(duplicateJsonKeys('{"a": {"k": 1}, "b": {"k": 1}, "c": "a", "d": ["a", "a"], "e": "x\\"a\\":"}'), []);
  assert.deepEqual(duplicateJsonKeys('{"a\\"": 1, "a": 2}'), []);
  assert.deepEqual(duplicateJsonKeys('{"a\\u0062": 1, "ab": 2}'), ["ab"]);
  // The files as committed have none.
  assert.deepEqual(jsonIssues(root), []);
});

test("seed refuses invalid sources, so a mistyped id cannot drop a row and its evidence", () => {
  const contract = parseContract(markdown);
  const inventory = loadInventory(root);
  const previous = clone(loadMatrix(root));
  (previous.screens["U-04"]!.gates as Record<string, unknown>).built = { state: "done", evidence: "PR #1 at 0123abcd" };
  const lines = markdown.split("\n");
  const at = lines.findIndex((line) => line.trim().startsWith("| `U-04`"));
  const typo = [...lines.slice(0, at), lines[at]!.replace("`U-04`", "`U-09`"), ...lines.slice(at + 1)].join("\n");
  const refused = seedIfValid(parseContract(typo), inventory, previous);
  assert.equal(refused.matrix, undefined);
  assert.ok(refused.issues.length > 0);
  const ok = seedIfValid(contract, inventory, previous);
  assert.deepEqual(ok.matrix!.screens["U-04"]!.gates.built, { state: "done", evidence: "PR #1 at 0123abcd" });
});

test("a changed import or release requirement reopens its gates; a reworded title does not", () => {
  const contract = loadContract(root);
  const inventory = loadInventory(root);
  const previous = clone(loadMatrix(root));
  (previous.release["SWITCHES"]!.gates as Record<string, unknown>).done = { state: "done", evidence: "PR #9 at abcdef1" };
  (previous.imports["M-1"]!.gates as Record<string, unknown>).built = { state: "done", evidence: "PR #9 at abcdef1" };
  // Same requirement, new wording: evidence stays.
  (previous.release["SWITCHES"] as { title: string }).title = "an older wording";
  assert.deepEqual(seedMatrix(contract, inventory, previous).release["SWITCHES"]!.gates.done, { state: "done", evidence: "PR #9 at abcdef1" });
  // Recorded against an older requirement revision: stale, and seeding reopens it.
  (previous.release["SWITCHES"] as { subject: string }).subject = "requirement r0";
  (previous.imports["M-1"] as { subject: string }).subject = "requirement r0";
  assert.deepEqual(rules(checkMatrix(previous, contract, inventory)), ["matrix.row.stale"]);
  const seeded = seedMatrix(contract, inventory, previous);
  assert.deepEqual(seeded.release["SWITCHES"]!.gates.done, { state: "open" });
  assert.deepEqual(seeded.imports["M-1"]!.gates.built, { state: "open" });
});
