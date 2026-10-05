import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createSyntheticLoginRig } from "@studenthub/login-contract";
import { createGatewayServer, createLoginApplication } from "../../../apps/gateway/src/index.js";

import { InMemoryAuthzStore, createPrincipal } from "@studenthub/contracts";
import {
  InMemoryApprovedProfileAdapter,
  UnconfiguredApprovedProfileAdapter,
  OWN_PROFILE_FIELD_CONTRACT,
  OWN_PROFILE_FIELD_NAMES,
  PROFILE_PARITY_REVISION,
  SYNTHETIC_PROFILE_FIXTURES,
} from "../src/index.js";
import * as builtInProfile from "../src/profile.js";

const implementation = process.env.SHU92_TEST_MODULE
  ? await import(process.env.SHU92_TEST_MODULE) as typeof builtInProfile
  : builtInProfile;
const { OwnProfileRepository, projectApprovedProfile } = implementation;

const PEOPLE = Object.freeze([
  createPrincipal({ id: "person-populated", pbuuids: ["pbuuid-populated"], displayName: "Registry must not win", email: "registry@example.invalid" }),
  createPrincipal({ id: "person-partial", pbuuids: ["pbuuid-partial"] }),
  createPrincipal({ id: "person-unavailable", pbuuids: ["pbuuid-unavailable"] }),
  createPrincipal({ id: "person-other", pbuuids: ["pbuuid-other"] }),
]);

function repository(input: {
  readonly links?: readonly { readonly principalId: string; readonly candidateRef: string }[];
  readonly rows?: ReadonlyMap<string, unknown>;
} = {}) {
  const principals = new InMemoryAuthzStore({ principals: PEOPLE });
  const source = new InMemoryApprovedProfileAdapter({
    links: input.links ?? [
      { principalId: "person-populated", candidateRef: "candidate-populated" },
      { principalId: "person-partial", candidateRef: "candidate-partial" },
      { principalId: "person-unavailable", candidateRef: "candidate-unavailable" },
    ],
    rows: input.rows ?? new Map([
      ["candidate-populated", SYNTHETIC_PROFILE_FIXTURES.populated],
      ["candidate-partial", SYNTHETIC_PROFILE_FIXTURES.partial],
      ["candidate-unavailable", SYNTHETIC_PROFILE_FIXTURES.unavailable],
    ]),
  });
  return new OwnProfileRepository({ principals, source, today: () => "2026-09-13" });
}

test("PROFILE-WHITELIST closed DTO excludes every sensitive and staff-only sentinel", () => {
  const projection = projectApprovedProfile(SYNTHETIC_PROFILE_FIXTURES.populated, "2026-09-13");
  assert.equal(projection.asOfDate, "2026-09-13");
  assert.deepEqual(Object.keys(projection.fields), [
    "displayName", "arabicName", "gender", "birthDate", "age", "nationality", "university",
    "objective", "intro", "preferredTime", "language", "area", "drivingLicence",
    "jobSearchStatus", "committed", "isProfileCompleted", "pendingFields",
    "employeeIdentifier", "civilExpired",
  ]);
  assert.deepEqual(Object.keys(projection.fields), OWN_PROFILE_FIELD_NAMES);
  const wire = JSON.stringify(projection);
  for (const forbidden of [
    "candidate_civil_id", "SENSITIVE-CIVIL-ID-SENTINEL", "candidate_resume",
    "SENSITIVE-RESUME-KEY-SENTINEL", "candidate_iban", "SENSITIVE-IBAN-SENTINEL",
    "candidate_video", "SENSITIVE-VIDEO-SENTINEL", "registry@example.invalid",
  ]) assert.ok(!wire.includes(forbidden), forbidden);
});

test("field contract binds production provenance, semantics and snapshot freshness", () => {
  assert.deepEqual(Object.keys(OWN_PROFILE_FIELD_CONTRACT), OWN_PROFILE_FIELD_NAMES);
  assert.match(OWN_PROFILE_FIELD_CONTRACT.isProfileCompleted.semantics, /Kuwaiti-mother, education and skill/);
  assert.match(OWN_PROFILE_FIELD_CONTRACT.age.semantics, /not an eligibility rule/);
  const projection = projectApprovedProfile(SYNTHETIC_PROFILE_FIXTURES.populated, "2026-09-13");
  for (const field of Object.values(projection.fields)) {
    assert.equal(field.provenance.system, "studenthub-production-approved-import");
    assert.equal(field.provenance.revision, PROFILE_PARITY_REVISION);
    assert.deepEqual(field.freshness, { kind: "imported_snapshot", observedAt: "2026-09-13T12:00:00.000Z" });
  }
  assert.deepEqual(projection.fields.age, {
    state: "available", value: 23,
    provenance: { system: "studenthub-production-approved-import", revision: PROFILE_PARITY_REVISION, sourceField: "candidate_birth_date" },
    freshness: { kind: "imported_snapshot", observedAt: "2026-09-13T12:00:00.000Z" },
  });
  assert.equal(projection.fields.employeeIdentifier.state === "available" && projection.fields.employeeIdentifier.value, "C00231");
});

test("PROFILE-OWNER port returns not_found for another person before reading the adapter", async () => {
  let linkReads = 0;
  const principals = new InMemoryAuthzStore({ principals: PEOPLE });
  const backing = new InMemoryApprovedProfileAdapter({
    links: [{ principalId: "person-populated", candidateRef: "candidate-populated" }],
    rows: new Map([["candidate-populated", SYNTHETIC_PROFILE_FIXTURES.populated]]),
  });
  const source = {
    async resolveLink(id: string) { linkReads += 1; return backing.resolveLink(id); },
    readCandidate: (ref: string) => backing.readCandidate(ref),
  };
  const profiles = new OwnProfileRepository({ principals, source, today: () => "2026-09-13" });
  assert.deepEqual(await profiles.readOwn({
    requesterPrincipalId: "person-populated", targetPersonId: "person-other",
  }), { kind: "not_found" });
  assert.equal(linkReads, 0);
  assert.equal((await profiles.readOwn({
    requesterPrincipalId: "person-populated", targetPersonId: "person-populated",
  })).kind, "found");
  assert.equal(linkReads, 1);
});

test("missing, duplicate and many-to-one immutable linkage fail closed", async () => {
  assert.deepEqual(await repository().readOwn({ requesterPrincipalId: "person-other", targetPersonId: "person-other" }), { kind: "not_found" });
  for (const links of [
    [
      { principalId: "person-populated", candidateRef: "candidate-populated" },
      { principalId: "person-populated", candidateRef: "candidate-second" },
    ],
    [
      { principalId: "person-populated", candidateRef: "candidate-populated" },
      { principalId: "person-other", candidateRef: "candidate-populated" },
    ],
  ]) {
    assert.deepEqual(await repository({ links }).readOwn({
      requesterPrincipalId: "person-populated", targetPersonId: "person-populated",
    }), { kind: "not_found" });
  }
  const misbound = new OwnProfileRepository({
    principals: { async getPrincipal() { return PEOPLE[3]; } },
    source: new InMemoryApprovedProfileAdapter({
      links: [{ principalId: "person-populated", candidateRef: "candidate-populated" }],
      rows: new Map([["candidate-populated", SYNTHETIC_PROFILE_FIXTURES.populated]]),
    }),
  });
  assert.deepEqual(await misbound.readOwn({
    requesterPrincipalId: "person-populated", targetPersonId: "person-populated",
  }), { kind: "not_found" });
});

test("PROFILE-UNAVAILABLE missing information remains typed unavailable and never empty", async () => {
  const partial = await repository().readOwn({ requesterPrincipalId: "person-partial", targetPersonId: "person-partial" });
  assert.equal(partial.kind, "found");
  if (partial.kind !== "found") return;
  assert.deepEqual(partial.profile.fields.arabicName, {
    state: "unavailable", reason: "not_recorded",
    provenance: { system: "studenthub-production-approved-import", revision: PROFILE_PARITY_REVISION, sourceField: "candidate_name_ar" },
    freshness: { kind: "imported_snapshot", observedAt: "2026-09-13T12:00:00.000Z" },
  });
  assert.equal(partial.profile.fields.preferredTime.state, "unavailable");
  assert.equal(partial.profile.fields.preferredTime.state === "unavailable" && partial.profile.fields.preferredTime.reason, "not_imported");
  assert.ok(!JSON.stringify(partial.profile).includes('"value":""'));

  const empty = await repository().readOwn({ requesterPrincipalId: "person-unavailable", targetPersonId: "person-unavailable" });
  assert.equal(empty.kind, "found");
  if (empty.kind === "found") {
    assert.equal(Object.values(empty.profile.fields).filter((field) => field.state === "unavailable").length, OWN_PROFILE_FIELD_NAMES.length);
  }
});

test("PROFILE-PARSER malformed imported values fail closed without echoing input", async () => {
  const malformedValues: readonly [string, unknown][] = [
    ["candidate_gender", 9],
    ["candidate_birth_date", "2001-02-30"],
    ["candidate_birth_date", "2025-1-01"],
    ["candidate_language_pref", "fr"],
    ["candidate_driving_license", "yes"],
    ["candidate_pending_profile", "civil id,unknown-private-field"],
    ["candidate_pending_profile", "education"],
    ["imported_at", "not-a-date"],
    ["source_revision", "unreviewed-revision"],
  ];
  for (const [key, value] of malformedValues) {
    const row = { ...SYNTHETIC_PROFILE_FIXTURES.populated, [key]: value, error: "SENSITIVE-ERROR-SENTINEL" };
    const result = await repository({ rows: new Map([["candidate-populated", row]]) }).readOwn({
      requesterPrincipalId: "person-populated", targetPersonId: "person-populated",
    });
    assert.deepEqual(result, { kind: "unavailable" }, `PROFILE-PARSER ${key} rejects malformed imported value`);
    assert.ok(!JSON.stringify(result).includes("SENSITIVE-ERROR-SENTINEL"));
  }
});

test("PROFILE-ERROR direct projection errors never echo malformed input", () => {
  const cases = [
    ["candidate_gender", 9, "malformed approved profile value"],
    ["candidate_name", "PRIVATE-NAME-".repeat(100), "malformed approved profile value"],
    ["candidate_birth_date", "2025-1-01", "malformed approved profile value"],
    ["candidate_birth_date", "2001-02-30", "malformed approved profile value"],
    ["candidate_pending_profile", "PRIVATE-UNKNOWN-FIELD", "malformed approved profile value"],
    ["candidate_id", "PRIVATE-ID", "malformed approved profile value"],
    ["imported_at", "PRIVATE-TIMESTAMP", "malformed approved profile snapshot"],
    ["source_revision", "PRIVATE-REVISION", "unapproved profile source revision"],
  ] as const;
  for (const [key, value, message] of cases) {
    assert.throws(() => projectApprovedProfile({
      ...SYNTHETIC_PROFILE_FIXTURES.populated, [key]: value,
    }, "2026-09-13"), (error: unknown) => {
      assert.ok(error instanceof TypeError, `PROFILE-ERROR ${key} throws TypeError`);
      assert.equal(error.message, message, `PROFILE-ERROR ${key} uses constant error message`);
      return true;
    }, `PROFILE-ERROR ${key} must reject malformed input`);
  }
});

test("read projection does not recreate the historical 16-25 eligibility rule", () => {
  const older = projectApprovedProfile({ ...SYNTHETIC_PROFILE_FIXTURES.populated, candidate_birth_date: "1980-09-13" }, "2026-09-13");
  assert.equal(older.fields.age.state === "available" && older.fields.age.value, 46);
});


test("PROFILE-ENUM positive fixture mappings preserve every production enum value", () => {
  const cases = [
    ["gender", "candidate_gender", [[1, "male"], [2, "female"], [3, "other"]]],
    ["drivingLicence", "candidate_driving_license", [[1, true], [2, false]]],
    ["language", "candidate_language_pref", [["en", "en"], ["ar", "ar"]]],
    ["jobSearchStatus", "candidate_job_search_status", [[0, "not_looking"], [1, "active"], [2, "open_to_offers"]]],
    ["committed", "candidate_committed", [[0, false], [1, true]]],
    ["isProfileCompleted", "is_incomplete_profile", [[0, true], [1, false]]],
  ] as const;
  for (const fixture of [SYNTHETIC_PROFILE_FIXTURES.populated, SYNTHETIC_PROFILE_FIXTURES.partial]) {
    const original = projectApprovedProfile(fixture, "2026-09-13");
    for (const [field, sourceKey, mappings] of cases) {
      const expected = mappings.find(([input]) => input === fixture[sourceKey])![1];
      assert.deepEqual(original.fields[field].state === "available" && original.fields[field].value,
        expected, `PROFILE-ENUM ${field} ${fixture[sourceKey]} positive fixture mapping`);
      for (const [input, output] of mappings) {
        const row = { ...fixture, [sourceKey]: input,
          ...(field === "isProfileCompleted" ? { candidate_pending_profile: input === 0 ? "" : "education" } : {}),
        };
        const projected = projectApprovedProfile(row, "2026-09-13").fields[field];
        assert.equal(projected.state, "available", `PROFILE-ENUM ${field} ${input} available`);
        assert.deepEqual(projected.state === "available" && projected.value, output,
          `PROFILE-ENUM ${field} ${input} positive mapping`);
      }
    }
  }
});

function unconfiguredRepository() {
  const source = new UnconfiguredApprovedProfileAdapter();
  source.readCandidate = async () => { assert.fail("PROFILE-DEFAULT must never read a candidate"); };
  return new OwnProfileRepository({
    principals: new InMemoryAuthzStore({ principals: PEOPLE }), source, today: () => "2026-09-13",
  });
}

test("PROFILE-DEFAULT-OWNER unconfigured adapter still rejects another or unknown person", async () => {
  const profiles = unconfiguredRepository();
  for (const [requesterPrincipalId, targetPersonId] of [
    ["person-populated", "person-other"], ["unknown", "unknown"],
  ]) {
    assert.deepEqual(await profiles.readOwn({ requesterPrincipalId: requesterPrincipalId!, targetPersonId: targetPersonId! }),
      { kind: "not_found" });
  }
});

async function unconfiguredServer(t: TestContext) {
  const rig = createSyntheticLoginRig(createLoginApplication);
  const session = "s".repeat(43);
  await rig.sessions.put({ id: session, personId: "person-populated" });
  const server = createGatewayServer(undefined, undefined, undefined, { ...rig.app, web: {
    origin: "https://studenthub.test.invalid", returnTo: rig.config.allowedReturnUrls[1],
    profiles: unconfiguredRepository(),
  } });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  return { url: `http://127.0.0.1:${address.port}/profile`, cookie: `__Host-studenthub_session=${session}` };
}

test("PROFILE-DEFAULT-JSON unconfigured adapter serves 200 with all 19 fields unavailable", async (t) => {
  const { url, cookie } = await unconfiguredServer(t);
  const response = await fetch(url, { headers: { cookie, accept: "application/json" } });
  assert.equal(response.status, 200, "PROFILE-DEFAULT-JSON unconfigured profile must render instead of 404");
  const profile = await response.json();
  assert.equal(Object.keys(profile.fields).length, 19);
  assert.deepEqual(Object.keys(profile.fields), OWN_PROFILE_FIELD_NAMES);
  for (const field of Object.values(profile.fields) as Record<string, unknown>[]) {
    assert.equal(field.state, "unavailable");
    assert.equal(field.reason, "not_imported");
    assert.equal(Object.hasOwn(field, "value"), false);
    assert.deepEqual(field.freshness, { kind: "not_imported", observedAt: "" });
  }
  assert.doesNotMatch(JSON.stringify(profile), /Registry must not win|registry@example|Synthetic|noor@example|profile_not_found/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("PROFILE-DEFAULT-HTML unconfigured adapter renders 200 with all 19 fields unavailable", async (t) => {
  const { url, cookie } = await unconfiguredServer(t);
  const response = await fetch(url, { headers: { cookie, accept: "text/html" } });
  assert.equal(response.status, 200, "PROFILE-DEFAULT-HTML unconfigured profile must render instead of 404");
  const html = await response.text();
  assert.match(response.headers.get("content-type")!, /^text\/html/);
  assert.equal((html.match(/data-state="unavailable"/g) ?? []).length, 19);
  assert.equal((html.match(/<dt>/g) ?? []).length, 19);
  for (const contract of Object.values(OWN_PROFILE_FIELD_CONTRACT)) assert.ok(html.includes(`<dt>${contract.label}</dt>`));
  assert.match(html, /Read-only/);
  assert.match(html, /editing isn’t enabled/);
  assert.doesNotMatch(html, /Registry must not win|registry@example|Synthetic|noor@example|This profile isn’t available/);
  assert.equal(response.headers.get("cache-control"), "no-store");
});
