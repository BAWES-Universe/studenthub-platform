// Test-side mirror of the batched board read.
//
// The coordinator reads every non-canceled card's comment thread INSIDE the
// paginated CoordinatorIssues query (one request per issues page) instead of
// one request per card. A Linear double must therefore answer that query with
// each node's thread attached, or the tick reports the card as unreadable and
// fails closed — which is exactly what a real Linear that omitted the field
// would mean.
//
// These doubles serve a complete thread in the first page (hasNextPage: false),
// so no continuation request is expected. A double that wants to exercise the
// continuation path builds the page itself.
export function batchedCommentPage(comments = []) {
  return { nodes: [...comments], pageInfo: { hasNextPage: false, endCursor: null } };
}

export function withBatchedComments(nodes, commentsFor) {
  return nodes.map((node) => ({
    ...node,
    comments: batchedCommentPage(typeof commentsFor === "function" ? commentsFor(node) ?? [] : commentsFor),
  }));
}
