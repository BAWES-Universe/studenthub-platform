import assert from "node:assert/strict";
import test from "node:test";
import { CONTRIBUTIONS } from "../src/contributions/index.js";
import { PERSON_CONTRIBUTION } from "../src/contributions/person.js";
import { PROFILE_COPY } from "../src/ui/profile-copy.js";
import { OWN_PROFILE_FIELD_NAMES, OWN_PROFILE_VERSION, PROFILE_PARITY_REVISION, type OwnProfileProjection } from "@studenthub/profile";
import { profileDocument, type BrowserLoginApplication } from "../src/web-ui.js";

// The person's own pages reach the profile navigation only where their route is wired.
const entry = (key: string) => {
  const e = CONTRIBUTIONS.navigation.find(n => n.key === key);
  assert.ok(e, key);
  return e;
};
const reports = (idCards: Record<string, unknown>) => ({ staffMessages: { idCards } }) as never;

test("PERSON_NAV each link points at its route and sits after the existing entries", () => {
  assert.deepEqual(PERSON_CONTRIBUTION.navigation.map(n => [n.key, n.href]), [
    ["statistics", "/profile/statistics"], ["pay", "/pay"], ["bank", "/profile/bank"], ["certificates", "/profile/certificates"], ["idCard", "/profile/id-card"],
  ]);
  const others = CONTRIBUTIONS.navigation.filter(n => !PERSON_CONTRIBUTION.navigation.some(p => p.key === n.key));
  assert.ok(PERSON_CONTRIBUTION.navigation.every(p => others.every(o => p.order > o.order)), "no existing entry moves");
});

test("PERSON_NAV a link shows only when its route is wired", () => {
  for (const key of ["statistics", "pay", "bank", "certificates", "idCard"]) {
    assert.equal(entry(key).visible({}), false, `${key}: nothing wired`);
    assert.equal(entry(key).visible({ navigation: {} } as never), false, `${key}: other areas only`);
  }
  assert.equal(entry("statistics").visible(reports({ certificates: {} })), false, "statistics needs its own service");
  assert.equal(entry("statistics").visible(reports({ candidateStatistics: {} })), true);
  assert.equal(entry("certificates").visible(reports({ candidateStatistics: {} })), false, "certificates need their own service");
  assert.equal(entry("certificates").visible(reports({ certificates: {} })), true);
  assert.equal(entry("idCard").visible({ staffMessages: {} } as never), false, "the ID card needs the reports service");
  assert.equal(entry("idCard").visible(reports({})), true);
  assert.equal(entry("pay").visible(reports({ candidateStatistics: {}, certificates: {} })), false, "pay needs the billing area");
  assert.equal(entry("pay").visible({ payHistory: {} } as never), true);
  assert.equal(entry("bank").visible({ payHistory: {} } as never), false, "bank details need the profile wiring");
  assert.equal(entry("bank").visible({ bankDetails: {} } as never), true);
});

test("PERSON_NAV every label has English and Arabic copy", () => {
  for (const n of PERSON_CONTRIBUTION.navigation) for (const language of ["en", "ar"] as const) {
    const text = (PROFILE_COPY as unknown as Record<string, Record<string, string>>)[language]?.[n.labelKey];
    assert.ok(typeof text === "string" && text.length > 0, `${language} ${n.labelKey}`);
  }
});

function profile(): OwnProfileProjection {
  const fields: Record<string, unknown> = {};
  for (const key of [...OWN_PROFILE_FIELD_NAMES, "phone", "handle", "kuwaitiMother"]) fields[key] = {
    state: "unavailable", freshness: { kind: "imported_snapshot", observedAt: "2026-11-04T00:00:00.000Z" },
    provenance: { system: "studenthub-production-approved-import", revision: PROFILE_PARITY_REVISION, sourceField: key },
  };
  fields.language = { ...fields.language as object, state: "available", value: "en", freshness: { kind: "written_by_person", observedAt: "2026-11-04T00:00:00.000Z" } };
  return { version: OWN_PROFILE_VERSION, fields } as unknown as OwnProfileProjection;
}

test("PERSON_NAV the profile page links the wired routes, read from the runtime's hidden reports wiring", async () => {
  const html = async (login: Partial<BrowserLoginApplication>) => {
    const page = await profileDocument({ status: 200, body: profile() as never } as never, login);
    return (page as { html: string }).html;
  };
  const bare = await html({});
  for (const href of ["/profile/statistics", "/pay", "/profile/bank", "/profile/certificates", "/profile/id-card"]) assert.equal(bare.includes(`href="${href}"`), false, href);
  // login-runtime attaches the reports wiring as a non-enumerable property, so the gate must read it directly.
  const wired = { payHistory: {}, bankDetails: {} } as unknown as Partial<BrowserLoginApplication>;
  Object.defineProperty(wired, "staffMessages", { value: { idCards: { candidateStatistics: {}, certificates: {} } }, enumerable: false });
  const page = await html(wired);
  assert.match(page, /<a href="\/profile\/statistics">My statistics<\/a><a href="\/pay">My pay<\/a><a href="\/profile\/bank">Bank details<\/a><a href="\/profile\/certificates">Certificates<\/a><a href="\/profile\/id-card">ID card<\/a>/);
});
