/**
 * Entry point for the staging cron job. Exit 0 only when the mirror was refreshed and
 * counted; the report file is written either way. Prints one line: the code, the table
 * count, the row total and the duration. Never prints rows, hosts or credentials.
 */
import { spawn } from "node:child_process";
import { closeSync, mkdirSync, openSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { loadConfig, RefreshRefused, runRefresh, type DatabaseUrl, type MysqlPort, type RefreshReport } from "./refresh.js";

const SAFE_TABLE = /^[A-Za-z0-9_]+$/;

function assertSafe(tables: readonly string[]): void {
  for (const table of tables) if (!SAFE_TABLE.test(table)) throw new RefreshRefused("source.unsafeTableName");
}

function connectionArgs(db: DatabaseUrl): string[] {
  return [`--host=${db.host}`, `--port=${db.port}`, `--user=${db.user}`];
}

/** The password goes through the child's environment only; stderr is discarded. */
function childEnv(db: DatabaseUrl): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, MYSQL_PWD: db.password, LANG: "C" };
}

function query(db: DatabaseUrl, sql: string): Promise<string[][]> {
  return new Promise((resolve, reject) => {
    const child = spawn("mysql", [...connectionArgs(db), "--batch", "--skip-column-names", "--raw", `--database=${db.database}`, "-e", sql], {
      env: childEnv(db),
      stdio: ["ignore", "pipe", "ignore"],
    });
    let out = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => (out += chunk));
    child.on("error", () => reject(new Error("mysql.spawn")));
    child.on("close", (code) => {
      if (code !== 0) return reject(new Error("mysql.exit"));
      resolve(out.split("\n").filter((line) => line.length > 0).map((line) => line.split("\t")));
    });
  });
}

export const mysqlClient: MysqlPort = {
  async grants(db) {
    return (await query(db, "SHOW GRANTS FOR CURRENT_USER()")).map((row) => row[0] ?? "");
  },
  async tables(db) {
    const rows = await query(db, "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'");
    return rows.map((row) => row[0]!);
  },
  copy(source, target, tables) {
    assertSafe(tables);
    return new Promise((resolve, reject) => {
      const dump = spawn(
        "mysqldump",
        [...connectionArgs(source), "--single-transaction", "--quick", "--skip-lock-tables", "--no-tablespaces", "--skip-triggers", "--skip-routines", "--skip-events", source.database, ...tables],
        { env: childEnv(source), stdio: ["ignore", "pipe", "ignore"] },
      );
      const load = spawn("mysql", [...connectionArgs(target), `--database=${target.database}`], {
        env: childEnv(target),
        stdio: ["pipe", "ignore", "ignore"],
      });
      dump.stdout.pipe(load.stdin);
      let pending = 2;
      let failed = false;
      const done = (code: number | null) => {
        if (code !== 0) failed = true;
        pending -= 1;
        if (pending === 0) (failed ? reject(new Error("copy.exit")) : resolve());
      };
      dump.on("error", () => reject(new Error("mysqldump.spawn")));
      load.on("error", () => reject(new Error("mysql.spawn")));
      dump.on("close", done);
      load.on("close", done);
    });
  },
  async dropTablesNotIn(target, keep) {
    const keepSet = new Set(keep);
    const stale = (await this.tables(target)).filter((table) => !keepSet.has(table));
    assertSafe(stale);
    if (stale.length > 0) await query(target, `DROP TABLE ${stale.map((t) => `\`${t}\``).join(", ")}`);
  },
  async counts(db, tables) {
    assertSafe(tables);
    const counts: Record<string, number> = {};
    for (let i = 0; i < tables.length; i += 50) {
      const batch = tables.slice(i, i + 50);
      const sql = batch.map((t) => `SELECT '${t}', COUNT(*) FROM \`${t}\``).join(" UNION ALL ");
      for (const [table, count] of await query(db, sql)) counts[table!] = Number(count);
    }
    return counts;
  },
};

export function summary(report: RefreshReport): string {
  return `legacy-refresh: ${report.code} tables=${Object.keys(report.tables).length} rows=${report.totalRows} excluded=${report.excluded.length} ms=${report.durationMs}`;
}

function writeReport(reportPath: string, report: RefreshReport): void {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  const temp = `${reportPath}.tmp`;
  writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o640 });
  renameSync(temp, reportPath);
}

/** A lock older than this was left by a crashed run; the nightly job may take it over. */
export const STALE_LOCK_MS = 6 * 60 * 60 * 1000;

export function takeLock(lockPath: string, now: number): number {
  try {
    return openSync(lockPath, "wx");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    if (now - statSync(lockPath).mtimeMs < STALE_LOCK_MS) throw error;
    unlinkSync(lockPath);
    return openSync(lockPath, "wx");
  }
}

async function main(): Promise<number> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (error) {
    console.error(`legacy-refresh: ${error instanceof RefreshRefused ? error.code : "config.invalid"}`);
    return 2;
  }
  mkdirSync(path.dirname(config.lockPath), { recursive: true });
  let lock: number;
  try {
    lock = takeLock(config.lockPath, Date.now());
  } catch {
    console.error("legacy-refresh: locked (another run in progress)");
    return 3;
  }
  try {
    const report = await runRefresh(config, mysqlClient);
    writeReport(config.reportPath, report);
    console.log(summary(report));
    return report.ok ? 0 : 1;
  } finally {
    closeSync(lock);
    unlinkSync(config.lockPath);
  }
}

const entry = process.argv[1];
if (entry && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(entry))) {
  main().then((code) => (process.exitCode = code));
}
