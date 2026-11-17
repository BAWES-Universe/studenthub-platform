/**
 * Work session decisions in the person's feed (legacy CandidateNotification types 8 and 9,
 * written by CandidateWorkLogFeedback::afterSave). The work lane calls these inside its own
 * decision and undo transactions, with its client, so a rolled-back decision leaves no row.
 */
type Client = { query(text: string, values?: readonly unknown[]): Promise<unknown> };
const DATE = /^\d{4}-\d{2}-\d{2}$/;
const ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

export interface WorkSessionDecisionNotice {
  readonly personPrincipalId: string;
  readonly sessionId: string;
  readonly decisionId: string;
  readonly decision: "approved" | "rejected";
  readonly workDate: string;
}

export async function recordWorkSessionDecision(client: Client, notice: WorkSessionDecisionNotice): Promise<void> {
  if (notice.decision !== "approved" && notice.decision !== "rejected") throw new TypeError("unknown work session decision");
  if (!DATE.test(notice.workDate) || Number.isNaN(Date.parse(`${notice.workDate}T00:00:00Z`))) throw new TypeError("workDate must be YYYY-MM-DD");
  if (!ID.test(notice.sessionId) || !ID.test(notice.decisionId)) throw new TypeError("invalid work session reference");
  await client.query(
    `INSERT INTO notifications(recipient_principal_id,kind,subject_reference,parameters,dedupe_key)
     VALUES($1,$2,$3,$4::jsonb,$5) ON CONFLICT(recipient_principal_id,dedupe_key) DO NOTHING`,
    [notice.personPrincipalId, `work.session_${notice.decision}`, `work_session:${notice.sessionId}`,
      JSON.stringify({ workDate: notice.workDate }), `work_decision:${notice.decisionId}`]);
}

/** Undo: the decision's feed row goes, so the person never sees a decision that no longer stands. */
export async function retractWorkSessionDecision(client: Client, notice: { readonly personPrincipalId: string; readonly decisionId: string }): Promise<void> {
  await client.query(
    `DELETE FROM notifications WHERE recipient_principal_id=$1 AND dedupe_key=$2 AND kind IN ('work.session_approved','work.session_rejected')`,
    [notice.personPrincipalId, `work_decision:${notice.decisionId}`]);
}
