/**
 * Daily read-only legacy refresh on staging (decision 2026-11-17, extends SHU-105).
 *
 * Copies the legacy MySQL database into a staging-only `legacy_mirror` database, then
 * counts rows. Conditions it enforces rather than trusts:
 *  - read-only against legacy: the source account may hold only USAGE, SELECT and
 *    SHOW VIEW; any other privilege refuses the run;
 *  - the target is a database named `legacy_mirror` on a server other than the source
 *    (different host name in config, and a different @@server_uuid at run time);
 *  - bearer-token tables are never copied;
 *  - nothing private leaves staging: the report carries table names, row counts and
 *    timings only, and error text is reduced to a fixed code so no value, host or
 *    credential can reach a log;
 *  - credentials reach mysql/mysqldump through MYSQL_PWD in the child environment,
 *    never through argv, and never appear in the report;
 *  - one run at a time (a kernel flock held for the life of the run and its children);
 *  - every run that ends, however it ends, leaves a fresh last-run.json, and a run in
 *    progress marks it `running`, so a consumer checking `ok` never reads a stale or
 *    half-copied mirror.
 *
 * The scheduler (cron on the staging host, installed by a Hermes card) runs
 * `node dist/tools/legacy-import/src/refresh-cli.js` with the environment below.
 */

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

export const DEFAULT_REPORT_PATH = "/var/lib/legacy-refresh/last-run.json";

/** Where the report goes; readable even when the rest of the configuration is not. */
export function reportPathFrom(env: NodeJS.ProcessEnv): string {
  return env.LEGACY_REFRESH_REPORT || DEFAULT_REPORT_PATH;
}

export function loadConfig(env: NodeJS.ProcessEnv): RefreshConfig {
  const source = parseDatabaseUrl(env.LEGACY_REFRESH_SOURCE_URL, "source");
  const target = parseDatabaseUrl(env.LEGACY_REFRESH_TARGET_URL, "target");
  if (target.database !== MIRROR_DATABASE) throw new RefreshRefused("config.target.notMirror");
  if (target.host === source.host && target.port === source.port) throw new RefreshRefused("config.target.isSource");
  return {
    source,
    target,
    reportPath: reportPathFrom(env),
    lockPath: env.LEGACY_REFRESH_LOCK || "/var/lib/legacy-refresh/run.lock",
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
    const head = /^GRANT\s+(.+?)\s+ON\s+/.exec(upper);
    if (!head) {
      // Role grants ("GRANT `role` TO ...") can carry anything; refuse what we can't read.
      found.add("UNREADABLE GRANT");
      continue;
    }
    const privileges = head[1]!
      .split(",")
      .map((p) => p.trim().replace(/\s*\(.*\)$/, "").replace(/\s+/g, " "));
    for (const privilege of privileges) {
      if (!READ_ONLY_PRIVILEGES.includes(privilege)) found.add(privilege || "UNREADABLE GRANT");
    }
  }
  if (read === 0) found.add("NO GRANTS");
  return [...found].sort();
}

/** A report for a run that ended before or outside `runRefresh` (config, lock, crash). */
export function failureReport(code: string, at: Date): RefreshReport {
  const iso = at.toISOString();
  return { ok: false, code, startedAt: iso, finishedAt: iso, durationMs: 0, excluded: [], tables: {}, totalRows: 0 };
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
  readonly tables: Readonly<Record<string, number>>;
  readonly totalRows: number;
}

/** What the refresh needs from MySQL. The CLI backs this with the mysql client tools. */
export interface MysqlPort {
  /** The server's own identity (`@@server_uuid`), whatever host name reached it. */
  serverId(db: DatabaseUrl): Promise<string>;
  grants(db: DatabaseUrl): Promise<string[]>;
  tables(db: DatabaseUrl): Promise<string[]>;
  /** Streams a consistent snapshot of `tables` from source into target, replacing them. */
  copy(source: DatabaseUrl, target: DatabaseUrl, tables: readonly string[]): Promise<void>;
  dropTablesNotIn(target: DatabaseUrl, keep: readonly string[]): Promise<void>;
  counts(db: DatabaseUrl, tables: readonly string[]): Promise<Record<string, number>>;
}

export async function runRefresh(
  config: RefreshConfig,
  mysql: MysqlPort,
  clock: () => Date = () => new Date(),
): Promise<RefreshReport> {
  const started = clock();
  const finish = (ok: boolean, code: string, excluded: string[] = [], tables: Record<string, number> = {}): RefreshReport => {
    const finished = clock();
    return {
      ok,
      code,
      startedAt: started.toISOString(),
      finishedAt: finished.toISOString(),
      durationMs: finished.getTime() - started.getTime(),
      excluded,
      tables,
      totalRows: Object.values(tables).reduce((sum, n) => sum + n, 0),
    };
  };

  let step = "server";
  try {
    // Host names can alias (an IP, a proxy, a second DNS name); the server identity cannot.
    const [sourceId, targetId] = [await mysql.serverId(config.source), await mysql.serverId(config.target)];
    if (sourceId === targetId) return finish(false, "target.isSource");

    step = "grants";
    const writes = writePrivileges(await mysql.grants(config.source));
    if (writes.length > 0) return finish(false, "source.notReadOnly");

    step = "tables";
    const all = (await mysql.tables(config.source)).sort();
    const excluded = all.filter(isExcluded);
    const copied = all.filter((table) => !isExcluded(table));
    if (copied.length === 0) return finish(false, "source.empty", excluded);

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
