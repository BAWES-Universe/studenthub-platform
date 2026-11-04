import pg from "pg";

export interface RestoreCheckOptions { scratchSuffix?: string | readonly string[]; now?: () => Date }
export interface CountCheck { table: string; sourceCount: number; restoredCount: number; matches: boolean }
export interface IntegrityCheck { table: string; constraint: string; ok: boolean }
export interface SequenceCheck { table: string; constraint: string; ok: boolean }
export interface RestoreCheckReport {
  ok: boolean;
  startedAt: string;
  endedAt: string;
  elapsedSeconds: number;
  sourceReadOnly: boolean;
  migrations: { sourceCount: number; restoredCount: number; matches: boolean };
  tables: CountCheck[];
  foreignKeys: IntegrityCheck[];
  sequences: SequenceCheck[];
  triggers: IntegrityCheck[];
}

type Queryable = { query: pg.Pool["query"] };
type TableRow = { table_name: string };
type ForeignKeyRow = { constraint_name: string; table_name: string; referenced_table: string; columns: string[]; referenced_columns: string[] };
type SequenceRow = { sequence_name: string; table_name: string; column_name: string };
type TriggerRow = { trigger_name: string; table_name: string };

const ident = (value: string): string => `"${value.replaceAll('"', '""')}"`;
const countNumber = (value: string): number => {
  const count = Number(value);
  if (!Number.isSafeInteger(count)) throw new Error("a table count exceeded JavaScript's safe integer range");
  return count;
};

function databaseName(connectionString: string): string {
  try {
    const name = decodeURIComponent(new URL(connectionString).pathname.slice(1));
    if (!name) throw new Error("missing database name");
    return name;
  } catch {
    throw new Error("restore check requires connection URLs with explicit database names");
  }
}

function validateTargets(sourceUrl: string, restoredUrl: string, suffixOption: RestoreCheckOptions["scratchSuffix"]): void {
  const source = databaseName(sourceUrl);
  const restored = databaseName(restoredUrl);
  const suffixes = typeof suffixOption === "string" ? [suffixOption] : [...(suffixOption ?? ["_restore_check"])];
  if (sourceUrl === restoredUrl || source === restored) throw new Error("source and restored databases must differ");
  if (suffixes.length === 0 || suffixes.some((suffix) => !suffix) || !suffixes.some((suffix) => restored.endsWith(suffix))) {
    throw new Error("restored database name does not end in an approved scratch suffix");
  }
}

async function tables(db: Queryable): Promise<string[]> {
  const result = await db.query<TableRow>(`SELECT table_name FROM information_schema.tables
    WHERE table_schema = 'public' AND table_type = 'BASE TABLE' ORDER BY table_name`);
  return result.rows.map((row) => row.table_name);
}

async function rowCount(db: Queryable, table: string): Promise<number> {
  const result = await db.query<{ count: string }>(`SELECT count(*)::text AS count FROM public.${ident(table)}`);
  return countNumber(result.rows[0]!.count);
}

async function migrations(db: Queryable, hasLedger: boolean): Promise<string[]> {
  if (!hasLedger) return [];
  const result = await db.query<{ version: string }>("SELECT version FROM public.schema_migrations ORDER BY version");
  return result.rows.map((row) => row.version);
}

async function foreignKeys(db: Queryable): Promise<ForeignKeyRow[]> {
  const result = await db.query<ForeignKeyRow>(`SELECT c.conname AS constraint_name, child.relname AS table_name,
    parent.relname AS referenced_table,
    array_agg(child_col.attname ORDER BY key.pos)::text[] AS columns,
    array_agg(parent_col.attname ORDER BY key.pos)::text[] AS referenced_columns
    FROM pg_catalog.pg_constraint c
    JOIN pg_catalog.pg_class child ON child.oid = c.conrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = child.relnamespace AND n.nspname = 'public'
    JOIN pg_catalog.pg_class parent ON parent.oid = c.confrelid
    CROSS JOIN LATERAL unnest(c.conkey, c.confkey) WITH ORDINALITY AS key(child_num, parent_num, pos)
    JOIN pg_catalog.pg_attribute child_col ON child_col.attrelid = child.oid AND child_col.attnum = key.child_num
    JOIN pg_catalog.pg_attribute parent_col ON parent_col.attrelid = parent.oid AND parent_col.attnum = key.parent_num
    WHERE c.contype = 'f' GROUP BY c.conname, child.relname, parent.relname ORDER BY child.relname, c.conname`);
  return result.rows;
}

async function sequences(db: Queryable): Promise<SequenceRow[]> {
  const result = await db.query<SequenceRow>(`SELECT seq.relname AS sequence_name, tab.relname AS table_name, col.attname AS column_name
    FROM pg_catalog.pg_class seq
    JOIN pg_catalog.pg_namespace n ON n.oid = seq.relnamespace AND n.nspname = 'public'
    JOIN pg_catalog.pg_depend dep ON dep.objid = seq.oid AND dep.classid = 'pg_class'::regclass AND dep.refclassid = 'pg_class'::regclass AND dep.deptype IN ('a', 'i')
    JOIN pg_catalog.pg_class tab ON tab.oid = dep.refobjid
    JOIN pg_catalog.pg_attribute col ON col.attrelid = tab.oid AND col.attnum = dep.refobjsubid
    WHERE seq.relkind = 'S' ORDER BY tab.relname, seq.relname`);
  return result.rows;
}

async function triggers(db: Queryable): Promise<TriggerRow[]> {
  const result = await db.query<TriggerRow>(`SELECT t.tgname AS trigger_name, rel.relname AS table_name
    FROM pg_catalog.pg_trigger t
    JOIN pg_catalog.pg_class rel ON rel.oid = t.tgrelid
    JOIN pg_catalog.pg_namespace n ON n.oid = rel.relnamespace
    WHERE n.nspname = 'public' AND NOT t.tgisinternal
    ORDER BY rel.relname, t.tgname`);
  return result.rows;
}

export async function checkRestore(sourceUrl: string, restoredUrl: string, options: RestoreCheckOptions = {}): Promise<RestoreCheckReport> {
  validateTargets(sourceUrl, restoredUrl, options.scratchSuffix);
  const clock = options.now ?? (() => new Date());
  const started = clock();
  const source = new pg.Pool({ connectionString: sourceUrl, max: 1, options: "-c default_transaction_read_only=on" });
  const restored = new pg.Pool({ connectionString: restoredUrl, max: 1 });
  try {
    const [sourceTables, restoredTables] = await Promise.all([tables(source), tables(restored)]);
    const readOnly = await source.query<{ default_transaction_read_only: string }>("SHOW default_transaction_read_only");
    const sourceReadOnly = readOnly.rows[0]?.default_transaction_read_only === "on";
    const allTables = [...new Set([...sourceTables, ...restoredTables])].sort();
    const tableChecks: CountCheck[] = [];
    for (const table of allTables) {
      const sourceCount = sourceTables.includes(table) ? await rowCount(source, table) : -1;
      const restoredCount = restoredTables.includes(table) ? await rowCount(restored, table) : -1;
      tableChecks.push({ table, sourceCount, restoredCount, matches: sourceCount === restoredCount });
    }
    const [sourceMigrations, restoredMigrations] = await Promise.all([
      migrations(source, sourceTables.includes("schema_migrations")), migrations(restored, restoredTables.includes("schema_migrations")),
    ]);
    const migrationCheck = { sourceCount: sourceMigrations.length, restoredCount: restoredMigrations.length, matches: JSON.stringify(sourceMigrations) === JSON.stringify(restoredMigrations) };

    const [sourceForeignKeys, restoredForeignKeys] = await Promise.all([foreignKeys(source), foreignKeys(restored)]);
    const sourceForeignKeyMap = new Map(sourceForeignKeys.map((fk) => [`${fk.table_name}\0${fk.constraint_name}`, fk]));
    const restoredForeignKeyMap = new Map(restoredForeignKeys.map((fk) => [`${fk.table_name}\0${fk.constraint_name}`, fk]));
    const foreignKeyChecks: IntegrityCheck[] = [];
    for (const key of new Set([...sourceForeignKeyMap.keys(), ...restoredForeignKeyMap.keys()])) {
      const expected = sourceForeignKeyMap.get(key);
      const fk = restoredForeignKeyMap.get(key);
      if (!fk || (expected && JSON.stringify(fk) !== JSON.stringify(expected))) {
        const named = expected ?? fk!;
        foreignKeyChecks.push({ table: named.table_name, constraint: named.constraint_name, ok: false });
        continue;
      }
      const present = fk.columns.map((column) => `child.${ident(column)} IS NOT NULL`).join(" AND ");
      const join = fk.columns.map((column, index) => `parent.${ident(fk.referenced_columns[index]!)} = child.${ident(column)}`).join(" AND ");
      const result = await restored.query(`SELECT 1 FROM public.${ident(fk.table_name)} child WHERE ${present} AND NOT EXISTS (SELECT 1 FROM public.${ident(fk.referenced_table)} parent WHERE ${join}) LIMIT 1`);
      foreignKeyChecks.push({ table: fk.table_name, constraint: fk.constraint_name, ok: result.rowCount === 0 });
    }

    const [sourceSequences, restoredSequences] = await Promise.all([sequences(source), sequences(restored)]);
    const sourceSequenceMap = new Map(sourceSequences.map((sequence) => [`${sequence.table_name}\0${sequence.sequence_name}`, sequence]));
    const restoredSequenceMap = new Map(restoredSequences.map((sequence) => [`${sequence.table_name}\0${sequence.sequence_name}`, sequence]));
    const sequenceChecks: SequenceCheck[] = [];
    for (const key of new Set([...sourceSequenceMap.keys(), ...restoredSequenceMap.keys()])) {
      const expected = sourceSequenceMap.get(key);
      const sequence = restoredSequenceMap.get(key);
      if (!sequence || (expected && JSON.stringify(sequence) !== JSON.stringify(expected))) {
        const named = expected ?? sequence!;
        sequenceChecks.push({ table: named.table_name, constraint: named.sequence_name, ok: false });
        continue;
      }
      const result = await restored.query<{ ok: boolean }>(`SELECT maximum.value IS NULL OR state.last_value > maximum.value OR (state.last_value = maximum.value AND state.is_called) AS ok
        FROM public.${ident(sequence.sequence_name)} state
        CROSS JOIN (SELECT max(${ident(sequence.column_name)}) AS value FROM public.${ident(sequence.table_name)}) maximum`);
      sequenceChecks.push({ table: sequence.table_name, constraint: sequence.sequence_name, ok: result.rows[0]!.ok });
    }

    const [sourceTriggers, restoredTriggers] = await Promise.all([triggers(source), triggers(restored)]);
    const restoredTriggerSet = new Set(restoredTriggers.map((trigger) => `${trigger.table_name}\0${trigger.trigger_name}`));
    const triggerChecks = sourceTriggers.map((trigger) => ({ table: trigger.table_name, constraint: trigger.trigger_name, ok: restoredTriggerSet.has(`${trigger.table_name}\0${trigger.trigger_name}`) }));
    const ended = clock();
    const checks = [sourceReadOnly, ...tableChecks.map((check) => check.matches), migrationCheck.matches, ...foreignKeyChecks.map((check) => check.ok), ...sequenceChecks.map((check) => check.ok), ...triggerChecks.map((check) => check.ok)];
    return { ok: checks.every(Boolean), startedAt: started.toISOString(), endedAt: ended.toISOString(), elapsedSeconds: Math.max(0, (ended.getTime() - started.getTime()) / 1000), sourceReadOnly, migrations: migrationCheck, tables: tableChecks, foreignKeys: foreignKeyChecks, sequences: sequenceChecks, triggers: triggerChecks };
  } finally {
    await Promise.allSettled([source.end(), restored.end()]);
  }
}

export function formatRestoreCheckSummary(report: RestoreCheckReport): string {
  const failures = report.tables.filter((item) => !item.matches).length + (report.migrations.matches ? 0 : 1) + [...report.foreignKeys, ...report.sequences, ...report.triggers].filter((item) => !item.ok).length;
  return `restore check ${report.ok ? "PASS" : "FAIL"}: ${report.tables.length} tables, ${report.foreignKeys.length} foreign keys, ${report.sequences.length} sequences, ${report.triggers.length} triggers, ${failures} failures, ${report.elapsedSeconds.toFixed(3)}s`;
}
