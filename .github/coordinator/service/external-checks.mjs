// An outside service never slows a card unless the committed config names it
// (design rule, 2026-10-18). A card lands on its own two reviewers, the
// builder and a reviewer of another model family, and on this repository's own
// CI. Everything else that reports on a pull request (a review bot, a
// rate-limited service, a third-party status) is advisory: it is reported, and
// never waited on, unless config.external_checks.required names it.
//
// What holds a landing:
//   - every GitHub Actions check run (this repository's own CI);
//   - a check run whose app, or a commit status whose context, is named;
//   - an unresolved review thread opened by a person, or by a named bot.
// A named service is waited on only as long as the landing waits for CI
// (LAND_LIMITS.waitMs), so even a required one has a timeout.

// GitHub Actions, by slug and by its fixed app id.
export const OWN_CHECK_APP = Object.freeze({ slug: "github-actions", id: 15368 });
const NAME_RE = /^[a-z0-9][a-z0-9-]{0,38}$/;

// The committed policy. A missing key names nothing; a malformed one is a
// refusal, never a guess.
export function externalPolicy(config) {
  const value = config?.external_checks;
  if (value === undefined) return { required: new Set() };
  const required = value?.required;
  if (!value || typeof value !== "object" || Object.keys(value).some((key) => key !== "required") || !Array.isArray(required)
      || required.some((name) => typeof name !== "string" || !NAME_RE.test(name)) || new Set(required).size !== required.length) {
    return null;
  }
  return { required: new Set(required) };
}

const named = (policy, name) => typeof name === "string" && policy.required.has(name.toLowerCase());

export function holdsRun(run, policy) {
  const app = run?.app;
  return app?.id === OWN_CHECK_APP.id || app?.slug === OWN_CHECK_APP.slug || named(policy, app?.slug) || named(policy, run?.name);
}

export function holdsStatus(status, policy) {
  return named(policy, status?.context);
}

// A thread belongs to whoever opened it: replies, ours included, never change
// whether it holds. A person's thread always holds.
export function holdsThread(thread, policy) {
  const author = thread?.comments?.nodes?.[0]?.author;
  if (author?.__typename !== "Bot") return true;
  return named(policy, author.login);
}

// Names an outside service chose, cut to plain characters for the report.
const plain = (value) => String(value ?? "").replace(/[^A-Za-z0-9 ._-]/g, "").slice(0, 40) || "unnamed";

// A one-line note of what was advisory and not green, for the run report.
export function advisoryNote({ runs = [], statuses = [], threads = [] }) {
  const parts = [
    ...runs.map((run) => `${plain(run?.app?.slug)} ${plain(run?.name)}: ${plain(run?.conclusion ?? run?.status)}`),
    ...statuses.map((status) => `${plain(status?.context)}: ${plain(status?.state)}`),
    ...(threads.length ? [`${threads.length} unresolved advisory review thread(s)`] : []),
  ];
  return parts.length ? `advisory, not waited on: ${parts.join(", ")}` : null;
}
