import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, closeSync, existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { acquireLock, createMysqlClient, runCli, spawnScoped, summary } from "../src/refresh-cli.js";
import {
  coversDatabase,
  isExcluded,
  loadConfig,
  parseDatabaseUrl,
  RefreshRefused,
  runRefresh,
  writePrivileges,
  type DatabaseUrl,
  type MysqlPort,
} from "../src/refresh.js";

const SOURCE = "mysql://reader:s3cret%21@legacy-replica.internal:3306/payroll";
const TARGET = "mysql://mirror:m1rror@staging-db.internal:3306/legacy_mirror";
const env = { LEGACY_REFRESH_SOURCE_URL: SOURCE, LEGACY_REFRESH_TARGET_URL: TARGET };
const READ_ONLY = ["GRANT USAGE ON *.* TO `reader`@`%`", "GRANT SELECT, SHOW VIEW ON `payroll`.* TO `reader`@`%`"];

function fakeMysql(overrides: Partial<MysqlPort> = {}, log: string[] = []): MysqlPort {
  const legacy: Record<string, number> = { candidate: 3, company: 2, candidate_token: 9, staff_token: 1, transfer: 4 };
  const mirror = new Map<string, number>([["old_table", 1]]);
  return {
    async serverId(db: DatabaseUrl) {
      return db.database === "payroll" ? "uuid-legacy" : "uuid-staging";
    },
    async grants() {
      return READ_ONLY;
    },
    async tables(db: DatabaseUrl) {
      return db.database === "payroll" ? Object.keys(legacy) : [...mirror.keys()];
    },
    async engines() {
      return Object.fromEntries(Object.keys(legacy).map((table) => [table, "InnoDB"]));
    },
    async foldsCase() {
      return false;
    },
    async copy(_source, _target, tables) {
      log.push(`copy ${tables.join(",")}`);
      for (const table of tables) mirror.set(table, legacy[table]!);
    },
    async dropTablesNotIn(_target, keep) {
      for (const table of [...mirror.keys()]) if (!keep.includes(table)) mirror.delete(table);
      log.push(`keep ${keep.join(",")}`);
    },
    async counts(_db, tables) {
      return Object.fromEntries(tables.map((table) => [table, mirror.get(table)!]));
    },
    ...overrides,
  };
}

const ticking = () => {
  let t = Date.parse("2026-11-18T00:00:00Z");
  return () => new Date((t += 1000));
};

test("config refuses a target that is not legacy_mirror, the source itself, or not mysql", () => {
  assert.equal(loadConfig(env).target.database, "legacy_mirror");
  assert.equal(loadConfig(env).source.password, "s3cret!");
  const refused = (e: NodeJS.ProcessEnv) => {
    try {
      loadConfig(e);
      return "accepted";
    } catch (error) {
      return (error as RefreshRefused).code;
    }
  };
  assert.equal(refused({ ...env, LEGACY_REFRESH_TARGET_URL: "mysql://m:p@staging-db.internal/payroll" }), "config.target.notMirror");
  assert.equal(refused({ ...env, LEGACY_REFRESH_TARGET_URL: "mysql://m:p@legacy-replica.internal:3306/legacy_mirror" }), "config.target.isSource");
  assert.equal(refused({ ...env, LEGACY_REFRESH_SOURCE_URL: "postgres://r:p@h/db" }), "config.source.notMysql");
  assert.equal(refused({ LEGACY_REFRESH_TARGET_URL: TARGET }), "config.source.missing");
  assert.throws(() => parseDatabaseUrl("mysql://host-only", "x"), /config.x.incomplete/);
});

test("read-only grants pass; any write privilege, grant option or unreadable role grant refuses", () => {
  assert.deepEqual(writePrivileges(READ_ONLY), []);
  assert.deepEqual(writePrivileges(["GRANT SELECT, INSERT ON `payroll`.* TO `r`@`%`"]), ["INSERT"]);
  assert.deepEqual(writePrivileges(["GRANT ALL PRIVILEGES ON *.* TO `r`@`%`"]), ["ALL PRIVILEGES"]);
  assert.deepEqual(writePrivileges(["GRANT SELECT ON `payroll`.* TO `r`@`%` WITH GRANT OPTION"]), ["GRANT OPTION"]);
  assert.deepEqual(writePrivileges(["GRANT UPDATE (`name`) ON `payroll`.`candidate` TO `r`@`%`"]), ["UPDATE"]);
  assert.deepEqual(writePrivileges(["GRANT `app_writer`@`%` TO `r`@`%`"]), ["UNREADABLE GRANT"]);
});

test("the read-only check is an allowlist: unlisted, unknown or missing privileges refuse", () => {
  const on = (privileges: string) => [`GRANT ${privileges} ON \`payroll\`.* TO \`r\`@\`%\``];
  assert.deepEqual(writePrivileges(on("SELECT, CREATE TEMPORARY TABLES")), ["CREATE TEMPORARY TABLES"]);
  assert.deepEqual(writePrivileges(["GRANT CREATE TABLESPACE ON *.* TO `r`@`%`"]), ["CREATE TABLESPACE"]);
  assert.deepEqual(writePrivileges(["GRANT BACKUP_ADMIN,SYSTEM_VARIABLES_ADMIN ON *.* TO `r`@`%`"]), ["BACKUP_ADMIN", "SYSTEM_VARIABLES_ADMIN"]);
  assert.deepEqual(writePrivileges(on("SELECT, LOCK TABLES")), ["LOCK TABLES"]);
  assert.deepEqual(writePrivileges(on("SOME FUTURE PRIVILEGE")), ["SOME FUTURE PRIVILEGE"]);
  assert.deepEqual(writePrivileges(["GRANT PROXY ON ``@`` TO `r`@`%`"]), ["PROXY"]);
  assert.deepEqual(writePrivileges(on("SELECT (`id`), SHOW  VIEW")), []);
  assert.deepEqual(writePrivileges([...READ_ONLY, "REVOKE SELECT ON `payroll`.`staff` FROM `r`@`%`"]), []);
  assert.deepEqual(writePrivileges([]), ["NO GRANTS"]);
});

test("a column list is one privilege, commas inside it included", () => {
  const on = (privileges: string) => [`GRANT ${privileges} ON \`payroll\`.\`candidate\` TO \`r\`@\`%\``];
  assert.deepEqual(writePrivileges(on("SELECT (`id`, `name`), SHOW VIEW")), []);
  assert.deepEqual(writePrivileges(on("SELECT (`id`, `name`), INSERT (`name`)")), ["INSERT"]);
  assert.deepEqual(writePrivileges(on("UPDATE (`a`,`b`,`c`)")), ["UPDATE"]);
});

test("SELECT must cover the whole source database, or the run refuses before copying", async () => {
  assert.equal(coversDatabase(READ_ONLY, "payroll"), true);
  assert.equal(coversDatabase(["GRANT SELECT ON *.* TO `r`@`%`"], "payroll"), true);
  assert.equal(coversDatabase(["GRANT SELECT ON `pay\\_roll`.* TO `r`@`%`"], "pay_roll"), true);
  assert.equal(coversDatabase(["GRANT USAGE ON *.* TO `r`@`%`", "GRANT SELECT ON `payroll`.`candidate` TO `r`@`%`"], "payroll"), false);
  assert.equal(coversDatabase(["GRANT SELECT (`id`) ON `payroll`.* TO `r`@`%`"], "payroll"), false);
  assert.equal(coversDatabase(["GRANT SELECT ON `other`.* TO `r`@`%`"], "payroll"), false);
  assert.equal(coversDatabase([...READ_ONLY, "REVOKE SELECT ON `payroll`.`staff` FROM `r`@`%`"], "payroll"), false);
  const log: string[] = [];
  const tableOnly = ["GRANT USAGE ON *.* TO `r`@`%`", "GRANT SELECT ON `payroll`.`candidate` TO `r`@`%`"];
  const report = await runRefresh(loadConfig(env), fakeMysql({ grants: async () => tableOnly }, log), ticking());
  assert.deepEqual([report.ok, report.code], [false, "source.partialGrant"]);
  assert.deepEqual(log, [], "nothing pruned or copied");
});

test("non-InnoDB tables are copied and named, since they have no snapshot", async () => {
  const report = await runRefresh(loadConfig(env), fakeMysql({ engines: async () => ({ candidate: "InnoDB", company: "MyISAM", transfer: "InnoDB" }) }), ticking());
  assert.equal(report.ok, true);
  assert.deepEqual(report.nonTransactional, ["company"]);
});

test("on a case-folding target, source names that fold together refuse before anything is touched", async () => {
  const log: string[] = [];
  const report = await runRefresh(
    loadConfig(env),
    fakeMysql({ foldsCase: async () => true, tables: async (db) => (db.database === "payroll" ? ["Candidate", "candidate", "company"] : []) }, log),
    ticking(),
  );
  assert.deepEqual([report.ok, report.code], [false, "source.caseCollision"]);
  assert.deepEqual(log, []);
  const fine = await runRefresh(loadConfig(env), fakeMysql({ foldsCase: async () => true }), ticking());
  assert.equal(fine.ok, true);
});

test("token tables are never copied", () => {
  assert.equal(isExcluded("candidate_token"), true);
  assert.equal(isExcluded("session"), true);
  assert.equal(isExcluded("candidate"), false);
  assert.equal(isExcluded("token_history"), false);
  for (const table of ["Candidate_Token", "oauth_access_tokens", "QUEUE", "queues", "Sessions"]) assert.equal(isExcluded(table), true, table);
  for (const table of ["session_log", "user_session", "queue_stats", "tokenizer"]) assert.equal(isExcluded(table), false, table);
});

test("a refresh copies every non-token table, prunes stale mirror tables, and reports counts only", async () => {
  const log: string[] = [];
  const report = await runRefresh(loadConfig(env), fakeMysql({}, log), ticking());
  assert.equal(report.ok, true);
  // Pruned before the copy (an excluded table never outlives a failed copy) and after it.
  assert.deepEqual(log, ["keep candidate,company,transfer", "copy candidate,company,transfer", "keep candidate,company,transfer"]);
  assert.deepEqual(report.nonTransactional, []);
  assert.deepEqual(report.tables, { candidate: 3, company: 2, transfer: 4 });
  assert.deepEqual(report.excluded, ["candidate_token", "staff_token"]);
  assert.equal(report.totalRows, 9);
  assert.equal(report.durationMs, 1000);
  const text = JSON.stringify(report) + summary(report);
  for (const secret of ["s3cret", "m1rror", "legacy-replica", "staging-db", "reader"]) assert.equal(text.includes(secret), false, secret);
  assert.equal(summary(report), "legacy-refresh: ok tables=3 rows=9 excluded=2 ms=1000");
});

test("a writable source account refuses before anything is copied", async () => {
  const log: string[] = [];
  const mysql = fakeMysql({ grants: async () => ["GRANT SELECT, DELETE ON `payroll`.* TO `r`@`%`"] }, log);
  const report = await runRefresh(loadConfig(env), mysql, ticking());
  assert.equal(report.ok, false);
  assert.equal(report.code, "source.notReadOnly");
  assert.deepEqual(log, []);
});

test("failures report a fixed code per step and never the error text", async () => {
  const leaky = new Error("ERROR 1045 Access denied for user 'reader'@'legacy-replica.internal' (using password: s3cret)");
  const steps: [Partial<MysqlPort>, string][] = [
    [{ grants: async () => Promise.reject(leaky) }, "failed.grants"],
    [{ tables: async () => Promise.reject(leaky) }, "failed.tables"],
    [{ copy: async () => Promise.reject(leaky) }, "failed.copy"],
    [{ foldsCase: async () => Promise.reject(leaky) }, "failed.target"],
    [{ engines: async () => Promise.reject(leaky) }, "failed.tables"],
    [{ dropTablesNotIn: async () => Promise.reject(leaky) }, "failed.prune"],
    [{ counts: async () => Promise.reject(leaky) }, "failed.counts"],
    [{ counts: async () => ({ candidate: 3 }) }, "target.countMissing"],
    [{ tables: async () => ["candidate_token"] }, "source.empty"],
    [{ tables: async () => Promise.reject(new RefreshRefused("source.unsafeTableName")) }, "source.unsafeTableName"],
  ];
  for (const [override, code] of steps) {
    const report = await runRefresh(loadConfig(env), fakeMysql(override), ticking());
    assert.equal(report.ok, false, code);
    assert.equal(report.code, code);
    assert.equal(JSON.stringify(report).includes("s3cret"), false);
    assert.equal(JSON.stringify(report).includes("legacy-replica"), false);
  }
});

test("every way a run ends leaves a fresh report, so a stale ok is never read", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "refresh-cli-"));
  const reportPath = path.join(dir, "last-run.json");
  const lockPath = path.join(dir, "run.lock");
  const report = () => JSON.parse(readFileSync(reportPath, "utf8")) as { ok: boolean; code: string; tables: object };
  const staleOk = () => writeFileSync(reportPath, JSON.stringify({ ok: true, code: "ok", tables: { candidate: 3 } }));
  const lines: string[] = [];
  const deps = (over: Partial<Parameters<typeof runCli>[0]> = {}): Parameters<typeof runCli>[0] => ({
    env: { ...env, LEGACY_REFRESH_REPORT: reportPath, LEGACY_REFRESH_LOCK: lockPath },
    mysql: () => fakeMysql(),
    now: ticking(),
    log: (line) => lines.push(line),
    error: (line) => lines.push(line),
    ...over,
  });
  try {
    staleOk();
    assert.equal(await runCli(deps({ env: { LEGACY_REFRESH_REPORT: reportPath } })), 2);
    assert.deepEqual([report().ok, report().code], [false, "config.source.missing"]);

    staleOk();
    const holder = await acquireLock(lockPath);
    assert.equal(holder.held, true);
    assert.equal(await runCli(deps()), 3);
    // Only the lock owner writes last-run.json; the refused attempt is recorded beside it.
    assert.deepEqual([report().ok, report().code], [true, "ok"]);
    const refused = JSON.parse(readFileSync(path.join(dir, "last-refused.json"), "utf8")) as { ok: boolean; code: string };
    assert.deepEqual([refused.ok, refused.code], [false, "locked"]);
    if (holder.held) closeSync(holder.fd);

    let seenDuringCopy = "";
    const watching = fakeMysql({
      async copy() {
        seenDuringCopy = report().code;
      },
      async counts(_db, tables) {
        return Object.fromEntries(tables.map((t) => [t, 1]));
      },
    });
    staleOk();
    assert.equal(await runCli(deps({ mysql: () => watching })), 0);
    assert.equal(seenDuringCopy, "running");
    assert.deepEqual([report().ok, report().code], [true, "ok"]);
    assert.equal(existsSync(lockPath), true, "the lock file is never deleted");

    staleOk();
    assert.equal(await runCli(deps({ mysql: () => fakeMysql({ grants: async () => ["GRANT SELECT, CREATE TEMPORARY TABLES ON *.* TO `r`@`%`"] }) })), 1);
    assert.deepEqual([report().ok, report().code], [false, "source.notReadOnly"]);

    staleOk();
    let calls = 0;
    const crashingClock = () => {
      calls += 1;
      if (calls === 2) throw new Error("clock");
      return new Date();
    };
    assert.equal(await runCli(deps({ now: crashingClock })), 1);
    assert.equal(report().ok, false);
    assert.equal(existsSync(lockPath), true, "the lock file is never deleted");
    assert.deepEqual(readdirSync(dir).sort(), ["last-refused.json", "last-run.json", "run.lock"], "no temp report files left behind");
    for (const line of lines) assert.equal(/s3cret|m1rror|legacy-replica|staging-db/.test(line), false, line);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a source and target that are the same server under different names refuse", async () => {
  const report = await runRefresh(loadConfig(env), fakeMysql({ serverId: async () => "uuid-same" }), ticking());
  assert.deepEqual([report.ok, report.code], [false, "target.isSource"]);
  const failing = await runRefresh(loadConfig(env), fakeMysql({ serverId: async () => Promise.reject(new Error("x")) }), ticking());
  assert.deepEqual([failing.ok, failing.code], [false, "failed.server"]);
});

const exited = (child: ReturnType<typeof spawn>) => new Promise<void>((resolve) => child.on("close", () => resolve()));

test("the run lock is exclusive under concurrency and never stale, taken over or released by another run", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "refresh-lock-"));
  const lockPath = path.join(dir, "run.lock");
  try {
    // Two runs started together: exactly one gets the lock.
    const both = await Promise.all([acquireLock(lockPath), acquireLock(lockPath), acquireLock(lockPath)]);
    assert.equal(both.filter((r) => r.held).length, 1);
    assert.deepEqual(both.filter((r) => !r.held).map((r) => !r.held && r.code), ["locked", "locked"]);
    for (const r of both) if (r.held) closeSync(r.fd);

    // A long run keeps its lock however old the file is: there is no takeover by age.
    const long = await acquireLock(lockPath);
    assert.equal(long.held, true);
    const { utimesSync } = await import("node:fs");
    const old = Date.now() / 1000 - 24 * 3600;
    utimesSync(lockPath, old, old);
    assert.equal((await acquireLock(lockPath)).held, false);

    // A child started by the run keeps the lock after the run's own descriptor closes.
    if (!long.held) throw new Error("unreachable");
    const child = spawn("sleep", ["30"], { stdio: ["ignore", "ignore", "ignore", long.fd] });
    closeSync(long.fd);
    assert.equal((await acquireLock(lockPath)).held, false, "orphaned child still holds the lock");
    child.kill("SIGKILL");
    await exited(child);

    // A crashed holder (killed, no cleanup) leaves nothing behind: the kernel released it.
    const crashed = spawn("flock", ["--nonblock", "--no-fork", lockPath, "sleep", "30"], { stdio: "ignore" });
    await new Promise((r) => setTimeout(r, 200));
    assert.equal((await acquireLock(lockPath)).held, false);
    crashed.kill("SIGKILL");
    await exited(crashed);
    const after = await acquireLock(lockPath);
    assert.equal(after.held, true);
    if (after.held) closeSync(after.fd);
    assert.equal(existsSync(lockPath), true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("two CLI runs at once: one refreshes, the other exits locked and copies nothing", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "refresh-cli2-"));
  try {
    const copies: string[] = [];
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const slow = fakeMysql({
      async copy(_s, _t, tables) {
        copies.push(tables.join(","));
        await gate;
      },
      async counts(_db, tables) {
        return Object.fromEntries(tables.map((t) => [t, 1]));
      },
    });
    const deps = {
      env: { ...env, LEGACY_REFRESH_REPORT: path.join(dir, "last-run.json"), LEGACY_REFRESH_LOCK: path.join(dir, "run.lock") },
      mysql: () => slow,
      now: () => new Date(),
      log: () => undefined,
      error: () => undefined,
    };
    let copyStarted!: () => void;
    const started = new Promise<"copying">((r) => (copyStarted = () => r("copying")));
    const watched = { ...slow, copy: async (...args: Parameters<MysqlPort["copy"]>) => (copyStarted(), slow.copy(...args)) };
    const first = runCli({ ...deps, mysql: () => watched });
    try {
      // The first run must reach its copy; finishing before that is a failure, not a hang.
      assert.equal(await Promise.race([started, first.then((code) => `exited ${code}`)]), "copying");
      assert.equal(await runCli(deps), 3);
    } finally {
      release();
    }
    assert.equal(await first, 0);
    assert.equal(copies.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a missing flock binary fails closed once, with no double close and no crash", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "refresh-noflock-"));
  const savedPath = process.env.PATH;
  try {
    process.env.PATH = dir;
    const result = await acquireLock(path.join(dir, "run.lock"));
    assert.deepEqual(result, { held: false, code: "lock.unavailable" });
    await new Promise((r) => setTimeout(r, 50));
  } finally {
    process.env.PATH = savedPath;
    rmSync(dir, { recursive: true, force: true });
  }
  const again = await acquireLock(path.join(mkdtempSync(path.join(tmpdir(), "refresh-relock-")), "run.lock"));
  assert.equal(again.held, true);
  if (again.held) closeSync(again.fd);
});

test("a report path that is the lock path is refused before anything is written", () => {
  const same = { ...env, LEGACY_REFRESH_REPORT: "/var/lib/x/run.lock", LEGACY_REFRESH_LOCK: "/var/lib/x/../x/run.lock" };
  assert.throws(() => loadConfig(same), /config.reportIsLock/);
  assert.throws(() => loadConfig({ ...env, LEGACY_REFRESH_TIMEOUT_MS: "soon" }), /config.timeout.invalid/);
  // Above Node's largest timer delay a timeout would fire after 1 ms.
  assert.throws(() => loadConfig({ ...env, LEGACY_REFRESH_TIMEOUT_MS: String(2 ** 31) }), /config.timeout.invalid/);
  assert.equal(loadConfig({ ...env, LEGACY_REFRESH_TIMEOUT_MS: String(2 ** 31 - 1) }).timeoutMs, 2 ** 31 - 1);
  assert.equal(loadConfig(env).timeoutMs, 4 * 60 * 60 * 1000);
});

test("a run past its deadline aborts its children, reports failed.timeout and frees the lock", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "refresh-deadline-"));
  try {
    const deps = {
      env: { ...env, LEGACY_REFRESH_REPORT: path.join(dir, "last-run.json"), LEGACY_REFRESH_LOCK: path.join(dir, "run.lock"), LEGACY_REFRESH_TIMEOUT_MS: "50" },
      mysql: (_fd: number, signal: AbortSignal) =>
        fakeMysql({
          copy: () => new Promise<void>((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("killed")))),
        }),
      now: () => new Date(),
      log: () => undefined,
      error: () => undefined,
    };
    assert.equal(await runCli(deps), 1);
    const report = JSON.parse(readFileSync(path.join(dir, "last-run.json"), "utf8")) as { ok: boolean; code: string };
    assert.deepEqual([report.ok, report.code], [false, "failed.timeout"]);
    const next = await acquireLock(path.join(dir, "run.lock"));
    assert.equal(next.held, true);
    if (next.held) closeSync(next.fd);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- Real mysql-tool children: every one, the mysqldump --help probe included, is scoped. ---

/** The TypeScript source, found from the compiled test (dist/tools/legacy-import/test). */
function cliSource(): string {
  for (const rel of ["../src/refresh-cli.ts", "../../../../tools/legacy-import/src/refresh-cli.ts"]) {
    const file = new URL(rel, import.meta.url);
    if (existsSync(file)) return readFileSync(file, "utf8");
  }
  throw new Error("refresh-cli.ts not found");
}

test("no child process in the refresh CLI bypasses spawnScoped (the flock helper aside)", () => {
  const source = cliSource();
  const calls = [...source.matchAll(/\bspawn\(([^,]+),/g)].map((match) => match[1]!.trim());
  // One spawn inside spawnScoped (command is its parameter) and one for flock, which gets
  // its own minimal env. Any new spawn, execFile or exec call fails this test.
  assert.deepEqual(calls.sort(), ['"flock"', "command"]);
  assert.doesNotMatch(source, /\b(execFile|execFileSync|exec|execSync|spawnSync|fork)\(/);
  assert.match(source, /spawn\("flock", \[[^\]]*\], \{\s*env: \{ PATH: process\.env\.PATH, LANG: "C" \}/);
});

/** Fake mysql and mysqldump on PATH that log what each child could see. */
function fakeTools(dir: string, helpScript: string): string {
  const bin = path.join(dir, "bin");
  const log = path.join(dir, "children.log");
  // Logs argv[1..2], the LEGACY_REFRESH_* and MYSQL_* variables it can see, whether its
  // HOME holds any file (an option file there would be read) and whether fd 3 is open.
  const record = [
    `legacy=$(env | grep -c '^LEGACY_REFRESH_'); mysqlenv=$(env | grep '^MYSQL_' | cut -d= -f1 | sort | tr '\\n' ' ')`,
    `if [ -d "$HOME" ] && [ -z "$(ls -A "$HOME")" ]; then home=empty; else home=used; fi`,
    `if { true >&3; } 2>/dev/null; then fd3=open; else fd3=closed; fi`,
    `echo "$(basename "$0") $1 $2 legacy=$legacy env=[$mysqlenv] home=$home fd3=$fd3" >> ${JSON.stringify(log)}`,
  ].join("\n");
  const tools: Record<string, string> = {
    mysqldump: `#!/bin/sh\n${record}\nif [ "$2" = "--help" ]; then\n${helpScript}\nfi\necho "SELECT 1;"\n`,
    mysql: `#!/bin/sh\n${record}\nfor a in "$@"; do if [ "$a" = "-e" ]; then echo "uuid-x"; exit 0; fi; done\ncat > /dev/null\n`,
  };
  for (const [name, body] of Object.entries(tools)) {
    writeFileSync(path.join(bin, name), body);
    chmodSync(path.join(bin, name), 0o755);
  }
  return log;
}

/** A HOME whose option files would connect as someone else, to somewhere else. */
function conflictingHome(dir: string): string {
  const home = path.join(dir, "home");
  mkdirSync(home);
  writeFileSync(path.join(home, ".my.cnf"), "[client]\nuser=intruder\npassword=wrong\nhost=intruder.example\n[mysqldump]\nuser=intruder\n");
  writeFileSync(path.join(home, ".mylogin.cnf"), "");
  return home;
}

async function withFakeTools(helpScript: string, body: (dir: string, log: string, lockFd: number) => Promise<void>): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "refresh-children-"));
  const keys = ["PATH", "HOME", "LEGACY_REFRESH_SOURCE_URL", "LEGACY_REFRESH_TARGET_URL", "MYSQL_HOST", "MYSQL_TEST_LOGIN_FILE"] as const;
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  const lock = await acquireLock(path.join(dir, "run.lock"));
  assert.equal(lock.held, true);
  if (!lock.held) return;
  try {
    mkdirSync(path.join(dir, "bin"));
    const log = fakeTools(dir, helpScript);
    // The parent holds both credential URLs, as the staging cron job does, plus a HOME
    // with option files and MYSQL_* variables that point somewhere else.
    process.env.PATH = `${path.join(dir, "bin")}:${saved.PATH ?? ""}`;
    process.env.HOME = conflictingHome(dir);
    process.env.LEGACY_REFRESH_SOURCE_URL = SOURCE;
    process.env.LEGACY_REFRESH_TARGET_URL = TARGET;
    process.env.MYSQL_HOST = "intruder.example";
    process.env.MYSQL_TEST_LOGIN_FILE = path.join(process.env.HOME, ".mylogin.cnf");
    await body(dir, log, lock.fd);
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    closeSync(lock.fd);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("every mysql child, the mysqldump probe included, gets the scrubbed env and the lock fd", async () => {
  await withFakeTools('echo "  --set-gtid-purged=name"; exit 0', async (_dir, log, lockFd) => {
    const client = createMysqlClient(lockFd, new AbortController().signal);
    const source = parseDatabaseUrl(SOURCE, "source");
    const target = parseDatabaseUrl(TARGET, "target");
    assert.equal(await client.serverId(source), "uuid-x");
    await client.copy(source, target, ["candidate"]);
    const lines = readFileSync(log, "utf8").trim().split("\n").sort();
    // --no-defaults first, so no option file is read; an empty HOME, so no ~/.my.cnf or
    // ~/.mylogin.cnf exists to read; MYSQL_PWD is the only MYSQL_* variable.
    const seen = "legacy=0 env=[MYSQL_PWD ] home=empty fd3=open";
    assert.deepEqual(lines, [
      `mysql --no-defaults --host=legacy-replica.internal ${seen}`,
      `mysql --no-defaults --host=staging-db.internal ${seen}`,
      `mysqldump --no-defaults --help ${seen}`,
      `mysqldump --no-defaults --host=legacy-replica.internal ${seen}`,
    ]);
  });
});

test("a hung mysqldump probe is killed and reaped by the run deadline", async () => {
  await withFakeTools('echo $$ > "$(dirname "$0")/../probe.pid"; exec sleep 30', async (dir, _log, lockFd) => {
    const deadline = new AbortController();
    const client = createMysqlClient(lockFd, deadline.signal);
    const pidFile = path.join(dir, "probe.pid");
    const copying = client.copy(parseDatabaseUrl(SOURCE, "source"), parseDatabaseUrl(TARGET, "target"), ["candidate"]);
    // Abort only once the probe is running, however slow the machine is to start it.
    const waitUntil = Date.now() + 10_000;
    while (!(existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0)) {
      assert.ok(Date.now() < waitUntil, "the probe never started");
      await new Promise((r) => setTimeout(r, 20));
    }
    const pid = Number(readFileSync(pidFile, "utf8"));
    const started = Date.now();
    deadline.abort();
    await assert.rejects(copying, /probe.aborted/);
    assert.ok(Date.now() - started < 5000, "the copy waited for the probe instead of the deadline");
    // Settled on close, so the probe is already gone (reaped), not merely signalled.
    assert.throws(() => process.kill(pid, 0), /ESRCH/);
  });
});

test("the real mysql client ignores a conflicting ~/.my.cnf when started through spawnScoped", async (t) => {
  type Run = { readonly spawned: boolean; readonly code: number | null; readonly out: string };
  const printDefaults = (child: ReturnType<typeof spawn>) =>
    new Promise<Run>((resolve) => {
      let out = "";
      let spawned = true;
      child.stdout!.setEncoding("utf8");
      child.stdout!.on("data", (chunk: string) => (out += chunk));
      child.on("error", () => (spawned = false));
      child.on("close", (code) => resolve({ spawned, code, out }));
    });
  const dir = mkdtempSync(path.join(tmpdir(), "refresh-mycnf-"));
  const savedHome = process.env.HOME;
  try {
    const home = conflictingHome(dir);
    const checked: string[] = [];
    for (const tool of ["mysql", "mysqldump"] as const) {
      // Control: the installed tool does read that file when nothing stops it.
      process.env.HOME = savedHome;
      // `--help` ends with the option values in effect (`user  intruder`). MySQL accepts
      // `--print-defaults` only as the first argument, so it cannot follow `--no-defaults`.
      const plain = await printDefaults(spawn(tool, ["--help"], { env: { PATH: process.env.PATH, HOME: home }, stdio: ["ignore", "pipe", "ignore"] }));
      if (!plain.spawned) continue; // not installed: skipped, and said so below
      assert.equal(plain.code, 0, `${tool} control run failed`);
      assert.match(plain.out, /^user\s+intruder$/m, `${tool} control did not read the option file`);
      process.env.HOME = home;
      const scoped = await printDefaults(spawnScoped({}, tool, ["--help"], parseDatabaseUrl(SOURCE, "source"), ["ignore", "pipe", "ignore"]));
      assert.equal(scoped.spawned, true, `${tool} scoped run did not start`);
      assert.equal(scoped.code, 0, `${tool} scoped run failed`);
      assert.match(scoped.out, /^user\s+/m, `${tool} scoped run printed no option values`);
      assert.doesNotMatch(scoped.out, /intruder|wrong/, `${tool} read the option file`);
      checked.push(tool);
    }
    if (checked.length < 2) t.skip(`checked ${checked.join(", ") || "nothing"}; not installed: ${["mysql", "mysqldump"].filter((x) => !checked.includes(x)).join(", ")}`);
  } finally {
    if (savedHome === undefined) delete process.env.HOME;
    else process.env.HOME = savedHome;
    rmSync(dir, { recursive: true, force: true });
  }
});

test("no run, misconfigured or not, can replace the lock file while another run holds it", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "refresh-lock-alias-"));
  const state = path.join(dir, "state");
  const lockPath = path.join(state, "run.lock");
  const held = await acquireLock(lockPath);
  assert.equal(held.held, true);
  if (!held.held) return;
  try {
    const inode = statSync(lockPath).ino;
    symlinkSync(state, path.join(dir, "alias"));
    symlinkSync(lockPath, path.join(dir, "link.json"));
    linkSync(lockPath, path.join(dir, "hard.json"));
    const aliases = [lockPath, path.join(dir, "alias", "run.lock"), path.join(dir, "link.json"), path.join(dir, "hard.json"), path.join(dir, "alias", "..", "state", "run.lock")];
    for (const report of aliases) {
      for (const valid of [true, false]) {
        let copied = false;
        const errors: string[] = [];
        const code = await runCli({
          env: { ...(valid ? env : { LEGACY_REFRESH_TARGET_URL: TARGET }), LEGACY_REFRESH_REPORT: report, LEGACY_REFRESH_LOCK: lockPath },
          mysql: () => fakeMysql({ copy: async () => void (copied = true) }),
          now: () => new Date(),
          log: () => undefined,
          error: (line) => errors.push(line),
        });
        const label = `${report} (${valid ? "valid" : "invalid"} config)`;
        assert.equal(code, 2, label);
        assert.equal(copied, false, label);
        assert.match(errors.join("\n"), /report not written/, label);
        // Same inode under the lock path, still empty, still locked, no temp files left.
        assert.equal(statSync(lockPath).ino, inode, label);
        assert.equal(readFileSync(lockPath, "utf8"), "", label);
        assert.deepEqual(readdirSync(state), ["run.lock"], label);
        const second = await acquireLock(lockPath);
        assert.deepEqual(second, { held: false, code: "locked" }, label);
      }
    }
  } finally {
    closeSync(held.fd);
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a config error still writes its report when the report path is distinct from the lock", async () => {
  const dir = mkdtempSync(path.join(tmpdir(), "refresh-config-report-"));
  try {
    const report = path.join(dir, "last-run.json");
    const code = await runCli({
      env: { LEGACY_REFRESH_TARGET_URL: TARGET, LEGACY_REFRESH_REPORT: report, LEGACY_REFRESH_LOCK: path.join(dir, "run.lock") },
      mysql: () => fakeMysql(),
      now: () => new Date(),
      log: () => undefined,
      error: () => undefined,
    });
    assert.equal(code, 2);
    const written = JSON.parse(readFileSync(report, "utf8")) as { ok: boolean; code: string };
    assert.deepEqual([written.ok, written.code], [false, "config.source.missing"]);
    assert.deepEqual(readdirSync(dir), ["last-run.json"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
