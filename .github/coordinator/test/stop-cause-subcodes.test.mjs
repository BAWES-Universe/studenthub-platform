// A filed stop card names its cause (a closed subcode read from the latest
// attempt's receipt), carries one route label saying who acts, and is marked
// looping on the third same-cause stop of the same card contract.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createReceipt } from "../reconcile.mjs";
import {
  cardContractKey,
  deriveIncidentEvent,
  INCIDENT_LABEL_NAME,
  INCIDENT_REASON,
  incidentIdentity,
  incidentTitle,
  incidentTitleMatches,
  LINEAR_INCIDENT_PRIOR_STOPS_QUERY,
  renderIncidentDescription,
  reportCoordinatorIncident,
  STOP_CAUSE,
  STOP_LOOPING_LABEL,
  STOP_ROUTE_LABEL,
  stopCauseFromReceipt,
  stopRouteLabel,
} from "../incident-reporting.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const COORDINATOR = path.join(HERE, "..");
const CARD = "SHU-197"; // a committed build card
const DESK = "SHU-304"; // the review desk: a review-only card
const NOW = new Date("2026-11-07T12:00:00.000Z");
const REVISION = "d".repeat(40);
const HEAD_A = "a".repeat(40);
const HEAD_B = "b".repeat(40);
const TARGET_LINEAR_ID = "11111111-1111-4111-8111-111111111111";
const HOLD = { ended: true, reason: "the episode ended HOLD without a coherent verdict" };

const attemptId = (n) => `${String(n).padStart(8, "0")}-0000-4000-8000-${String(n).padStart(12, "0")}`;

function heldReceipt({ issue = CARD, activationId = "stopcause0001", n = 1, notes = [], target = HEAD_A, worker = "codex-builder", at = NOW.toISOString() } = {}) {
  const made = createReceipt({
    issue_id: issue,
    authorization_ref: issue,
    requested_worker: worker,
    repo: "BAWES-Universe/studenthub-platform",
    branch: `coordinator/${issue}`,
    target_sha: target,
    attempt_id: attemptId(n),
    episode_id: activationId,
    reserved_at: at,
  });
  assert.equal(made.ok, true, made.errors?.join("; "));
  return {
    ...made.receipt,
    stage: "HOLD",
    worker_identity: `${worker}:session-${n}`,
    external_run_id: `run_${n}`,
    adapter_status: "completed",
    timestamps: { reserved: at, launch: at, heartbeat: null, terminal: at },
    last_activity: at,
    notes,
  };
}

function holdEvent({ issue = CARD, activationId = "stopcause0001", notes = [], target = HEAD_A, decision = HOLD, worker } = {}) {
  const event = deriveIncidentEvent({
    activation: { requested: true, state: "armed", valid: true, activation_id: activationId, target_issue_id: issue, coordinator_revision: REVISION },
    receipts: [heldReceipt({ issue, activationId, notes, target, worker })],
    config: {},
    episodeDecision: decision,
  });
  assert.ok(event, "a HOLD stop derives an incident event");
  return event;
}

const adapterNote = (code) => [`held: run ended`, `adapter reason code: ${code}`];

// A fake Linear: the team's labels, the target card's related incident cards
// (prior stops) and whatever the reporter files.
function fakeLinear({ labels = Object.values(STOP_ROUTE_LABEL).concat(STOP_LOOPING_LABEL), priors = [], priorsFail = false } = {}) {
  const teamLabels = [INCIDENT_LABEL_NAME, ...labels].map((name, index) => ({ id: `label-${index}-${name}`, name }));
  const issues = new Map();
  const relations = [];
  const creates = [];
  const queries = [];
  const sendLinear = async (query, variables) => {
    queries.push(query);
    if (query.includes("CoordinatorIncidentComments")) return { issue: { comments: { nodes: [] } } };
    if (query.includes("CoordinatorIncidentPriorStops")) {
      if (priorsFail) throw new Error("prior stops unreadable");
      return { issue: {
        relations: { nodes: [] },
        inverseRelations: { nodes: priors.map((description, index) => ({ type: "related", issue: { id: `prior-${index}`, description } })) },
      } };
    }
    if (query.includes("CoordinatorIncidentLookup")) {
      const issue = issues.get(variables.issueId) ?? null;
      if (!issue) return { issue: null };
      const related = relations.filter((relation) => relation.issueId === issue.id)
        .map(() => ({ type: "related", relatedIssue: { id: TARGET_LINEAR_ID, identifier: issue.target } }));
      return { issue: { ...issue, relations: { nodes: related } } };
    }
    if (query.includes("CoordinatorIncidentMetadata")) {
      const wanted = new Set(variables.labelNames);
      return { teams: { nodes: [{
        id: "team-shu", key: "SHU",
        states: { nodes: [{ id: "state-backlog", name: "Backlog", type: "backlog" }, { id: "state-done", name: "Done", type: "completed" }].filter((state) => state.name === variables.stateName) },
        labels: { nodes: teamLabels.filter((label) => wanted.has(label.name)) },
      }] } };
    }
    if (query.includes("CoordinatorIncidentCreate")) {
      const input = variables.input;
      creates.push(input);
      issues.set(input.id, {
        id: input.id, identifier: "SHU-999", title: input.title, description: input.description,
        team: { id: input.teamId, key: "SHU" }, state: { name: input.stateId === "state-done" ? "Done" : "Backlog" },
        labels: { nodes: teamLabels.filter((label) => input.labelIds.includes(label.id)) },
        assignee: Object.hasOwn(input, "assigneeId") && input.assigneeId !== null ? { id: input.assigneeId } : null,
        target: input.description.match(/\[(SHU-[0-9]+)\]/)[1],
      });
      return { issueCreate: { success: true, issue: { id: input.id, identifier: "SHU-999" } } };
    }
    if (query.includes("CoordinatorIncidentRelate")) {
      relations.push(variables.input);
      return { issueRelationCreate: { success: true, issueRelation: { id: variables.input.id } } };
    }
    if (query.includes("commentCreate")) return { commentCreate: { success: true } };
    throw new Error(`unexpected query ${query.slice(0, 60)}`);
  };
  const labelNames = (input) => teamLabels.filter((label) => input.labelIds.includes(label.id)).map((label) => label.name);
  return { sendLinear, creates, queries, labelNames };
}

async function file(event, linear) {
  return reportCoordinatorIncident({
    event,
    authorized: true,
    targetLinearId: TARGET_LINEAR_ID,
    config: {},
    token: "tok",
    sendLinear: linear.sendLinear,
    commentMutation: "mutation CoordinatorComment($issueId: String!, $body: String!) { commentCreate(input: { issueId: $issueId, body: $body }) { success } }",
    now: NOW,
    timeoutMs: 200,
  });
}

// The description an earlier stop of the same card filed, rendered by the
// same code, so the prior-stop reader is checked against the real format.
function priorDescription({ issue = CARD, activationId, code = "RESULT_SCOPE_REFUSED", target = HEAD_A, contract = null }) {
  const event = holdEvent({ issue, activationId, notes: adapterNote(code), target });
  const description = renderIncidentDescription(event, {});
  return contract ? description.replace(/^- Card contract: `[^`]+`$/m, `- Card contract: \`${contract}\``) : description;
}

const MAPPING = [
  ["RESULT_SCOPE_REFUSED", STOP_CAUSE.RESULT_SCOPE_REFUSED, STOP_ROUTE_LABEL.CARD_FIX],
  ["REVIEW_EXECUTION_UNAVAILABLE", STOP_CAUSE.REVIEW_EXECUTION_UNAVAILABLE, STOP_ROUTE_LABEL.BOX_RETRY],
  ["SUPERVISOR_WORKER_EXIT", STOP_CAUSE.SUPERVISOR_WORKER_EXIT, STOP_ROUTE_LABEL.BOX_RETRY],
  ["FILESYSTEM_OR_AUTH_DENIED", STOP_CAUSE.FILESYSTEM_OR_AUTH_DENIED, STOP_ROUTE_LABEL.NEEDS_PERSON],
  ["CLAUDE_1", STOP_CAUSE.CLAUDE_1, STOP_ROUTE_LABEL.NEEDS_PERSON],
];

test("stop cause S1: each adapter reason code on the HOLD receipt maps to its subcode, title and route label", async () => {
  for (const [code, cause, label] of MAPPING) {
    const event = holdEvent({ notes: adapterNote(code) });
    assert.equal(event.cause, cause, code);
    assert.equal(event.route_label, label, `${code} routes to ${label}`);
    assert.equal(incidentTitle(event), `coordinator stop: ${CARD} — ambiguous_hold (${cause})`);
    assert.match(renderIncidentDescription(event, {}), new RegExp(`^- Cause: \`${cause}\`$`, "m"));
    const linear = fakeLinear();
    const result = await file(event, linear);
    assert.equal(result.status, "confirmed", code);
    assert.equal(linear.creates.length, 1);
    assert.equal(linear.creates[0].title, `coordinator stop: ${CARD} — ambiguous_hold (${cause})`);
    assert.deepEqual(linear.labelNames(linear.creates[0]).sort(), [INCIDENT_LABEL_NAME, label].sort(), `${code}: repo:platform and exactly one route label`);
    assert.equal(linear.creates[0].assigneeId, null, "a stop card never has an assignee");
  }
});

test("stop cause S2: the coordinator's own fixed HOLD notes name provenance and an unapplied verdict", () => {
  const provenance = holdEvent({ notes: ["run completed but review provenance is not closable — HOLD (reviewed lineage carries no readable provenance — authorship ambiguous)"] });
  assert.equal(provenance.cause, STOP_CAUSE.PROVENANCE_UNREADABLE);
  assert.equal(provenance.route_label, STOP_ROUTE_LABEL.NEEDS_PERSON);
  const unapplied = holdEvent({ notes: ["held: review finished on the supervisor (COMPLETED) after its pull request moved or its review activation ended; verdict not applied"] });
  assert.equal(unapplied.cause, STOP_CAUSE.VERDICT_NOT_APPLIED);
  assert.equal(unapplied.route_label, STOP_ROUTE_LABEL.NEEDS_PERSON);
  // Only the latest attempt decides: an older attempt's code never relabels a later stop.
  const older = heldReceipt({ n: 1, notes: adapterNote("RESULT_SCOPE_REFUSED"), at: "2026-11-07T10:00:00.000Z" });
  const latest = heldReceipt({ n: 2, notes: adapterNote("SUPERVISOR_WORKER_EXIT"), at: "2026-11-07T11:00:00.000Z" });
  const event = deriveIncidentEvent({
    activation: { requested: true, state: "armed", valid: true, activation_id: "stopcause0001", target_issue_id: CARD, coordinator_revision: REVISION },
    receipts: [latest, older], config: {}, episodeDecision: HOLD,
  });
  assert.equal(event.cause, STOP_CAUSE.SUPERVISOR_WORKER_EXIT);
});

test("stop cause S3: non-HOLD stops route by their reason code", () => {
  const table = {
    [INCIDENT_REASON.REVISION_EXHAUSTED]: STOP_ROUTE_LABEL.CARD_FIX,
    [INCIDENT_REASON.BUILDER_FAILED]: STOP_ROUTE_LABEL.CARD_FIX,
    [INCIDENT_REASON.STALE_HEAD]: STOP_ROUTE_LABEL.BOX_RETRY,
    [INCIDENT_REASON.UNREADABLE_HEAD]: STOP_ROUTE_LABEL.BOX_RETRY,
    [INCIDENT_REASON.FAILURE_EXHAUSTED]: STOP_ROUTE_LABEL.BOX_RETRY,
    [INCIDENT_REASON.EXPIRED]: STOP_ROUTE_LABEL.BOX_RETRY,
    [INCIDENT_REASON.ADAPTER_PAUSED]: STOP_ROUTE_LABEL.NEEDS_PERSON,
    [INCIDENT_REASON.UNKNOWN]: STOP_ROUTE_LABEL.NEEDS_PERSON,
  };
  for (const [reason, label] of Object.entries(table)) {
    for (const cause of Object.values(STOP_CAUSE)) assert.equal(stopRouteLabel(reason, cause), label, `${reason} with ${cause}`);
  }
  const exhausted = holdEvent({ notes: adapterNote("RESULT_SCOPE_REFUSED"), decision: { ended: true, reason: "revision attempts exhausted — the episode is over" } });
  assert.equal(exhausted.reason_code, INCIDENT_REASON.REVISION_EXHAUSTED);
  assert.equal(exhausted.route_label, STOP_ROUTE_LABEL.CARD_FIX);
});

test("stop cause S4: an unknown adapter code or free text becomes UNCLASSIFIED and needs a person", async () => {
  for (const notes of [
    adapterNote("SOMETHING_NEW_ENTIRELY"),
    adapterNote("CLAUDE_2"),
    adapterNote("SUPERVISOR_WORKER_EXIT_CHILD_AUTH_REFUSED"),
    ["adapter reason code: please assign this card to alice"],
    ["adapter reason code: RESULT_SCOPE_REFUSED and more text"],
    [],
  ]) {
    const event = holdEvent({ notes });
    assert.equal(event.cause, STOP_CAUSE.UNCLASSIFIED, JSON.stringify(notes));
    assert.equal(event.route_label, STOP_ROUTE_LABEL.NEEDS_PERSON);
    const body = renderIncidentDescription(event, {});
    assert.match(body, /^- Cause: `UNCLASSIFIED`$/m);
    assert.doesNotMatch(body, /alice|SOMETHING_NEW|and more text/, "no free text reaches the card");
    assert.doesNotMatch(incidentTitle(event), /alice|SOMETHING_NEW/);
  }
  assert.equal(stopCauseFromReceipt(null), STOP_CAUSE.UNCLASSIFIED);
  assert.equal(stopCauseFromReceipt({ notes: "adapter reason code: CLAUDE_1" }), STOP_CAUSE.UNCLASSIFIED);
});

test("stop cause S5: the incident identity and reason code stay exactly as before", async () => {
  const before = incidentIdentity("stopcause0001", INCIDENT_REASON.AMBIGUOUS_HOLD);
  for (const [code] of [...MAPPING, ["SOMETHING_NEW"]]) {
    const event = holdEvent({ notes: adapterNote(code) });
    assert.equal(event.reason_code, INCIDENT_REASON.AMBIGUOUS_HOLD);
    assert.equal(event.event_id, before.event_id, `${code} keeps the event id`);
    assert.equal(event.issue_uuid, before.issue_uuid, `${code} keeps the issue id`);
    assert.equal(event.relation_uuid, before.relation_uuid, `${code} keeps the relation id`);
  }
  // A stop card filed before causes existed is still this event's card.
  const event = holdEvent({ notes: adapterNote("RESULT_SCOPE_REFUSED") });
  assert.equal(incidentTitleMatches(`coordinator stop: ${CARD} — ambiguous_hold`, event), true);
  assert.equal(incidentTitleMatches(`coordinator stop: ${CARD} — ambiguous_hold (RESULT_SCOPE_REFUSED)`, event), true);
  assert.equal(incidentTitleMatches(`coordinator stop: ${CARD} — ambiguous_hold (whatever)`, event), false);
  assert.equal(incidentTitleMatches(`coordinator stop: ${CARD} — stale_head`, event), false);
});

test("stop cause S6: the third stop with the same card, cause and contract is looping; the second is not", async () => {
  const event = holdEvent({ activationId: "stopcause0003", notes: adapterNote("RESULT_SCOPE_REFUSED") });
  const first = priorDescription({ activationId: "stopcause0001" });
  const second = priorDescription({ activationId: "stopcause0002" });

  const once = fakeLinear({ priors: [first] });
  assert.equal((await file(event, once)).status, "confirmed");
  assert.deepEqual(once.labelNames(once.creates[0]).sort(), [INCIDENT_LABEL_NAME, STOP_ROUTE_LABEL.CARD_FIX].sort(), "the second stop is not looping");
  assert.ok(once.queries.some((query) => query === LINEAR_INCIDENT_PRIOR_STOPS_QUERY), "prior stops are read from the card's incident cards");

  const twice = fakeLinear({ priors: [first, second] });
  assert.equal((await file(event, twice)).status, "confirmed");
  assert.deepEqual(twice.labelNames(twice.creates[0]).sort(), [INCIDENT_LABEL_NAME, STOP_ROUTE_LABEL.CARD_FIX, STOP_LOOPING_LABEL].sort(), "the third stop is looping");
  assert.match(twice.creates[0].description, /^- Looping: stop 3 /m);

  // Prior stops that differ in cause, contract or card, or are this same
  // activation, never count toward a loop.
  for (const [label, other] of [
    ["another cause", priorDescription({ activationId: "stopcause0002", code: "SUPERVISOR_WORKER_EXIT" })],
    ["another card contract", priorDescription({ activationId: "stopcause0002", contract: `card:${"e".repeat(16)}` })],
    ["another card", priorDescription({ issue: "SHU-294", activationId: "stopcause0002" })],
    ["the same activation", priorDescription({ activationId: "stopcause0003" })],
    ["the same activation twice", first],
  ]) {
    const linear = fakeLinear({ priors: [first, other] });
    assert.equal((await file(event, linear)).status, "confirmed", label);
    assert.ok(!linear.labelNames(linear.creates[0]).includes(STOP_LOOPING_LABEL), `${label} is not a loop`);
  }
});

test("stop cause S7: review desk stops on different reviewed heads are not a loop", async () => {
  const event = holdEvent({ issue: DESK, activationId: "deskstop0003", worker: "claude-verifier", notes: adapterNote("REVIEW_EXECUTION_UNAVAILABLE"), target: HEAD_A });
  assert.equal(event.reviewed_head, HEAD_A);
  assert.match(renderIncidentDescription(event, {}), new RegExp(`^- Reviewed head: \`${HEAD_A}\`$`, "m"));
  const prior = (activationId, target) => renderIncidentDescription(holdEvent({ issue: DESK, activationId, worker: "claude-verifier", notes: adapterNote("REVIEW_EXECUTION_UNAVAILABLE"), target }), {});

  const differentHeads = fakeLinear({ priors: [prior("deskstop0001", HEAD_B), prior("deskstop0002", HEAD_B)] });
  await file(event, differentHeads);
  assert.ok(!differentHeads.labelNames(differentHeads.creates[0]).includes(STOP_LOOPING_LABEL), "stops on other PR heads are not a loop");

  const sameHead = fakeLinear({ priors: [prior("deskstop0001", HEAD_A), prior("deskstop0002", HEAD_A)] });
  await file(event, sameHead);
  assert.ok(sameHead.labelNames(sameHead.creates[0]).includes(STOP_LOOPING_LABEL), "three stops on one PR head are a loop");

  // A build card is not keyed by head: its stops on different heads still loop.
  const build = holdEvent({ activationId: "stopcause0003", notes: adapterNote("RESULT_SCOPE_REFUSED"), target: HEAD_A });
  assert.equal(build.reviewed_head, null);
  const buildLinear = fakeLinear({ priors: [priorDescription({ activationId: "stopcause0001", target: HEAD_B }), priorDescription({ activationId: "stopcause0002", target: HEAD_B })] });
  await file(build, buildLinear);
  assert.ok(buildLinear.labelNames(buildLinear.creates[0]).includes(STOP_LOOPING_LABEL));
});

test("stop cause S8: a missing route or looping label still files and names only the missing label", async () => {
  const event = holdEvent({ activationId: "stopcause0003", notes: adapterNote("RESULT_SCOPE_REFUSED") });
  const priors = [priorDescription({ activationId: "stopcause0001" }), priorDescription({ activationId: "stopcause0002" })];
  const linear = fakeLinear({ labels: [], priors });
  const result = await file(event, linear);
  assert.equal(result.status, "confirmed", "a missing label never blocks filing");
  assert.deepEqual(linear.labelNames(linear.creates[0]), [INCIDENT_LABEL_NAME]);
  assert.equal(linear.creates[0].labelIds.length, 1);
  assert.match(linear.creates[0].description, /`stop:card-fix`/);
  assert.match(linear.creates[0].description, /`stop:looping`/);
  assert.match(linear.creates[0].description, /could not be found in Linear/);
  assert.equal(linear.creates[0].assigneeId, null);

  // Only the looping label missing: the route label still applies, and the note names only what is missing.
  const partial = fakeLinear({ labels: Object.values(STOP_ROUTE_LABEL), priors });
  assert.equal((await file(event, partial)).status, "confirmed");
  assert.deepEqual(partial.labelNames(partial.creates[0]).sort(), [INCIDENT_LABEL_NAME, "stop:card-fix"].sort());
  assert.match(partial.creates[0].description, /The label `stop:looping` could not be found in Linear, so this card is filed without it\./);
  assert.doesNotMatch(partial.creates[0].description, /`stop:card-fix` could not be found/);

  // An unreadable prior-stop read also never blocks filing; it only skips the loop check.
  const unreadable = fakeLinear({ priorsFail: true });
  assert.equal((await file(event, unreadable)).status, "confirmed");
  assert.ok(!unreadable.labelNames(unreadable.creates[0]).includes(STOP_LOOPING_LABEL));
});

test("stop cause S9: the card contract key follows the card's committed contract", () => {
  assert.match(cardContractKey(CARD, REVISION), /^card:[0-9a-f]{16}$/);
  assert.notEqual(cardContractKey(CARD, REVISION), cardContractKey("SHU-294", REVISION));
  assert.equal(cardContractKey(CARD, REVISION), cardContractKey(CARD, "f".repeat(40)), "an unrelated coordinator revision is the same card contract");
  assert.equal(cardContractKey("SHU-140", REVISION), `revision:${REVISION}`, "a card with no committed contract is keyed by the armed revision");
  assert.equal(cardContractKey("SHU-140", "not-a-sha"), null);
});

const MUTATIONS = [
  {
    name: "remove the adapter code mapping",
    from: "    if (match) return ADAPTER_REASON_CAUSES[match[1]] ?? STOP_CAUSE.UNCLASSIFIED;",
    to: "    if (match) return STOP_CAUSE.UNCLASSIFIED; // MUTANT",
    named: /stop cause S1/,
  },
  {
    name: "route every HOLD to needs-person",
    from: "  if (reasonCode === INCIDENT_REASON.AMBIGUOUS_HOLD) return CAUSE_ROUTE[cause] ?? STOP_ROUTE_LABEL.NEEDS_PERSON;",
    to: "  if (reasonCode === INCIDENT_REASON.AMBIGUOUS_HOLD) return STOP_ROUTE_LABEL.NEEDS_PERSON; // MUTANT",
    named: /stop cause S1/,
  },
  {
    name: "remove the looping check",
    from: "  return priorStopCount(event, descriptions) + 1 >= STOP_LOOPING_THRESHOLD;",
    to: "  return false; // MUTANT",
    named: /stop cause S6/,
  },
  {
    name: "loop at the second stop",
    from: "export const STOP_LOOPING_THRESHOLD = 3;",
    to: "export const STOP_LOOPING_THRESHOLD = 2; // MUTANT",
    named: /stop cause S6/,
  },
  {
    name: "ignore the reviewed head",
    from: "    if (reviewed && prior.reviewed_head !== event.reviewed_head) continue;",
    to: "    // MUTANT",
    named: /stop cause S7/,
  },
  {
    name: "refuse to file when a route label is missing",
    from: "  const missingLabels = wantedLabels.filter((name) => !labelNamed(name));",
    to: "  const missingLabels = wantedLabels.filter((name) => !labelNamed(name)); if (missingLabels.length) throw new Error('MUTANT');",
    named: /stop cause S8/,
  },
];

for (const mutation of MUTATIONS) {
  test(`stop cause mutation: ${mutation.name}`, () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "stop-cause-mutation-"));
    try {
      fs.cpSync(COORDINATOR, root, { recursive: true });
      const target = path.join(root, "incident-reporting.mjs");
      const source = fs.readFileSync(target, "utf8");
      assert.equal(source.split(mutation.from).length, 2, `${mutation.name}: the mutation anchor must be unique`);
      fs.writeFileSync(target, source.replace(mutation.from, mutation.to));
      const env = { ...process.env };
      delete env.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, [
        "--test", "--test-name-pattern=^stop cause S",
        path.join(root, "test", path.basename(fileURLToPath(import.meta.url))),
      ], { cwd: root, env, encoding: "utf8", timeout: 60_000 });
      const output = run.stdout + run.stderr;
      assert.equal(run.signal, null, `${mutation.name}: a timeout or crash is not a kill`);
      assert.equal(run.status, 1, `${mutation.name}: the mutant survived\n${output}`);
      assert.match(output, /AssertionError/, `${mutation.name}: must fail by assertion`);
      assert.match(output, new RegExp(`not ok \\d+ - ${mutation.named.source}`), `${mutation.name}: must fail its named test`);
      assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${mutation.name}: infrastructure crashes do not count`);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
}
