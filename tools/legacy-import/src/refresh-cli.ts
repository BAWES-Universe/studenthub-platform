/**
 * Entry point for the staging cron job. Exit 0 only when the mirror was refreshed and
 * counted. Every run that holds the lock writes a fresh report however it ends (a refused
 * copy, a crash, the deadline), and marks the report `running` before it touches the
 * mirror, so `ok: true` always describes the mirror as it is now. A configuration error
 * also writes the report (where that cannot touch the lock); a run refused by the lock
 * writes last-refused.json and leaves the owner's report alone. Prints one
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
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { closeSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  failureReport,
  loadConfig,
  lockPathFrom,
  refusedPathFrom,
  RefreshRefused,
  reportPathFrom,
  runRefresh,
  type DatabaseUrl,
  GENERATION,
  MIRROR_GENERATION_TABLE,
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

/**
 * TCP always: with `--host=localhost` the clients would otherwise use a Unix socket and
 * ignore the port, reaching whichever server owns the socket.
 */
function connectionArgs(db: DatabaseUrl): string[] {
  return [`--host=${db.host}`, `--port=${db.port}`, `--user=${db.user}`, "--protocol=TCP"];
}

/** Decodes a HEX() column; table names come back hex-encoded so a tab or newline cannot split them. */
function fromHex(hex: string): string {
  if (!/^(?:[0-9A-Fa-f]{2})*$/.test(hex)) throw new RefreshRefused("source.unsafeTableName");
  return Buffer.from(hex, "hex").toString("utf8");
}

const LIST_TABLES =
  "SELECT HEX(table_name), HEX(IFNULL(engine, '')) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_type = 'BASE TABLE'";

/** mysql sessions also get a bounded metadata-lock wait. mysqldump takes no init command. */
function mysqlArgs(db: DatabaseUrl): string[] {
  return [...connectionArgs(db), `--init-command=SET SESSION lock_wait_timeout=${LOCK_WAIT_TIMEOUT_S}`];
}

let emptyHome: string | undefined;
/**
 * An empty, private directory used as every child's HOME, so no `~/.my.cnf` or
 * `~/.mylogin.cnf` of the account running the job can supply a user, password, host or
 * other option. Created once per process and removed when the process exits.
 */
function childHome(): string {
  if (emptyHome === undefined) {
    const dir = mkdtempSync(path.join(tmpdir(), "legacy-refresh-home-"));
    emptyHome = dir;
    process.once("exit", () => rmSync(dir, { recursive: true, force: true }));
  }
  return emptyHome;
}

/**
 * The child's whole environment: the password for `db` only, an empty HOME, and nothing
 * else of the parent's (no LEGACY_REFRESH_* URLs, no MYSQL_HOST, MYSQL_TCP_PORT,
 * MYSQL_TEST_LOGIN_FILE or the like). stderr is discarded.
 */
function childEnv(db: DatabaseUrl): NodeJS.ProcessEnv {
  return { PATH: process.env.PATH, HOME: childHome(), MYSQL_PWD: db.password, LANG: "C" };
}

type Streams = ["ignore" | "pipe", "ignore" | "pipe", "ignore"];

/** How every mysql-tool child of a run is started: see {@link createMysqlClient}. */
export interface ChildScope {
  /** The run's lock descriptor, passed as the child's fd 3. */
  readonly lockFd?: number;
  /** The run's deadline; abort SIGKILLs the child. */
  readonly signal?: AbortSignal;
}

/**
 * The only way this tool starts a mysql or mysqldump process. Every child runs with
 * `--no-defaults` first and gets the scrubbed environment for `db` with an empty HOME
 * (never the parent's, which holds both LEGACY_REFRESH_*_URL values and option files),
 * the run's lock descriptor as fd 3, and the run's abort signal with SIGKILL. A test fails
 * if any other spawn call appears in this file besides this one and the flock helper.
 */
export function spawnScoped(scope: ChildScope, command: "mysql" | "mysqldump", args: readonly string[], db: DatabaseUrl, streams: Streams): ChildProcess {
  const stdio: (Streams[number] | number)[] = scope.lockFd === undefined ? [...streams] : [...streams, scope.lockFd];
  // --no-defaults must come first: no option file (/etc/mysql, /etc/my.cnf, ~/.my.cnf) is read,
  // so the connection is exactly the host, port, user and MYSQL_PWD this tool chose.
  return spawn(command, ["--no-defaults", ...args], { env: childEnv(db), stdio, signal: scope.signal, killSignal: "SIGKILL" });
}

/**
 * The mysql client tools behind MysqlPort. Every child, the mysqldump capability probe
 * included, starts through {@link spawnScoped}: it inherits the run's lock descriptor (an
 * orphaned child keeps the lock until it exits), is killed when the run's deadline aborts,
 * and sees only the password of the database it talks to. Each promise settles on close.
 */
export function createMysqlClient(lockFd?: number, signal?: AbortSignal): MysqlPort {
  const scope: ChildScope = { lockFd, signal };
  let gtidOption: Promise<string[]> | undefined;
  /** `--set-gtid-purged=OFF` where this mysqldump knows it (MySQL); MariaDB's does not. */
  function gtidArgs(source: DatabaseUrl): Promise<string[]> {
    gtidOption ??= new Promise((resolve, reject) => {
      const probe = spawnScoped(scope, "mysqldump", ["--help"], source, ["ignore", "pipe", "ignore"]);
      let help = "";
      probe.stdout!.setEncoding("utf8");
      probe.stdout!.on("data", (chunk: string) => (help += chunk));
      // "error" (missing binary, abort) is always followed by "close"; settle there only.
      probe.on("error", () => undefined);
      probe.on("close", () => {
        if (signal?.aborted) return reject(new Error("probe.aborted"));
        resolve(help.includes("--set-gtid-purged") ? ["--set-gtid-purged=OFF"] : []);
      });
    });
    return gtidOption;
  }

  function query(db: DatabaseUrl, sql: string): Promise<string[][]> {
    return new Promise((resolve, reject) => {
      const child = spawnScoped(scope, "mysql", [...mysqlArgs(db), "--batch", "--skip-column-names", "--raw", `--database=${db.database}`, "-e", sql], db, ["ignore", "pipe", "ignore"]);
      let out = "";
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => (out += chunk));
      // "error" (missing binary, abort) is always followed by "close"; settle there only,
      // so a killed child is reaped before the run moves on.
      let spawnFailed = false;
      child.on("error", () => (spawnFailed = true));
      child.on("close", (code) => {
        if (spawnFailed) return reject(new Error("mysql.spawn"));
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
      const names = (await query(db, LIST_TABLES)).map((row) => fromHex(row[0] ?? ""));
      // Refused here, before exclusion or pruning, so a name the tool cannot quote safely
      // never reaches a DROP or a dump.
      assertSafe(names);
      return names;
    },
    async engines(db) {
      const engines: Record<string, string> = {};
      for (const row of await query(db, LIST_TABLES)) engines[fromHex(row[0] ?? "")] = fromHex(row[1] ?? "");
      return engines;
    },
    async foldsCase(db) {
      const [row] = await query(db, "SELECT @@lower_case_table_names");
      const value = row?.[0];
      if (value === undefined || !/^[0-9]+$/.test(value)) throw new Error("mysql.lowerCaseTableNames");
      return value !== "0";
    },
    async copy(source, target, tables) {
      assertSafe(tables);
      const gtid = await gtidArgs(source);
      return new Promise((resolve, reject) => {
        const dump = spawnScoped(
          scope,
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
          source,
          ["ignore", "pipe", "ignore"],
        );
        const load = spawnScoped(scope, "mysql", [...mysqlArgs(target), `--database=${target.database}`], target, ["pipe", "ignore", "ignore"]);
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
      // Under lower_case_table_names the copy created `candidate` for a source `Candidate`;
      // compare as the server does, or the prune would drop the table it just loaded.
      const fold = await client.foldsCase(target);
      const key = (table: string) => (fold ? table.toLowerCase() : table);
      const keepSet = new Set(keep.map(key));
      const stale = (await client.tables(target)).filter((table) => !keepSet.has(key(table)));
      assertSafe(stale);
      // One session: foreign keys between mirror tables must not stop a stale table going.
      if (stale.length > 0) await query(target, `SET SESSION foreign_key_checks = 0; DROP TABLE ${stale.map((t) => `\`${t}\``).join(", ")}`);
    },
    async setGeneration(target, generation) {
      if (generation !== null && !GENERATION.test(generation)) throw new Error("mysql.generation");
      const table = `\`${MIRROR_GENERATION_TABLE}\``;
      // One session, one transaction: the marker is never seen holding two rows.
      await query(target, `CREATE TABLE IF NOT EXISTS ${table} (generation CHAR(36) NOT NULL) ENGINE=InnoDB; `
        + `START TRANSACTION; DELETE FROM ${table}; ${generation ? `INSERT INTO ${table} VALUES ('${generation}'); ` : ""}COMMIT`);
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

/** `p` with every existing ancestor resolved through symlinks (the leaf itself is not). */
function canonicalEntry(p: string): string {
  const absolute = path.resolve(p);
  const rest: string[] = [path.basename(absolute)];
  let dir = path.dirname(absolute);
  for (;;) {
    try {
      return path.join(realpathSync(dir), ...rest);
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return absolute;
      rest.unshift(path.basename(dir));
      dir = parent;
    }
  }
}

function fileId(p: string): string | undefined {
  try {
    const stat = statSync(p);
    return `${stat.dev}:${stat.ino}`;
  } catch {
    return undefined;
  }
}

/**
 * True when renaming a file onto `reportPath` could replace, or touch, the lock file: the
 * same directory entry after resolving symlinked directories, or (followed through any
 * symlink) the same inode, which also covers a symlink or hard link to the lock.
 */
export function reportReplacesLock(reportPath: string, lockPath: string): boolean {
  if (canonicalEntry(reportPath) === canonicalEntry(lockPath)) return true;
  const report = fileId(reportPath);
  return report !== undefined && report === fileId(lockPath);
}

/**
 * The only way a report is written. It refuses (throws) when the report could replace the
 * lock file, so no exit path, configuration error included, can swap the locked inode.
 * The temp file is created exclusively (`wx`), so it never truncates or replaces an
 * existing file, and only a temp file this call created is removed.
 */
function writeReport(reportPath: string, lockPath: string, report: RefreshReport): void {
  if (reportReplacesLock(reportPath, lockPath)) throw new RefreshRefused("config.reportIsLock");
  mkdirSync(path.dirname(reportPath), { recursive: true });
  // A temp name per writer, so two writers can never interleave in one temp file.
  const temp = `${reportPath}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  const fd = openSync(temp, "wx", 0o640); // fails if anything already has this name
  try {
    try {
      writeFileSync(fd, `${JSON.stringify(report, null, 2)}\n`);
    } finally {
      closeSync(fd);
    }
    renameSync(temp, reportPath);
  } finally {
    rmSync(temp, { force: true }); // ours: created above; gone already after the rename
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
    const helper = spawn("flock", ["--nonblock", "--conflict-exit-code", "75", "3"], {
      env: { PATH: process.env.PATH, LANG: "C" },
      stdio: ["ignore", "ignore", "ignore", fd],
    });
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

function safeToWrite(reportPath: string, lockPath: string): boolean {
  try {
    return !reportReplacesLock(reportPath, lockPath);
  } catch {
    return false;
  }
}

/**
 * Best effort: a report that cannot be written must not hide the run's own exit code.
 * Returns whether it was written, so the output line can say when it was not. The report
 * is built inside the attempt, so a failure while building it also counts as not written.
 */
function tryWriteReport(reportPath: string, lockPath: string, report: () => RefreshReport): boolean {
  try {
    writeReport(reportPath, lockPath, report());
    return true;
  } catch {
    return false;
  }
}

/** One run. Exit codes: 0 ok, 1 refresh failed, 2 configuration invalid, 3 locked or lock unavailable. */
export async function runCli(deps: CliDeps): Promise<number> {
  let config: RefreshConfig;
  try {
    config = loadConfig(deps.env);
    if (reportReplacesLock(config.reportPath, config.lockPath)) throw new RefreshRefused("config.reportIsLock");
  } catch (error) {
    const code = error instanceof RefreshRefused ? error.code : "config.invalid";
    // Written only where it cannot replace the lock (writeReport checks) or be the file a
    // contender writes; else stderr only.
    // The path checks are repeated here because loadConfig may have stopped before them.
    const reportPath = reportPathFrom(deps.env);
    const writable =
      code !== "config.reportIsLock" &&
      path.resolve(refusedPathFrom(reportPath)) !== path.resolve(reportPath) &&
      safeToWrite(reportPath, lockPathFrom(deps.env));
    const written = writable && tryWriteReport(reportPath, lockPathFrom(deps.env), () => failureReport(code, deps.now()));
    deps.error(`legacy-refresh: ${code}${written ? "" : " (report not written)"}`);
    return 2;
  }
  const lock = await acquireLock(config.lockPath);
  if (!lock.held) {
    // The owner's report (`running`, or its result) stays as it is: only the lock owner
    // writes last-run.json. This attempt is recorded beside it.
    const written = tryWriteReport(refusedPathFrom(config.reportPath), config.lockPath, () => failureReport(lock.code, deps.now()));
    const reason = lock.code === "locked" ? "locked (another run in progress)" : lock.code;
    deps.error(`legacy-refresh: ${reason}${written ? "" : " (report not written)"}`);
    return 3;
  }
  try {
    writeReport(config.reportPath, config.lockPath, failureReport("running", deps.now()));
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
    // An ok report names the lock it was produced under, so a reader can prove it holds the same one.
    if (report.ok) report = { ...report, lock: path.resolve(config.lockPath) };
    writeReport(config.reportPath, config.lockPath, report);
    deps.log(summary(report));
    return report.ok ? 0 : 1;
  } catch {
    const written = tryWriteReport(config.reportPath, config.lockPath, () => failureReport("failed.unexpected", deps.now()));
    deps.error(`legacy-refresh: failed.unexpected${written ? "" : " (report not written)"}`);
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
