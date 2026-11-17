// Recruit R2: staff work a request through a pipeline.
//
// Legacy stories (common/models/Story.php) carry an integer status any save can
// set, and the request status flips as a side effect of story saves (RC-F3,
// RC-F4). Here the stage list and its transitions are explicit, the request
// status follows the pipeline in `requestStatusAfterPipeline` and nowhere else,
// and "placed" hands over to the work lane's placement exactly once.

import type { RecruitGrantRow, RequestStatus } from "./requests.js";

export const PIPELINE_STAGES = ["suggested", "contacted", "interviewing", "offered", "placed", "withdrawn"] as const;
export type PipelineStage = typeof PIPELINE_STAGES[number];

/** Exactly these moves are allowed; placed and withdrawn are final. */
export const PIPELINE_TRANSITIONS: readonly (readonly [PipelineStage, PipelineStage])[] = Object.freeze([
  ["suggested", "contacted"],
  ["suggested", "withdrawn"],
  ["contacted", "interviewing"],
  ["contacted", "offered"],
  ["contacted", "withdrawn"],
  ["interviewing", "offered"],
  ["interviewing", "withdrawn"],
  ["offered", "placed"],
  ["offered", "withdrawn"],
]);

export function pipelineTransitionAllowed(from: PipelineStage, to: PipelineStage): boolean {
  return PIPELINE_TRANSITIONS.some(([a, b]) => a === from && b === to);
}

/** Stages a cancelled request withdraws; placed cards stay as they are. */
export const OPEN_PIPELINE_STAGES: readonly PipelineStage[] = Object.freeze(["suggested", "contacted", "interviewing", "offered"]);

/** Requests accept new cards only while open or filling. */
export function requestAcceptsCards(status: RequestStatus): boolean {
  return status === "open" || status === "filling";
}

export type PipelineEvent = { readonly kind: "card_added" } | { readonly kind: "placed"; readonly placedCount: number; readonly headcount: number };

/**
 * The one place the pipeline moves a request: the first card on an open request
 * makes it filling; reaching the headcount in placed cards makes a filling request
 * filled. A request already past that status is left alone (null).
 */
export function requestStatusAfterPipeline(status: RequestStatus, event: PipelineEvent): RequestStatus | null {
  if (event.kind === "card_added") return status === "open" ? "filling" : null;
  return status === "filling" && event.placedCount >= event.headcount ? "filled" : null;
}

const covers = (rows: readonly RecruitGrantRow[], roles: readonly string[], operators: readonly string[]) =>
  rows.some((row) => roles.includes(row.role) && row.scope === "subtree" && operators.includes(row.org_id));

/** Staff and admin on an operator organization assign a recruiter to a request. */
export function pipelineAssignDecision(rows: readonly RecruitGrantRow[], operators: readonly string[]): boolean {
  return covers(rows, ["staff", "admin"], operators);
}

/** A lead is an admin on an operator organization. */
export function pipelineLeadDecision(rows: readonly RecruitGrantRow[], operators: readonly string[]): boolean {
  return covers(rows, ["admin"], operators);
}

/** A recruiter is a person holding recruiter or staff on an operator organization, subtree scope (the work lane's placement requires it). */
export function pipelineRecruiterEligible(rows: readonly RecruitGrantRow[], operators: readonly string[]): boolean {
  return covers(rows, ["recruiter", "staff"], operators);
}

/** Only the request's assigned recruiter or a lead adds or moves a card. */
export function pipelineAuthority(principalId: string, assignedRecruiterId: string | null, isLead: boolean): boolean {
  return isLead || (assignedRecruiterId !== null && assignedRecruiterId === principalId);
}

export function parsePipelineStage(value: unknown): PipelineStage | undefined {
  return typeof value === "string" && (PIPELINE_STAGES as readonly string[]).includes(value) ? value as PipelineStage : undefined;
}

/** Legacy suggestion statuses that seed cards: SUGGESTED (1) and ACCEPTED (3). Anything else is reported. */
export function legacySuggestionStage(value: number): { kind: "mapped"; stage: PipelineStage } | { kind: "unmapped"; value: number } {
  if (value === 1) return { kind: "mapped", stage: "suggested" };
  if (value === 3) return { kind: "mapped", stage: "placed" };
  return { kind: "unmapped", value };
}

// ---- Views --------------------------------------------------------------

export interface PipelineCardRow { readonly id: string; readonly person_principal_id: string; readonly person_name: string | null; readonly stage: PipelineStage; readonly updated_at: string | Date }
export interface PipelineEventRow { readonly card_id: string; readonly from_stage: PipelineStage | null; readonly to_stage: PipelineStage; readonly actor_name: string | null; readonly at: string | Date }
export interface PipelineCardView { readonly cardId: string; readonly personId: string; readonly personName: string | null; readonly stage: PipelineStage; readonly allowedMoves: readonly PipelineStage[]; readonly history: readonly { from: PipelineStage | null; to: PipelineStage; actor: string | null; at: string }[] }

const iso = (value: string | Date) => (value instanceof Date ? value : new Date(value)).toISOString();

/** Cards grouped in stage order, each with its own history oldest first; moves only for those who may move. */
export function pipelineView(cards: readonly PipelineCardRow[], events: readonly PipelineEventRow[], canMove: boolean): Readonly<Record<PipelineStage, readonly PipelineCardView[]>> {
  const byCard = new Map<string, PipelineEventRow[]>();
  for (const event of events) byCard.set(event.card_id, [...(byCard.get(event.card_id) ?? []), event]);
  const out = Object.fromEntries(PIPELINE_STAGES.map((stage) => [stage, [] as PipelineCardView[]])) as Record<PipelineStage, PipelineCardView[]>;
  for (const card of cards) {
    out[card.stage].push({
      cardId: card.id, personId: card.person_principal_id, personName: card.person_name, stage: card.stage,
      allowedMoves: canMove ? PIPELINE_TRANSITIONS.filter(([from]) => from === card.stage).map(([, to]) => to) : [],
      history: (byCard.get(card.id) ?? []).sort((a, b) => iso(a.at).localeCompare(iso(b.at)))
        .map((e) => ({ from: e.from_stage, to: e.to_stage, actor: e.actor_name, at: iso(e.at) })),
    });
  }
  return out;
}
