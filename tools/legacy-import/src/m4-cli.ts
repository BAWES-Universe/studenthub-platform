/**
 * M-4 importer CLI: organizations, stores, contacts and catalogues from the refreshed legacy copy.
 *
 * On the staging host (a Hermes card runs it), under the refresh's shared lock:
 *   flock --shared "$LEGACY_REFRESH_LOCK" node dist/tools/legacy-import/src/m4-cli.js plan
 *   flock --shared "$LEGACY_REFRESH_LOCK" node dist/tools/legacy-import/src/m4-cli.js write
 *
 *   plan   Reads the legacy copy and maps every table. Writes nothing to the platform.
 *   write  Also imports, in order: catalogues, companies, brand links, stores, contacts.
 *          Each step is idempotent, so a re-run writes only what is new and reports changed rows
 *          as conflicts. Never overwrites.
 *
 * Both write the private-safe report (table names, legacy ids, rule codes, counts) to
 * M4_REPORT_PATH, mode 600, and print a one-line receipt per step. Exit 0 when the run is ok,
 * 3 when a write step refused rows or found conflicts, 2 when refused before reading.
 *
 * Environment:
 *   M4_LEGACY_MIRROR_URL   mysql://user:pass@host:port/legacy_mirror (read-only account)
 *   LEGACY_REFRESH_REPORT  the refresh's last-run.json; the run refuses unless it says ok
 *   M4_REPORT_PATH         default /var/lib/legacy-import/m4-last-run.json
 * For write only:
 *   M4_DATABASE_URL        staging PostgreSQL
 *   M4_IMPORT_ACTOR        sha256 hex recorded as the creator of imported rows
 *   M4_OPERATOR_ORG_ID     the operator organization top-level companies hang under
 */

import { chmodSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { PostgresCatalogueImportStore, PostgresContactImportStore, PostgresOrganizationImportStore, PostgresStoreImportStore } from "@studenthub/db/import";
import { ORGANIZATION_PARITY_REVISION } from "@studenthub/organizations";
import { DEFAULT_REPORT_PATH as REFRESH_REPORT_PATH, parseDatabaseUrl } from "./refresh.js";
import { refreshIdentity } from "./twin/cli.js";
import { mirrorReader } from "./twin/staging.js";
import { readM4Sources, receiptSafe, runM4, type M4Report, type M4Writers } from "./m4-run.js";

export const DEFAULT_M4_REPORT_PATH = "/var/lib/legacy-import/m4-last-run.json";

export function m4Writers(pool: pg.Pool, actorRef: string, operatorOrgId: string): M4Writers {
  const catalogue = new PostgresCatalogueImportStore(pool, actorRef);
  const organizations = new PostgresOrganizationImportStore(pool, ORGANIZATION_PARITY_REVISION, operatorOrgId);
  const stores = new PostgresStoreImportStore(pool, actorRef);
  const contacts = new PostgresContactImportStore(pool, actorRef);
  return {
    catalogue: (_table, items, now) => catalogue.importItems(items, now),
    companies: (rows) => organizations.importOrganizations(rows),
    brandLinks: (rows) => stores.importBrandLinks(rows),
    stores: (rows, now) => stores.importStores(rows, now),
    contacts: (rows, now) => contacts.importContacts(rows, now),
  };
}

/** One line per step: counts and rule codes only. */
export function receipt(report: M4Report): string[] {
  return report.steps.map((s) => {
    const rules = Object.entries(s.rules).map(([rule, n]) => `${rule}=${n}`).join(" ");
    const w = s.write;
    const write = w ? ` inserted=${w.inserted} merged=${w.merged} adopted=${w.adopted} unchanged=${w.unchanged} conflicts=${w.conflicts.length} refused=${Object.values(w.refused).reduce((n, ids) => n + ids.length, 0)}` : "";
    return `${s.step} legacy=${s.legacy} mapped=${s.mapped}${write}${rules ? ` ${rules}` : ""}`;
  });
}

export async function main(argv: readonly string[], env: NodeJS.ProcessEnv): Promise<number> {
  const mode = argv[0];
  if (mode !== "plan" && mode !== "write") { console.error("m4: usage: m4-cli.js plan|write"); return 2; }
  let refresh: unknown;
  try { refresh = JSON.parse(readFileSync(env.LEGACY_REFRESH_REPORT || REFRESH_REPORT_PATH, "utf8")); } catch { refresh = undefined; }
  if (!refreshIdentity(refresh)) { console.error("m4: refused.refreshNotOk"); return 2; }
  let writers: M4Writers | null = null;
  let pool: pg.Pool | undefined;
  if (mode === "write") {
    const actor = env.M4_IMPORT_ACTOR ?? "";
    const operator = env.M4_OPERATOR_ORG_ID ?? "";
    if (!/^[0-9a-f]{64}$/.test(actor) || operator === "" || !env.M4_DATABASE_URL) { console.error("m4: refused.writeConfig"); return 2; }
    pool = new pg.Pool({ connectionString: env.M4_DATABASE_URL, max: 2 });
    writers = m4Writers(pool, actor, operator);
  }
  try {
    const sources = await readM4Sources(mirrorReader(parseDatabaseUrl(env.M4_LEGACY_MIRROR_URL, "mirror")));
    const report = await runM4(sources, writers, new Date().toISOString());
    if (!receiptSafe(report)) throw new Error("m4.report.unsafe");
    const out = env.M4_REPORT_PATH || DEFAULT_M4_REPORT_PATH;
    mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
    chmodSync(out, 0o600);
    for (const line of receipt(report)) console.log(line);
    console.log(`m4 ${report.mode} ok=${report.ok}`);
    return report.ok ? 0 : 3;
  } catch (error) {
    // Only fixed codes: an error from a driver or the mysql client may quote legacy values.
    const message = error instanceof Error && /^m4\.[a-z_.]+$/.test(error.message) ? error.message : "m4.failed";
    console.error(`m4: ${message}`);
    return 1;
  } finally {
    await pool?.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2), process.env).then((code) => { process.exitCode = code; });
}
