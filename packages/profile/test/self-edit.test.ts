import assert from "node:assert/strict";
import { test } from "node:test";
import {
  runSafeWriteConformance, TEST_SECRET, type ChangeRequest, type CommitInput, type SafeWriteImplementation, type SafeWriteStore,
} from "@studenthub/safe-write-contract";
import {
  acceptAnySelfEditValue, buildSelfEditWrite, candidateProfileOwnerDecision, candidateProfileRecordRef, isCanonicalSelfEditValue,
  LEGACY_AGE_RULE, normalizeIntro, normalizePersonName, normalizeSelfEdit, pendingProfileRequirements, PROFILE_TEXT_FORBIDDEN_RANGES,
  selfEditValueCheck, SELF_EDIT_FIELDS, type CompletenessFacts, type SelfEditField, type SelfEditReferences,
} from "@studenthub/profile";

// Synthetic fixtures only; the catalogue ids are made up.
const PERSON = "principal-candidate-s2";
const PRINCIPAL_REF = "d".repeat(64);
const COUNTRY = "44444444-4444-4444-8444-44444444abcd";
const UNIVERSITY = "77777777-7777-4777-8777-77777777abcd";
const TODAY = "2026-10-08";

/**
 * The contract's conformance suite writes the field `display_name`. Each run maps
 * that one name onto a self-edit field at the builder's boundary, so all of the
 * suite's scenarios exercise the builder on that field.
 */
function onField(field: SelfEditField) {
  return (input: Parameters<Parameters<typeof runSafeWriteConformance>[0]>[0]): SafeWriteImplementation => {
    const to = (name: string) => name === "display_name" ? field : name;
    const from = (name: string) => name === field ? "display_name" : name;
    const store: SafeWriteStore = {
      ownedRecord: (principalRef) => input.store.ownedRecord(principalRef),
      readField: (personRef, name) => input.store.readField(personRef, from(name)),
      commit: (commit: CommitInput) => input.store.commit({
        ...commit, field: from(commit.field), receipt: { ...commit.receipt, fields: commit.receipt.fields.map(from) },
      }),
    };
    const implementation = buildSelfEditWrite({
      store, secret: input.secret, check: acceptAnySelfEditValue, clock: input.clock,
      policy: { allowed: input.policy.allowed.map(to), maxValueLength: input.policy.maxValueLength },
      ...(input.tokenLifetimeMs === undefined ? {} : { tokenLifetimeMs: input.tokenLifetimeMs }),
    });
    const mapped = (change: ChangeRequest): ChangeRequest => ({ ...change, field: to(change.field) });
    return {
      preview: async (request) => {
        const result = await implementation.preview({ ...request, change: mapped(request.change) });
        return result.ok ? { ...result, changes: result.changes.map((change) => ({ ...change, field: from(change.field) })) } : result;
      },
      confirm: async (request) => {
        const result = await implementation.confirm({ ...request, change: mapped(request.change) });
        return result.ok ? { ...result, receipt: { ...result.receipt, fields: result.receipt.fields.map(from) } } : result;
      },
    };
  };
}

test("SHU143_CONFORMANCE every self-edit field passes the safe-write conformance suite through the one builder", async () => {
  for (const field of SELF_EDIT_FIELDS) {
    const report = await runSafeWriteConformance(onField(field));
    assert.equal(report.ok, true, `${field}: ${JSON.stringify(report.results.filter((result) => !result.ok))}`);
  }
});

test("SHU143_NORMALIZE each field has one canonical value and refuses malformed input", () => {
  const cases: Array<[SelfEditField, unknown, string | undefined]> = [
    ["display_name", "  Synthetic   Person ", "Synthetic Person"],
    ["display_name", "Single", undefined],
    ["display_name", "\uFF21\uFF42 \uFF23\uFF44", "Ab Cd"],
    ["display_name", "Zero\u200Bwidth name", undefined],
    ["display_name", "x".repeat(254) + " y", undefined],
    ["arabic_name", "عبدالله  الكندري", "عبدالله الكندري"],
    ["gender", "female", "female"],
    ["gender", "2", undefined],
    ["birth_date", "2006-02-28", "2006-02-28"],
    ["birth_date", "2006-02-30", undefined],
    ["birth_date", "1899-12-31", undefined],
    ["nationality", COUNTRY.toUpperCase(), COUNTRY],
    ["nationality", "not-a-uuid", undefined],
    ["kuwaiti_mother", true, "true"],
    ["kuwaiti_mother", "true", undefined],
    ["driving_licence", false, "false"],
    ["objective", "  Retail\tjobs ", "Retail jobs"],
    ["objective", "x".repeat(101), undefined],
    ["preferred_time", "Evenings", "Evenings"],
    ["intro", " Line one  \r\n\r\n\r\n  line\ttwo ", "Line one\n\nline two"],
    ["intro", "\n\n", undefined],
    ["profile_url", " Synthetic-Person ", "synthetic-person"],
    ["profile_url", "-bad", undefined],
    ["job_search_status", "open_to_offers", "open_to_offers"],
    ["job_search_status", 1, undefined],
    ["phone", "+965 5555-0101", "+96555550101"],
    ["phone", "call me", undefined],
  ];
  for (const [field, input, expected] of cases) assert.equal(normalizeSelfEdit(field, input), expected, `${field} ${JSON.stringify(input)}`);
  for (const field of SELF_EDIT_FIELDS) assert.equal(normalizeSelfEdit(field, undefined), undefined, field);
  // A stored value is acceptable only in its canonical form.
  assert.equal(isCanonicalSelfEditValue("display_name", "Synthetic Person"), true);
  assert.equal(isCanonicalSelfEditValue("display_name", "Synthetic  Person"), false);
  assert.equal(isCanonicalSelfEditValue("profile_url", "Synthetic-Person"), false);
  assert.equal(isCanonicalSelfEditValue("driving_licence", "true"), true);
  assert.equal(isCanonicalSelfEditValue("driving_licence", "yes"), false);
});

test("SHU143_TEXT_RULE text fields refuse every listed code point, and the introduction admits only the line feed", () => {
  const listed = PROFILE_TEXT_FORBIDDEN_RANGES.filter(([low]) => low <= 0x2fff);
  for (const [low, high] of listed) {
    for (const code of [low, high]) {
      const char = String.fromCodePoint(code);
      if (/\s/u.test(char)) continue; // whitespace collapses to one space before the check
      assert.equal(normalizePersonName(`Ab${char} Cd`), undefined, `U+${code.toString(16)} in a name`);
      assert.equal(normalizeIntro(`Ab${char}Cd`), undefined, `U+${code.toString(16)} in an intro`);
    }
  }
  assert.equal(normalizeIntro("First\nSecond"), "First\nSecond");
  // Other line separators are whitespace: they become one space, as in a name. NEL is a control.
  assert.equal(normalizeIntro("First\u2028Second"), "First Second");
  assert.equal(normalizeIntro("First\u0085Second"), undefined);
});

test("SHU143_AGE_RULE the birth date must give an age inside the configured rule, legacy 16 to 25 by default", async () => {
  const references: SelfEditReferences = { activeCatalogueItem: async () => true, available: async () => true };
  const legacy = selfEditValueCheck(references, { today: () => TODAY });
  assert.deepEqual(LEGACY_AGE_RULE, { minYears: 16, maxYears: 25 });
  assert.equal(await legacy("birth_date", "2010-10-08"), undefined, "16 today");
  assert.equal(await legacy("birth_date", "2010-10-09"), "age_out_of_range", "16 tomorrow");
  assert.equal(await legacy("birth_date", "2000-10-09"), undefined, "25 until tomorrow");
  assert.equal(await legacy("birth_date", "2000-10-08"), "age_out_of_range", "26 today");
  const wider = selfEditValueCheck(references, { today: () => TODAY, ageRule: { minYears: 16, maxYears: 40 } });
  assert.equal(await wider("birth_date", "1990-01-01"), undefined);
  assert.throws(() => selfEditValueCheck(references, { today: () => TODAY, ageRule: { minYears: 30, maxYears: 20 } }));
});

function rig(references: Partial<SelfEditReferences> = {}) {
  let catalogue = new Set([COUNTRY, UNIVERSITY]);
  let taken = new Set<string>();
  const values = new Map<string, string>();
  let roles = ["candidate"];
  const commits: CommitInput[] = [];
  const store: SafeWriteStore = {
    ownedRecord: (principalRef) => principalRef === PRINCIPAL_REF && candidateProfileOwnerDecision(roles.map((role) => ({ role })))
      ? candidateProfileRecordRef(PERSON) : null,
    readField: (_record, field) => values.get(field) ?? null,
    commit: (input) => {
      if ((values.get(input.field) ?? null) !== input.expectedBefore) return { ok: false, reason: "state_changed" };
      commits.push(input);
      values.set(input.field, input.value);
      return { ok: true };
    },
  };
  const check = selfEditValueCheck({
    activeCatalogueItem: async (_type, id) => catalogue.has(id),
    available: async (_field, value) => !taken.has(value),
    ...references,
  }, { today: () => TODAY });
  const writer = buildSelfEditWrite({ store, secret: TEST_SECRET, check });
  const change = (field: SelfEditField, value: string) => ({ personRef: candidateProfileRecordRef(PERSON), field, value });
  return {
    writer, change, commits, values,
    retire: (id: string) => { catalogue = new Set([...catalogue].filter((item) => item !== id)); },
    take: (value: string) => { taken = new Set([...taken, value]); },
    setRoles: (next: string[]) => { roles = next; },
  };
}

test("SHU143_VALUE_CHECKED preview and confirm both refuse a value the check does not accept, and nothing is written", async () => {
  const x = rig();
  assert.deepEqual(await x.writer.preview({ principalRef: PRINCIPAL_REF, change: x.change("display_name", "Synthetic  Person") }),
    { ok: false, reason: "invalid_value" });
  assert.deepEqual(await x.writer.preview({ principalRef: PRINCIPAL_REF, change: x.change("nationality", "66666666-6666-4666-8666-666666666666") }),
    { ok: false, reason: "invalid_value" });
  // The country is retired between preview and confirm.
  const country = await x.writer.preview({ principalRef: PRINCIPAL_REF, change: x.change("nationality", COUNTRY) });
  assert.ok(country.ok);
  x.retire(COUNTRY);
  assert.deepEqual(await x.writer.confirm({ principalRef: PRINCIPAL_REF, change: x.change("nationality", COUNTRY), token: country.token }),
    { ok: false, reason: "invalid_value" });
  // Someone else takes the phone between preview and confirm.
  const phone = await x.writer.preview({ principalRef: PRINCIPAL_REF, change: x.change("phone", "+96555550101") });
  assert.ok(phone.ok);
  x.take("+96555550101");
  assert.deepEqual(await x.writer.confirm({ principalRef: PRINCIPAL_REF, change: x.change("phone", "+96555550101"), token: phone.token }),
    { ok: false, reason: "invalid_value" });
  assert.equal(x.commits.length, 0);
  // A good value goes through, and the receipt names the field only.
  const name = await x.writer.preview({ principalRef: PRINCIPAL_REF, change: x.change("display_name", "Synthetic Person") });
  assert.ok(name.ok);
  const done = await x.writer.confirm({ principalRef: PRINCIPAL_REF, change: x.change("display_name", "Synthetic Person"), token: name.token });
  assert.ok(done.ok);
  assert.deepEqual(done.receipt.fields, ["display_name"]);
  assert.ok(!JSON.stringify(done.receipt).includes("Synthetic"));
});

test("SHU143_OWNER only a person with a candidate grant may edit a candidate profile", async () => {
  assert.equal(candidateProfileOwnerDecision([{ role: "candidate" }]), true);
  for (const role of ["staff", "admin", "org-owner", "recruiter", "finance"]) assert.equal(candidateProfileOwnerDecision([{ role }]), false, role);
  const x = rig();
  x.setRoles(["staff"]);
  assert.deepEqual(await x.writer.preview({ principalRef: PRINCIPAL_REF, change: x.change("gender", "female") }),
    { ok: false, reason: "not_own_record" });
});

const EMPTY: CompletenessFacts = {
  fields: {}, emailRecorded: false, personalPhoto: false, civilId: false, civilExpiry: false, civilFront: false, civilBack: false,
  location: undefined, nationalityKuwaiti: undefined, educationCount: 0, skillCount: 0,
};

test("SHU143_COMPLETENESS pending requirements follow isInCompleteProfile, including the conditional and child-table ones", () => {
  assert.deepEqual(pendingProfileRequirements(EMPTY), [
    "nationality", "display_name", "arabic_name", "gender", "objective", "personal_photo", "email", "phone", "birth_date",
    "civil_id", "civil_expiry", "civil_front", "civil_back", "driving_licence", "location", "education", "skill",
  ]);
  const full: CompletenessFacts = {
    fields: {
      nationality: COUNTRY, display_name: "Synthetic Person", arabic_name: "اسم تجريبي", gender: "female", objective: "Retail",
      phone: "+96555550101", birth_date: "2006-01-01", driving_licence: "false",
    },
    emailRecorded: true, personalPhoto: true, civilId: true, civilExpiry: true, civilFront: true, civilBack: true,
    location: { inKuwait: true }, nationalityKuwaiti: true, educationCount: 1, skillCount: 2,
  };
  assert.deepEqual(pendingProfileRequirements(full), []);
  // A non-Kuwaiti living in Kuwait must say whether their mother is Kuwaiti.
  assert.deepEqual(pendingProfileRequirements({ ...full, nationalityKuwaiti: false }), ["kuwaiti_mother"]);
  assert.deepEqual(pendingProfileRequirements({ ...full, nationalityKuwaiti: false, fields: { ...full.fields, kuwaiti_mother: "false" } }), []);
  assert.deepEqual(pendingProfileRequirements({ ...full, nationalityKuwaiti: false, location: { inKuwait: false } }), []);
  assert.deepEqual(pendingProfileRequirements({ ...full, educationCount: 0, skillCount: 0 }), ["education", "skill"]);
  assert.deepEqual(pendingProfileRequirements({ ...full, fields: { ...full.fields, phone: null } }), ["phone"]);
});
