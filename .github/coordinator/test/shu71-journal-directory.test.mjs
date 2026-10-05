// SHU-71: the coordinator's readers and the supervisor child's writers resolve
// one push journal. The coordinator unit loads CODEX_HOME from coordinator.env;
// the adapter child takes that file's value, or none, so a journal written by a
// writer is the journal a recovery or progression read consults.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fork } from "node:child_process";
import { coordinatorJournalDirectory } from "../push-broker.mjs";
import { createSupervisorSpawner } from "../supervisor-worker.mjs";
import { supervisorChildEnvironment } from "../service/credential-delivery.mjs";
import { adapterLaunchEnvironment, applyAdapterLaunchEnvironment } from "../service/units.mjs";
import { coordinatorText } from "../service/test/shu71-supervisor-environment-fixture.mjs";

const HOME = "/home/shu-coordinator";
// systemd gives both units the service user's passwd HOME; only the coordinator
// unit loads coordinator.env.
const supervisor = { HOME, PATH: "/usr/bin:/bin", SHU71_EVIDENCE_BROKER: "true", SHU_SUPERVISOR_SECRET: "s".repeat(40) };
function adapterChild(fileText, supervisorEnv = supervisor) {
  return applyAdapterLaunchEnvironment(supervisorChildEnvironment(supervisorEnv), adapterLaunchEnvironment(fileText));
}

test("SHU71_JOURNAL_ONE_DIRECTORY: the adapter child resolves the journal the coordinator reads", () => {
  const withHome = coordinatorText() + "CODEX_HOME='/srv/shu/state'\n";
  const child = adapterChild(withHome);
  assert.equal(coordinatorJournalDirectory({ HOME, CODEX_HOME: "/srv/shu/state" }), "/srv/shu/state/coordinator-runs");
  assert.equal(coordinatorJournalDirectory(child), "/srv/shu/state/coordinator-runs", "the writer journals where the coordinator reads");
  for (const key of ["GITHUB_TOKEN", "LINEAR_API_TOKEN", "SHU_SUPERVISOR_SECRET"]) assert.equal(child[key], undefined, key);

  // A CODEX_HOME in the supervisor's own environment (a drop-in) never outranks
  // the file: with none in the file, both processes fall back to HOME.
  const stray = adapterChild(coordinatorText(), { ...supervisor, CODEX_HOME: "/var/elsewhere" });
  assert.equal(stray.CODEX_HOME, undefined);
  assert.equal(coordinatorJournalDirectory(stray), coordinatorJournalDirectory({ HOME }));
  assert.equal(coordinatorJournalDirectory(stray), `${HOME}/.codex/coordinator-runs`);
  const replaced = adapterChild(withHome, { ...supervisor, CODEX_HOME: "/var/elsewhere" });
  assert.equal(coordinatorJournalDirectory(replaced), "/srv/shu/state/coordinator-runs");
});

// The real supervisor worker, forked by the real spawner, with coordinator.env
// served from memory and an adapter that reports the environment it was given.
async function forkedAdapterEnvironment(t, fileText, supervisorEnv) {
  const url = new URL("../supervisor-worker.mjs", import.meta.url);
  const source = fs.readFileSync(url, "utf8").replace(/from (["'])(\.\.?\/[^"']+)\1/g, (_, q, p) => `from '${new URL(p, url).href}'`);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "shu71-journal-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const worker = path.join(dir, "supervisor-worker.mjs"), preload = path.join(dir, "preload.mjs"), authorizationModule = path.join(dir, "authorize.mjs");
  fs.writeFileSync(worker, source);
  fs.writeFileSync(authorizationModule, "export const authorizeWorkOrder = () => true;");
  fs.writeFileSync(preload, `import fs from 'node:fs';
process.getuid = () => 999; process.getgid = () => 982;
const open = fs.openSync, stat = fs.fstatSync, read = fs.readFileSync, close = fs.closeSync;
fs.openSync = (p, ...args) => p === '/srv/shu/coordinator.env' ? 987654 : open(p, ...args);
fs.fstatSync = (fd) => fd === 987654 ? { isFile: () => true, nlink: 1, uid: 999, gid: 982, mode: 0o100600, size: 100 } : stat(fd);
fs.readFileSync = (fd, ...args) => fd === 987654 ? ${JSON.stringify(fileText)} : read(fd, ...args);
fs.closeSync = (fd) => fd === 987654 ? undefined : close(fd);
`);
  fs.mkdirSync(path.join(dir, "adapters"));
  fs.writeFileSync(path.join(dir, "adapters/claude-code.mjs"),
    "export async function launchBuilder(options) { await new Promise(() => process.send({ adapterEnvironment: options.env }, () => process.exit(0))); }");
  const spawn = createSupervisorSpawner({ stateDir: dir, authorizationModule, env: supervisorEnv,
    forkImpl: (_file, args, options) => fork(worker, args, { ...options, execArgv: ["--import", preload] }) });
  const child = spawn({ runtime: "claude-code" }, {});
  const messages = []; let stderr = "";
  child.on("message", (value) => messages.push(value)); child.stderr.on("data", (value) => { stderr += value; });
  const exit = await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { child.kill("SIGKILL"); reject(new Error("forked adapter timed out")); }, 10000);
    child.once("error", reject); child.once("close", (code) => { clearTimeout(timeout); resolve(code); });
  });
  assert.equal(exit, 0, stderr);
  return messages.find((m) => m.adapterEnvironment)?.adapterEnvironment;
}

test("SHU71_JOURNAL_CHILD_WIRING: the forked supervisor child journals where the coordinator reads", async (t) => {
  const supervisorEnv = { ...supervisor, CODEX_HOME: "/var/elsewhere" };
  const named = await forkedAdapterEnvironment(t, coordinatorText() + "CODEX_HOME='/srv/shu/state'\n", supervisorEnv);
  assert.equal(coordinatorJournalDirectory(named), "/srv/shu/state/coordinator-runs");
  const unnamed = await forkedAdapterEnvironment(t, coordinatorText(), supervisorEnv);
  assert.equal(unnamed.CODEX_HOME, undefined, "the supervisor's own CODEX_HOME does not reach the adapter");
  assert.equal(coordinatorJournalDirectory(unnamed), `${HOME}/.codex/coordinator-runs`);
});
