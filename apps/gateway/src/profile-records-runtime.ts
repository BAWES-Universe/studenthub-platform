import pg from "pg";
import { PostgresCatalogueStore, PostgresLoginStore, PostgresProfileRecordStore, PostgresReferenceResolver } from "@studenthub/db";
import { ProfileRecords } from "@studenthub/profile-records";
import { ReferenceCatalogue } from "@studenthub/reference-catalogue";
import type { ProfileRecordsRuntime } from "./profile-records-http.js";

/** Needs the platform database and the login callback origin; otherwise the routes answer 503. */
export function createRuntimeProfileRecordsFromEnv(env: NodeJS.ProcessEnv = process.env): (ProfileRecordsRuntime & { close(): Promise<void> }) | undefined {
  if (!env.DATABASE_URL || !env.OIDC_CALLBACK_URL) return undefined;
  const origin = new URL(env.OIDC_CALLBACK_URL).origin;
  const pool = new pg.Pool({ connectionString: env.DATABASE_URL, max: 4 });
  const login = new PostgresLoginStore(pool);
  const catalogue = new ReferenceCatalogue(new PostgresCatalogueStore(pool));
  return {
    service: new ProfileRecords(new PostgresProfileRecordStore(pool), new PostgresReferenceResolver(pool)),
    sessions: login.sessions,
    origin,
    options: async (type) => (await catalogue.list(type, { pageSize: 100 })).items.map((item) => ({ id: item.id, name: item.name })),
    close: () => pool.end(),
  };
}
