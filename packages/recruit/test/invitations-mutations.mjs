// Recruit R4: each invitation rule is pinned by a mutant its named test kills.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = new URL("../../../dist/packages/recruit/src/invitations.js", import.meta.url);
const original = await readFile(source, "utf8");
const suite = fileURLToPath(new URL("../../../dist/packages/recruit/test/invitations.test.js", import.meta.url));
const mutations = [
  ["staff-accepts", "REC4_TRANSITIONS", '(actor === "person" ? PERSON_MOVES : STAFF_MOVES)', "[...PERSON_MOVES, ...STAFF_MOVES]"],
  ["reopen", "REC4_TRANSITIONS", '["seen", "declined"],', '["seen", "declined"], ["declined", "accepted"],'],
  ["unsee", "REC4_TRANSITIONS", '["sent", "seen"], ["sent", "accepted"]', '["sent", "seen"], ["seen", "sent"], ["sent", "accepted"]'],
  ["readd-withdrawn", "REC4_ACCEPT", 'return stage === "withdrawn" ? "refuse" : "keep";', 'return "keep";'],
  ["skip-move", "REC4_ACCEPT", 'if (stage === "suggested")\n        return "move_contacted";', ""],
  ["tell-person", "REC4_OUTBOX", "recipient: recruiter ?? inviter", "recipient: person"],
  ["seen-noise", "REC4_OUTBOX", "    return null;\n}", '    return { kind: "invitation.sent", recipient: person };\n}'],
  ["answer-closed", "REC4_VIEW", "canAnswer: OPEN_INVITATION_STATUSES.includes(row.status)", 'canAnswer: row.status !== "withdrawn"'],
  ["open-body", "REC4_VIEW", 'Object.keys(r).some((k) => k !== "personId")', "false"],
];
function run(pattern, module) {
  const r = spawnSync(process.execPath, ["--test", "--test-reporter=tap", ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], {
    encoding: "utf8", env: { ...process.env, ...(module ? { REC4_INVITATIONS_MODULE: module } : {}) }, timeout: 30000,
  });
  return { ...r, output: r.stdout + r.stderr };
}
assert.equal(run().status, 0, "unmutated suite passes");
for (const [name, pattern, from, to] of mutations) {
  assert.equal(original.split(from).length - 1, 1, `${name} binds once`);
  const target = new URL(`../../../dist/packages/recruit/src/invitations-mutation-${process.pid}.js`, import.meta.url);
  try {
    await writeFile(target, original.replace(from, to));
    const r = run(pattern, `${target.href}?mutation=${encodeURIComponent(name)}`);
    assert.notEqual(r.status, 0, `${name} survived\n${r.output}`);
    assert.match(r.output, new RegExp(`not ok \\d+ - ${pattern} `));
  } finally {
    await unlink(target).catch(() => {});
  }
}
assert.equal(run().status, 0);
process.stdout.write(`${mutations.length}/${mutations.length} recruit invitation mutations killed\n`);
