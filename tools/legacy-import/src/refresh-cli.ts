/**
 * Entry point for the staging cron job. Exit 0 only when the mirror was refreshed and
 * counted. Every run that ends writes a fresh report, whatever the reason (bad config,
 * another run holding the lock, a crash), and a run marks the report `running` before it
 * touches the mirror, so `ok: true` always describes the mirror as it is now. Prints one
 * line: the code, the table count, the row total and the duration. Never prints rows,
 * hosts or credentials.
 *
 * One run at a time is a kernel lock, not a file that exists: `flock(2)` on the lock file,
 * taken through util-linux `flock` on a descriptor this process keeps open. The lock
 * belongs to that open file description, so it is held exactly as long as this process or
 * any mysql/mysqldump child it started is alive (the children inherit the descriptor), is
 * released by the kernel when the last of them exits or dies, and can never be stale,
 * taken over or released by another run. The lock file itself is never deleted.
 */
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  failureReport,
  loadConfig,
  RefreshRefused,
  reportPathFrom,
  runRefresh,
  type DatabaseUrl,
  type MysqlPort,
  type RefreshConfig,
  type RefreshReport,
} from "./refresh.js";

const SAFE_TABLE = /^[A-Za-z0-9_]+$/;

function assertSafe(tables: readonly string[]): void {
  for (const table of tables) if (!SAFE_TABLE.test(table)) throw new RefreshRefused("source.unsafeTableName");
}

/** Seconds a statement may wait on a metadata lock before it fails (MySQL default: a year). */
export const LOCK_WAIT_TIMEOUT_S = 600;

function connectionArgs(db: DatabaseUrl): string[] {
  return [`--host=${db.host}`, `--port=${db.port}`, `--user=${db.user}`];
}

/** mysql sessions also get a bounded metadata-lock wait. mysqldump takes no init command. */
function mysqlArgs(db: DatabaseUrl): string[] {
  return [...connectionArgs(db), `--init-command=SET SESSION lock_wait_timeout=${LOCK_WAIT_TIMEOUT_S}`];
}

/** The password goes through the child's environment only; stderr is discarded. */
function childEnv(db: DatabaseUrl): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: process.env.HOME, MYSQL_PWD: db.password, LANG: "C" };
}

/** stdio for a mysql child: the three standard streams, then the run's lock descriptor. */
type Stdio = ["ignore" | "pipe", "ignore" | "pipe", "ignore"];
function stdio(streams: Stdio, lockFd: number | undefined): (Stdio[number] | number)[] {
  return lockFd === undefined ? streams : [...streams, lockFd];
}

/**
 * The mysql client tools behind MysqlPort. With `lockFd`, every child inherits the run's
 * lock descriptor, so an orphaned mysqldump or load keeps the lock until it exits.
 */
export function createMysqlClient(lockFd?: number, signal?: AbortSignal): MysqlPort {
  // An aborted run (deadline passed) kills every child; each promise still waits for close.
  const killable = { signal, killSignal: "SIGKILL" as const };
  let gtidOption: Promise<string[]> | undefined;
  /** `--set-gtid-purged=OFF` where this mysqldump knows it (MySQL); MariaDB's does not. */
  function gtidArgs(): Promise<string[]> {
    gtidOption ??= new Promise((resolve) => {
      const probe = spawn("mysqldump", ["--help"], { stdio: ["ignore", "pipe", "ignore"] });
      let help = "";
      probe.stdout!.setEncoding("utf8");
      probe.stdout!.on("data", (chunk: string) => (help += chunk));
      probe.on("error", () => resolve([]));
      probe.on("close", () => resolve(help.includes("--set-gtid-purged") ? ["--set-gtid-purged=OFF"] : []));
    });
    return gtidOption;
  }

  function query(db: DatabaseUrl, sql: string): Promise<string[][]> {
    return new Promise((resolve, reject) => {
      const child = spawn("mysql", [...mysqlArgs(db), "--batch", "--skip-column-names", "--raw", `--database=${db.database}`, "-e", sql], {
        env: childEnv(db),
        stdio: stdio(["ignore", "pipe", "ignore"], lockFd),
        ...killable,
      });
      let out = "";
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => (out += chunk));
      child.on("error", () => reject(new Error("mysql.spawn")));
      child.on("close", (code) => {
        if (code !== 0) return reject(new Error("mysql.exit"));
        resolve(out.split("\n").filter((line) => line.length > 0).map((line) => line.split("\t")));
      });
    });
  }

  const client: MysqlPort = {
    async serverId(db) {
      const [row] = await query(db, "SELECT @@server_uuid");
      const id = row?.[0];
      if (!id) throw new Error("mysql.serverId");
      return id;
    },
    async grants(db) {
      // Plain SHOW GRANTS covers the session, roles included; mandatory roles are added
      // as a role grant line so the allowlist refuses them like any other role.
      const lines = (await query(db, "SHOW GRANTS")).map((row) => row[0] ?? "");
      const [mandatory] = await query(db, "SELECT @@GLOBAL.mandatory_roles");
      const roles = (mandatory?.[0] ?? "").trim();
      if (roles.length > 0 && roles.toUpperCase() !== "NULL") lines.push(`GRANT ${roles} TO CURRENT_USER`);
      return lines;
    },
    async tables(db) {
      const rows = await query(db, "SELECT table_name FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'");
      return rows.map((row) => row[0]!);
    },
    async copy(source, target, tables) {
      assertSafe(tables);
      const gtid = await gtidArgs();
      return new Promise((resolve, reject) => {
        const dump = spawn(
          "mysqldump",
          [
            ...connectionArgs(source),
            "--single-transaction",
            "--quick",
            "--skip-lock-tables",
            "--no-tablespaces",
            "--skip-triggers",
            "--skip-routines",
            "--skip-events",
            ...gtid,
            source.database,
            ...tables,
          ],
          { env: childEnv(source), stdio: stdio(["ignore", "pipe", "ignore"], lockFd), ...killable },
        );
        const load = spawn("mysql", [...mysqlArgs(target), `--database=${target.database}`], {
          env: childEnv(target),
          stdio: stdio(["pipe", "ignore", "ignore"], lockFd),
          ...killable,
        });
        // If either side fails, stop the other (a dump blocked on a full pipe would never
        // exit) and settle only once both have closed, so no child outlives the copy.
        let failed = false;
        let open = 2;
        const fail = () => {
          if (failed) return;
          failed = true;
          for (const child of [dump, load]) if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
        };
        const closed = (code: number | null) => {
          if (code !== 0) fail();
          open -= 1;
          if (open === 0) (failed ? reject(new Error("copy.exit")) : resolve());
        };
        load.stdin!.on("error", fail);
        dump.stdout!.on("error", fail);
        dump.stdout!.pipe(load.stdin!);
        dump.on("error", fail);
        load.on("error", fail);
        dump.on("close", closed);
        load.on("close", closed);
      });
    },
    async dropTablesNotIn(target, keep) {
      const keepSet = new Set(keep);
      const stale = (await client.tables(target)).filter((table) => !keepSet.has(table));
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
  return client;
}

/** Without a lock descriptor; the CLI always uses createMysqlClient(lockFd). */
export const mysqlClient: MysqlPort = createMysqlClient();

export function summary(report: RefreshReport): string {
  return `legacy-refresh: ${report.code} tables=${Object.keys(report.tables).length} rows=${report.totalRows} excluded=${report.excluded.length} ms=${report.durationMs}`;
}

function writeReport(reportPath: string, report: RefreshReport): void {
  mkdirSync(path.dirname(reportPath), { recursive: true });
  // A temp name per writer, so two writers can never interleave in one temp file.
  const temp = `${reportPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(temp, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o640 });
    renameSync(temp, reportPath);
  } finally {
    rmSync(temp, { force: true });
  }
}

export type LockResult = { readonly held: true; readonly fd: number } | { readonly held: false; readonly code: "locked" | "lock.unavailable" };

/**
 * Takes the run lock without waiting. `flock -n 3` locks the open file description this
 * process passes it as descriptor 3; the lock outlives the flock helper because this
 * process (and later its children) still hold that description. Close `fd` to release.
 */
export function acquireLock(lockPath: string): Promise<LockResult> {
  return new Promise((resolve) => {
    let fd: number;
    try {
      mkdirSync(path.dirname(lockPath), { recursive: true });
      fd = openSync(lockPath, "a", 0o600);
    } catch {
      return resolve({ held: false, code: "lock.unavailable" });
    }
    // A failed spawn emits both "error" and "close"; settle once so fd is closed once.
    let settled = false;
    const settle = (result: LockResult) => {
      if (settled) return;
      settled = true;
      if (!result.held) closeSync(fd);
      resolve(result);
    };
    const helper = spawn("flock", ["--nonblock", "--conflict-exit-code", "75", "3"], { stdio: ["ignore", "ignore", "ignore", fd] });
    helper.on("error", () => settle({ held: false, code: "lock.unavailable" }));
    helper.on("close", (code) => {
      if (code === 0) settle({ held: true, fd });
      else settle({ held: false, code: code === 75 ? "locked" : "lock.unavailable" });
    });
  });
}

export interface CliDeps {
  readonly env: NodeJS.ProcessEnv;
  /** Builds the MySQL port; children it starts must inherit `lockFd`. */
  readonly mysql: (lockFd: number, signal: AbortSignal) => MysqlPort;
  readonly now: () => Date;
  readonly log: (line: string) => void;
  readonly error: (line: string) => void;
}

/** Best effort: a report that cannot be written must not hide the run's own exit code. */
function tryWriteReport(reportPath: string, report: RefreshReport): void {
  try {
    writeReport(reportPath, report);
  } catch {
    // The exit code and the one-line output still say what happened.
  }
}

/** One run. Exit codes: 0 ok, 1 refresh failed, 2 configuration invalid, 3 locked or lock unavailable. */
export async function runCli(deps: CliDeps): Promise<number> {
  const reportPath = reportPathFrom(deps.env);
  let config: RefreshConfig;
  try {
    config = loadConfig(deps.env);
  } catch (error) {
    const code = error instanceof RefreshRefused ? error.code : "config.invalid";
    tryWriteReport(reportPath, failureReport(code, deps.now()));
    deps.error(`legacy-refresh: ${code}`);
    return 2;
  }
  const lock = await acquireLock(config.lockPath);
  if (!lock.held) {
    // Another run is copying right now (or the lock cannot be taken): not safe to read.
    tryWriteReport(config.reportPath, failureReport(lock.code, deps.now()));
    deps.error(`legacy-refresh: ${lock.code === "locked" ? "locked (another run in progress)" : lock.code}`);
    return 3;
  }
  try {
    writeReport(config.reportPath, failureReport("running", deps.now()));
    // A deadline long enough for a normal copy; past it every child is killed and reaped
    // (each step waits for its children to close) before the lock is released.
    const deadline = new AbortController();
    const timer = setTimeout(() => deadline.abort(), config.timeoutMs);
    let report: RefreshReport;
    try {
      report = await runRefresh(config, deps.mysql(lock.fd, deadline.signal), deps.now);
    } finally {
      clearTimeout(timer);
    }
    if (deadline.signal.aborted && !report.ok) report = { ...report, code: "failed.timeout" };
    writeReport(config.reportPath, report);
    deps.log(summary(report));
    return report.ok ? 0 : 1;
  } catch {
    tryWriteReport(config.reportPath, failureReport("failed.unexpected", deps.now()));
    deps.error("legacy-refresh: failed.unexpected");
    return 1;
  } finally {
    // Only this run's own descriptor; the file stays, and children still alive keep the lock.
    closeSync(lock.fd);
  }
}

const entry = process.argv[1];
if (entry && realpathSync(fileURLToPath(import.meta.url)) === realpathSync(path.resolve(entry))) {
  // Until the run settles, the exit code says failure: a run that never settles cannot exit 0.
  process.exitCode = 1;
  runCli({
    env: process.env,
    mysql: createMysqlClient,
    now: () => new Date(),
    log: (line) => console.log(line),
    error: (line) => console.error(line),
  }).then(
    (code) => (process.exitCode = code),
    () => {
      console.error("legacy-refresh: failed.unexpected");
      process.exitCode = 1;
    },
  );
}
