import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bindClaimingPullRequests,
  computeEligibility,
  fetchLinearIssues,
  isLinearRateLimited,
  LINEAR_ISSUE_COMMENT_PAGE,
  LINEAR_ISSUE_PAGE,
  LINEAR_ISSUES_QUERY,
  LINEAR_RATE_LIMIT_FALLBACK_SECONDS,
  linearRateLimitSeconds,
  main,
  normalizeLinearIssue,
  pullRequestClaimsIssue,
  resolveRepositoryOwnership,
} from "../reconcile.mjs";

function issue(number) {
  return {
    id: `uuid-${number}`,
    identifier: `SHU-${number}`,
    title: `Issue ${number}`,
    state: { name: "Todo" },
    priorityLabel: "High",
    labels: { nodes: [] },
    assignee: null,
    delegate: null,
    parent: null,
    relations: { nodes: [] },
  };
}

function response(data) {
  return { ok: true, status: 200, json: async () => ({ data }) };
}

test("SHU-63: the live Linear query uses the supported team filter and requests pagination", () => {
  assert.match(LINEAR_ISSUES_QUERY, /issues\(filter: \{ team: \{ key: \{ eq: \$team \} \}/);
  assert.match(LINEAR_ISSUES_QUERY, new RegExp(`first: ${LINEAR_ISSUE_PAGE}, after: \\$after`));
  // The board read nests a comment connection, and Linear multiplies a connection's
  // children by its page size against a 10,000-point ceiling for a single query.
  // Pinned: the batched query stays cheaper than the unbatched issues(first: 100).
  assert.equal(LINEAR_ISSUE_PAGE, 50);
  assert.equal(LINEAR_ISSUE_COMMENT_PAGE, 50);
  assert.ok(LINEAR_ISSUE_PAGE * LINEAR_ISSUE_COMMENT_PAGE <= 100 * 50, "a board read that Linear refuses reads nothing at all");
  assert.match(LINEAR_ISSUES_QUERY, /pageInfo \{ hasNextPage endCursor \}/);
});

test("SHU-63: fetchLinearIssues follows every Linear page and preserves order", async () => {
  const requests = [];
  const pages = [
    { nodes: Array.from({ length: 100 }, (_, index) => issue(index + 1)), pageInfo: { hasNextPage: true, endCursor: "page-2" } },
    { nodes: [issue(101)], pageInfo: { hasNextPage: false, endCursor: null } },
  ];
  const fetchImpl = async (_url, init) => {
    requests.push(JSON.parse(init.body));
    return response({ issues: pages[requests.length - 1] });
  };

  const issues = await fetchLinearIssues({ token: "test-token", repo: "owner/repo", team: "SHU", fetchImpl });

  assert.equal(issues.length, 101);
  assert.equal(issues[0].id, "SHU-1");
  assert.equal(issues.at(-1).id, "SHU-101");
  assert.deepEqual(requests.map((request) => request.variables), [
    { team: "SHU", after: null },
    { team: "SHU", after: "page-2" },
  ]);
});

test("SHU-63: a claimed next page without a usable cursor fails closed", async () => {
  const fetchImpl = async () => response({
    issues: { nodes: [issue(1)], pageInfo: { hasNextPage: true, endCursor: null } },
  });

  await assert.rejects(
    fetchLinearIssues({ token: "test-token", repo: "owner/repo", fetchImpl }),
    (error) => error?.code === "LINEAR_PAGINATION_INVALID",
  );
});

test("SHU-63: a repeated pagination cursor fails closed instead of looping", async () => {
  let calls = 0;
  const fetchImpl = async () => {
    calls += 1;
    return response({
      issues: { nodes: [issue(calls)], pageInfo: { hasNextPage: true, endCursor: "same-cursor" } },
    });
  };

  await assert.rejects(
    fetchLinearIssues({ token: "test-token", repo: "owner/repo", fetchImpl }),
    (error) => error?.code === "LINEAR_PAGINATION_INVALID",
  );
  assert.equal(calls, 2);
});

test("SHU-222 mutation guard: repository ownership comes from repo labels, not query scope", () => {
  assert.deepEqual(resolveRepositoryOwnership(["repo:platform"]), {
    repo: "BAWES-Universe/studenthub-platform",
    error: null,
  });
  assert.deepEqual(resolveRepositoryOwnership(["repo:legacy"]), {
    repo: "BAWES-Universe/studenthub",
    error: null,
  });
  assert.match(resolveRepositoryOwnership([]).error, /missing/);
  assert.match(resolveRepositoryOwnership(["repo:platform", "repo:infrastructure"]).error, /multiple/);
  assert.match(resolveRepositoryOwnership(["repo:unknown"]).error, /unknown/);

  const legacy = issue(200);
  legacy.labels.nodes = [{ name: "repo:legacy" }];
  const normalized = normalizeLinearIssue(legacy, "BAWES-Universe/studenthub-platform");
  assert.equal(normalized.repo, "BAWES-Universe/studenthub");
  const eligibility = computeEligibility({
    issues: [normalized],
    openPRs: [],
    config: { pilot_repo: "BAWES-Universe/studenthub-platform" },
  });
  assert.deepEqual(eligibility.ready, []);
  assert.match(eligibility.excluded[0].reason, /outside pilot repo/);
});

test("SHU-222 mutation guard: inaccessible and canceled blockers survive normalization and HOLD", () => {
  for (const state of [null, "Canceled"]) {
    const node = issue(state === null ? 201 : 202);
    node.labels.nodes = [{ name: "repo:platform" }];
    node.relations.nodes = [{
      type: "blockedBy",
      relatedIssue: { identifier: "SHU-9", state: state === null ? null : { name: state } },
    }];
    const normalized = normalizeLinearIssue(node, "BAWES-Universe/studenthub-platform");
    assert.deepEqual(normalized.blockers, [{ id: "SHU-9", state }]);
    const { ready, excluded } = computeEligibility({
      issues: [normalized],
      openPRs: [],
      config: { pilot_repo: "BAWES-Universe/studenthub-platform" },
    });
    assert.deepEqual(ready, []);
    assert.match(excluded[0].reason, /blocked by SHU-9/);
  }
});

test("SHU-222/reference-is-not-claim: bare references stay ready; explicit claims do not", () => {
  const issues = [201, 202, 203].map((number) => ({
    id: `SHU-${number}`,
    title: `Issue ${number}`,
    state: "Todo",
    priority: "High",
    labels: [],
    assignee: null,
    delegate: null,
    linkedPRs: [],
    parent: null,
    blockers: [],
    repo: "BAWES-Universe/studenthub-platform",
    repoResolutionError: null,
  }));
  const openPRs = [
    {
      number: 77,
      title: "feat: implement SHU-201",
      body: "This depends on SHU-202 and discusses it as context.",
      head: { ref: "feat/shu-201" },
    },
    {
      number: 78,
      title: "maintenance",
      body: "Fixes SHU-203",
      head: { ref: "maintenance" },
    },
  ];
  assert.equal(pullRequestClaimsIssue(openPRs[0], "SHU-201"), true);
  assert.equal(pullRequestClaimsIssue(openPRs[0], "SHU-202"), false);
  assert.equal(pullRequestClaimsIssue(openPRs[1], "SHU-203"), true);
  bindClaimingPullRequests(issues, openPRs);
  const { ready, excluded } = computeEligibility({
    issues,
    openPRs,
    config: { pilot_repo: "BAWES-Universe/studenthub-platform" },
  });
  assert.deepEqual(ready.map((card) => card.id), ["SHU-202"]);
  assert.deepEqual(excluded.map((card) => card.id), ["SHU-201", "SHU-203"]);
});

test("SHU-222: a 200 OK non-array GitHub PR response produces claim evidence HOLD", async () => {
  const candidate = issue(204);
  candidate.labels.nodes = [{ name: "repo:platform" }];
  const output = [];

  const code = await main([], {
    LINEAR_API_TOKEN: "linear-token",
    GITHUB_TOKEN: "github-token",
  }, {
    fetchDurable: false,
    stdout: (line) => output.push(line),
    fetchImpl: async (url) => {
      if (url === "https://api.linear.app/graphql") {
        return response({
          issues: {
            nodes: [candidate],
            pageInfo: { hasNextPage: false, endCursor: null },
          },
        });
      }
      if (url.includes("api.github.com/repos/")) {
        return { ok: true, status: 200, json: async () => ({ message: "API rate limit exceeded" }) };
      }
      throw new Error(`unexpected request: ${url}`);
    },
  });

  assert.equal(code, 0);
  assert.match(output.join("\n"), /SHU-204\s+claim evidence HOLD — GitHub open PR response was not an array/);
});

// ---------------------------------------------------------------------------
// Batched board read (one request per issues page carries every card's thread)
// and the rate-limit HOLD. Before this, the tick spent one Linear request PER
// non-canceled card PER 60-second tick, exhausted the workspace's 2500/hour
// budget, and then could not read the board at all.
// ---------------------------------------------------------------------------

const PAUSE_COMMENT = { body: "coordinator-pause: codex-cli", createdAt: "2026-09-20T00:00:00.000Z", user: { id: "u1" } };

function card(number) {
  const node = issue(number);
  node.labels.nodes = [{ name: "repo:platform" }];
  return node;
}

function commentPage(nodes, { hasNextPage = false, endCursor = null } = {}) {
  return { nodes, pageInfo: { hasNextPage, endCursor } };
}

// runTick — main() over a live-Linear board, counting every Linear request the
// tick actually spends. GitHub claims are injected, so the count is Linear only.
async function runTick(linear) {
  const queries = [];
  const out = [];
  const code = await main([], { LINEAR_API_TOKEN: "test-token" }, {
    openPRsOverride: [],
    stdout: (line) => out.push(line),
    fetchImpl: async (url, init) => {
      assert.equal(url, "https://api.linear.app/graphql");
      const request = JSON.parse(init.body);
      queries.push(request);
      return linear(request);
    },
  });
  const named = (name) => queries.filter((q) => q.query.includes(name));
  return { code, out, queries, named };
}

test("LINEAR BUDGET: every card's receipts arrive WITH the board read — no per-card comment request", async () => {
  const cards = [1, 2, 3].map(card);
  const { code, out, queries, named } = await runTick(({ query }) => {
    if (query.includes("CoordinatorIssues")) {
      return response({
        issues: {
          // Only the middle card carries a durable marker: the report can only
          // show it if the BATCHED thread was really read and parsed.
          nodes: cards.map((node) => ({
            ...node,
            comments: commentPage(node.identifier === "SHU-2" ? [PAUSE_COMMENT] : []),
          })),
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
    }
    throw new Error(`unexpected Linear request: ${query.slice(0, 60)}`);
  });

  assert.equal(code, 0);
  assert.equal(queries.length, 1, "three cards must cost ONE Linear request, not one per card");
  assert.equal(named("CoordinatorIssueComments").length, 0, "the per-card comment read is gone from the tick");
  assert.equal(named("CoordinatorCommentPage").length, 0, "a short comment page needs no continuation");
  assert.match(out.join("\n"), /adapter_pause_map=\{"codex-cli":true\}/, "the batched thread is parsed, not merely fetched");
});

test("LINEAR BUDGET: a full comment page is followed to the end of the thread; a short page is not", async () => {
  const [short, long] = [card(1), card(2)];
  // The long card's thread is one full page plus a tail. The tail holds the
  // marker, so honouring it proves COMPLETENESS, not just a cheaper read.
  const firstPage = Array.from({ length: LINEAR_ISSUE_COMMENT_PAGE }, (_, index) => ({
    body: `receipt filler ${index}`, createdAt: "2026-09-20T00:00:00.000Z", user: { id: "u1" },
  }));
  const { code, out, queries, named } = await runTick((request) => {
    const { query, variables } = request;
    if (query.includes("CoordinatorIssues")) {
      return response({
        issues: {
          nodes: [
            { ...short, comments: commentPage([{ body: "nothing durable", createdAt: "2026-09-20T00:00:00.000Z", user: { id: "u1" } }]) },
            { ...long, comments: commentPage(firstPage, { hasNextPage: true, endCursor: "comments-page-2" }) },
          ],
          pageInfo: { hasNextPage: false, endCursor: null },
        },
      });
    }
    if (query.includes("CoordinatorCommentPage")) {
      assert.deepEqual(variables, { issueId: long.id, after: "comments-page-2" });
      return response({ issue: { comments: commentPage([PAUSE_COMMENT]) } });
    }
    throw new Error(`unexpected Linear request: ${query.slice(0, 60)}`);
  });

  assert.equal(code, 0);
  assert.equal(queries.length, 2, "one board read plus ONE continuation");
  assert.equal(named("CoordinatorCommentPage").length, 1, "only the card whose page came back full is followed up");
  assert.equal(named("CoordinatorIssueComments").length, 0);
  assert.match(out.join("\n"), /adapter_pause_map=\{"codex-cli":true\}/, "a comment past the first page is still read");
});

test("LINEAR BUDGET: a rate-limited answer HOLDs the tick with the retry Linear stated and exits cleanly", async () => {
  // The answer the service actually received: a GraphQL error, with the reset
  // published as a header, NOT an HTTP 429 body the caller can ignore.
  const reset = Date.now() + 900_000;
  const { code, out, queries } = await runTick(() => ({
    ok: true,
    status: 200,
    headers: new Headers({ "X-RateLimit-Requests-Reset": String(reset) }),
    json: async () => ({ errors: [{ message: "Rate limit exceeded. Only 2500 requests are allowed per 1 hour." }] }),
  }));

  assert.equal(code, 0, "a spent workspace budget is a HOLD, not a failed tick");
  assert.deepEqual(out, ["HOLD=LINEAR_RATE_LIMITED retry_after=900"]);
  assert.equal(queries.length, 1, "a rate-limited tick stops reading instead of spending the rest of the budget");
});

test("LINEAR BUDGET: the reported retry is the one Linear stated, in seconds", () => {
  const withHeaders = (headers, status = 429) => ({ status, headers: new Headers(headers) });
  assert.equal(linearRateLimitSeconds(withHeaders({ "Retry-After": "42" })), 42);
  assert.equal(linearRateLimitSeconds(withHeaders({ "X-RateLimit-Requests-Reset": String(1_000_000 + 120_000) }), null, 1_000_000), 120);
  assert.equal(linearRateLimitSeconds({ status: 429 }, { errors: [{ extensions: { retryAfter: 7 } }] }), 7);
  // Nothing stated: hold for the whole budget window Linear enforces.
  assert.equal(linearRateLimitSeconds({ status: 429 }, {}), LINEAR_RATE_LIMIT_FALLBACK_SECONDS);
  assert.equal(LINEAR_RATE_LIMIT_FALLBACK_SECONDS, 3600);
  // Both shapes of the same condition are recognised.
  assert.equal(isLinearRateLimited({ status: 429 }, null), true);
  assert.equal(isLinearRateLimited({ status: 200 }, { errors: [{ extensions: { code: "RATELIMITED" } }] }), true);
  assert.equal(isLinearRateLimited({ status: 200 }, { errors: [{ message: "Entity not found" }] }), false);
});
