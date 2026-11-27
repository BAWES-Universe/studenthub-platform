/**
 * Daily read-only legacy refresh on staging (decision 2026-11-17, extends SHU-105).
 *
 * Copies the legacy MySQL database into a staging-only `legacy_mirror` database, then
 * counts rows. Conditions it enforces rather than trusts:
 *  - read-only against legacy: the source account may hold only USAGE, SELECT and
 *    SHOW VIEW; any other privilege refuses the run;
 *  - a complete inventory: SELECT must cover the whole source database (`db`.* or *.*,
 *    with no partial revoke), because a table the account cannot see would otherwise be
 *    pruned from the mirror while the run still reported ok;
 *  - the target is a database named `legacy_mirror` on a server other than the source
 *    (different host name in config, and a different @@server_uuid at run time);
 *  - bearer-token tables are never copied;
 *  - nothing private leaves staging: the report carries table names, row counts and
 *    timings only, and error text is reduced to a fixed code so no value, host or
 *    credential can reach a log;
 *  - credentials reach mysql/mysqldump through MYSQL_PWD in the child environment,
 *    never through argv, and never appear in the report;
 *  - one run at a time (a kernel flock held for the life of the run and its children);
 *  - every run that holds the lock leaves a fresh last-run.json however it ends, and
 *    marks it `running` while it copies; a run refused by the lock writes
 *    last-refused.json instead and never touches the owner's report. Readers hold the
 *    same lock (shared) while they read, see docs/lanes/cutover/PLAN.md.
 *
 * The scheduler (cron on the staging host, installed by a Hermes card) runs
 * `node dist/tools/legacy-import/src/refresh-cli.js` with the environment below.
 */

import path from "node:path";

export const MIRROR_DATABASE = "legacy_mirror";

/**
 * Tables holding live bearer tokens, sessions or queued jobs; a mirror never needs them.
 * Case-insensitive and plural-tolerant, because MySQL on Linux keeps table-name case.
 */
export const EXCLUDED_TABLE_PATTERNS: readonly RegExp[] = [/_tokens?$/i, /^queues?$/i, /^sessions?$/i];

/**
 * The only privileges the source account may hold. Anything else, including a privilege
 * this list has never heard of, refuses the run: an allowlist, so a new or unusual
 * write-capable privilege (CREATE TEMPORARY TABLES, CREATE TABLESPACE, a dynamic
 * privilege, PROXY) cannot slip through.
 */
export const READ_ONLY_PRIVILEGES: readonly string[] = ["USAGE", "SELECT", "SHOW VIEW"];

export interface DatabaseUrl {
  readonly host: string;
  readonly port: number;
  readonly user: string;
  readonly password: string;
  readonly database: string;
}

export interface RefreshConfig {
  readonly source: DatabaseUrl;
  readonly target: DatabaseUrl;
  readonly reportPath: string;
  readonly lockPath: string;
  /** The whole run's deadline; LEGACY_REFRESH_TIMEOUT_MS, default four hours. */
  readonly timeoutMs: number;
}

export class RefreshRefused extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "RefreshRefused";
  }
}

export function parseDatabaseUrl(value: string | undefined, name: string): DatabaseUrl {
  if (!value) throw new RefreshRefused(`config.${name}.missing`);
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new RefreshRefused(`config.${name}.invalid`);
  }
  if (url.protocol !== "mysql:") throw new RefreshRefused(`config.${name}.notMysql`);
  const database = decodeURIComponent(url.pathname.replace(/^\//, ""));
  if (!url.hostname || !url.username || !database) throw new RefreshRefused(`config.${name}.incomplete`);
  return {
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: decodeURIComponent(url.username),
    password: decodeURIComponent(url.password),
    database,
  };
}

export const DEFAULT_TIMEOUT_MS = 4 * 60 * 60 * 1000;

/** Node's largest timer delay; a longer one fires after 1 ms. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

export const DEFAULT_REPORT_PATH = "/var/lib/legacy-refresh/last-run.json";

/** Where the report goes; readable even when the rest of the configuration is not. */
export function reportPathFrom(env: NodeJS.ProcessEnv): string {
  return env.LEGACY_REFRESH_REPORT || DEFAULT_REPORT_PATH;
}

export const DEFAULT_LOCK_PATH = "/var/lib/legacy-refresh/run.lock";

/** Where the run lock lives; readable even when the rest of the configuration is not. */
export function lockPathFrom(env: NodeJS.ProcessEnv): string {
  return env.LEGACY_REFRESH_LOCK || DEFAULT_LOCK_PATH;
}

/**
 * Where a run refused by the lock records itself: beside the report, never the report
 * itself, so a contender cannot overwrite the lock owner's `running` or `ok`.
 */
export function refusedPathFrom(reportPath: string): string {
  return path.join(path.dirname(reportPath), "last-refused.json");
}

export function loadConfig(env: NodeJS.ProcessEnv): RefreshConfig {
  const source = parseDatabaseUrl(env.LEGACY_REFRESH_SOURCE_URL, "source");
  const target = parseDatabaseUrl(env.LEGACY_REFRESH_TARGET_URL, "target");
  if (target.database !== MIRROR_DATABASE) throw new RefreshRefused("config.target.notMirror");
  if (target.host === source.host && target.port === source.port) throw new RefreshRefused("config.target.isSource");
  const reportPath = reportPathFrom(env);
  const lockPath = lockPathFrom(env);
  // The report is replaced by rename; if it were the lock file, a rename would swap the
  // locked inode for a fresh one and let a second run in. This is the lexical check; the
  // CLI also refuses aliases (symlinked directories, symlinks, hard links) on disk before
  // every report write, see reportReplacesLock in refresh-cli.ts.
  if (path.resolve(reportPath) === path.resolve(lockPath)) throw new RefreshRefused("config.reportIsLock");
  // A run refused by the lock writes last-refused.json beside the report; if the report
  // were that file, a contender would overwrite the lock owner's report.
  if (path.resolve(refusedPathFrom(reportPath)) === path.resolve(reportPath)) throw new RefreshRefused("config.reportIsRefused");
  const timeoutMs = env.LEGACY_REFRESH_TIMEOUT_MS ? Number(env.LEGACY_REFRESH_TIMEOUT_MS) : DEFAULT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > MAX_TIMEOUT_MS) throw new RefreshRefused("config.timeout.invalid");
  return { source, target, reportPath, lockPath, timeoutMs };
}

/**
 * Splits a privilege list on commas outside parentheses: `SELECT (a, b), SHOW VIEW`.
 * Parentheses and commas inside backtick-quoted column names (a doubled backtick is a
 * literal one) do not count. A list whose quotes or parentheses do not balance comes back
 * as one empty entry, which every caller treats as an unreadable grant.
 */
function splitPrivileges(list: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let i = 0; i < list.length; i += 1) {
    const ch = list[i]!;
    if (ch === "`") {
      if (quoted && list[i + 1] === "`") {
        current += "``";
        i += 1;
        continue;
      }
      quoted = !quoted;
    } else if (!quoted && ch === "(") depth += 1;
    else if (!quoted && ch === ")") {
      depth -= 1;
      if (depth < 0) return [""];
    }
    if (ch === "," && depth === 0 && !quoted) {
      parts.push(current);
      current = "";
    } else current += ch;
  }
  if (quoted || depth !== 0) return [""];
  parts.push(current);
  return parts.map((p) => p.trim());
}

interface ParsedGrant {
  readonly privileges: string[];
  /** The object as written after ON, backticks and escaped wildcards removed: `db.*`, `*.*`, `db.table`. */
  readonly object: string;
}

function parseGrant(line: string): ParsedGrant | undefined {
  const match = /^(?:GRANT|REVOKE)\s+(.+?)\s+ON\s+(?:TABLE\s+|FUNCTION\s+|PROCEDURE\s+)?(\S+)\s+(?:TO|FROM)\s+/i.exec(line.trim());
  if (!match) return undefined;
  return {
    privileges: splitPrivileges(match[1]!),
    object: match[2]!.replace(/`/g, "").replace(/\\([_%])/g, "$1"),
  };
}

/**
 * Returns every privilege in `SHOW GRANTS FOR CURRENT_USER()` output that is not in
 * READ_ONLY_PRIVILEGES, plus GRANT OPTION, role grants it cannot read, and NO GRANTS
 * when nothing was listed. An empty result is the only one that lets a run continue.
 * REVOKE lines (partial revokes) only take privileges away, so they are skipped.
 */
export function writePrivileges(grants: readonly string[]): string[] {
  const found = new Set<string>();
  let read = 0;
  for (const grant of grants) {
    const upper = grant.trim().toUpperCase();
    if (upper.length === 0 || upper.startsWith("REVOKE ")) continue;
    read += 1;
    if (/WITH\s+GRANT\s+OPTION/.test(upper)) found.add("GRANT OPTION");
    const parsed = upper.startsWith("GRANT ") ? parseGrant(upper) : undefined;
    if (!parsed) {
      // Role grants ("GRANT `role` TO ...") can carry anything; refuse what we can't read.
      found.add("UNREADABLE GRANT");
      continue;
    }
    // A column list ("SELECT (`a`, `b`)") belongs to its privilege; only the name counts.
    const privileges = parsed.privileges.map((p) => p.replace(/\s*\(.*\)$/s, "").replace(/\s+/g, " "));
    for (const privilege of privileges) {
      if (!READ_ONLY_PRIVILEGES.includes(privilege)) found.add(privilege || "UNREADABLE GRANT");
    }
  }
  if (read === 0) found.add("NO GRANTS");
  return [...found].sort();
}

/**
 * True when SELECT covers every table of `database`: a whole-database or global SELECT
 * grant without a column list, and no partial revoke of SELECT anywhere. Table-level or
 * column-level grants are not enough, because information_schema then lists only the
 * tables the account can see, and the mirror would lose the rest on the next prune.
 */
export function coversDatabase(grants: readonly string[], database: string): boolean {
  let covered = false;
  for (const line of grants) {
    const trimmed = line.trim();
    const parsed = parseGrant(trimmed);
    if (!parsed) continue;
    const select = parsed.privileges.some((p) => /^SELECT$/i.test(p));
    if (/^REVOKE\s/i.test(trimmed)) {
      if (parsed.privileges.some((p) => /^SELECT\b/i.test(p))) return false;
      continue;
    }
    if (select && (parsed.object === "*.*" || parsed.object === `${database}.*`)) covered = true;
  }
  return covered;
}

/** A report for a run that ended before or outside `runRefresh` (config, lock, crash). */
export function failureReport(code: string, at: Date): RefreshReport {
  const iso = at.toISOString();
  return { ok: false, code, startedAt: iso, finishedAt: iso, durationMs: 0, excluded: [], nonTransactional: [], tables: {}, totalRows: 0 };
}

export function isExcluded(table: string): boolean {
  return EXCLUDED_TABLE_PATTERNS.some((pattern) => pattern.test(table));
}

export interface RefreshReport {
  readonly ok: boolean;
  /** A fixed code on failure; never error text from mysql. */
  readonly code: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly durationMs: number;
  readonly excluded: readonly string[];
  /**
   * Copied tables whose engine is not InnoDB (MyISAM, MEMORY, ...). `--single-transaction`
   * gives them no snapshot, so their rows may be from slightly later than the rest; they
   * are copied and named here so a reader can tell.
   */
  readonly nonTransactional: readonly string[];
  readonly tables: Readonly<Record<string, number>>;
  readonly totalRows: number;
  /**
   * For an ok run: the mirror server this run copied into (`@@server_uuid`), so a reader of the
   * mirror can prove it reads the generation this report describes, not another server's.
   */
  readonly mirror?: { readonly serverId: string };
  /** For an ok run: the lock file the run held (resolved path), so readers can prove they share it. */
  readonly lock?: string;
}

/** What the refresh needs from MySQL. The CLI backs this with the mysql client tools. */
export interface MysqlPort {
  /** The server's own identity (`@@server_uuid`), whatever host name reached it. */
  serverId(db: DatabaseUrl): Promise<string>;
  grants(db: DatabaseUrl): Promise<string[]>;
  /** Base-table names, complete and exact (no truncation at tabs or newlines). */
  tables(db: DatabaseUrl): Promise<string[]>;
  /** The storage engine of every base table. */
  engines(db: DatabaseUrl): Promise<Record<string, string>>;
  /** True when the server folds table names to lower case (`lower_case_table_names` != 0). */
  foldsCase(db: DatabaseUrl): Promise<boolean>;
  /** Streams a consistent snapshot of `tables` from source into target, replacing them. */
  copy(source: DatabaseUrl, target: DatabaseUrl, tables: readonly string[]): Promise<void>;
  /** Drops every table not in `keep` (compared under the server's case rule), with foreign key checks off. */
  dropTablesNotIn(target: DatabaseUrl, keep: readonly string[]): Promise<void>;
  counts(db: DatabaseUrl, tables: readonly string[]): Promise<Record<string, number>>;
}

export async function runRefresh(
  config: RefreshConfig,
  mysql: MysqlPort,
  clock: () => Date = () => new Date(),
): Promise<RefreshReport> {
  const started = clock();
  let nonTransactional: string[] = [];
  let mirrorId: string | undefined;
  const finish = (ok: boolean, code: string, excluded: string[] = [], tables: Record<string, number> = {}): RefreshReport => {
    const finished = clock();
    return {
      ok,
      code,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      excluded,
      nonTransactional,
      tables,
      totalRows: Object.values(tables).reduce((sum, n) => sum + n, 0),
      ...(ok && mirrorId ? { mirror: { serverId: mirrorId } } : {}),
    };
  };

  let step = "server";
  try {
    // Host names can alias (an IP, a proxy, a second DNS name); the server identity cannot.
    const [sourceId, targetId] = [await mysql.serverId(config.source), await mysql.serverId(config.target)];
    if (sourceId === targetId) return finish(false, "target.isSource");
    mirrorId = targetId;

    step = "grants";
    const grants = await mysql.grants(config.source);
    if (writePrivileges(grants).length > 0) return finish(false, "source.notReadOnly");
    if (!coversDatabase(grants, config.source.database)) return finish(false, "source.partialGrant");

    step = "tables";
    const all = (await mysql.tables(config.source)).sort();
    const excluded = all.filter(isExcluded);
    const copied = all.filter((table) => !isExcluded(table));
    if (copied.length === 0) return finish(false, "source.empty", excluded);
    const engines = await mysql.engines(config.source);
    nonTransactional = copied.filter((table) => (engines[table] ?? "").toUpperCase() !== "INNODB");

    step = "target";
    if (await mysql.foldsCase(config.target)) {
      const folded = new Set(copied.map((table) => table.toLowerCase()));
      if (folded.size !== copied.length) return finish(false, "source.caseCollision", excluded);
    }

    // Prune first: a table excluded since the last run (a token table, say) leaves the
    // mirror before anything else happens, even if the copy then fails.
    step = "prune";
    await mysql.dropTablesNotIn(config.target, copied);
    step = "copy";
    await mysql.copy(config.source, config.target, copied);
    step = "prune";
    await mysql.dropTablesNotIn(config.target, copied);

    step = "counts";
    const counts = await mysql.counts(config.target, copied);
    const missing = copied.filter((table) => typeof counts[table] !== "number");
    if (missing.length > 0) return finish(false, "target.countMissing", excluded, counts);
    return finish(true, "ok", excluded, counts);
  } catch (error) {
    if (error instanceof RefreshRefused) return finish(false, error.code);
    return finish(false, `failed.${step}`);
  }
}
