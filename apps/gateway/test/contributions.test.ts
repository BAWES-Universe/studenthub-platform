import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { OWN_PROFILE_FIELD_NAMES, OWN_PROFILE_VERSION, PROFILE_PARITY_REVISION, type OwnProfileProjection } from "@studenthub/profile";
import { CONTRIBUTIONS, mergeContributions, type Contributions } from "../src/contributions/index.js";
import { profileDocument, type BrowserLoginApplication } from "../src/web-ui.js";
import type { ProfileLanguage } from "../src/ui/profile-copy.js";

function profile(language: ProfileLanguage): OwnProfileProjection {
  const fields: Record<string, unknown> = {};
  for (const key of [...OWN_PROFILE_FIELD_NAMES, "phone", "handle", "kuwaitiMother"]) fields[key] = {
    state: "unavailable", freshness: { kind: "imported_snapshot", observedAt: "2026-11-04T00:00:00.000Z" },
    provenance: { system: "studenthub-production-approved-import", revision: PROFILE_PARITY_REVISION, sourceField: key },
  };
  fields.language = { ...fields.language as object, state: "available", value: language, freshness: { kind: "written_by_person", observedAt: "2026-11-04T00:00:00.000Z" } };
  fields.displayName = { ...fields.displayName as object, state: "available", value: "Noor Al-Sabah", freshness: { kind: "written_by_person", observedAt: "2026-11-04T00:00:00.000Z" } };
  return { version: OWN_PROFILE_VERSION, fields } as unknown as OwnProfileProjection;
}

const digest = (value: string) => createHash("sha256").update(value).digest("hex");

test("PREP_NAV default area contributions preserve profile navigation", () => {
  assert.deepEqual(CONTRIBUTIONS.navigation.map(({ key, order, current }) => ({ key, order, ...(current ? { current } : {}) })), [
    { key: "profile", order: 100, current: true },
    { key: "background", order: 200 },
    { key: "workspaces", order: 300 },
  ]);
  assert.deepEqual(CONTRIBUTIONS.profileRows, []);
  assert.equal(CONTRIBUTIONS.navigation[2]!.visible({}), false);
  assert.equal(CONTRIBUTIONS.navigation[2]!.visible({ navigation: {} as never }), true);
});

test("PREP_NAV profile HTML remains byte-identical for every login shape and language", async () => {
  const choices = async () => ({ countries: [], universities: [] });
  const shapes: readonly [string, Partial<BrowserLoginApplication>, { readonly title: string; readonly message: string } | undefined][] = [
    ["none", {}, undefined],
    ["navigation", { navigation: {} as never }, undefined],
    ["browser-preferences", { navigation: {} as never, browserEdit: {} as never, preferences: {} as never }, undefined],
    ["legacy-preferences", { profileEdit: { choices } as never, preferences: {} as never }, undefined],
    ["verified", {}, { title: "Saved safely", message: "Your profile was verified." }],
  ];
  const expected: Record<string, string> = {
    // Frozen from the bound, pre-refactor profileDocument implementation.
    "en:none": "58e4748e2a1d8238daa5857d7fbeec8062eaadbb791e8e1f1dbeb0b144d1c3bb",
    "en:navigation": "9bffb8bc8567dc98a5f4ad884c8e8bfbdff33c178f20c9e2e5dc2a85811cb232",
    "en:browser-preferences": "00f97f6174305da1de0b9005675db6c2610ffa3d5071baed509dbd2fd18d2172",
    "en:legacy-preferences": "6bbb0e5152b7379cd525a66b06cb03a52621ddd96162771e74b15eb286bb9cfc",
    "en:verified": "b85cbac984e60dcec5ad18acbac2b1a44fe63ff96f886bc29a6d319d304ac1ef",
    "ar:none": "3db09f006b8d30d8c43d84b53c25a6111f505155c7bff573186ba14064326154",
    "ar:navigation": "31375d4b36ae5b4e12ad8d4f766f67378cd63ce883a664c445280e580b1ce08c",
    "ar:browser-preferences": "428e77f132b134f46963be1ce669f824e8a690473b821f7d5ba013bffee6edd0",
    "ar:legacy-preferences": "b666f9f0fa1820cbd6645a2f94c7e8c018885d2ef95d884e9631b2ae6cea2791",
    "ar:verified": "6bbfa75fb9e6ef57d1b82183b65f596a1dbf9e135aeb3df3cac342b1afaed97b",
  };
  for (const language of ["en", "ar"] as const) for (const [name, login, notice] of shapes) {
    const { html } = await profileDocument({ status: 200, body: profile(language) }, login, notice);
    assert.equal(digest(html), expected[`${language}:${name}`], `PREP_NAV byte identity ${language} ${name}`);
  }
});

test("PREP_NAV_MERGE sorts by order then key and refuses duplicate keys", () => {
  const contribution = (key: string, order: number): Contributions => ({
    navigation: [{ key, order, href: `/${key}`, labelKey: "nav.profile", visible: () => true }], profileRows: [],
  });
  assert.deepEqual(mergeContributions([contribution("z", 100), contribution("a", 100), contribution("middle", 50)]).navigation.map(item => item.key), ["middle", "a", "z"]);
  assert.throws(() => mergeContributions([contribution("same", 1), contribution("same", 2)]), /duplicate contribution key/);
});

test("PREP_NAV_MERGE renders injected navigation and escaped personal row in English and Arabic", async () => {
  for (const language of ["en", "ar"] as const) {
    const extra: Contributions = {
      navigation: [{ key: "extra-link", order: 150, href: "/extra?a=1&amp;b=2", labelKey: "nav.main", visible: () => true }],
      profileRows: [{
        key: "extra-personal", section: "personal", order: 900,
        render: (renderLanguage) => `<div class="p-row" data-extra="${renderLanguage}">&lt;unsafe &amp; escaped&gt;</div>`,
      }],
    };
    const merged = mergeContributions([CONTRIBUTIONS, extra]);
    const { html } = await profileDocument({ status: 200, body: profile(language) }, { navigation: {} as never }, undefined, false, merged);
    const profileAt = html.indexOf('href="/profile"');
    const extraAt = html.indexOf('href="/extra?a=1&amp;b=2"');
    const backgroundAt = html.indexOf('href="/profile/background"');
    assert.ok(profileAt < extraAt && extraAt < backgroundAt, `PREP_NAV_MERGE link order ${language}`);
    assert.doesNotMatch(html, /<unsafe/);
    const personal = html.slice(html.indexOf('id="section-personal"'), html.indexOf('</section>', html.indexOf('id="section-personal"')));
    assert.match(personal, new RegExp(`data-extra="${language}"`));
    assert.ok(personal.lastIndexOf('data-extra=') > personal.lastIndexOf('id="field-drivingLicence"'), `PREP_NAV_MERGE row last ${language}`);
    assert.match(personal, /&lt;unsafe &amp; escaped&gt;/);
  }
});
