import { test } from "node:test";
import assert from "node:assert/strict";

import { fetchLinearIssues, LINEAR_ISSUES_QUERY } from "../reconcile.mjs";

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
