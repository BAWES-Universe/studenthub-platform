/**
 * Legacy-twin walker CLI.
 *
 *   walk   On the staging host (a Hermes card runs it), under the refresh's shared lock:
 *            flock --shared "$LEGACY_REFRESH_LOCK" node dist/tools/legacy-import/src/twin/cli.js walk
 *          Reads the refreshed copy and the staging app, writes the private-safe report to
 *          TWIN_REPORT_PATH (mode 600) and prints one line per journey. Nothing is printed
 *          or written that a person typed.
 *   close  In a lane's PR, after the report is posted on a pull request (the report's revision
 *          must be in this tree with the walker unchanged since):
 *            node dist/tools/legacy-import/src/twin/cli.js close <report.json> "PR #n comment <id>"
 *          Closes `verified` in tools/release-matrix/matrix.json for every screen whose
 *          journeys all passed and whose `built` gate is already done.
 *
 * Environment for `walk`:
 *   TWIN_LEGACY_MIRROR_URL  mysql://user:pass@host:port/legacy_mirror (read-only account)
 *   TWIN_DATABASE_URL       staging PostgreSQL (session rows and the legacy id map)
 *   TWIN_REVISION           the 40-character platform commit staging is running
 *   TWIN_MONTH              YYYY-MM to walk; default the last finished month in Kuwait
 *   TWIN_JOURNEYS           comma-separated journey ids; default all
 *   TWIN_LIMIT              people per journey, default 10; TWIN_MINIMUM_PEOPLE default and floor 5
 *   TWIN_REPORT_PATH        default /var/lib/legacy-twin/last-walk.json
 *   LEGACY_REFRESH_REPORT   the refresh's last-run.json; the walk refuses unless it says ok
 */

import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDatabaseUrl, DEFAULT_REPORT_PATH as REFRESH_REPORT_PATH } from "../refresh.js";
import { validateExplanations, type Explanation } from "./compare.js";
import { JOURNEYS } from "./journeys/index.js";
import { closeVerified, MINIMUM_PEOPLE_FLOOR, verdictOf, type TwinReport } from "./report.js";
import { linkedPerson, mirrorReader, stagingApp, type BrowserLike } from "./staging.js";
import { walk } from "./walk.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../../..");
const MATRIX = path.join(ROOT, "tools/release-matrix/matrix.json");
const EXPLANATIONS = path.join(ROOT, "tools/legacy-import/twin-explanations.json");

export function lastFinishedMonth(now: Date): string {
  const kuwait = new Date(now.getTime() + 3 * 3600 * 1000);
  const d = new Date(Date.UTC(kuwait.getUTCFullYear(), kuwait.getUTCMonth() - 1, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}

export function loadExplanations(file = EXPLANATIONS): Explanation[] {
  const parsed = JSON.parse(readFileSync(file, "utf8")) as { explanations: Explanation[] };
  const problems = validateExplanations(parsed.explanations, JOURNEYS.map((j) => j.id));
  if (problems.length > 0) throw new Error(`twin.explanations.invalid: ${problems.join("; ")}`);
  return parsed.explanations;
}

function positive(value: string | undefined, fallback: number, name: string): number {
  if (value === undefined || value === "") return fallback;
  if (!/^[1-9]\d{0,3}$/.test(value)) throw new Error(`twin.config.${name}`);
  return Number(value);
}

async function runWalk(env: NodeJS.ProcessEnv): Promise<number> {
  const refresh = JSON.parse(readFileSync(env.LEGACY_REFRESH_REPORT || REFRESH_REPORT_PATH, "utf8")) as { ok?: unknown };
  if (refresh.ok !== true) { console.error("legacy-twin: refused.refreshNotOk"); return 2; }
  const revision = env.TWIN_REVISION ?? "";
  if (!/^[0-9a-f]{40}$/.test(revision)) { console.error("legacy-twin: config.revision"); return 2; }
  const month = env.TWIN_MONTH || lastFinishedMonth(new Date());
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month) || month > lastFinishedMonth(new Date())) { console.error("legacy-twin: config.month"); return 2; }
  const wanted = env.TWIN_JOURNEYS ? env.TWIN_JOURNEYS.split(",") : JOURNEYS.map((j) => j.id);
  const journeys = JOURNEYS.filter((j) => wanted.includes(j.id));
  if (journeys.length !== wanted.length) { console.error("legacy-twin: config.journeys"); return 2; }
  const legacy = mirrorReader(parseDatabaseUrl(env.TWIN_LEGACY_MIRROR_URL, "mirror"));
  const { default: pg } = await import("pg");
  const pool = new pg.Pool({ connectionString: env.TWIN_DATABASE_URL, max: 2 });
  const { PostgresLoginStore } = await import("@studenthub/db");
  const { chromium } = await import("playwright");
  const browser = await chromium.launch();
  try {
    const sessions = new PostgresLoginStore(pool).sessions;
    const app = stagingApp(browser as unknown as BrowserLike, sessions, (legacyId, persona) => linkedPerson(pool, legacyId, persona));
    const report = await walk(journeys, legacy, app, { month }, {
      revision, limit: positive(env.TWIN_LIMIT, 10, "limit"), minimumPeople: Math.max(MINIMUM_PEOPLE_FLOOR, positive(env.TWIN_MINIMUM_PEOPLE, MINIMUM_PEOPLE_FLOOR, "minimumPeople")),
      explanations: loadExplanations(), now: () => new Date(),
    });
    const out = env.TWIN_REPORT_PATH || "/var/lib/legacy-twin/last-walk.json";
    mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    chmodSync(out, 0o600);
    for (const j of report.journeys) {
      const v = verdictOf(j, report.minimumPeople);
      const counts = ["match", "explained", "regression", "error"].map((o) => `${o}=${j.people.filter((p) => p.outcome === o).length}`).join(" ");
      console.log(`legacy-twin: ${j.journey} ${v.verdict}${v.verdict === "open" ? `.${v.reason}` : ""} walked=${v.walked} ${counts}`);
    }
    return 0;
  } finally {
    await browser.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

/**
 * The revision a report claims must be in this tree, and the walker's code and
 * explanations must be unchanged since it, so a report from older journey code is refused.
 */
export function walkedRevisionMatchesTree(revision: string, git = (args: string[]) => spawnSync("git", args, { cwd: ROOT, stdio: "ignore" }).status): boolean {
  if (!/^[0-9a-f]{40}$/.test(revision)) return false;
  if (git(["merge-base", "--is-ancestor", revision, "HEAD"]) !== 0) return false;
  const twin = ["tools/legacy-import/src/twin", "tools/legacy-import/twin-explanations.json"];
  // Committed changes since the walk, then uncommitted ones: the code that closes must be the code that walked.
  return git(["diff", "--quiet", revision, "HEAD", "--", ...twin]) === 0 && git(["diff", "--quiet", "HEAD", "--", ...twin]) === 0;
}

function runClose(reportFile: string | undefined, evidence: string | undefined): number {
  if (!reportFile || !evidence) { console.error("usage: close <report.json> \"PR #n comment <id>\""); return 2; }
  const report = JSON.parse(readFileSync(reportFile, "utf8")) as TwinReport;
  if (!walkedRevisionMatchesTree(String(report.revision))) { console.error("legacy-twin: twin.gate.staleRevision"); return 2; }
  const matrix = JSON.parse(readFileSync(MATRIX, "utf8")) as { screens: Record<string, { gates: Record<string, { state: string }> }> };
  const { screens, changes } = closeVerified(matrix.screens, report, evidence, {
    registry: JOURNEYS.map((j) => ({ id: j.id, screens: j.screens })), revision: report.revision, minimumPeople: MINIMUM_PEOPLE_FLOOR,
  });
  writeFileSync(MATRIX, `${JSON.stringify({ ...matrix, screens }, null, 2)}\n`);
  for (const c of changes) console.log(`legacy-twin: ${c.screen} ${c.journey} ${c.change}`);
  return 0;
}

const entry = process.argv[1];
if (entry && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(entry))) {
  process.exitCode = 1;
  const [command, ...rest] = process.argv.slice(2);
  const run = command === "walk" ? runWalk(process.env) : command === "close" ? Promise.resolve().then(() => runClose(rest[0], rest[1])) : Promise.resolve(2);
  run.then((code) => (process.exitCode = code), (e: unknown) => {
    // Only a fixed code is printed: an error message could carry a value.
    const code = e instanceof Error && /^twin\.[\w.]+/.test(e.message) ? /^twin\.[\w.]+/.exec(e.message)![0] : "failed.unexpected";
    console.error(`legacy-twin: ${code}`);
    process.exitCode = 1;
  });
}
