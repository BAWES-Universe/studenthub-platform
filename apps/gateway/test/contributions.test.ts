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
    "en:none": "83d3e5dfa40ac1f8785de302a9ab05862d177d307d1b2a24b8bdc3fe30282b78",
    "en:navigation": "5efc20498a380dc4b8459f45dd621cd2effc3c98ca9951d961dc1b59501330ba",
    "en:browser-preferences": "c0f79562dc5af4bf1874b8a02e8f35749297761604276bca8705cacb382f589d",
    "en:legacy-preferences": "c8a7a46f5dc6bbc67dd12d12de1b1d8b63fa1bdbc0b0b86770a864a4c5905fb1",
    "en:verified": "3d16ae0256b3c08b151723f895301bb2be026a37948e8c2c32607eb2ac92efef",
    "ar:none": "de239dd6597911e3aa2aae97acfb642ff8e0bb6480229fb14af19d6372b54ad2",
    "ar:navigation": "f5383a0018f18b91a24e91aad230b0106a5cdd2d4ddc78d6f6ea6777efbbf8fd",
    "ar:browser-preferences": "52879527ab601c2850893748e1ec173be0db51533b42c98aaf1eb12af1acc229",
    "ar:legacy-preferences": "89706ef9029170aab97ae581ed84993f9f456df89cf8712525ec03963f8ec4ec",
    "ar:verified": "186d769a43488f995f3757edb60a2cf712736e93879bcbe7c16795c8ab249253",
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
