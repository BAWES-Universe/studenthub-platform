import pg from "pg";
import { PostgresRecruitChecklistStore, PostgresRecruitFulltimersStore, PostgresRecruitInterviewsStore, PostgresRecruitInvitationsStore, PostgresRecruitJobsStore, PostgresRecruitPeopleSearchStore, PostgresRecruitPipelineStore, PostgresRecruitRequestsStore, type RecruitPlacementPort } from "@studenthub/db/recruit";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import { FULLTIMER_PAGE_SIZE, JOB_PAGE_SIZE, PEOPLE_SEARCH_PAGE_SIZE, fulltimerNameKey, fulltimerStaffDecision, acceptCardEffect, applicationOutbox, applicationTransitionAllowed, jobAcceptsApplications, jobCandidateDecision, jobStaffDecision, evaluationAllowed, internalNoteDecision, interviewCompanyDecision, interviewOutbox, interviewStageAllowed, interviewTransitionAllowed, checklistAdminDecision, invitationOutbox, invitationTransitionAllowed, peopleSearchDecision, searchTokens, pipelineAssignDecision, recruitNotesDecision, pipelineAuthority, pipelineLeadDecision, pipelineRecruiterEligible, pipelineTransitionAllowed, recruitStaffDecision, requestAcceptsCards, requestCreateDecision, requestReadDecision, requestStatusAfterPipeline, requestTransitionAllowed, requestTransitionDecision } from "../../../../packages/recruit/src/index.js";
import { createRecruitChecklist } from "../recruit/checklist-http.js";
import { createRecruitPipeline } from "../recruit/pipeline-http.js";
import { createRecruitRequests } from "../recruit/requests-http.js";
import { createRecruitPeopleSearch } from "../recruit/search-http.js";
import { createRecruitInvitations } from "../recruit/invitations-http.js";
import { createRecruitEmployerView } from "../recruit/employer-view-http.js";
import { createRecruitInterviews } from "../recruit/interviews-http.js";
import { createRecruitJobs } from "../recruit/jobs-http.js";
import { createRecruitFulltimers } from "../recruit/fulltimers-http.js";
import type { wireAccess } from "./access.js";
import type { Wired, WiringSettings } from "./context.js";

type Access = ReturnType<typeof wireAccess>["services"];

// Until the work lane's placement lands, "placed" is refused rather than recorded without an assignment.
const PLACEMENT_UNAVAILABLE: RecruitPlacementPort = { placeFromRecruit: async () => ({ kind: "refused", code: "work_unavailable" }) };

export function wireRecruit(settings: WiringSettings, access: Access, placement: RecruitPlacementPort = PLACEMENT_UNAVAILABLE): Wired<{
  readonly recruitRequests: ReturnType<typeof createRecruitRequests>;
  readonly recruitPipeline: ReturnType<typeof createRecruitPipeline>;
  readonly recruitChecklist: ReturnType<typeof createRecruitChecklist>;
  readonly recruitPeopleSearch: ReturnType<typeof createRecruitPeopleSearch>;
  readonly recruitInvitations: ReturnType<typeof createRecruitInvitations>;
  readonly recruitEmployerView: ReturnType<typeof createRecruitEmployerView>;
  readonly recruitInterviews: ReturnType<typeof createRecruitInterviews>;
  readonly recruitJobs: ReturnType<typeof createRecruitJobs>;
  readonly recruitFulltimers: ReturnType<typeof createRecruitFulltimers>;
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
    candidateDecision: jobCandidateDecision,
    authority: pipelineAuthority,
    transitionAllowed: pipelineTransitionAllowed,
    acceptsCards: requestAcceptsCards,
    requestStatusAfter: requestStatusAfterPipeline,
    placement,
    operatorOrgIds: operators,
  });
  const checklist = new PostgresRecruitChecklistStore({ pool, adminDecision: (rows) => checklistAdminDecision(rows, operators), notesDecision: (rows) => recruitNotesDecision(rows, operators) });
  const people = new PostgresRecruitPeopleSearchStore({ pool, searchDecision: (rows) => peopleSearchDecision(rows, operators), tokens: searchTokens, pageSize: PEOPLE_SEARCH_PAGE_SIZE });
  const invitations = new PostgresRecruitInvitationsStore({
    pool,
    leadDecision: (rows) => pipelineLeadDecision(rows, operators),
    staffDecision: (rows) => recruitNotesDecision(rows, operators),
    authority: pipelineAuthority,
    acceptsCards: requestAcceptsCards,
    transitionAllowed: invitationTransitionAllowed,
    acceptCardEffect,
    requestStatusAfter: requestStatusAfterPipeline,
    candidateDecision: jobCandidateDecision,
    outbox: invitationOutbox,
  });
  const interviews = new PostgresRecruitInterviewsStore({
    pool,
    companyDecision: (rows, orgId, ancestors) => interviewCompanyDecision(rows, orgId, ancestors, operators),
    staffDecision: (rows) => recruitStaffDecision(rows, operators),
    leadDecision: (rows) => pipelineLeadDecision(rows, operators),
    authority: pipelineAuthority,
    internalDecision: (rows) => internalNoteDecision(rows, operators),
    stageAllowed: interviewStageAllowed,
    transitionAllowed: interviewTransitionAllowed,
    evaluationAllowed,
    outbox: interviewOutbox,
  });
  const jobs = new PostgresRecruitJobsStore({
    pool,
    staffDecision: (rows) => jobStaffDecision(rows, operators),
    candidateDecision: jobCandidateDecision,
    acceptsApplications: jobAcceptsApplications,
    transitionAllowed: applicationTransitionAllowed,
    outbox: applicationOutbox,
    pageSize: JOB_PAGE_SIZE,
  });
  const fulltimers = new PostgresRecruitFulltimersStore({ pool, staffDecision: (rows) => fulltimerStaffDecision(rows, operators), nameKey: fulltimerNameKey, pageSize: FULLTIMER_PAGE_SIZE });
  return {
    services: {
      recruitRequests: createRecruitRequests({ sessions: access.loginStore.sessions, store: requests }),
      recruitPipeline: createRecruitPipeline({ sessions: access.loginStore.sessions, store: pipeline }),
      recruitChecklist: createRecruitChecklist({ sessions: access.loginStore.sessions, store: checklist }),
      recruitPeopleSearch: createRecruitPeopleSearch({ sessions: access.loginStore.sessions, store: people }),
      recruitInvitations: createRecruitInvitations({ sessions: access.loginStore.sessions, store: invitations }),
      // Employer document links come from the documents area once it issues them; until then the page says so.
      recruitEmployerView: createRecruitEmployerView({ sessions: access.loginStore.sessions, store: requests }),
      recruitInterviews: createRecruitInterviews({ sessions: access.loginStore.sessions, store: interviews }),
      recruitJobs: createRecruitJobs({ sessions: access.loginStore.sessions, store: jobs }),
      recruitFulltimers: createRecruitFulltimers({ sessions: access.loginStore.sessions, store: fulltimers }),
    },
    async close() { await pool.end(); },
  };
}
