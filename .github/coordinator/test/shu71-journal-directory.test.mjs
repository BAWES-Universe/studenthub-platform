// SHU-71: the coordinator's readers and the supervisor child's writers resolve
// one push journal. The coordinator unit loads CODEX_HOME from coordinator.env;
// the adapter child takes that file's value, or none, so a journal written by a
// writer is the journal a recovery or progression read consults.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { coordinatorJournalDirectory } from "../push-broker.mjs";
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

test("SHU71_JOURNAL_CHILD_WIRING: the supervisor child applies coordinator.env through the journal rule", () => {
  const source = fs.readFileSync(new URL("../supervisor-worker.mjs", import.meta.url), "utf8");
  assert.match(source, /applyAdapterLaunchEnvironment\(process\.env, readAdapterLaunchEnvironment\(\)\)/);
  assert.doesNotMatch(source, /Object\.assign\(process\.env/, "a plain merge keeps a CODEX_HOME the file does not name");
});
