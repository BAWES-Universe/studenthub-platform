import pg from "pg";
import { PostgresRecruitRequestsStore } from "@studenthub/db/recruit";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import { recruitStaffDecision, requestCreateDecision, requestReadDecision, requestTransitionAllowed, requestTransitionDecision } from "../../../../packages/recruit/src/index.js";
import { createRecruitRequests } from "../recruit/requests-http.js";
import type { wireAccess } from "./access.js";
import type { Wired, WiringSettings } from "./context.js";

type Access = ReturnType<typeof wireAccess>["services"];

export function wireRecruit(settings: WiringSettings, access: Access): Wired<{ readonly recruitRequests: ReturnType<typeof createRecruitRequests> }> {
  const operators = DEFAULT_OPERATOR_ORG_IDS;
  // One pool for the whole recruit area; the stores borrow it and never end it.
  const pool = new pg.Pool({ connectionString: settings.databaseUrl });
  const requests = new PostgresRecruitRequestsStore({
    pool,
    createDecision: (rows, orgId, ancestors) => requestCreateDecision(rows, orgId, ancestors, operators),
    readDecision: (rows, orgId, ancestors) => requestReadDecision(rows, orgId, ancestors, operators),
    transitionDecision: (rows, orgId, ancestors) => requestTransitionDecision(rows, orgId, ancestors, operators),
    staffDecision: (rows) => recruitStaffDecision(rows, operators),
    transitionAllowed: requestTransitionAllowed,
  });
  return {
    services: { recruitRequests: createRecruitRequests({ sessions: access.loginStore.sessions, store: requests }) },
    async close() { await pool.end(); },
  };
}
