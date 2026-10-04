// SHU-259 — exact-head routine merge consumption.
//
// Linear remains the durable state store and GitHub remains the merge authority.
// A deterministic PREPARED record is committed before the conditional merge
// request. Every authority input is fetched again after that write and directly
// before the request. The committed configuration is disabled by default.
import { createHash } from 'node:crypto';
import { requireHoldCode } from './intended-work.mjs';
import { reviewVerdictProvenanceValid } from './review-routing.mjs';
import { LINEAR_COMMENT_CREATE_MUTATION, parseReceiptCommentBody, parseReceiptsFromComments,
  receiptCommentBody, sendLinear, validateReceipt } from './reconcile.mjs';
import { validHandoff } from './durable-handoff.mjs';

const SHA = /^[0-9a-f]{40}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARKER = '<!-- coordinator-merge-attempt v1 -->';
const STATES = Object.freeze(['PREPARED', 'COMPLETED', 'HOLD']);
const IMMUTABLE = Object.freeze([
  'version', 'attempt_id', 'source_attempt_id', 'issue_id', 'repo', 'branch',
  'pr_number', 'approved_head_sha', 'approved_tree_sha', 'base_sha', 'base_ref',
  'merge_method', 'authority_ref',
]);
const FORBIDDEN_LABELS = new Set([
  'production', 'deployment', 'activation', 'credential', 'credentials', 'spend',
  'destructive-migration', 'product-decision', 'type:decision', 'needs:decision',
]);
const EXPLICIT_HOLD_LABELS = new Set(['blocked', 'hold', 'on-hold', 'on hold']);

export const LINEAR_MERGE_ISSUE_QUERY = `
  query CoordinatorMergeIssue($issueId: String!) {
    issue(id: $issueId) {
      id identifier title
      state { name type }
      labels { nodes { name } }
      relations { nodes { type relatedIssue { identifier state { name type } } } }
      comments(first: 100, orderBy: createdAt) {
        nodes { body createdAt user { id displayName } }
      }
    }
  }`;

const ghHeaders = token => ({
  Authorization: `Bearer ${token}`,
  Accept: 'application/vnd.github+json',
  'X-GitHub-Api-Version': '2022-11-28',
  'User-Agent': 'studenthub-coordinator-merge',
});

function uuidFor(sourceAttemptId, targetSha) {
  const hex = createHash('sha256').update(`merge:${sourceAttemptId}:${targetSha}`).digest('hex').slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20)}`;
}

function sameImmutable(a, b) {
  return IMMUTABLE.every(key => JSON.stringify(a?.[key] ?? null) === JSON.stringify(b?.[key] ?? null));
}

export function routineMergeEnabledFor(env = {}, config = {}) {
  const authority = config.routine_merge_authority;
  return authority?.enabled === true && authority.authority_ref === 'SHU-259' &&
    authority.merge_method === 'squash' && authority.max_per_tick === 1 &&
    /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(authority.repo ?? '') &&
    env.ENABLE_ROUTINE_MERGE === 'true';
}

export function mergeAttemptCommentBody(record) {
  return [MARKER, `**Coordinator merge attempt** — ${record.attempt_id}`, '```json',
    JSON.stringify(record, null, 2), '```'].join('\n');
}

export function parseMergeAttemptCommentBody(body) {
  if (!String(body ?? '').includes(MARKER)) return null;
  const match = /```json\n([\s\S]*?)\n```/.exec(body ?? '');
  if (!match) return null;
  try {
    const record = JSON.parse(match[1]);
    return validateMergeAttempt(record).ok ? record : null;
  } catch {
    return null;
  }
}

export function validateMergeAttempt(record) {
  if (!record || typeof record !== 'object' || Array.isArray(record)) return { ok: false, reason: 'not an object' };
  const allowed = new Set([...IMMUTABLE, 'state', 'hold_code', 'reason', 'merge_commit_sha', 'landed_tree_sha', 'updated_at']);
  if (Object.keys(record).some(key => !allowed.has(key))) return { ok: false, reason: 'unknown field' };
  if (record.version !== '1.0.0' || !UUID.test(record.attempt_id ?? '') || !UUID.test(record.source_attempt_id ?? '') ||
      typeof record.issue_id !== 'string' || typeof record.repo !== 'string' || typeof record.branch !== 'string' ||
      !SHA.test(record.approved_head_sha ?? '') || record.merge_method !== 'squash' ||
      record.authority_ref !== 'SHU-259' || !STATES.includes(record.state) || typeof record.updated_at !== 'string') {
    return { ok: false, reason: 'invalid required field' };
  }
  // Retain legacy records without base_ref so their deterministic attempt cannot
  // disappear on upgrade. They may only transition to HOLD, never resume a PUT.
  if (record.base_ref !== undefined && !(record.state === 'HOLD' && record.base_ref === null) &&
      (typeof record.base_ref !== 'string' || record.base_ref.length === 0)) return { ok: false, reason: 'invalid base ref' };
  if (record.state === 'HOLD') {
    if (record.pr_number !== null && (!Number.isInteger(record.pr_number) || record.pr_number <= 0)) return { ok: false, reason: 'invalid HOLD pull request' };
    if (record.approved_tree_sha !== null && !SHA.test(record.approved_tree_sha ?? '')) return { ok: false, reason: 'invalid HOLD tree' };
    if (record.base_sha !== null && !SHA.test(record.base_sha ?? '')) return { ok: false, reason: 'invalid HOLD base' };
    try { requireHoldCode(record.hold_code); } catch { return { ok: false, reason: 'invalid hold code' }; }
    if (typeof record.reason !== 'string' || record.reason.length === 0) return { ok: false, reason: 'missing hold reason' };
  } else {
    if (!Number.isInteger(record.pr_number) || record.pr_number <= 0 || !SHA.test(record.approved_tree_sha ?? '') || !SHA.test(record.base_sha ?? '')) return { ok: false, reason: 'merge attempt lacks exact object bindings' };
    if (record.hold_code !== null || record.reason !== null) return { ok: false, reason: 'non-HOLD carries hold data' };
  }
  if (record.state === 'COMPLETED') {
    if (!SHA.test(record.merge_commit_sha ?? '') || !SHA.test(record.landed_tree_sha ?? '')) return { ok: false, reason: 'completion lacks landed object ids' };
    if (record.landed_tree_sha !== record.approved_tree_sha) return { ok: false, reason: 'completion tree mismatch' };
  } else if (record.merge_commit_sha !== null || record.landed_tree_sha !== null) return { ok: false, reason: 'non-completion carries landed object ids' };
  return { ok: true };
}

export function parseMergeAttemptsFromComments(comments = [], allowedActorIds = []) {
  const allowed = new Set((allowedActorIds ?? []).filter(Boolean));
  const byAttempt = new Map();
  const conflicts = new Set();
  for (const [index, comment] of (comments ?? []).entries()) {
    if (!allowed.has(comment?.user?.id)) continue;
    const record = parseMergeAttemptCommentBody(comment?.body);
    if (!record) continue;
    const previous = byAttempt.get(record.attempt_id);
    if (previous && !sameImmutable(previous.record, record)) { conflicts.add(record.attempt_id); continue; }
    const createdAt = typeof comment.createdAt === 'string' ? comment.createdAt : '';
    if (!previous || createdAt > previous.createdAt || (createdAt === previous.createdAt && index > previous.index)) {
      byAttempt.set(record.attempt_id, { record, createdAt, index });
    }
  }
  return { records: [...byAttempt.values()].map(item => item.record), conflicts };
}

function trustedReceipts(comments, allowedActorIds) {
  const allowed = new Set((allowedActorIds ?? []).filter(Boolean));
  if (allowed.size === 0) return [];
  return parseReceiptsFromComments((comments ?? []).filter(comment =>
    allowed.has(comment?.user?.id) && parseReceiptCommentBody(comment?.body)));
}

function mergeVerdict(receipts, sourceAttemptId, targetSha, issueId, repo, branch) {
  const lineage = receipts.filter(r => r?.issue_id === issueId && r.repo === repo && r.branch === branch)
    .sort((a, b) => String(a.last_activity ?? '').localeCompare(String(b.last_activity ?? '')));
  const review = lineage.find(r => r.attempt_id === sourceAttemptId);
  if (!review || lineage.at(-1)?.attempt_id !== review.attempt_id || !validateReceipt(review).valid || !validHandoff(review) ||
      review.stage !== 'COMPLETED' || review.verdict_stage !== 'PASS' || review.target_sha !== targetSha ||
      review.handoff.action !== 'merge-readiness' || review.handoff.hold_code !== 'MISSING_AUTHORITY' ||
      review.handoff.target_sha !== targetSha) return { ok: false, reason: 'latest durable handoff is not the exact-head merge-readiness PASS' };
  const provenance = reviewVerdictProvenanceValid(review, lineage);
  if (!provenance.ok) return { ok: false, reason: provenance.reason };
  const writers = lineage.filter(r => ['BUILD_READY', 'REVISION_READY'].includes(r.verdict_stage) && r.result_sha === targetSha);
  if (writers.length === 0) return { ok: false, reason: 'review has no exact-head writer lineage' };
  return { ok: true, review, lineage };
}

function issuePolicy(issue) {
  if (!issue || issue.identifier == null || issue.state?.type === 'canceled') return { ok: false, code: 'EXPLICIT_HOLD', reason: 'issue state is unavailable or canceled' };
  const labels = (issue.labels?.nodes ?? []).map(x => String(x?.name ?? '').trim().toLowerCase());
  if (labels.some(label => FORBIDDEN_LABELS.has(label))) return { ok: false, code: 'FORBIDDEN_MERGE_ACTION', reason: 'issue carries a protected action/decision label' };
  if (labels.some(label => EXPLICIT_HOLD_LABELS.has(label))) return { ok: false, code: 'EXPLICIT_HOLD', reason: 'issue carries an explicit hold label' };
  const blocker = (issue.relations?.nodes ?? []).find(r => r?.type === 'blockedBy' && r.relatedIssue?.state?.type !== 'completed' && r.relatedIssue?.state?.name !== 'Done');
  if (blocker) return { ok: false, code: 'EXPLICIT_HOLD', reason: 'issue has an unresolved explicit blocker' };
  return { ok: true };
}

async function jsonRequest(fetchImpl, url, token, options = {}) {
  let response;
  try { response = await fetchImpl(url, { ...options, headers: { ...ghHeaders(token), ...(options.headers ?? {}) } }); }
  catch { return { ok: false, status: null, body: null }; }
  const body = await response.json().catch(() => null);
  return { ok: response.ok, status: response.status, body };
}

async function reviewThreads({ fetchImpl, token, owner, name, number }) {
  const nodes = [];
  let after = null;
  const seen = new Set();
  do {
    const query = `query MergeThreads($owner:String!,$name:String!,$number:Int!,$after:String) { repository(owner:$owner,name:$name) { pullRequest(number:$number) { reviewThreads(first:100,after:$after) { nodes { isResolved comments(first:1) { nodes { isMinimized } } } pageInfo { hasNextPage endCursor } } } } }`;
    const result = await jsonRequest(fetchImpl, 'https://api.github.com/graphql', token, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ query, variables: { owner, name, number, after } }) });
    const page = result.body?.data?.repository?.pullRequest?.reviewThreads;
    if (!result.ok || result.body?.errors?.length || !page || !Array.isArray(page.nodes)) return { ok: false };
    nodes.push(...page.nodes);
    if (!page.pageInfo?.hasNextPage) return { ok: true, nodes };
    const cursor = page.pageInfo.endCursor;
    if (typeof cursor !== 'string' || cursor.length === 0 || seen.has(cursor)) return { ok: false };
    seen.add(cursor); after = cursor;
  } while (true);
}

function requiredChecksGreen(protection, statuses, checks) {
  const required = Array.isArray(protection?.contexts) ? protection.contexts.map(context => ({ context, app_id: null })) : [];
  for (const check of protection?.checks ?? []) {
    if (!required.some(item => item.context === check?.context && item.app_id === (check?.app_id ?? null))) required.push({ context: check?.context, app_id: check?.app_id ?? null });
  }
  if (required.some(item => typeof item.context !== 'string' || item.context.length === 0)) return false;
  return required.every(item => {
    const run = (checks ?? []).find(candidate => candidate?.name === item.context && (item.app_id === null || candidate?.app?.id === item.app_id));
    if (run) return run.status === 'completed' && ['success', 'neutral', 'skipped'].includes(run.conclusion);
    return (statuses ?? []).some(status => status?.context === item.context && status?.state === 'success');
  });
}

export async function fetchGitHubMergeSnapshot({ repo, branch, targetSha, token, fetchImpl = fetch }) {
  if (!token || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo ?? '') || !branch || !SHA.test(targetSha ?? '')) {
    return { ok: false, code: 'AMBIGUOUS_GITHUB_RESPONSE', reason: 'GitHub merge authority input is incomplete' };
  }
  const [owner, name] = repo.split('/');
  const list = await jsonRequest(fetchImpl, `https://api.github.com/repos/${repo}/pulls?state=all&head=${encodeURIComponent(`${owner}:${branch}`)}&per_page=100`, token);
  if (!list.ok || !Array.isArray(list.body) || list.body.length >= 100) return { ok: false, code: 'AMBIGUOUS_GITHUB_RESPONSE', reason: 'pull request lookup was unavailable or incomplete' };
  const open = list.body.filter(pr => pr?.state === 'open');
  const landed = list.body.filter(pr => pr?.merged_at && pr?.head?.sha === targetSha);
  const candidates = open.length ? open : landed;
  if (candidates.length !== 1) return { ok: false, code: 'AMBIGUOUS_GITHUB_RESPONSE', reason: 'branch does not identify exactly one current pull request' };
  const number = candidates[0].number;
  const detailResult = await jsonRequest(fetchImpl, `https://api.github.com/repos/${repo}/pulls/${number}`, token);
  const pr = detailResult.body;
  if (!detailResult.ok || !pr || !Number.isInteger(pr.number) || pr.number !== number || pr.head?.ref !== branch || pr.head?.repo?.full_name !== repo || !SHA.test(pr.head?.sha ?? '') || !SHA.test(pr.base?.sha ?? '') || typeof pr.base?.ref !== 'string') {
    return { ok: false, code: 'AMBIGUOUS_GITHUB_RESPONSE', reason: 'pull request response did not bind the expected repository and branch' };
  }
  if (pr.head.sha !== targetSha) return { ok: false, code: 'STALE_HEAD', reason: 'pull request head changed after the eligible PASS' };
  const prLabels = (pr.labels ?? []).map(label => String(label?.name ?? '').trim().toLowerCase());
  if (prLabels.some(label => FORBIDDEN_LABELS.has(label))) return { ok: false, code: 'FORBIDDEN_MERGE_ACTION', reason: 'pull request carries a protected action/decision label' };
  if (prLabels.some(label => EXPLICIT_HOLD_LABELS.has(label))) return { ok: false, code: 'EXPLICIT_HOLD', reason: 'pull request carries an explicit hold label' };
  const headCommitResult = await jsonRequest(fetchImpl, `https://api.github.com/repos/${repo}/commits/${targetSha}`, token);
  const treeSha = headCommitResult.body?.commit?.tree?.sha;
  if (!headCommitResult.ok || !SHA.test(treeSha ?? '')) return { ok: false, code: 'AMBIGUOUS_GITHUB_RESPONSE', reason: 'approved head tree was not readable' };
  if (pr.merged === true || pr.merged_at) {
    if (!SHA.test(pr.merge_commit_sha ?? '')) return { ok: false, code: 'AMBIGUOUS_GITHUB_RESPONSE', reason: 'merged pull request omitted its merge commit' };
    const mergedCommitResult = await jsonRequest(fetchImpl, `https://api.github.com/repos/${repo}/commits/${pr.merge_commit_sha}`, token);
    const landedTree = mergedCommitResult.body?.commit?.tree?.sha;
    if (!mergedCommitResult.ok || !SHA.test(landedTree ?? '')) return { ok: false, code: 'AMBIGUOUS_GITHUB_RESPONSE', reason: 'landed merge tree was not readable' };
    return { ok: true, merged: true, pr_number: number, head_sha: targetSha, tree_sha: treeSha,
      base_sha: pr.base.sha, base_ref: pr.base.ref, merge_commit_sha: pr.merge_commit_sha, landed_tree_sha: landedTree };
  }
  if (pr.state !== 'open' || pr.draft === true) return { ok: false, code: 'EXPLICIT_HOLD', reason: 'pull request is not open and ready for review' };
  const branchResult = await jsonRequest(fetchImpl, `https://api.github.com/repos/${repo}/branches/${encodeURIComponent(pr.base.ref)}`, token);
  const baseLive = branchResult.body?.commit?.sha;
  if (!branchResult.ok || branchResult.body?.protected !== true || !SHA.test(baseLive ?? '')) return { ok: false, code: 'BRANCH_PROTECTION_UNSATISFIED', reason: 'base branch protection was unavailable or not enabled' };
  const compareResult = await jsonRequest(fetchImpl, `https://api.github.com/repos/${repo}/compare/${baseLive}...${targetSha}`, token);
  if (!compareResult.ok || !['ahead', 'identical'].includes(compareResult.body?.status) || compareResult.body?.base_commit?.sha !== baseLive) {
    return { ok: false, code: 'BASE_ADVANCED', reason: 'the approved head does not contain the current base; use the base-update/delta-verdict path' };
  }
  const [protectionResult, statusResult, checksResult, threadsResult] = await Promise.all([
    jsonRequest(fetchImpl, `https://api.github.com/repos/${repo}/branches/${encodeURIComponent(pr.base.ref)}/protection`, token),
    jsonRequest(fetchImpl, `https://api.github.com/repos/${repo}/commits/${targetSha}/status?per_page=100`, token),
    jsonRequest(fetchImpl, `https://api.github.com/repos/${repo}/commits/${targetSha}/check-runs?filter=latest&per_page=100`, token),
    reviewThreads({ fetchImpl, token, owner, name, number }),
  ]);
  if (!protectionResult.ok || !statusResult.ok || !Array.isArray(statusResult.body?.statuses) || statusResult.body.statuses.length >= 100 || !checksResult.ok || !Array.isArray(checksResult.body?.check_runs) || checksResult.body.total_count > 100) {
    return { ok: false, code: 'AMBIGUOUS_GITHUB_RESPONSE', reason: 'required-check authority was unavailable or incomplete' };
  }
  if (protectionResult.body?.required_status_checks?.strict !== true) {
    return { ok: false, code: 'BRANCH_PROTECTION_UNSATISFIED', reason: 'server-enforced strict base freshness is required' };
  }
  const requiredGreen = requiredChecksGreen(protectionResult.body?.required_status_checks ?? {}, statusResult.body.statuses, checksResult.body.check_runs);
  if (!threadsResult.ok) return { ok: false, code: 'AMBIGUOUS_GITHUB_RESPONSE', reason: 'review thread authority was unavailable or incomplete' };
  return { ok: true, merged: false, pr_number: number, head_sha: targetSha, tree_sha: treeSha, base_sha: baseLive, base_ref: pr.base.ref,
    required_checks_green: requiredGreen,
    blocking_threads: threadsResult.nodes.filter(thread => thread?.isResolved !== true).length,
    protection_satisfied: pr.mergeable === true && pr.mergeable_state === 'clean' };
}

async function fetchMergeIssue({ issueId, token, fetchImpl }) {
  const data = await sendLinear(LINEAR_MERGE_ISSUE_QUERY, { issueId }, token, fetchImpl);
  return data?.issue ?? null;
}

function makeRecord({ source, snapshot, authorityRef, state = 'PREPARED', code = null, reason = null, now = new Date() }) {
  return {
    version: '1.0.0',
    attempt_id: uuidFor(source.attempt_id, source.handoff.target_sha),
    source_attempt_id: source.attempt_id,
    issue_id: source.issue_id,
    repo: source.repo,
    branch: source.branch,
    pr_number: snapshot.pr_number,
    approved_head_sha: source.handoff.target_sha,
    approved_tree_sha: snapshot.tree_sha,
    base_sha: snapshot.base_sha,
    base_ref: snapshot.base_ref,
    merge_method: 'squash',
    authority_ref: authorityRef,
    state,
    hold_code: code ? requireHoldCode(code) : null,
    reason,
    merge_commit_sha: null,
    landed_tree_sha: null,
    updated_at: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
}

function initialHoldRecord({ source, authorityRef, code, reason, snapshot = {}, now = new Date() }) {
  return {
    version: '1.0.0', attempt_id: uuidFor(source.attempt_id, source.handoff.target_sha),
    source_attempt_id: source.attempt_id, issue_id: source.issue_id, repo: source.repo, branch: source.branch,
    pr_number: Number.isInteger(snapshot.pr_number) ? snapshot.pr_number : null,
    approved_head_sha: source.handoff.target_sha,
    approved_tree_sha: SHA.test(snapshot.tree_sha ?? '') ? snapshot.tree_sha : null,
    base_sha: SHA.test(snapshot.base_sha ?? '') ? snapshot.base_sha : null,
    base_ref: typeof snapshot.base_ref === 'string' && snapshot.base_ref.length > 0 ? snapshot.base_ref : null,
    merge_method: 'squash', authority_ref: authorityRef, state: 'HOLD',
    hold_code: requireHoldCode(code), reason, merge_commit_sha: null, landed_tree_sha: null,
    updated_at: (now instanceof Date ? now : new Date(now)).toISOString(),
  };
}

async function appendRecord({ record, issueId, linearToken, fetchImpl, allowedActorIds }) {
  const body = mergeAttemptCommentBody(record);
  const committed = await sendLinear(LINEAR_COMMENT_CREATE_MUTATION, { issueId, body }, linearToken, fetchImpl);
  if (committed?.commentCreate?.success !== true) throw new Error('merge-attempt write was not acknowledged');
  const issue = await fetchMergeIssue({ issueId, token: linearToken, fetchImpl });
  const parsed = parseMergeAttemptsFromComments(issue?.comments?.nodes ?? [], allowedActorIds);
  if (parsed.conflicts.has(record.attempt_id) || !parsed.records.some(candidate => candidate.attempt_id === record.attempt_id && candidate.state === record.state && JSON.stringify(candidate) === JSON.stringify(record))) {
    throw new Error('merge-attempt write was not durably visible');
  }
  return issue;
}

function holdFrom(prepared, code, reason, now) {
  return { ...prepared, state: 'HOLD', hold_code: requireHoldCode(code), reason,
    merge_commit_sha: null, landed_tree_sha: null, updated_at: now.toISOString() };
}

function bindingHold(prepared, snapshot, now) {
  if (!prepared) return null;
  if (snapshot.pr_number !== prepared.pr_number) return holdFrom(prepared, 'AMBIGUOUS_GITHUB_RESPONSE',
    'pull request identity changed after the durable merge intent', now);
  if (!prepared.base_ref || snapshot.base_ref !== prepared.base_ref) return holdFrom(prepared, 'BASE_ADVANCED',
    'base ref is unbound or changed after the durable merge intent', now);
  return null;
}

function completedFrom(prepared, snapshot, now) {
  return { ...prepared, state: 'COMPLETED', hold_code: null, reason: null,
    merge_commit_sha: snapshot.merge_commit_sha, landed_tree_sha: snapshot.landed_tree_sha,
    updated_at: now.toISOString() };
}

function snapshotPolicy(snapshot) {
  if (!snapshot.required_checks_green) return { ok: false, code: 'REQUIRED_CHECKS_NOT_GREEN', reason: 'one or more required checks are absent, pending or non-green' };
  if (snapshot.blocking_threads !== 0) return { ok: false, code: 'BLOCKING_REVIEW_THREAD', reason: 'one or more blocking review threads are unresolved' };
  if (!snapshot.protection_satisfied) return { ok: false, code: 'BRANCH_PROTECTION_UNSATISFIED', reason: 'GitHub does not report the protected pull request as clean and mergeable' };
  return { ok: true };
}

async function authorityNow({ source, linearIssueId, linearToken, githubToken, fetchImpl, allowedActorIds }) {
  let issue;
  try { issue = await fetchMergeIssue({ issueId: linearIssueId, token: linearToken, fetchImpl }); }
  catch { return { ok: false, code: 'EXPLICIT_HOLD', reason: 'Linear merge authority could not be re-fetched' }; }
  if (issue?.identifier !== source.issue_id) return { ok: false, code: 'EXPLICIT_HOLD', reason: 'Linear merge authority did not bind the expected issue' };
  const policy = issuePolicy(issue);
  if (!policy.ok) return policy;
  const receipts = trustedReceipts(issue.comments?.nodes ?? [], allowedActorIds);
  const verdict = mergeVerdict(receipts, source.attempt_id, source.handoff.target_sha, source.issue_id, source.repo, source.branch);
  if (!verdict.ok) return { ok: false, code: 'INELIGIBLE_VERDICT', reason: verdict.reason };
  const snapshot = await fetchGitHubMergeSnapshot({ repo: source.repo, branch: source.branch,
    targetSha: source.handoff.target_sha, token: githubToken, fetchImpl });
  if (!snapshot.ok) return snapshot;
  if (!snapshot.merged) {
    const policy = snapshotPolicy(snapshot);
    if (!policy.ok) return policy;
  }
  return { ok: true, issue, snapshot };
}

export async function consumeMergeReadiness({
  receipts = [], issues = [], linearToken = '', githubToken = '', config = {}, env = {}, fetchImpl = fetch,
  stdout = () => {}, now = () => new Date(),
}) {
  if (!routineMergeEnabledFor(env, config)) return { writes: 0, merges: 0 };
  if (!linearToken || !githubToken) return { writes: 0, merges: 0, error: 'merge credentials unavailable' };
  const authority = config.routine_merge_authority;
  const allowedActorIds = config.linear_receipt_actor_ids ?? [];
  const issueMap = new Map((issues ?? []).map(issue => [issue.id, issue]));
  let writes = 0, merges = 0;
  const sources = receipts.filter(receipt => receipt?.handoff?.action === 'merge-readiness' && validHandoff(receipt));
  for (const source of sources) {
    if (writes > 0 || merges >= authority.max_per_tick) break;
    if (source.repo !== authority.repo) continue;
    const linearIssueId = issueMap.get(source.issue_id)?.linearId ?? source.issue_id;
    let issue;
    try { issue = await fetchMergeIssue({ issueId: linearIssueId, token: linearToken, fetchImpl }); }
    catch { stdout(`merge-readiness: ${source.issue_id} HOLD=EXPLICIT_HOLD — Linear authority unavailable`); continue; }
    const parsedAttempts = parseMergeAttemptsFromComments(issue?.comments?.nodes ?? [], allowedActorIds);
    const attemptId = uuidFor(source.attempt_id, source.handoff.target_sha);
    if (parsedAttempts.conflicts.has(attemptId)) { stdout(`merge-readiness: ${source.issue_id} HOLD=EXPLICIT_HOLD — durable merge-attempt conflict`); continue; }
    let existing = parsedAttempts.records.find(record => record.attempt_id === attemptId);
    if (existing?.state === 'COMPLETED' || existing?.state === 'HOLD') continue;

    let authorityCheck = await authorityNow({ source, linearIssueId, linearToken, githubToken, fetchImpl, allowedActorIds });
    if (!authorityCheck.ok) {
      const held = existing ? holdFrom(existing, authorityCheck.code, authorityCheck.reason, now()) : initialHoldRecord({ source, authorityRef: authority.authority_ref,
        code: authorityCheck.code, reason: authorityCheck.reason, snapshot: authorityCheck.snapshot, now: now() });
      await appendRecord({ record: held, issueId: linearIssueId, linearToken, fetchImpl, allowedActorIds });
      writes++;
      stdout(`merge-readiness: ${source.issue_id} HOLD=${authorityCheck.code} — ${authorityCheck.reason}`);
      continue;
    }
    const initialBinding = bindingHold(existing, authorityCheck.snapshot, now());
    if (initialBinding) {
      await appendRecord({ record: initialBinding, issueId: linearIssueId, linearToken, fetchImpl, allowedActorIds }); writes++;
      continue;
    }
    if (authorityCheck.snapshot.merged) {
      const recoveredBase = existing ?? makeRecord({ source, snapshot: authorityCheck.snapshot, authorityRef: authority.authority_ref, now: now() });
      const recovered = authorityCheck.snapshot.landed_tree_sha !== recoveredBase.approved_tree_sha
        ? holdFrom(recoveredBase, 'TREE_MISMATCH', 'landed squash tree does not match the approved head tree', now())
        : completedFrom(recoveredBase, authorityCheck.snapshot, now());
      await appendRecord({ record: recovered, issueId: linearIssueId, linearToken, fetchImpl, allowedActorIds });
      writes++;
      stdout(`merge-readiness: ${source.issue_id} ${recovered.state} at ${source.handoff.target_sha}`);
      continue;
    }

    if (!existing) {
      existing = makeRecord({ source, snapshot: authorityCheck.snapshot, authorityRef: authority.authority_ref, now: now() });
      await appendRecord({ record: existing, issueId: linearIssueId, linearToken, fetchImpl, allowedActorIds });
      writes++;
    }

    // Immediate pre-merge re-fetch. No value from the earlier preflight is
    // authoritative here except the immutable values in the durable intent.
    authorityCheck = await authorityNow({ source, linearIssueId, linearToken, githubToken, fetchImpl, allowedActorIds });
    if (!authorityCheck.ok) {
      const held = holdFrom(existing, authorityCheck.code, authorityCheck.reason, now());
      await appendRecord({ record: held, issueId: linearIssueId, linearToken, fetchImpl, allowedActorIds });
      writes++;
      stdout(`merge-readiness: ${source.issue_id} HOLD=${held.hold_code} — ${held.reason}`);
      continue;
    }
    const snapshot = authorityCheck.snapshot;
    const changedBinding = bindingHold(existing, snapshot, now());
    if (changedBinding) {
      await appendRecord({ record: changedBinding, issueId: linearIssueId, linearToken, fetchImpl, allowedActorIds }); writes++;
      continue;
    }
    if (snapshot.merged) {
      const recovered = snapshot.landed_tree_sha !== existing.approved_tree_sha
        ? holdFrom(existing, 'TREE_MISMATCH', 'landed squash tree does not match the approved head tree', now())
        : completedFrom(existing, snapshot, now());
      await appendRecord({ record: recovered, issueId: linearIssueId, linearToken, fetchImpl, allowedActorIds }); writes++;
      stdout(`merge-readiness: ${source.issue_id} ${recovered.state} at ${existing.approved_head_sha}`);
      continue;
    }
    if (snapshot.base_sha !== existing.base_sha || snapshot.tree_sha !== existing.approved_tree_sha) {
      const held = holdFrom(existing, snapshot.base_sha !== existing.base_sha ? 'BASE_ADVANCED' : 'TREE_MISMATCH',
        'pre-merge object bindings changed after the durable merge intent', now());
      await appendRecord({ record: held, issueId: linearIssueId, linearToken, fetchImpl, allowedActorIds }); writes++;
      continue;
    }

    let mergeResponse;
    try {
      mergeResponse = await jsonRequest(fetchImpl, `https://api.github.com/repos/${existing.repo}/pulls/${existing.pr_number}/merge`, githubToken, {
        method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sha: existing.approved_head_sha, merge_method: 'squash' }),
      });
    } catch { mergeResponse = { ok: false, status: null, body: null }; }
    const recovered = await fetchGitHubMergeSnapshot({ repo: source.repo, branch: source.branch,
      targetSha: existing.approved_head_sha, token: githubToken, fetchImpl });
    if (!recovered.ok || !recovered.merged) {
      const held = holdFrom(existing, mergeResponse?.ok === false && mergeResponse?.status === 409 ? 'STALE_HEAD' : 'AMBIGUOUS_MERGE_RESPONSE',
        'conditional merge did not produce a uniquely verifiable landed pull request', now());
      await appendRecord({ record: held, issueId: linearIssueId, linearToken, fetchImpl, allowedActorIds }); writes++;
      stdout(`merge-readiness: ${source.issue_id} HOLD=${held.hold_code} — ${held.reason}`);
      continue;
    }
    const recoveredBinding = bindingHold(existing, recovered, now());
    if (recoveredBinding) {
      await appendRecord({ record: recoveredBinding, issueId: linearIssueId, linearToken, fetchImpl, allowedActorIds }); writes++;
      continue;
    }
    if (recovered.landed_tree_sha !== existing.approved_tree_sha) {
      const held = holdFrom(existing, 'TREE_MISMATCH', 'landed squash tree does not match the approved head tree', now());
      await appendRecord({ record: held, issueId: linearIssueId, linearToken, fetchImpl, allowedActorIds }); writes++;
      stdout(`merge-readiness: ${source.issue_id} HOLD=TREE_MISMATCH`);
      continue;
    }
    const completed = completedFrom(existing, recovered, now());
    await appendRecord({ record: completed, issueId: linearIssueId, linearToken, fetchImpl, allowedActorIds });
    writes++; merges++;
    stdout(`merge-readiness: ${source.issue_id} COMPLETED head=${completed.approved_head_sha} merge=${completed.merge_commit_sha} tree=${completed.landed_tree_sha}`);
  }
  return { writes, merges };
}
