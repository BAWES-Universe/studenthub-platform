/**
 * Daily read-only legacy refresh on staging (decision 2026-11-17, extends SHU-105).
 *
 * Copies the legacy MySQL database into a staging-only `legacy_mirror` database, then
 * counts rows. Conditions it enforces rather than trusts:
 *  - read-only against legacy: the source account must hold no write privilege;
 *  - the target is a database named `legacy_mirror` on a host other than the source;
 *  - bearer-token tables are never copied;
 *  - nothing private leaves staging: the report carries table names, row counts and
 *    timings only, and error text is reduced to a fixed code so no value, host or
 *    credential can reach a log;
 *  - credentials reach mysql/mysqldump through MYSQL_PWD in the child environment,
 *    never through argv, and never appear in the report;
 *  - one run at a time (exclusive lock file).
 *
 * The scheduler (cron on the staging host, installed by a Hermes card) runs
 * `node dist/tools/legacy-import/src/refresh-cli.js` with the environment below.
 */

export const MIRROR_DATABASE = "legacy_mirror";

/** Tables holding live bearer tokens; a mirror never needs them. */
export const EXCLUDED_TABLE_PATTERNS: readonly RegExp[] = [/_token$/, /^queue$/, /^session$/];

/** Privileges that make an account able to change legacy. Any one refuses the run. */
const WRITE_PRIVILEGES = [
  "ALL PRIVILEGES",
  "INSERT",
  "UPDATE",
  "DELETE",
  "CREATE",
  "DROP",
  "ALTER",
  "INDEX",
  "REFERENCES",
  "TRIGGER",
  "EXECUTE",
  "CREATE ROUTINE",
  "ALTER ROUTINE",
  "CREATE VIEW",
  "EVENT",
  "FILE",
  "SUPER",
  "GRANT OPTION",
  "CREATE USER",
  "RELOAD",
  "SHUTDOWN",
  "PROCESS",
];

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

export function loadConfig(env: NodeJS.ProcessEnv): RefreshConfig {
  const source = parseDatabaseUrl(env.LEGACY_REFRESH_SOURCE_URL, "source");
  const target = parseDatabaseUrl(env.LEGACY_REFRESH_TARGET_URL, "target");
  if (target.database !== MIRROR_DATABASE) throw new RefreshRefused("config.target.notMirror");
  if (target.host === source.host && target.port === source.port) throw new RefreshRefused("config.target.isSource");
  return {
    source,
    target,
    reportPath: env.LEGACY_REFRESH_REPORT ?? "/var/lib/legacy-refresh/last-run.json",
    lockPath: env.LEGACY_REFRESH_LOCK ?? "/var/lib/legacy-refresh/run.lock",
  };
}

/**
 * Returns the write privileges found in `SHOW GRANTS FOR CURRENT_USER()` output.
 * `GRANT USAGE` and `GRANT SELECT, SHOW VIEW, LOCK TABLES` are fine; anything else
 * listed above is not.
 */
export function writePrivileges(grants: readonly string[]): string[] {
  const found = new Set<string>();
  for (const grant of grants) {
    const upper = grant.toUpperCase();
    if (/WITH GRANT OPTION/.test(upper)) found.add("GRANT OPTION");
    const head = /^GRANT\s+(.+?)\s+ON\s+/.exec(upper);
    if (!head) {
      // Role grants ("GRANT `role` TO ...") can carry anything; refuse what we can't read.
      if (/^GRANT\s+/.test(upper)) found.add("UNREADABLE GRANT");
      continue;
    }
    const privileges = head[1]!.split(",").map((p) => p.trim().replace(/\s*\(.*\)$/, ""));
    for (const privilege of privileges) {
      if (WRITE_PRIVILEGES.includes(privilege)) found.add(privilege);
    }
  }
  return [...found].sort();
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

  let step = "grants";
  try {
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
