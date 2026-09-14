// Reviewed fixture operator loop. Journal is write-ahead state, retained until
// restoration is verified. A crash requires explicit restore before another run.
import fs from "node:fs";
import { dirname } from "node:path";

function save(file, value, exclusive = false) {
  const fd = fs.openSync(file, exclusive ? "wx" : "w", 0o600);
  try { fs.writeFileSync(fd, JSON.stringify(value) + "\n"); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  const parent = fs.openSync(dirname(file), "r");
  try { fs.fsyncSync(parent); } finally { fs.closeSync(parent); }
}

export async function restoreFixture({ journalPath, readIssue, updateIssue }) {
  const record = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (record.version !== "1.0.0") throw new Error("unknown fixture journal version");
  await updateIssue(record.issue_id, record.original);
  const restored = await readIssue(record.issue_id);
  if (restored.assigneeId !== record.original.assigneeId || restored.stateId !== record.original.stateId) {
    throw new Error("fixture restore verification failed; journal retained");
  }
  fs.unlinkSync(journalPath);
  return { restored: true };
}

export async function runFixtureDriver({ issueId, fixtureId, todoStateId, journalPath, readIssue, updateIssue,
  tick, maxTicks = 120, intervalMs = 1000, wait = ms => new Promise(resolve => setTimeout(resolve, ms)) }) {
  if (!issueId || issueId !== fixtureId || !todoStateId || !Number.isInteger(maxTicks) || maxTicks < 1
      || !Number.isFinite(intervalMs) || intervalMs < 0) throw new Error("invalid bounded fixture driver contract");
  if (fs.existsSync(journalPath)) throw new Error("unfinished fixture run: restore the retained journal first");
  const original = await readIssue(issueId);
  if (!original || !Object.hasOwn(original, "assigneeId") || !original.stateId) throw new Error("fixture original assignment unavailable");
  save(journalPath, { version: "1.0.0", issue_id: issueId, original: { assigneeId: original.assigneeId, stateId: original.stateId } }, true);
  try {
    await updateIssue(issueId, { assigneeId: null, stateId: todoStateId });
    const ready = await readIssue(issueId);
    if (ready.assigneeId !== null || ready.stateId !== todoStateId) throw new Error("fixture preparation verification failed");
    for (let count = 1; count <= maxTicks; count++) {
      const outcome = await tick();
      if (outcome.terminal === true) return { ticks: count, terminal: true };
      if (count < maxTicks) await wait(intervalMs);
    }
    throw new Error("fixture tick limit reached");
  } finally {
    await restoreFixture({ journalPath, readIssue, updateIssue });
  }
}
