// W-1: a person is placed at a store for a period.
//
// Legacy (staff CandidateController actionAssign/actionUnassign, company
// StoreController request, StoreAssignmentRequestController accept/reject):
// - one store at a time ("remove old store before assigning a new one");
// - the store must exist; a company asks for a person at its own store and
//   staff accept or reject the request;
// - assign created a contract row itself and stored `parent_company_id` with
//   `||`, which wrote a boolean (defect, not ported).
// Here the F1 contract is chosen, never created, and the choice is recorded.
// The civil ID check is a warning shown to staff, not a refusal: legacy has no
// such gate and the 10-27 rule is "no regressions" (W-1 draft, rule 6).

import { matchContracts, RATE_RESOLUTION_VERSION, RateResolutionError, type PayContract } from "@studenthub/pay-contracts";
import { cleanText, sqlState, isOperatorRecruiter, isIsoDate, isPrincipalId, isUuid, kuwaitDate, isCompanyFor, isStaffFor, OPERATOR_ORG_IDS, type IsoDate, type WorkGrant } from "./common.js";

export const PLACEMENT_WARNINGS = ["civil_id_missing", "civil_id_expires_before_start", "no_pay_contract"] as const;
export type PlacementWarning = typeof PLACEMENT_WARNINGS[number];
export type PlacementSource = "staff" | "request" | "recruit" | "import";

export interface ContractResolutionRecord {
  readonly version: typeof RATE_RESOLUTION_VERSION;
  readonly steps: readonly string[];
  readonly matchedContractIds: readonly string[];
  readonly contractId: string | null;
}

export interface Assignment {
  readonly id: string;
  readonly personId: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly payContractId: string | null;
  readonly contractResolution: ContractResolutionRecord;
  readonly startDate: IsoDate;
  readonly endDate: IsoDate | null;
  readonly warnings: readonly PlacementWarning[];
  readonly source: PlacementSource;
  readonly requestId: string | null;
  /** Set when the recruit lane's "placed" stage made this placement; unique, so the call is idempotent. */
  readonly recruitCardId: string | null;
  readonly recruitRequestId: string | null;
  readonly createdBy: string | null;
  readonly createdAt: string;
}

export type AssignmentRequestStatus = "pending" | "accepted" | "rejected" | "cancelled";
export interface AssignmentRequest {
  readonly id: string;
  readonly personId: string;
  readonly orgId: string;
  readonly storeId: string;
  readonly status: AssignmentRequestStatus;
  readonly note: string | null;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly decidedBy: string | null;
  readonly decidedAt: string | null;
  readonly decisionReason: string | null;
}

export interface StoreFacts {
  readonly id: string;
  readonly orgId: string;
  readonly status: "active" | "deleted";
  /** The store organization's ancestors, nearest first. */
  readonly ancestors: readonly string[];
}

export type WorkEventKind =
  | "assignment.created" | "assignment.ended" | "assignment.extended"
  | "assignment_request.created" | "assignment_request.accepted" | "assignment_request.rejected" | "assignment_request.cancelled"
  | "session.started" | "session.stopped" | "session.discarded" | "session.added" | "session.deleted" | "session.restored"
  | "session.approved" | "session.rejected" | "session.undone";

export interface WorkEvent {
  readonly kind: WorkEventKind;
  readonly orgId: string;
  readonly personId: string;
  readonly subjectId: string;
  readonly actorId: string | null;
  readonly detail: Readonly<Record<string, string | number | boolean | null>>;
}

export interface PlacementTransaction {
  /** Raises `PlacementConflict` when the dates overlap another assignment of the person. */
  insertAssignment(assignment: Assignment): Promise<void>;
  /** Locks and returns the assignment. */
  lockAssignment(id: string): Promise<Assignment | undefined>;
  /** Raises `PlacementConflict` on overlap. */
  setEndDate(id: string, endDate: IsoDate | null): Promise<void>;
  insertRequest(request: AssignmentRequest): Promise<"inserted" | "duplicate_pending">;
  lockRequest(id: string): Promise<AssignmentRequest | undefined>;
  decideRequest(id: string, status: Exclude<AssignmentRequestStatus, "pending">, actorId: string, reason: string | null): Promise<void>;
  /** Number of the person's sessions still open at this assignment (refuses ending under an open session). */
  openSessionCount(assignmentId: string): Promise<number>;
  event(event: WorkEvent): Promise<void>;
}

export interface PlacementStore {
  store(storeId: string): Promise<StoreFacts | undefined>;
  /** Ancestors of an organization, nearest first; undefined when it doesn't exist. */
  organizationAncestors(orgId: string): Promise<readonly string[] | undefined>;
  personExists(personId: string): Promise<boolean>;
  /** The person's civil ID expiry; `present: false` when none is recorded. */
  civilId(personId: string): Promise<{ readonly present: boolean; readonly expiry: IsoDate | null }>;
  /** Every pay contract the person holds, deleted included (the F1 resolver filters). */
  contracts(personId: string): Promise<readonly PayContract[]>;
  assignment(id: string): Promise<Assignment | undefined>;
  assignmentForRecruitCard(recruitCardId: string): Promise<Assignment | undefined>;
  request(id: string): Promise<AssignmentRequest | undefined>;
  listAssignments(filter: { readonly personId?: string; readonly orgIds?: readonly string[]; readonly storeId?: string }): Promise<readonly Assignment[]>;
  listRequests(filter: { readonly orgIds?: readonly string[]; readonly status?: AssignmentRequestStatus }): Promise<readonly AssignmentRequest[]>;
  transaction<T>(work: (tx: PlacementTransaction) => Promise<T>): Promise<T>;
}

export interface GrantsPort {
  listGrantsForPrincipal(principalId: string): Promise<readonly WorkGrant[]>;
}

export class PlacementConflict extends Error {
  constructor() { super("work assignment overlaps another assignment of this person"); }
}

/** An overlap refusal from a store: the in-memory conflict, or Postgres exclusion_violation (23P01) from the 0500 trigger. */
export function isPlacementConflict(error: unknown): boolean {
  return error instanceof PlacementConflict || sqlState(error) === "23P01";
}

export interface PlacementInput {
  readonly personId: string;
  readonly storeId: string;
  readonly startDate?: IsoDate;
  readonly endDate?: IsoDate | null;
  readonly payContractId?: string;
}

export type PlacementRefusal =
  | "invalid_input" | "forbidden" | "person_not_found" | "store_not_found" | "store_removed"
  | "overlaps_assignment" | "ambiguous_contract" | "contract_not_applicable"
  | "request_not_found" | "request_not_pending" | "duplicate_request"
  | "assignment_not_found" | "end_before_start" | "open_session" | "recruit_card_reused";

export type PlaceOutcome = { readonly kind: "placed"; readonly assignment: Assignment } | { readonly kind: "refused"; readonly code: PlacementRefusal; readonly matchedContractIds?: readonly string[] };
export type RequestOutcome = { readonly kind: "requested"; readonly request: AssignmentRequest } | { readonly kind: "refused"; readonly code: PlacementRefusal };
export type DecideOutcome = { readonly kind: "accepted"; readonly assignment: Assignment } | { readonly kind: "rejected" | "cancelled" } | { readonly kind: "refused"; readonly code: PlacementRefusal; readonly matchedContractIds?: readonly string[] };
export type RecruitPlaceOutcome = { readonly kind: "placed"; readonly assignmentId: string; readonly created: boolean } | { readonly kind: "refused"; readonly code: PlacementRefusal; readonly matchedContractIds?: readonly string[] };
export type EndOutcome = { readonly kind: "ended" | "extended" | "unchanged"; readonly endDate: IsoDate | null } | { readonly kind: "refused"; readonly code: PlacementRefusal };

const INPUT_KEYS = ["personId", "storeId", "startDate", "endDate", "payContractId"];

/** Parses a placement body. Unknown keys are refused so a typo can't silently drop a field. */
export function parsePlacementInput(value: unknown): PlacementInput | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some((k) => !INPUT_KEYS.includes(k))) return undefined;
  if (!isPrincipalId(r.personId) || !isUuid(r.storeId)) return undefined;
  if (r.startDate !== undefined && !isIsoDate(r.startDate)) return undefined;
  if (r.endDate !== undefined && r.endDate !== null && !isIsoDate(r.endDate)) return undefined;
  if (r.payContractId !== undefined && !isUuid(r.payContractId)) return undefined;
  return {
    personId: r.personId, storeId: r.storeId.toLowerCase(),
    ...(r.startDate !== undefined ? { startDate: r.startDate as IsoDate } : {}),
    ...(r.endDate !== undefined ? { endDate: r.endDate as IsoDate | null } : {}),
    ...(r.payContractId !== undefined ? { payContractId: (r.payContractId as string).toLowerCase() } : {}),
  };
}

/** Warnings staff see before confirming; none of them refuses the placement. */
export function placementWarnings(civilId: { readonly present: boolean; readonly expiry: IsoDate | null }, startDate: IsoDate, contractId: string | null): PlacementWarning[] {
  const warnings: PlacementWarning[] = [];
  if (!civilId.present) warnings.push("civil_id_missing");
  // Valid through the start date, inclusive (Asia/Kuwait): expiring on the start date is still valid.
  else if (civilId.expiry !== null && civilId.expiry < startDate) warnings.push("civil_id_expires_before_start");
  if (contractId === null) warnings.push("no_pay_contract");
  return warnings;
}

/**
 * Chooses the F1 contract for a placement with the F1 resolver's own matching
 * (non-deleted contracts for this person and store overlapping the period). An
 * open-ended placement is matched on its start date onward. No match is allowed
 * (legacy pays contract-less hours at entered rates) and is flagged; more than
 * one match needs an explicit contract id.
 */
export function chooseContract(contracts: readonly PayContract[], personId: string, storeId: string, startDate: IsoDate, endDate: IsoDate | null, today: IsoDate, payContractId?: string):
  { readonly ok: true; readonly record: ContractResolutionRecord } | { readonly ok: false; readonly code: "ambiguous_contract" | "contract_not_applicable"; readonly matchedContractIds: readonly string[] } {
  const period = { start: startDate, end: endDate ?? "9999-12-31" };
  try {
    const { contracts: matches, steps } = matchContracts({ candidateId: personId, storeId, contracts, period, today, ...(payContractId ? { contractId: payContractId } : {}) });
    const ids = Object.freeze(matches.map((c) => c.id));
    if (matches.length > 1) return { ok: false, code: "ambiguous_contract", matchedContractIds: ids };
    const chosen = matches[0];
    return { ok: true, record: Object.freeze({ version: RATE_RESOLUTION_VERSION, steps: Object.freeze([...steps, chosen ? "single_contract_selected" : "no_matching_contract"]), matchedContractIds: ids, contractId: chosen?.id ?? null }) };
  } catch (error) {
    if (error instanceof RateResolutionError && error.code === "contract_not_applicable") return { ok: false, code: "contract_not_applicable", matchedContractIds: error.matchedContractIds };
    throw error;
  }
}

interface Origin {
  readonly source: "staff" | "request" | "recruit";
  readonly requestId: string | null;
  readonly recruitCardId: string | null;
  readonly recruitRequestId: string | null;
}
const STAFF_ORIGIN: Origin = Object.freeze({ source: "staff", requestId: null, recruitCardId: null, recruitRequestId: null });

export interface PlacementServiceOptions {
  readonly store: PlacementStore;
  readonly grants: GrantsPort;
  readonly newId: () => string;
  readonly now?: () => Date;
}

export class PlacementService {
  readonly #store: PlacementStore;
  readonly #grants: GrantsPort;
  readonly #newId: () => string;
  readonly #now: () => Date;

  constructor(options: PlacementServiceOptions) {
    this.#store = options.store;
    this.#grants = options.grants;
    this.#newId = options.newId;
    this.#now = options.now ?? (() => new Date());
  }

  /** Staff place a person directly. */
  async place(actorId: string, input: PlacementInput): Promise<PlaceOutcome> {
    const store = await this.#store.store(input.storeId);
    if (!store) return { kind: "refused", code: "store_not_found" };
    if (OPERATOR_ORG_IDS.includes(store.orgId) || !isStaffFor(await this.#grants.listGrantsForPrincipal(actorId), store.orgId, store.ancestors)) return { kind: "refused", code: "forbidden" };
    return this.#store.transaction((tx) => this.#place(tx, actorId, input, store, STAFF_ORIGIN));
  }

  /**
   * The recruit lane's "placed" stage. Same rules as `place` (staff only, F1
   * contract chosen and recorded, no overlap), plus idempotency on the recruit
   * card: a repeat or a lost race returns the existing placement with
   * `created: false`. A card id already used for another person or store is
   * refused rather than silently returning the wrong placement.
   */
  async placeFromRecruit(actorId: string, input: {
    readonly recruitCardId: string; readonly requestId: string | null; readonly personId: string; readonly storeId: string;
    readonly startDate: IsoDate | null; readonly endDate: IsoDate | null; readonly payContractId?: string;
  }): Promise<RecruitPlaceOutcome> {
    if (!isUuid(input.recruitCardId) || (input.requestId !== null && !isUuid(input.requestId)) || !isPrincipalId(input.personId) || !isUuid(input.storeId)
      || (input.startDate !== null && !isIsoDate(input.startDate)) || (input.endDate !== null && !isIsoDate(input.endDate))
      || (input.payContractId !== undefined && !isUuid(input.payContractId))) return { kind: "refused", code: "invalid_input" };
    const cardId = input.recruitCardId.toLowerCase(), storeId = input.storeId.toLowerCase();
    const replay = async (): Promise<RecruitPlaceOutcome | undefined> => {
      const existing = await this.#store.assignmentForRecruitCard(cardId);
      if (!existing) return undefined;
      return existing.personId === input.personId && existing.storeId === storeId
        ? { kind: "placed", assignmentId: existing.id, created: false } : { kind: "refused", code: "recruit_card_reused" };
    };
    const store = await this.#store.store(storeId);
    if (!store) return { kind: "refused", code: "store_not_found" };
    // The recruit lane has already checked the actor is the request's assigned recruiter or a lead;
    // StudentHub recruiters (operator org, subtree) may place here, but not through `place`.
    const grants = await this.#grants.listGrantsForPrincipal(actorId);
    if (OPERATOR_ORG_IDS.includes(store.orgId) || !(isStaffFor(grants, store.orgId, store.ancestors) || isOperatorRecruiter(grants))) return { kind: "refused", code: "forbidden" };
    const earlier = await replay();
    if (earlier) return earlier;
    const origin: Origin = { source: "recruit", requestId: null, recruitCardId: cardId, recruitRequestId: input.requestId?.toLowerCase() ?? null };
    const placement: PlacementInput = {
      personId: input.personId, storeId, ...(input.startDate !== null ? { startDate: input.startDate } : {}), endDate: input.endDate,
      ...(input.payContractId !== undefined ? { payContractId: input.payContractId.toLowerCase() } : {}),
    };
    try {
      const out = await this.#store.transaction((tx) => this.#place(tx, actorId, placement, store, origin));
      if (out.kind === "placed") return { kind: "placed", assignmentId: out.assignment.id, created: true };
      // A concurrent call for the same card that committed first shows up here as an overlap.
      if (out.code === "overlaps_assignment") { const raced = await replay(); if (raced) return raced; }
      return out;
    } catch (error) {
      // A concurrent call for the same card won the unique index: return its placement.
      if (sqlState(error) === "23505") { const raced = await replay(); if (raced) return raced; }
      throw error;
    }
  }

  /** A company asks for a specific person at one of its stores (legacy StoreAssignmentRequest). */
  async request(actorId: string, input: { readonly personId: string; readonly storeId: string; readonly note?: string }): Promise<RequestOutcome> {
    const note = input.note === undefined ? null : cleanText(input.note, 1000);
    if (!isPrincipalId(input.personId) || !isUuid(input.storeId) || note === undefined) return { kind: "refused", code: "invalid_input" };
    const store = await this.#store.store(input.storeId.toLowerCase());
    if (!store) return { kind: "refused", code: "store_not_found" };
    const grants = await this.#grants.listGrantsForPrincipal(actorId);
    if (OPERATOR_ORG_IDS.includes(store.orgId) || !(isCompanyFor(grants, store.orgId, store.ancestors) || isStaffFor(grants, store.orgId, store.ancestors))) return { kind: "refused", code: "forbidden" };
    if (store.status !== "active") return { kind: "refused", code: "store_removed" };
    if (!(await this.#store.personExists(input.personId))) return { kind: "refused", code: "person_not_found" };
    const request: AssignmentRequest = Object.freeze({
      id: this.#newId(), personId: input.personId, orgId: store.orgId, storeId: store.id, status: "pending", note,
      requestedBy: actorId, requestedAt: this.#now().toISOString(), decidedBy: null, decidedAt: null, decisionReason: null,
    });
    return this.#store.transaction(async (tx) => {
      if ((await tx.insertRequest(request)) === "duplicate_pending") return { kind: "refused", code: "duplicate_request" } as const;
      await tx.event({ kind: "assignment_request.created", orgId: store.orgId, personId: request.personId, subjectId: request.id, actorId, detail: { storeId: store.id } });
      return { kind: "requested", request } as const;
    });
  }

  /**
   * Staff accept (placing the person, in the same transaction) or reject a
   * request; the requesting company may cancel its own pending request.
   * Legacy accepted a request by store and person when no id was sent, and
   * skipped the step silently for an unknown id; here the id is required.
   */
  async decideRequest(actorId: string, requestId: string, decision: "accept" | "reject" | "cancel", options: { readonly reason?: string; readonly placement?: Omit<PlacementInput, "personId" | "storeId"> } = {}): Promise<DecideOutcome> {
    if (!isUuid(requestId)) return { kind: "refused", code: "request_not_found" };
    const reason = options.reason === undefined ? null : cleanText(options.reason, 500);
    if (reason === undefined) return { kind: "refused", code: "invalid_input" };
    const existing = await this.#store.request(requestId.toLowerCase());
    if (!existing) return { kind: "refused", code: "request_not_found" };
    const store = await this.#store.store(existing.storeId);
    if (!store) return { kind: "refused", code: "store_not_found" };
    const grants = await this.#grants.listGrantsForPrincipal(actorId);
    const staff = isStaffFor(grants, store.orgId, store.ancestors);
    const allowed = decision === "cancel" ? staff || isCompanyFor(grants, store.orgId, store.ancestors) : staff;
    if (!allowed) return { kind: "refused", code: "forbidden" };
    return this.#store.transaction(async (tx): Promise<DecideOutcome> => {
      const request = await tx.lockRequest(existing.id);
      if (!request) return { kind: "refused", code: "request_not_found" };
      if (request.status !== "pending") return { kind: "refused", code: "request_not_pending" };
      if (decision === "accept") {
        const placed = await this.#place(tx, actorId, { ...(options.placement ?? {}), personId: request.personId, storeId: request.storeId }, store,
          { source: "request", requestId: request.id, recruitCardId: null, recruitRequestId: null });
        if (placed.kind !== "placed") return placed;
        await tx.decideRequest(request.id, "accepted", actorId, reason);
        await tx.event({ kind: "assignment_request.accepted", orgId: request.orgId, personId: request.personId, subjectId: request.id, actorId, detail: { assignmentId: placed.assignment.id } });
        return { kind: "accepted", assignment: placed.assignment };
      }
      const status = decision === "reject" ? "rejected" : "cancelled";
      await tx.decideRequest(request.id, status, actorId, reason);
      await tx.event({ kind: `assignment_request.${status}`, orgId: request.orgId, personId: request.personId, subjectId: request.id, actorId, detail: {} });
      return { kind: status };
    });
  }

  /**
   * Staff end a placement (legacy unassign) or move its end date. Ending is
   * refused while the person has an open session there: legacy left that
   * session open and unreachable once the store was cleared (W-1 draft).
   * `null` makes the placement open-ended again.
   */
  async setEndDate(actorId: string, assignmentId: string, endDate: IsoDate | null): Promise<EndOutcome> {
    if (!isUuid(assignmentId) || (endDate !== null && !isIsoDate(endDate))) return { kind: "refused", code: "invalid_input" };
    const existing = await this.#store.assignment(assignmentId.toLowerCase());
    if (!existing) return { kind: "refused", code: "assignment_not_found" };
    const ancestors = await this.#store.organizationAncestors(existing.orgId) ?? [];
    if (!isStaffFor(await this.#grants.listGrantsForPrincipal(actorId), existing.orgId, ancestors)) return { kind: "refused", code: "forbidden" };
    return this.#store.transaction(async (tx): Promise<EndOutcome> => {
      const current = await tx.lockAssignment(existing.id);
      if (!current) return { kind: "refused", code: "assignment_not_found" };
      if (endDate !== null && endDate < current.startDate) return { kind: "refused", code: "end_before_start" };
      if (current.endDate === endDate) return { kind: "unchanged", endDate };
      const today = kuwaitDate(this.#now());
      const ending = endDate !== null && endDate <= today && (current.endDate === null || current.endDate > endDate);
      if (ending && (await tx.openSessionCount(current.id)) > 0) return { kind: "refused", code: "open_session" };
      try {
        await tx.setEndDate(current.id, endDate);
      } catch (error) {
        if (isPlacementConflict(error)) return { kind: "refused", code: "overlaps_assignment" };
        throw error;
      }
      const kind = current.endDate === null || (endDate !== null && endDate < current.endDate) ? "ended" : "extended";
      await tx.event({ kind: `assignment.${kind}`, orgId: current.orgId, personId: current.personId, subjectId: current.id, actorId, detail: { from: current.endDate, to: endDate } });
      return { kind, endDate };
    });
  }

  /** "Where I work": the person's own placements, newest first. */
  async mine(personId: string): Promise<readonly Assignment[]> {
    return this.#store.listAssignments({ personId });
  }

  /**
   * The people placed at an organization's stores (sub-companies included for
   * a subtree grant). Staff see every company; a company sees its own.
   */
  async forOrganization(actorId: string, orgId: string, storeId?: string): Promise<readonly Assignment[] | undefined> {
    const ancestors = await this.#store.organizationAncestors(orgId);
    if (ancestors === undefined) return undefined;
    const grants = await this.#grants.listGrantsForPrincipal(actorId);
    if (!(isStaffFor(grants, orgId, ancestors) || isCompanyFor(grants, orgId, ancestors))) return undefined;
    return this.#store.listAssignments({ orgIds: [orgId], ...(storeId ? { storeId } : {}) });
  }

  async #place(tx: PlacementTransaction, actorId: string, input: PlacementInput, store: StoreFacts, origin: Origin): Promise<PlaceOutcome> {
    const { source } = origin;
    if (store.status !== "active") return { kind: "refused", code: "store_removed" };
    if (!(await this.#store.personExists(input.personId))) return { kind: "refused", code: "person_not_found" };
    const today = kuwaitDate(this.#now());
    const startDate = input.startDate ?? today;
    const endDate = input.endDate ?? null;
    if (endDate !== null && endDate < startDate) return { kind: "refused", code: "end_before_start" };
    const chosen = chooseContract(await this.#store.contracts(input.personId), input.personId, store.id, startDate, endDate, today, input.payContractId);
    if (!chosen.ok) return { kind: "refused", code: chosen.code, matchedContractIds: chosen.matchedContractIds };
    const assignment: Assignment = Object.freeze({
      id: this.#newId(), personId: input.personId, orgId: store.orgId, storeId: store.id,
      payContractId: chosen.record.contractId, contractResolution: chosen.record, startDate, endDate,
      warnings: Object.freeze(placementWarnings(await this.#store.civilId(input.personId), startDate, chosen.record.contractId)),
      source, requestId: origin.requestId, recruitCardId: origin.recruitCardId, recruitRequestId: origin.recruitRequestId,
      createdBy: actorId, createdAt: this.#now().toISOString(),
    });
    try {
      await tx.insertAssignment(assignment);
    } catch (error) {
      if (isPlacementConflict(error)) return { kind: "refused", code: "overlaps_assignment" };
      throw error;
    }
    await tx.event({ kind: "assignment.created", orgId: store.orgId, personId: assignment.personId, subjectId: assignment.id, actorId,
      detail: { storeId: store.id, startDate, endDate, payContractId: assignment.payContractId, source, warnings: assignment.warnings.join(","), recruitCardId: origin.recruitCardId } });
    return { kind: "placed", assignment };
  }
}
