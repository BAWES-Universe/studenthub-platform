import { PostgresExportsStore, PostgresJobRunsStore } from "@studenthub/db/ops";
import { PostgresEmailOutboxStore } from "@studenthub/db/notifications";
import { createAdminJobs } from "../admin-jobs.js";
import { createAdminOutbox } from "../admin-outbox.js";
import { createPlatformOperations } from "../platform/operations-page.js";
import { createExportsHttp } from "../exports-http.js";
import { createJobRegistry, writeJobAlert } from "../../../../packages/observability/src/jobs.js";
import { ExportService, type ExportKind } from "../../../../packages/exports/src/exports.js";
import { createCompanyDirectoryExport } from "../../../../packages/exports/src/company-directory-export.js";
import { createCatalogueListExports } from "../../../../packages/exports/src/catalogue-list-export.js";
import { PostgresCatalogueListStore } from "@studenthub/db/reports";
import { hasOperatorStaffGrant } from "./profile.js";
import type { wireAccess } from "./access.js";
import type { Wired, WiringSettings } from "./context.js";
import type { wireOrganizations } from "./organizations.js";

type Access = ReturnType<typeof wireAccess>["services"];
type Organizations = ReturnType<typeof wireOrganizations>["services"];

/** `areaKinds` are export kinds other lanes register with the one service (the work lane's when it is on). */
export function wireOps(settings: WiringSettings, access: Access, organizationArea: Organizations, areaKinds: readonly ExportKind<never>[] = []): Wired<{
  readonly exports: ReturnType<typeof createExportsHttp>;
  readonly adminJobs: ReturnType<typeof createAdminJobs>;
  readonly adminOutbox: ReturnType<typeof createAdminOutbox>;
  readonly platformOperations: ReturnType<typeof createPlatformOperations>;
}> {
  const jobRuns = new PostgresJobRunsStore({connectionString:settings.databaseUrl});
  const emailOutbox=new PostgresEmailOutboxStore({connectionString:settings.databaseUrl});
  const exportsStore=new PostgresExportsStore({connectionString:settings.databaseUrl});
  const catalogueLists=new PostgresCatalogueListStore({connectionString:settings.databaseUrl});
  const listSource={isStaff:async(principalId:string)=>hasOperatorStaffGrant(await access.authzStore.listGrantsForPrincipal(principalId)),list:(type:"country"|"university")=>catalogueLists.list(type)};
  const exportsService=new ExportService(exportsStore,[createCompanyDirectoryExport(organizationArea.organizations) as never,...createCatalogueListExports(listSource) as never[],...areaKinds]);
  return {
    services: {
      exports:createExportsHttp(access.loginStore.sessions,exportsService),
      ...({adminJobs:createAdminJobs(access.loginStore.sessions,access.authzStore,jobRuns,createJobRegistry(jobRuns,writeJobAlert))} as { adminJobs: ReturnType<typeof createAdminJobs> }),
      platformOperations:createPlatformOperations({sessions:access.loginStore.sessions,authz:access.authzStore,jobRuns,jobs:createJobRegistry(jobRuns,writeJobAlert),email:emailOutbox}),
      ...({adminOutbox:createAdminOutbox(access.loginStore.sessions,access.authzStore,emailOutbox)} as { adminOutbox: ReturnType<typeof createAdminOutbox> }),
    },
    async close() { await Promise.all([jobRuns.close(), exportsStore.close(), emailOutbox.close(), catalogueLists.close()]); },
  };
}
