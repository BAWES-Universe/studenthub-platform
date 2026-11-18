// Recruit R4: invitations to a request.
//
// Legacy staff invited candidates to a request and the candidate saw the invitation
// in the app, marked it seen and accepted or declined it. Here the same: one
// invitation per person per request; the person marks it seen, accepts or declines;
// staff may withdraw it while it is open. Accepting moves the person into the
// request's pipeline at "contacted". Every change writes a recruit outbox event
// for the notifications lane to deliver; nothing is sent from here.

export const INVITATION_STATUSES = ["sent", "seen", "accepted", "declined", "withdrawn"] as const;
export type InvitationStatus = typeof INVITATION_STATUSES[number];
export type InvitationActor = "person" | "staff";
export const OPEN_INVITATION_STATUSES: readonly InvitationStatus[] = ["sent", "seen"];

const PERSON_MOVES: readonly (readonly [InvitationStatus, InvitationStatus])[] = [
  ["sent", "seen"], ["sent", "accepted"], ["sent", "declined"], ["seen", "accepted"], ["seen", "declined"],
];
const STAFF_MOVES: readonly (readonly [InvitationStatus, InvitationStatus])[] = [["sent", "withdrawn"], ["seen", "withdrawn"]];

export function invitationTransitionAllowed(from: InvitationStatus, to: InvitationStatus, actor: InvitationActor): boolean {
  return (actor === "person" ? PERSON_MOVES : STAFF_MOVES).some(([a, b]) => a === from && b === to);
}

export type PipelineStageForInvite = "suggested" | "contacted" | "interviewing" | "offered" | "placed" | "withdrawn";
/** What accepting does to the person's card on the request: create it, move a suggestion on, leave a later card, or refuse after a withdrawal. */
export function acceptCardEffect(stage: PipelineStageForInvite | null): "insert_contacted" | "move_contacted" | "keep" | "refuse" {
  if (stage === null) return "insert_contacted";
  if (stage === "suggested") return "move_contacted";
  return stage === "withdrawn" ? "refuse" : "keep";
}

export const RECRUIT_OUTBOX_KINDS = ["invitation.sent", "invitation.accepted", "invitation.declined", "invitation.withdrawn"] as const;
export type RecruitOutboxKind = typeof RECRUIT_OUTBOX_KINDS[number];
/** Who hears about a change: the person for sent and withdrawn, the assigned recruiter (or the inviter) for answers. */
export function invitationOutbox(to: InvitationStatus, person: string, recruiter: string | null, inviter: string): { kind: RecruitOutboxKind; recipient: string } | null {
  if (to === "sent") return { kind: "invitation.sent", recipient: person };
  if (to === "withdrawn") return { kind: "invitation.withdrawn", recipient: person };
  if (to === "accepted" || to === "declined") return { kind: `invitation.${to}`, recipient: recruiter ?? inviter };
  return null;
}

export function parseInvitationCreate(value: unknown): { personId: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const r = value as Record<string, unknown>;
  if (Object.keys(r).some((k) => k !== "personId")) return undefined;
  return typeof r.personId === "string" && r.personId.length >= 1 && r.personId.length <= 255 && r.personId === r.personId.trim() ? { personId: r.personId } : undefined;
}

export interface InvitationRow {
  readonly id: string; readonly request_id: string; readonly status: InvitationStatus; readonly org_name: string; readonly store_name: string;
  readonly position_title: string; readonly position_type: string; readonly period_start: string | null; readonly period_end: string | null;
  readonly compensation_text: string; readonly pay_model: string | null; readonly location: string | null; readonly created_at: string | Date;
}
export interface InvitationView {
  readonly invitationId: string; readonly status: InvitationStatus; readonly company: string; readonly store: string; readonly positionTitle: string;
  readonly positionType: string; readonly period: { readonly start: string; readonly end: string } | null; readonly pay: string; readonly payModel: string | null;
  readonly location: string | null; readonly invitedAt: string; readonly canAnswer: boolean;
}
export function invitationView(row: InvitationRow): InvitationView {
  return {
    invitationId: row.id, status: row.status, company: row.org_name, store: row.store_name, positionTitle: row.position_title, positionType: row.position_type,
    period: row.period_start && row.period_end ? { start: row.period_start, end: row.period_end } : null, pay: row.compensation_text, payModel: row.pay_model,
    location: row.location, invitedAt: (row.created_at instanceof Date ? row.created_at : new Date(row.created_at)).toISOString(), canAnswer: OPEN_INVITATION_STATUSES.includes(row.status),
  };
}
