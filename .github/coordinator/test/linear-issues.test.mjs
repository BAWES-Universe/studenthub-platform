import { test } from "node:test";
import assert from "node:assert/strict";

import {
  bindClaimingPullRequests,
  computeEligibility,
  fetchLinearIssues,
  LINEAR_ISSUES_QUERY,
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
  assert.match(LINEAR_ISSUES_QUERY, /first: 100, after: \$after/);
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
