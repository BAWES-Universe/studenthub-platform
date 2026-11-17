import assert from "node:assert/strict";
import test from "node:test";

import { STALE_LOCK_MS, summary, takeLock } from "../src/refresh-cli.js";
import {
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
const READ_ONLY = ["GRANT USAGE ON *.* TO `reader`@`%`", "GRANT SELECT, SHOW VIEW, LOCK TABLES ON `payroll`.* TO `reader`@`%`"];

function fakeMysql(overrides: Partial<MysqlPort> = {}, log: string[] = []): MysqlPort {
  const legacy: Record<string, number> = { candidate: 3, company: 2, candidate_token: 9, staff_token: 1, transfer: 4 };
  const mirror = new Map<string, number>([["old_table", 1]]);
  return {
    async grants() {
      return READ_ONLY;
    },
    async tables(db: DatabaseUrl) {
      return db.database === "payroll" ? Object.keys(legacy) : [...mirror.keys()];
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

test("token tables are never copied", () => {
  assert.equal(isExcluded("candidate_token"), true);
  assert.equal(isExcluded("session"), true);
  assert.equal(isExcluded("candidate"), false);
  assert.equal(isExcluded("token_history"), false);
});

test("a refresh copies every non-token table, prunes stale mirror tables, and reports counts only", async () => {
  const log: string[] = [];
  const report = await runRefresh(loadConfig(env), fakeMysql({}, log), ticking());
  assert.equal(report.ok, true);
  assert.deepEqual(log, ["copy candidate,company,transfer", "keep candidate,company,transfer"]);
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

test("a fresh lock blocks a second run; a lock left by a crash for six hours is taken over", async () => {
  const { closeSync, mkdtempSync, rmSync, utimesSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const path = await import("node:path");
  const dir = mkdtempSync(path.join(tmpdir(), "refresh-lock-"));
  try {
    const lock = path.join(dir, "run.lock");
    closeSync(takeLock(lock, Date.now()));
    assert.throws(() => takeLock(lock, Date.now()));
    const old = (Date.now() - STALE_LOCK_MS - 1000) / 1000;
    utimesSync(lock, old, old);
    closeSync(takeLock(lock, Date.now()));
    writeFileSync(lock, "");
    assert.throws(() => takeLock(lock, Date.now()));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
