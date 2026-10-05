import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { main, sendLinear, fetchIssueComments, parseReceiptsFromComments, fetchBranchHead } from "./reconcile.mjs";
import { episodeVerdict, episodeScopeFor, singleRunActivationStatus } from "./single-run-activation.mjs";
import { runFixtureDriver, restoreFixture } from "./fixture-driver.mjs";

const dir = path.dirname(fileURLToPath(import.meta.url));
const [command, activationPath, journalPath, todoStateId, limit = "120"] = process.argv.slice(2);
if (!["run", "restore"].includes(command) || !path.isAbsolute(activationPath ?? "") || !path.isAbsolute(journalPath ?? "")) {
  throw new Error("usage: fixture-driver-cli.mjs run|restore /absolute/activation.json /absolute/journal.json <Todo state UUID> [max ticks]");
}
const parent = fs.lstatSync(path.dirname(journalPath));
if (!parent.isDirectory() || parent.isSymbolicLink() || (parent.mode & 0o077) || parent.uid !== process.getuid()) throw new Error("journal directory must be private and owned by operator");
const config = JSON.parse(fs.readFileSync(path.join(dir, "config.json"), "utf8"));
const record = JSON.parse(fs.readFileSync(activationPath, "utf8"));
if (record.target_issue_id !== config.fixture_lane?.id) throw new Error("activation is not the configured fixture");
const token = process.env.LINEAR_API_TOKEN;
if (!token) throw new Error("Linear credential required");
const readIssue = async id => {
  const data = await sendLinear(`query FixtureAssignment($id: String!) { issue(id: $id) { id assignee { id } state { id } } }`, { id }, token);
  if (!data.issue?.id || !data.issue.state?.id) throw new Error("fixture issue unavailable");
  return { assigneeId: data.issue.assignee?.id ?? null, stateId: data.issue.state.id };
};
const updateIssue = async (id, input) => {
  const data = await sendLinear(`mutation FixtureAssignment($id: String!, $input: IssueUpdateInput!) { issueUpdate(id: $id, input: $input) { success } }`, { id, input }, token);
  if (data.issueUpdate?.success !== true) throw new Error("fixture assignment update failed");
};
if (command === "restore") {
  const saved = JSON.parse(fs.readFileSync(journalPath, "utf8"));
  if (saved.issue_id !== record.target_issue_id) throw new Error("journal fixture binding mismatch");
  await restoreFixture({ journalPath, readIssue, updateIssue });
} else {
  const receipts = parseReceiptsFromComments(await fetchIssueComments({ issueId: record.target_issue_id, token }));
  const activation = singleRunActivationStatus({ filePath: activationPath, config, receipts, dir,
    initialTargetSha: process.env.DISPATCH_TARGET_SHA });
  if (process.env.ENABLE_DISPATCH !== "true" || activation.state !== "armed") throw new Error("fixture activation is not armed");
  await runFixtureDriver({ issueId: record.target_issue_id, fixtureId: config.fixture_lane.id, todoStateId, journalPath,
    maxTicks: Number(limit), readIssue, updateIssue, tick: async () => {
      const code = await main(["--activation", activationPath], process.env, { stdout: console.log });
      if (code !== 0) throw new Error(`coordinator tick refused (${code})`);
      const receipts = parseReceiptsFromComments(await fetchIssueComments({ issueId: record.target_issue_id, token }));
      const scoped = receipts.filter(r => r.issue_id === record.target_issue_id);
      const latest = scoped.at(-1);
      const head = latest ? await fetchBranchHead({ repo: latest.repo, branch: latest.branch, token: process.env.GITHUB_TOKEN }) : null;
      const verdict = episodeVerdict({ receipts, targetIssueId: record.target_issue_id, config,
        bootstrapReviewer: record.reviewer_lane ? { lane: record.reviewer_lane } : null,
        authoritativeHead: head, episodeScope: episodeScopeFor(record) });
      return { terminal: Boolean(head) && verdict.ended };
    } });
}
