// Existing Linear receipt store, existing reconcile writer. No scheduler or
// adapter calls here. The handoff and its action are committed in ONE comment.
import { routeSuccessorFromReceipts, validWorkOrder } from './review-routing.mjs';
import { requireHoldCode, HOLD_CODES } from './intended-work.mjs';
import { validateReceipt, terminalVerdictCoherent, receiptsWithinDispatchScope,
  receiptCommentBody, parseReceiptsFromComments, RECEIPT_IMMUTABLE_FIELDS,
  sendLinear, LINEAR_COMMENT_CREATE_MUTATION, fetchBranchHead, fetchIssueComments } from './reconcile.mjs';

const findings = r => ({ notes: [...(r.notes ?? [])], evidence_links: [...(r.evidence_links ?? [])] });
const same = (a, b) => RECEIPT_IMMUTABLE_FIELDS.every(k => JSON.stringify(a[k]) === JSON.stringify(b[k]));
const hold = (code, reason) => ({ action: 'HOLD', hold_code: requireHoldCode(code), reason });

export function durableHandoffStatus(terminal, receipts = []) {
  const unknown = { stage: 'UNKNOWN', hold_code: requireHoldCode('MISSING_LAUNCH_RECEIPT') };
  const durable = receipts.find(r => r.attempt_id === terminal?.attempt_id && same(r, terminal)
    && JSON.stringify(r.handoff) === JSON.stringify(terminal.handoff));
  if (!durable) return unknown;
  const h = durable.handoff;
  if (!h) return { stage: 'UNLAUNCHED', hold_code: requireHoldCode('AWAITING_VERDICT') };
  if (!validHandoff(durable)) return unknown;
  if (h.action === 'HOLD') return { stage: 'HOLD', hold_code: h.hold_code };
  if (h.action === 'merge-readiness') return { stage: 'UNLAUNCHED', action: h.action, target_sha: h.target_sha, hold_code: requireHoldCode('MISSING_AUTHORITY') };
  const claim = receipts.find(r => r.attempt_id === h.order?.attempt_id && r.branch === durable.branch && r.target_sha === h.target_sha);
  if (h.claim_attempt_id && !claim) return unknown;
  // A historical RUNNING receipt alone does not prove a live process. Lifecycle
  // polling remains the authority; this queue view never invents liveness.
  if (claim) return { ...unknown, attempt_id: claim.attempt_id };
  return { stage: 'UNLAUNCHED', action: 'work-order', hold_code: requireHoldCode('MISSING_CLAIM'), order: h.order };
}

export async function consumeDurableHandoffs({ receipts = [], commentsByIssue = new Map(), dispatchEnabled = false,
  linearToken = '', githubToken = '', linearIdFor = new Map(), config = {}, fetchImpl = fetch, stdout = () => {} }) {
  if (!dispatchEnabled || !linearToken) return 0;
  let writes = 0;
  const scoped = receiptsWithinDispatchScope(receipts, config);
  for (const supplied of scoped) {
    if (!['COMPLETED', 'HOLD'].includes(supplied.stage)) continue;
    const comments = commentsByIssue.get(supplied.issue_id) ?? [];
    const durable = parseReceiptsFromComments(comments);
    const terminal = durable.find(r => r.attempt_id === supplied.attempt_id && same(r, supplied));
    if (!terminal) { stdout(`handoff: ${supplied.issue_id} UNKNOWN HOLD=MISSING_LAUNCH_RECEIPT`); continue; }
    if (terminal.handoff) continue;
    const lineage = receipts.filter(r => r.issue_id === terminal.issue_id && r.repo === terminal.repo && r.branch === terminal.branch);
    // A later durable lane already supersedes this completion. Never revive an
    // older build or verdict when replaying the entire append-only history.
    if (lineage.at(-1)?.attempt_id !== terminal.attempt_id) continue;
    const issueId = linearIdFor.get(terminal.issue_id);
    if (!issueId) { stdout(`handoff: ${terminal.issue_id} UNKNOWN HOLD=MISSING_AUTHORITY`); continue; }
    const target = ['BUILD_READY', 'REVISION_READY'].includes(terminal.verdict_stage) ? terminal.result_sha : terminal.target_sha;
    let decision;
    if (!validateReceipt(terminal).valid || !terminalVerdictCoherent(terminal, terminal.verdict_stage) || !/^[0-9a-f]{40}$/.test(target ?? '')) {
      decision = hold('AWAITING_VERDICT', 'terminal completion lacks a coherent exact-head verdict');
    }
    let liveHead = null;
    if (!decision && githubToken) {
      try { liveHead = await fetchBranchHead({ repo: terminal.repo, branch: terminal.branch, token: githubToken, fetchImpl }); } catch { /* typed HOLD below */ }
      if (liveHead !== target) decision = hold('AWAITING_VERDICT', 'exact handoff head is stale or unverifiable');
    }
    const occupied = receipts.some(r => r.repo === terminal.repo && r.branch === terminal.branch && !['COMPLETED', 'FAILED', 'HOLD'].includes(r.stage));
    if (!decision && occupied) decision = hold('BRANCH_OCCUPIED', 'durable active receipt owns this branch');
    if (!decision && ['PASS', 'BLOCKED', 'FAILED'].includes(terminal.verdict_stage)) {
      const writer = lineage.filter(r => ['BUILD_READY', 'REVISION_READY'].includes(r.verdict_stage)).at(-1);
      if (!writer || writer.result_sha !== terminal.target_sha) decision = hold('AWAITING_VERDICT', 'review does not bind the same-branch writer output');
    }
    if (!decision) {
      const routed = routeSuccessorFromReceipts({ issueReceipts: lineage, terminal,
        evidenceStage: terminal.verdict_stage, evidenceResultSha: terminal.result_sha,
        authoritativeHead: liveHead, max_revise: config.max_revise ?? 3 });
      if (routed.ok && routed.terminal) decision = { action: 'merge-readiness', hold_code: requireHoldCode('MISSING_AUTHORITY') };
      else if (routed.ok && routed.order) decision = { action: 'work-order', hold_code: requireHoldCode('MISSING_CLAIM'),
        order: { ...routed.order, repo: terminal.repo, branch: terminal.branch, findings: findings(terminal) } };
      else decision = hold('AWAITING_VERDICT', routed.reason ?? 'unroutable handoff');
    }
    const next = { ...terminal, handoff: { source_attempt_id: terminal.attempt_id, target_sha: target ?? terminal.target_sha,
      verdict_stage: terminal.verdict_stage ?? null, ...decision } };
    const body = receiptCommentBody(next);
    const committed = await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId, body }, linearToken, fetchImpl);
    if (committed?.commentCreate?.success !== true) throw new Error('handoff write was not acknowledged');
    const readback = await fetchIssueComments({ issueId, token: linearToken, fetchImpl });
    if (!parseReceiptsFromComments(readback).some(r => r.attempt_id === next.attempt_id && same(r, next) &&
      JSON.stringify(r.handoff) === JSON.stringify(next.handoff))) throw new Error('handoff write not durably visible');
    // Include the committed action in this tick's view as well as the next
    // tick's durable replay. No separate consumed bit/action crash window.
    commentsByIssue.set(terminal.issue_id, readback);
    writes++;
    stdout(decision.order ? `handoff: ${terminal.issue_id} POSTED ${decision.order.role} order; UNLAUNCHED HOLD=MISSING_CLAIM`
      : `handoff: ${terminal.issue_id} ${decision.action} HOLD=${decision.hold_code}${decision.reason ? ` — ${decision.reason}` : ""}`);
  }
  return writes;
}

export function handoffContinuations(receipts) {
  const result = new Map();
  for (const r of receipts) {
    if (receipts.filter(other => other.repo === r.repo && other.branch === r.branch).at(-1) !== r) continue;
    const status = durableHandoffStatus(r, receipts);
    if (status.action !== 'work-order' || !status.order || r.handoff.claim_attempt_id) continue;
    if (receipts.some(other => other.attempt_id === status.order.attempt_id ||
      (other.repo === r.repo && other.branch === r.branch && !['COMPLETED', 'FAILED', 'HOLD'].includes(other.stage)))) continue;
    result.set(r.issue_id, { successor: status.order });
  }
  return result;
}

export function validHandoff(receipt) {
  const h = receipt?.handoff;
  if (!h || h.source_attempt_id !== receipt.attempt_id || !HOLD_CODES.includes(h.hold_code) ||
      !['merge-readiness', 'work-order', 'HOLD'].includes(h.action) ||
      !/^[0-9a-f]{40}$/.test(h.target_sha ?? '')) return false;
  if (h.action === 'HOLD') return typeof h.reason === 'string';
  const expected = ['BUILD_READY', 'REVISION_READY'].includes(receipt.verdict_stage) ? receipt.result_sha : receipt.target_sha;
  if (h.target_sha !== expected || h.verdict_stage !== receipt.verdict_stage) return false;
  if (h.action === 'merge-readiness') return receipt.stage === 'COMPLETED' && receipt.verdict_stage === 'PASS';
  return validWorkOrder(h.order).ok && h.order.issue_id === receipt.issue_id && h.order.repo === receipt.repo &&
    h.order.branch === receipt.branch && h.order.target_sha === h.target_sha &&
    (!h.claim_attempt_id || h.claim_attempt_id === h.order.attempt_id);
}
