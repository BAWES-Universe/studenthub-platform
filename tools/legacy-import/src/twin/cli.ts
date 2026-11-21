/**
 * Legacy-twin walker CLI.
 *
 *   walk   On the staging host (a Hermes card runs it), under the refresh's shared lock:
 *            flock --shared "$LEGACY_REFRESH_LOCK" node dist/tools/legacy-import/src/twin/cli.js walk
 *          Reads the refreshed copy and the staging app, writes the private-safe report to
 *          TWIN_REPORT_PATH (mode 600) and prints the receipt: revision, Kuwait month, refresh
 *          run, and per journey its verdict, walked and distinct people and outcome counts.
 *          Exits 0 only when every journey is verified, 3 when one is open. Nothing is
 *          printed or written that a person typed.
 *   close  Where the report is (it never leaves the staging host and is never attached to a
 *          pull request), in a checkout of the walked revision plus evidence only:
 *            node dist/tools/legacy-import/src/twin/cli.js close <report.json> "PR #n comment <id>"
 *          Closes `verified` in tools/release-matrix/matrix.json for every screen whose
 *          journeys all passed and whose `built` gate is already done, and prints the receipt,
 *          each screen's outcome and the written matrix's sha256. Refuses (exit 2) when
 *          anything but evidence differs from the walked revision; exits 3 unless every
 *          screen ended verified. The pull request carries the matrix change and the receipt.
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
import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseDatabaseUrl, DEFAULT_REPORT_PATH as REFRESH_REPORT_PATH } from "../refresh.js";
import { validateExplanations, type Explanation } from "./compare.js";
import { JOURNEYS } from "./journeys/index.js";
import { closeSucceeded, closeVerified, MINIMUM_PEOPLE_FLOOR, walkReceipt, walkVerified, type RefreshIdentity, type TwinReport } from "./report.js";
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
  const refresh = refreshIdentity(JSON.parse(readFileSync(env.LEGACY_REFRESH_REPORT || REFRESH_REPORT_PATH, "utf8")));
  if (!refresh) { console.error("legacy-twin: refused.refreshNotOk"); return 2; }
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
      revision, refresh, limit: positive(env.TWIN_LIMIT, 10, "limit"), minimumPeople: Math.max(MINIMUM_PEOPLE_FLOOR, positive(env.TWIN_MINIMUM_PEOPLE, MINIMUM_PEOPLE_FLOOR, "minimumPeople")),
      explanations: loadExplanations(), now: () => new Date(),
    });
    const out = env.TWIN_REPORT_PATH || "/var/lib/legacy-twin/last-walk.json";
    mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    chmodSync(out, 0o600);
    for (const line of walkReceipt(report)) console.log(line);
    // Only a fully verified walk exits 0; an open journey is a failed run, not a quiet success.
    return walkVerified(report) ? 0 : 3;
  } finally {
    await browser.close().catch(() => undefined);
    await pool.end().catch(() => undefined);
  }
}

/** The refresh the walk read, or undefined unless that refresh says ok and names its run. */
export function refreshIdentity(last: unknown): RefreshIdentity | undefined {
  if (!last || typeof last !== "object") return undefined;
  const r = last as Record<string, unknown>;
  const iso = (v: unknown) => typeof v === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/.test(v);
  if (r.ok !== true || !iso(r.startedAt) || !iso(r.finishedAt) || !Number.isSafeInteger(r.totalRows) || (r.totalRows as number) < 0) return undefined;
  return { startedAt: r.startedAt as string, finishedAt: r.finishedAt as string, totalRows: r.totalRows as number };
}

/**
 * Paths a change may touch after a walk without changing what was walked: the matrix that
 * records the evidence, and documentation. Anything else (a renderer, a route, a config
 * file, the walker itself, its explanations) is a new candidate, and the walk is redone.
 */
export function isEvidenceOnly(file: string): boolean {
  return file === "tools/release-matrix/matrix.json" || file.startsWith("docs/") || /^[^\0]+\.md$/.test(file);
}

export type Git = (args: string[]) => { status: number | null; stdout: string };
const runGit: Git = (args) => {
  const r = spawnSync("git", args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { status: r.status, stdout: r.stdout ?? "" };
};

/**
 * A close is bound to the walked candidate: the report's revision must be in this tree, and
 * nothing but evidence may differ from it, committed or not. So a close that only records
 * evidence is accepted, and any change to the app, its config or the walker refuses it.
 */
export function candidateMatchesWalk(revision: string, git: Git = runGit): boolean {
  if (!/^[0-9a-f]{40}$/.test(revision)) return false;
  if (git(["merge-base", "--is-ancestor", revision, "HEAD"]).status !== 0) return false;
  const committed = git(["diff", "--name-only", "--no-renames", revision, "HEAD"]);
  if (committed.status !== 0) return false;
  const pending = git(["status", "--porcelain", "--untracked-files=all", "--no-renames"]);
  if (pending.status !== 0) return false;
  const files = [
    ...committed.stdout.split("\n").filter((l) => l.length > 0),
    ...pending.stdout.split("\n").filter((l) => l.length > 0).map((l) => l.slice(3)),
  ];
  return files.every(isEvidenceOnly);
}

function runClose(reportFile: string | undefined, evidence: string | undefined): number {
  if (!reportFile || !evidence) { console.error("usage: close <report.json> \"PR #n comment <id>\""); return 2; }
  const report = JSON.parse(readFileSync(reportFile, "utf8")) as TwinReport;
  if (!candidateMatchesWalk(String(report.revision))) { console.error("legacy-twin: twin.gate.staleRevision"); return 2; }
  const matrix = JSON.parse(readFileSync(MATRIX, "utf8")) as { screens: Record<string, { gates: Record<string, { state: string }> }> };
  const { screens, changes } = closeVerified(matrix.screens, report, evidence, {
    registry: JOURNEYS.map((j) => ({ id: j.id, screens: j.screens })), revision: report.revision, minimumPeople: MINIMUM_PEOPLE_FLOOR,
  });
  const written = `${JSON.stringify({ ...matrix, screens }, null, 2)}\n`;
  writeFileSync(MATRIX, written);
  for (const line of walkReceipt(report)) console.log(line);
  for (const c of changes) console.log(`legacy-twin: close ${c.screen} ${c.journey} ${c.change}`);
  // The matrix as written, so a reviewer can check the closed state against this receipt.
  console.log(`legacy-twin: close revision=${report.revision} matrix=sha256:${createHash("sha256").update(written).digest("hex")}`);
  return closeSucceeded(changes) ? 0 : 3;
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
