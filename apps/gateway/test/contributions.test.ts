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
    "en:none": "e27e06b4131d4be652991bff826d91e90b559f1a570b3d84c1a42ddc4e22102a",
    "en:navigation": "692b02ab73f0bc21d6d8466ed85065c86665861e7df65cfef39a9bc99f50093a",
    "en:browser-preferences": "602b23269015b9e4710ba38443dfcf93dd9b4aa05cef78bcdde013755ba18c9a",
    "en:legacy-preferences": "323e7f6e35b122da5c17a00cf803b8fc1ef9f1055a12571dd13d654756fbb6f8",
    "en:verified": "7eae9c84c3b1144ddfaebb4b31b5dbe4a15aa40d4b76c74c9e3258aa94c72b6a",
    "ar:none": "d259b5884d31c88933a4651159203b21b91ef46c9d0fe32b9b351a3d3a998f1a",
    "ar:navigation": "f4bb55b722e1d07e20d0b8591cc50b67a51ef75fda624f46446b748f07461ce8",
    "ar:browser-preferences": "c75a20e67132a16834fb8b65bb88dbf42b899b5a5c9bc11a130cbd3f607b370b",
    "ar:legacy-preferences": "bca89d7be25d2d7d8cd34809cb4ab9c8d19640f827fa5e7f93dcb048a0de0a6a",
    "ar:verified": "4768740e0b6648641623fadbae0f03266875d69f052fbfc6196cbe7fd09c340b",
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
