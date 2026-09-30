// A reviewer's BLOCKED verdict is only useful to the revision if the writer can
// read it. The verdict's own words and citations are kept on the review's
// terminal receipt, copied onto the routed revise receipt, and rendered into the
// writer's task context from that receipt, so every submit and retry of the
// same attempt carries the identical text.

export const REVIEW_FINDINGS_SUMMARY_MAX = 4000;
export const REVIEW_FINDINGS_LINKS_MAX = 32;
// A citation is a path@sha:range, far below this.
export const REVIEW_FINDINGS_LINK_LENGTH_MAX = 512;
// The findings are rendered into the work order's task_context, and the
// supervisor refuses an order whose canonical JSON is over 32 KiB. Escaping can
// grow text several times, so the budget is measured on the escaped rendering.
export const REVIEW_FINDINGS_CONTEXT_BYTES_MAX = 16384;
// The reviewer-evidence shapes (review-execution.mjs) plus Linear's own key
// prefixes, since these receipts are published to Linear.
const TOKEN_SHAPE = /(?:github_pat_[A-Za-z0-9_]{20,}|gh[pousr]_[A-Za-z0-9]{20,}|sk-(?:ant-)?[A-Za-z0-9_-]{20,}|lin_(?:api|oauth)_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._-]{16,})/;

function renderedBytes(summary, links) {
  return Buffer.byteLength(JSON.stringify(JSON.stringify({ summary, links })));
}

// Receipts are public Linear comments. Text that looks like a credential is
// dropped rather than trimmed, so a partial secret can never be published.
export function reviewFindingsFromCallback(callback) {
  if (!callback || callback.stage !== "BLOCKED") return null;
  const links = Array.isArray(callback.links)
    ? callback.links.filter((link) => typeof link === "string" && link.length > 0 && link.length <= REVIEW_FINDINGS_LINK_LENGTH_MAX && !TOKEN_SHAPE.test(link)).slice(0, REVIEW_FINDINGS_LINKS_MAX)
    : [];
  const text = typeof callback.summary === "string" ? callback.summary.trim() : "";
  let summary = text && !TOKEN_SHAPE.test(text) ? text.slice(0, REVIEW_FINDINGS_SUMMARY_MAX) : null;
  // Over budget, trailing citations go first, then the summary is shortened.
  while (links.length && renderedBytes(summary, links) > REVIEW_FINDINGS_CONTEXT_BYTES_MAX) links.pop();
  while (summary && renderedBytes(summary, links) > REVIEW_FINDINGS_CONTEXT_BYTES_MAX) summary = summary.slice(0, Math.floor(summary.length * 0.9)) || null;
  if (!summary && !links.length) return null;
  return { verdict_stage: "BLOCKED", target_sha: callback.target_sha, summary, links };
}

// Stored findings are checked for credential shapes too, so no writer other
// than reviewFindingsFromCallback can put a secret into a receipt or prompt.
export function validReviewFindings(findings) {
  return Boolean(findings) && typeof findings === "object" && !Array.isArray(findings)
    && findings.verdict_stage === "BLOCKED"
    && typeof findings.target_sha === "string" && /^[0-9a-f]{40}$/.test(findings.target_sha)
    && (findings.summary === null || (typeof findings.summary === "string" && findings.summary.length <= REVIEW_FINDINGS_SUMMARY_MAX))
    && Array.isArray(findings.links) && findings.links.length <= REVIEW_FINDINGS_LINKS_MAX
    && findings.links.every((link) => typeof link === "string" && link.length <= REVIEW_FINDINGS_LINK_LENGTH_MAX && !TOKEN_SHAPE.test(link))
    && !(findings.summary && TOKEN_SHAPE.test(findings.summary))
    && renderedBytes(findings.summary, findings.links) <= REVIEW_FINDINGS_CONTEXT_BYTES_MAX;
}

export function reviewFindingsContext(receipt) {
  if (receipt?.scope_phase !== "revision" || !validReviewFindings(receipt.review_findings)) return "";
  const { target_sha, summary, links } = receipt.review_findings;
  return `\nReview findings (the independent reviewer BLOCKED ${target_sha}; address them): ${JSON.stringify({ summary, links })}`;
}
