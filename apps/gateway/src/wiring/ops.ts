import { PostgresEmailOutboxStore, PostgresExportsStore, PostgresJobRunsStore } from "@studenthub/db";
import { createAdminJobs } from "../admin-jobs.js";
import { createAdminOutbox } from "../admin-outbox.js";
import { createExportsHttp } from "../exports-http.js";
import { createJobRegistry, writeJobAlert } from "../../../../packages/observability/src/jobs.js";
import { ExportService } from "../../../../packages/exports/src/exports.js";
import { createCompanyDirectoryExport } from "../../../../packages/exports/src/company-directory-export.js";
import type { wireAccess } from "./access.js";
import type { Wired, WiringSettings } from "./context.js";
import type { wireOrganizations } from "./organizations.js";

type Access = ReturnType<typeof wireAccess>["services"];
type Organizations = ReturnType<typeof wireOrganizations>["services"];

export function wireOps(settings: WiringSettings, access: Access, organizationArea: Organizations): Wired<{
  readonly exports: ReturnType<typeof createExportsHttp>;
  readonly adminJobs: ReturnType<typeof createAdminJobs>;
  readonly adminOutbox: ReturnType<typeof createAdminOutbox>;
}> {
  const jobRuns = new PostgresJobRunsStore({connectionString:settings.databaseUrl});
  const emailOutbox=new PostgresEmailOutboxStore({connectionString:settings.databaseUrl});
  const exportsStore=new PostgresExportsStore({connectionString:settings.databaseUrl});
  const exportsService=new ExportService(exportsStore,[createCompanyDirectoryExport(organizationArea.organizations) as never]);
  return {
    services: {
      exports:createExportsHttp(access.loginStore.sessions,exportsService),
      ...({adminJobs:createAdminJobs(access.loginStore.sessions,access.authzStore,jobRuns,createJobRegistry(jobRuns,writeJobAlert))} as { adminJobs: ReturnType<typeof createAdminJobs> }),
      ...({adminOutbox:createAdminOutbox(access.loginStore.sessions,access.authzStore,emailOutbox)} as { adminOutbox: ReturnType<typeof createAdminOutbox> }),
    },
    async close() { await Promise.all([jobRuns.close(), exportsStore.close(), emailOutbox.close()]); },
  };
}
