import pg from "pg";
import { PostgresRecruitPipelineStore, PostgresRecruitRequestsStore, type RecruitPlacementPort } from "@studenthub/db/recruit";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import { pipelineAssignDecision, pipelineAuthority, pipelineLeadDecision, pipelineRecruiterEligible, pipelineTransitionAllowed, recruitStaffDecision, requestAcceptsCards, requestCreateDecision, requestReadDecision, requestStatusAfterPipeline, requestTransitionAllowed, requestTransitionDecision } from "../../../../packages/recruit/src/index.js";
import { createRecruitPipeline } from "../recruit/pipeline-http.js";
import { createRecruitRequests } from "../recruit/requests-http.js";
import type { wireAccess } from "./access.js";
import type { Wired, WiringSettings } from "./context.js";

type Access = ReturnType<typeof wireAccess>["services"];

// Until the work lane's placement lands, "placed" is refused rather than recorded without an assignment.
const PLACEMENT_UNAVAILABLE: RecruitPlacementPort = { placeFromRecruit: async () => ({ kind: "refused", code: "work_unavailable" }) };

export function wireRecruit(settings: WiringSettings, access: Access, placement: RecruitPlacementPort = PLACEMENT_UNAVAILABLE): Wired<{
  readonly recruitRequests: ReturnType<typeof createRecruitRequests>;
  readonly recruitPipeline: ReturnType<typeof createRecruitPipeline>;
}> {
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
  const pipeline = new PostgresRecruitPipelineStore({
    pool,
    assignDecision: (rows) => pipelineAssignDecision(rows, operators),
    leadDecision: (rows) => pipelineLeadDecision(rows, operators),
    recruiterEligible: (rows) => pipelineRecruiterEligible(rows, operators),
    authority: pipelineAuthority,
    transitionAllowed: pipelineTransitionAllowed,
    acceptsCards: requestAcceptsCards,
    requestStatusAfter: requestStatusAfterPipeline,
    placement,
    operatorOrgIds: operators,
  });
  return {
    services: {
      recruitRequests: createRecruitRequests({ sessions: access.loginStore.sessions, store: requests }),
      recruitPipeline: createRecruitPipeline({ sessions: access.loginStore.sessions, store: pipeline }),
    },
    async close() { await pool.end(); },
  };
}
