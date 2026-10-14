// SHU-322 — every guard of the card queue self-install is pinned: removing it
// makes its named test in shu322-card-install.test.mjs fail by assertion.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COORDINATOR = path.join(HERE, "..");
const FILE = "service/card-install.mjs";

const CASES = [
  {
    name: "M1 drop the path allowlist",
    from: "    if (!installablePath(change?.path)) return no(",
    to: "    if (false) /* SHU322-M1 */ return no(",
    pattern: "SHU-322 B2:",
  },
  {
    name: "M2 install a deleted coordinator file",
    from: '    if (!["A", "M"].includes(change.status)) return no(',
    to: "    if (false) /* SHU322-M2 */ return no(",
    pattern: "SHU-322 B2:",
  },
  {
    name: "M3 drop the contracts deletions check",
    from: "facts.contractLines?.deleted !== 0 || ",
    to: "/* SHU322-M3 */ ",
    pattern: "SHU-322 B3:",
  },
  {
    name: "M4 let any config key change",
    from: '    if (key === "dispatch_scope" || key === "card_lanes") continue;',
    to: "    continue; // SHU322-M4",
    pattern: "SHU-322 B4:",
  },
  {
    name: "M5 drop the card_lanes prefix check",
    from: "      || !before.every((lane, i) => isDeepStrictEqual(lane, after[i]))) {",
    to: "      /* SHU322-M5 */) {",
    pattern: "SHU-322 B4:",
  },
  {
    name: "M6 drop the queue size bounds",
    from: "  if (ids.length < MIN_INSTALL_QUEUE || ids.length > MAX_CARD_QUEUE || new Set(ids).size !== ids.length) {",
    to: "  if (false) { // SHU322-M6",
    pattern: "SHU-322 B4:",
  },
  {
    name: "M7 accept a queued card that is not an appended lane",
    from: "  for (const id of ids) if (!added.includes(id)) return no(",
    to: "  for (const id of ids) if (false) /* SHU322-M7 */ return no(",
    pattern: "SHU-322 B4:",
  },
  {
    name: "M8 drop the landed check",
    from: "  for (const id of ids) if (landed.has(id)) return no(",
    to: "  for (const id of ids) if (false) /* SHU322-M8 */ return no(",
    pattern: "SHU-322 B4:",
  },
  {
    name: "M9 drop the added contract check",
    from: "    if (installedContracts.has(id) || !nextContracts.has(id)) return no(",
    to: "    if (false) /* SHU322-M9 */ return no(",
    pattern: "SHU-322 B4:",
  },
  {
    name: "M10 drop the REVIEW_PASS blob binding",
    from: "    if (!pass) return no(",
    to: "    if (false) /* SHU322-M10 */ return no(",
    pattern: "SHU-322 B5:",
  },
  {
    name: "M11 trust a review claim root did not write",
    from: " || stat.uid !== 0) continue;",
    to: ") /* SHU322-M11 */ continue;",
    pattern: "SHU-322 B5:",
  },
  {
    name: "M12 drop the ancestry check",
    from: "  if (facts.descends !== true) return no(",
    to: "  if (false) /* SHU322-M12 */ return no(",
    pattern: "SHU-322 B6:",
  },
  {
    name: "M13 install on red checks",
    from: "  if (Array.isArray(checks?.red) && checks.red.length) return no(",
    to: "  if (false) /* SHU322-M13 */ return no(",
    pattern: "SHU-322 B8:",
  },
  {
    name: "M14 install before the checks are green",
    from: "  if (checks?.green !== true) return no(",
    to: "  if (false) /* SHU322-M14 */ return no(",
    pattern: "SHU-322 B8:",
  },
  {
    name: "M15 claim a refusal without the exclusive flag",
    from: 'claimed_at: io.now().toISOString() })}\\n`, { flag: "wx", mode: 0o600 });\n    } catch (error) {\n      if (error.code === "EEXIST") return { silent: true };\n      return { skipped: "INSTALL_UNREADABLE", reason: `the claim cannot be written: ${error.code ?? error.message}` };\n    }\n    return { result:',
    to: 'claimed_at: io.now().toISOString() })}\\n`, { flag: "w", mode: 0o600 }); // SHU322-M15\n    } catch (error) {\n      if (error.code === "EEXIST") return { silent: true };\n      return { skipped: "INSTALL_UNREADABLE", reason: `the claim cannot be written: ${error.code ?? error.message}` };\n    }\n    return { result:',
    pattern: "SHU-322 B9:",
  },
  {
    name: "M16 claim an install without the exclusive flag",
    from: "JSON.stringify({ main, revision, queue, claimed_at: io.now().toISOString() })}\\n`, { flag: \"wx\", mode: 0o600 });",
    to: "JSON.stringify({ main, revision, queue, claimed_at: io.now().toISOString() })}\\n`, { flag: \"w\", mode: 0o600 }); // SHU322-M16",
    pattern: "SHU-322 B10:",
  },
  {
    name: "M17 install on a busy host",
    from: "    if (busy.length) { io.fs.unlinkSync(claim); return",
    to: "    if (false) { /* SHU322-M17 */ return",
    pattern: "SHU-322 B10:",
  },
  {
    name: "M18 drop the pause recheck between steps",
    from: '      if (paused()) { outcome = "INSTALL_PAUSED";',
    to: '      if (false) { /* SHU322-M18 */ outcome = "INSTALL_PAUSED";',
    pattern: "SHU-322 B11:",
  },
  {
    name: "M19 leave the host unpaused after a failure",
    from: "        ...(outcome === \"INSTALL_PAUSED\" ? {} : { pause: pauseHost(io, paths, `${main} ${reason}`) }) };",
    to: "        /* SHU322-M19 */ };",
    pattern: "SHU-322 B12:",
  },
  {
    name: "M20 reinstall R instead of rolling N back",
    from: '            try { provision(io, paths, "rollback", main); rollback = { ok: true }; }',
    to: '            try { provision(io, paths, "install", revision); rollback = { ok: true }; } // SHU322-M20',
    pattern: "SHU-322 B13:",
  },
  {
    name: "M21 accept a plan whose next card is not the first",
    from: "  if (plan.next?.id !== queue[0]) throw",
    to: "  if (false) /* SHU322-M21 */ throw",
    pattern: "SHU-322 B14:",
  },
  {
    name: "M22 skip the plan check",
    from: '      run("plan", () => planCheck(io, paths, queue));',
    to: "      // SHU322-M22",
    pattern: "SHU-322 B14:",
  },
  {
    name: "M23 overwrite an existing pause file",
    from: "    io.fs.writeFileSync(paths.pause, `card-install: ${plainReason(reason)}\\n`, { flag: \"wx\", mode: 0o644 });",
    to: "    io.fs.writeFileSync(paths.pause, `card-install: ${plainReason(reason)}\\n`, { mode: 0o644 }); // SHU322-M23",
    pattern: "SHU-322 B15:",
  },
  {
    name: "M24 review after an install in the same start",
    file: "service/card-run.mjs",
    from: "  if (install.result) return install.result;",
    to: "  // SHU322-M24",
    pattern: "SHU-322 B16:",
  },
  {
    name: "M25 install from a stopped queue",
    file: "service/card-run.mjs",
    from: '    if (next.skipped === "QUEUE_DONE") done = next;',
    to: '    if (next.skipped === "QUEUE_DONE" || next.skipped === "QUEUE_STOPPED") done = next; // SHU322-M25',
    pattern: "SHU-322 B16:",
  },
];

for (const mutation of CASES) {
  test(`SHU-322 mutation ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "shu322-mutation-"));
    try {
      fs.cpSync(COORDINATOR, root, { recursive: true });
      const target = path.join(root, mutation.file ?? FILE);
      const source = fs.readFileSync(target, "utf8");
      assert.equal(source.split(mutation.from).length, 2, `${mutation.name}: mutation anchor must be unique`);
      fs.writeFileSync(target, source.replace(mutation.from, () => mutation.to));
      const childEnv = { ...process.env };
      delete childEnv.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, [
        "--test",
        `--test-name-pattern=${mutation.pattern}`,
        path.join(root, "test", "shu322-card-install.test.mjs"),
      ], { cwd: root, env: childEnv, encoding: "utf8", timeout: 60_000 });
      const output = run.stdout + run.stderr;
      assert.equal(run.signal, null, `${mutation.name}: a timeout or crash is not a mutation kill`);
      assert.equal(run.status, 1, `${mutation.name}: mutation survived\n${output}`);
      assert.match(output, /AssertionError/, `${mutation.name}: must fail by assertion`);
      assert.match(output, new RegExp(`not ok \\d+ - ${mutation.pattern}`), `${mutation.name}: must fail its named test`);
      assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|TypeError/, `${mutation.name}: infrastructure crashes do not count`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}

test("SHU-322 mutation the unmutated suite passes", () => {
  const childEnv = { ...process.env };
  delete childEnv.NODE_TEST_CONTEXT;
  const run = spawnSync(process.execPath, ["--test", "--test-name-pattern=SHU-322 B", path.join(HERE, "shu322-card-install.test.mjs")],
    { cwd: COORDINATOR, env: childEnv, encoding: "utf8", timeout: 60_000 });
  assert.equal(run.status, 0, run.stdout + run.stderr);
  assert.match(run.stdout, /^# pass 17$/m);
});
