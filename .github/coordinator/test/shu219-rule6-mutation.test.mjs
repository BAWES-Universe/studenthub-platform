// shu219-rule6-mutation.test.mjs — SHU-219 mutation proof: restoring the old
// "parent !== Done" comparison must re-break eligibility for children of open
// parents. Proves the new Rule 6 guard is load-bearing, not decorative.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const COORDINATOR_DIR = fileURLToPath(new URL("..", import.meta.url));

test("SHU-219 MUTATION: restoring 'parent !== Done' excludes a child of an In Progress parent again", () => {
  const tmp = fs.mkdtempSync(join(tmpdir(), "shu219-mutant-"));
  try {
    fs.cpSync(COORDINATOR_DIR, tmp, { recursive: true });
    const target = join(tmp, "reconcile.mjs");
    const src = fs.readFileSync(target, "utf8");

    const newGuard = "if (issue.parent && PARENT_TERMINAL_EXCLUDED_STATES.has(issue.parent.state)) {";
    assert.ok(src.includes(newGuard), "new Rule 6 guard present in the original");
    assert.ok(src.includes('PARENT_TERMINAL_EXCLUDED_STATES = new Set(["Canceled", "Duplicate"])'),
      "terminal-canceled set present in the original");

    // Mutant: revert to the deadlocking comparison the audit found at main.
    const oldGuard = 'if (issue.parent && issue.parent.state !== "Done") {';
    const mutated = src
      .replace(newGuard, `${oldGuard} // SHU219-MUTATION-RULE6`)
      .replace('PARENT_TERMINAL_EXCLUDED_STATES = new Set(["Canceled", "Duplicate"])',
        'PARENT_TERMINAL_EXCLUDED_STATES = new Set(["Canceled", "Duplicate"]) // SHU219-MUTATION-RULE6');
    fs.writeFileSync(target, mutated);

    // Marker proof the mutation landed on the copy.
    assert.ok(mutated.includes("SHU219-MUTATION-RULE6"), "mutation marker applied");
    assert.ok(!mutated.includes(newGuard), "new guard removed in the mutant");

    const scenario = `
      import { computeEligibility } from ${JSON.stringify("file://" + join(tmp, "reconcile.mjs"))};
      const card = (over) => ({ id: "SHU-71", title: "child of open epic", state: "Todo",
        priority: "High", labels: [], assignee: null, delegate: null, linkedPRs: [],
        parent: { id: "SHU-66", state: "In Progress" }, blockers: [], repo: "BAWES-Universe/studenthub-platform", ...over });
      const config = { pilot_repo: "BAWES-Universe/studenthub-platform", max_dispatch: 1,
        enable_dispatch: false, adapter_pause_map: {}, fixture_lane: { id: "NONE", authorization_ref: null } };
      const { ready, excluded } = computeEligibility({ issues: [card()], openPRs: [], config });
      console.log(JSON.stringify({ ready: ready.map((r) => r.id), excluded: excluded.map((e) => e.id + ":" + e.reason.slice(0, 40)) }));
    `;
    const child = spawnSync(process.execPath, ["--input-type=module", "-e", scenario], { encoding: "utf8", timeout: 30000 });
    assert.equal(child.status, 0, `mutant scenario crashed: ${child.stderr}`);
    const out = JSON.parse(child.stdout.trim().split("\n").at(-1));
    // The unmutated coordinator keeps SHU-71 eligible (covered by the direct
    // eligibility tests); the mutant must WRONGLY exclude it — proving the new
    // comparison is what un-deadlocks children of open parents.
    assert.deepEqual(out.ready, [], "mutant must exclude the child of an In Progress parent — guard is load-bearing");
    assert.equal(out.excluded.length, 1);
    assert.match(out.excluded[0], /not Done|parent SHU-66/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
