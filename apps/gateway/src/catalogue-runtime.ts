import { PostgresCatalogueStore } from "@studenthub/db";
import { ReferenceCatalogue } from "@studenthub/reference-catalogue";

export function createRuntimeCatalogueFromEnv(env: NodeJS.ProcessEnv = process.env): { service: ReferenceCatalogue; close(): Promise<void> } | undefined {
  if (!env.DATABASE_URL) return undefined;
  const store = new PostgresCatalogueStore({ connectionString: env.DATABASE_URL });
  return { service: new ReferenceCatalogue(store), close: () => store.close() };
}
