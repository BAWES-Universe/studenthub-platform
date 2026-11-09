import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import {
  PROFILE_KIT_CSS, PROFILE_FIELD_KEYS, PROFILE_ROW_KEYS, profileShell, profileHeading, profileSection,
  profileRow, profileControl, profileActions, profileErrorSummary, profileNotice,
  profileEmpty, type ProfileFieldKey, type ProfileHtml,
} from "../src/ui/profile-kit.js";
import {
  PROFILE_COPY, profileCopy, profileCopyText, directionForProfileLanguage,
  type ProfileCopyKey, type ProfileLanguage,
} from "../src/ui/profile-copy.js";

const attack = `&<>"'`;
const escaped = "&amp;&lt;&gt;&quot;&#39;";
const rawCopy = profileCopyText as (language: ProfileLanguage, key: ProfileCopyKey, parameters?: unknown) => string;

function splitSelectors(value: string): string[] {
  let depth = 0, start = 0;
  const result: string[] = [];
  for (let i = 0; i < value.length; i++) {
    if (value[i] === "(") depth++;
    if (value[i] === ")") depth--;
    if (value[i] === "," && depth === 0) { result.push(value.slice(start, i).trim()); start = i + 1; }
  }
  result.push(value.slice(start).trim());
  return result;
}

test("U1_SCOPED: every CSS selector is profile-local and the library emits no document or script", () => {
  const selectors = Array.from(PROFILE_KIT_CSS.matchAll(/([^{}]+)\{/g), match => match[1]!.trim());
  assert.ok(selectors.length > 35);
  for (const group of selectors) {
    if (group.startsWith("@media ")) continue;
    for (const selector of splitSelectors(group)) assert.match(selector, /^\.profile-ui(?:\s|$)/, selector);
  }
  assert.doesNotMatch(PROFILE_KIT_CSS, /@import|url\(|letter-spacing|overflow-x|position:\s*fixed/);
  assert.match(PROFILE_KIT_CSS, /min-block-size: 2\.75rem/);
  assert.match(PROFILE_KIT_CSS, /:focus-visible/);
  assert.match(PROFILE_KIT_CSS, /prefers-reduced-motion/);
  const html = profileShell("en", [profileHeading("My profile"), profileEmpty("Empty")]).html;
  assert.doesNotMatch(html, /<(?:html|main|script|style)\b|skip/i);
  assert.match(html, /class="profile-ui"/);
  assert.throws(() => profileShell("en", [{ html: "<script>bad()</script>" }]), /kit-generated/);
  assert.throws(() => profileShell("en", [Object.freeze({ html: profileEmpty("safe").html })]), /kit-generated/);
});

test("U1_A11Y: text, date, textarea and select connect labels, hints and errors", () => {
  for (const type of ["text", "date", "textarea", "select"] as const) {
    const html = profileControl({ key: "displayName", type, label: attack, value: attack,
      hint: attack, error: attack, required: true, requiredLabel: "Required", choices: [{ value: attack, label: attack }] }).html;
    assert.match(html, /for="field-displayName"/);
    assert.match(html, /id="field-displayName"/);
    assert.match(html, /aria-describedby="field-displayName-hint field-displayName-error"/);
    assert.match(html, /aria-invalid="true"/);
    assert.match(html, /id="field-displayName-hint"/);
    assert.match(html, /id="field-displayName-error"/);
    assert.match(html, / required/);
    assert.ok(html.includes(escaped));
    assert.ok(!html.includes(attack));
    assert.doesNotMatch(html, /maxlength|placeholder|tabindex="[1-9]/);
  }
  const clean = profileControl({ key: "intro", type: "textarea", label: "Intro", value: "\n𐐀 ".repeat(5001) }).html;
  assert.ok(clean.includes("\n𐐀 ".repeat(5001)), "draft must not be truncated or normalized");
  assert.throws(() => profileControl({ key: "intro", label: "Intro", value: "", required: true }), /required/i);
  assert.match(profileControl({ key: "intro", label: "Intro", value: "", required: true, requiredLabel: "مطلوب" }).html, /مطلوب/);
  assert.doesNotMatch(clean, /aria-invalid|aria-describedby|maxlength/);
  const breakout = profileControl({ key: "intro", type: "textarea", label: "Intro", value: "</textarea><script>x</script>" }).html;
  assert.ok(breakout.includes("&lt;/textarea&gt;&lt;script&gt;x&lt;/script&gt;"));
  assert.equal((breakout.match(/<\/textarea>/g) ?? []).length, 1);
});

test("U1_A11Y: radio group has a legend, unique linked labels, errors and no guessed selection", () => {
  const options = { key: "drivingLicence" as const, type: "radio" as const, label: "Licence", value: "", hint: "Choose", error: "Required", required: true, requiredLabel: "Required",
    choices: [{ value: "true", label: "Yes" }, { value: "false", label: "No" }] };
  const html = profileControl(options).html;
  assert.match(html, /<fieldset[^>]*aria-describedby="field-drivingLicence-hint field-drivingLicence-error"/);
  assert.match(html, /<legend>Licence <span class="p-hint">Required<\/span><\/legend>/);
  assert.doesNotMatch(html, / checked/);
  for (const id of ["field-drivingLicence", "field-drivingLicence-1"]) {
    assert.ok(html.includes(`for="${id}"`));
    assert.ok(html.includes(`id="${id}"`));
  }
  assert.equal((html.match(/aria-invalid="true"/g) ?? []).length, 1);
  assert.equal((html.match(/aria-describedby=/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<input[^>]*aria-(?:describedby|invalid)=/, "U2B_RADIO_GROUP: associations belong to the fieldset only");
  const selected = profileControl({ ...options, value: "false" }).html;
  assert.match(selected, /value="false" checked/);
  assert.equal((selected.match(/ checked/g) ?? []).length, 1);
  assert.throws(() => profileControl({ ...options, choices: [] }), /choices/i);
  assert.throws(() => profileControl({ ...options, choices: [{ value: "x", label: "X" }, { value: "x", label: "Y" }] }), /choices/i);
  assert.throws(() => profileControl({ ...options, type: "select", value: "unknown" }), /explicit/);
  const select = profileControl({ ...options, type: "select", value: "false" }).html;
  assert.match(select, /value="false" selected/);
  assert.equal((select.match(/ selected/g) ?? []).length, 1);
});

test("U1_A11Y: actions, summary, section and notice preserve semantic relationships and escaping", () => {
  const html = profileShell("en", [profileHeading(attack, attack), profileSection("personal", attack,
    [profileRow({ key: "displayName", label: attack, value: attack, metadata: attack, editLabel: attack })]),
    profileErrorSummary(attack, [{ key: "displayName", message: attack }]), profileNotice(attack, attack),
    profileActions(attack, attack, "displayName"), profileEmpty(attack, { href: "/profile/edit/displayName", label: attack })]).html;
  assert.ok(!html.includes(attack));
  assert.match(html, /aria-labelledby="personal-heading"/);
  assert.match(html, /id="personal-heading"/);
  assert.match(html, /href="#field-displayName"/);
  assert.match(html, /href="\/profile#field-displayName"/);
  assert.equal((html.match(/type="submit"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<form|<main|<html|<script/);
  for (const href of ["javascript:alert(1)", "//evil.test", "https://evil.test", "/profile?draft=x", "/profile/edit/unknown", "/profile\\evil", "/profile\n"]) {
    assert.throws(() => profileEmpty("Empty", { href, label: "Add" }), /Unsupported/);
  }
  for (const href of ["/profile", "/profile#field-intro", "#field-intro", "/profile/edit/intro"]) {
    assert.ok(profileEmpty("Empty", { href, label: "Add" }).html.includes(`href="${href}"`));
  }
  assert.throws(() => profileRow({ key: 'x" onclick="bad' as ProfileFieldKey, label: "X", value: "Y" }), /Unsupported/);
  assert.ok(Object.isFrozen(profileHeading("title")));
});

test("U1_SCOPED: readonly projection rows render without exposing an edit route", () => {
  assert.ok(Object.isFrozen(PROFILE_FIELD_KEYS));
  assert.ok(Object.isFrozen(PROFILE_ROW_KEYS));
  assert.throws(() => (PROFILE_FIELD_KEYS as unknown as string[]).push("invented"), TypeError);
  assert.throws(() => (PROFILE_ROW_KEYS as unknown as string[]).push("invented"), TypeError);
  for (const key of ["age", "nationality", "university", "language", "area", "committed", "isProfileCompleted", "pendingFields", "employeeIdentifier", "civilExpired"] as const) {
    const html = profileRow({ key, label: attack, value: attack, metadata: attack }).html;
    assert.ok(html.includes(`id="field-${key}"`));
    assert.ok(html.includes(escaped));
    assert.ok(!html.includes(attack));
    assert.doesNotMatch(html, /href=|p-row-actions/);
    assert.throws(() => profileRow({ key, label: "Field", value: "Value", editLabel: "Edit" }), /Unsupported profile field/);
  }
});

test("U1_A11Y: phone recovery never echoes a submitted phone value", () => {
  const phone = "+96550001234";
  assert.ok(profileControl({ key: "phone", type: "tel", label: "Phone", value: phone }).html.includes(phone));
  for (const recovery of [{ error: "Invalid" }, { recovery: true }, { error: "Conflict", recovery: true }]) {
    const html = profileControl({ key: "phone", type: "tel", label: "Phone", value: phone, ...recovery }).html;
    assert.ok(!html.includes(phone));
    assert.match(html, /value=""/);
    assert.match(html, /dir="ltr"/);
  }
});

test("U1_COPY: all dictionary keys and placeholders match, every value is nonempty and interpolated safely", () => {
  const keys = Object.keys(PROFILE_COPY.en) as ProfileCopyKey[];
  assert.equal(keys.length, 198);
  assert.deepEqual(keys.sort(), Object.keys(PROFILE_COPY.ar).sort());
  const parameters = (value: string) => [...new Set(Array.from(value.matchAll(/\{([A-Za-z]+)\}/g), match => match[1]!))].sort();
  for (const key of keys) {
    const en = PROFILE_COPY.en[key], ar = PROFILE_COPY.ar[key];
    assert.ok(en.trim() && ar.trim(), key);
    assert.deepEqual(parameters(en), parameters(ar), key);
    const values = Object.fromEntries(parameters(en).map(name => [name, attack]));
    for (const language of ["en", "ar"] as const) {
      const plain = rawCopy(language, key, values);
      assert.equal(plain, PROFILE_COPY[language][key].replace(/\{[A-Za-z]+\}/g, attack));
    }
  }
  assert.equal(profileCopyText("ar", "value.open"), "أرحّب بعروض العمل");
  assert.equal(profileCopyText("ar", "field.employeeIdentifier"), "رقم StudentHub");
  assert.equal(profileCopyText("en", "field.employeeIdentifier"), "StudentHub ID");
  assert.equal(profileCopyText("ar", "meta.updated", { date: "اليوم" }), "آخر تحديث منك في اليوم");
  assert.equal(profileCopyText("ar", "help.limit", { limit: 100 }), "الحد الأقصى لعدد الأحرف: 100");
  assert.equal(profileCopyText("ar", "error.length", { limit: 5000 }), "يجب ألا يتجاوز عدد الأحرف 5000");
  assert.equal(profileCopy("en", "action.editField", { field: attack }), `Edit ${escaped}`);
  assert.equal(profileCopyText("en", "action.editField", { field: "{field}" }), "Edit {field}");
  assert.ok(Object.isFrozen(PROFILE_COPY) && Object.isFrozen(PROFILE_COPY.en) && Object.isFrozen(PROFILE_COPY.ar));
});

test("U1_COPY: rejects unknown locales, keys, missing or extra parameters and accessors", () => {
  assert.throws(() => rawCopy("xx" as ProfileLanguage, "action.save"), /language/);
  assert.throws(() => rawCopy("en", "toString" as ProfileCopyKey), /key/);
  assert.throws(() => rawCopy("en", "action.editField"), /parameters/);
  for (const value of [null, [], { field: "x", extra: "y" }, { field: Infinity }, { field: {} }, Object.create({ field: "x" })]) {
    assert.throws(() => rawCopy("en", "action.editField", value), /parameters/);
  }
  let getterRan = false;
  assert.throws(() => rawCopy("en", "action.editField", { get field() { getterRan = true; return "x"; } }), /parameters/);
  assert.equal(getterRan, false);
  assert.throws(() => rawCopy("en", "action.save", { field: "x" }), /parameters/);
});

test("U1_RTL: explicit locale direction and mixed-direction values without duplicate landmarks", () => {
  for (const [language, direction] of [["en", "ltr"], ["ar", "rtl"]] as const) {
    assert.equal(directionForProfileLanguage(language), direction);
    const html = profileShell(language, [profileHeading(profileCopyText(language, "nav.profile")),
      profileSection("personal", profileCopyText(language, "section.personal"), [profileRow({ key: "displayName", label: "الاسم", value: "Noor نور 123" })])]).html;
    assert.match(html, new RegExp(`lang="${language}" dir="${direction}"`));
    assert.match(html, /<bdi class="p-value" dir="auto">Noor نور 123<\/bdi>/);
    assert.doesNotMatch(html, /<(?:html|main)\b|skip/);
  }
  assert.throws(() => profileShell('ar" onload="bad' as ProfileLanguage, []), /language/);
  assert.match(profileRow({ key: "phone", label: "هاتف", value: "+96550001234" }).html, /<bdi class="p-value" dir="ltr">/);
  assert.equal(new Set(PROFILE_FIELD_KEYS).size, PROFILE_FIELD_KEYS.length);
});

// Execute each altered compiled implementation in a disposable ESM directory. A mutant
// counts as killed only after the same probe passed unmodified and its named assertion
// fails (not because of a syntax error, missing module, or import failure).
const probes = [
  { name: "U2B_RADIO_GROUP", target: "kit", from: '${required}>${escape(choice.label)}', to: '${required}${associations}>${escape(choice.label)}',
    assertion: `assert.doesNotMatch(kit.profileControl({key:"drivingLicence",type:"radio",label:"Licence",value:"",hint:"Choose",error:"Required",choices:[{value:"true",label:"Yes"},{value:"false",label:"No"}]}).html, /<input[^>]*aria-(?:describedby|invalid)=/, "U2B_RADIO_GROUP mutant");` },
  { name: "U1_SCOPED", target: "kit", from: ".profile-ui {", to: "body {",
    assertion: `assert.ok(kit.PROFILE_KIT_CSS.trimStart().startsWith('.profile-ui {'), 'U1_SCOPED mutant');` },
  { name: "U1_A11Y", target: "kit", from: ' aria-invalid="true"', to: ' aria-invalid="false"',
    assertion: `assert.ok(kit.profileControl({key:'displayName',label:'Name',value:'X',error:'Invalid'}).html.includes('aria-invalid="true"'), 'U1_A11Y mutant');` },
  { name: "U1_COPY", target: "copy", from: "أرحّب بعروض العمل", to: "Open to offers",
    assertion: `assert.equal(copy.profileCopyText('ar','value.open'), 'أرحّب بعروض العمل', 'U1_COPY mutant');` },
  { name: "U1_RTL", target: "copy", from: "language === 'ar' ? 'rtl' : 'ltr'", to: "language === 'ar' ? 'ltr' : 'ltr'",
    assertion: `assert.ok(kit.profileShell('ar',[]).html.includes('dir="rtl"'), 'U1_RTL mutant');` },
] as const;
for (const probe of probes) {
  test(`${probe.name}: real implementation mutant dies at its named assertion`, () => {
    const dir = mkdtempSync(join(tmpdir(), "profile-kit-mutant-"));
    try {
      const kit = readFileSync(new URL("../src/ui/profile-kit.js", import.meta.url), "utf8");
      const copy = readFileSync(new URL("../src/ui/profile-copy.js", import.meta.url), "utf8");
      writeFileSync(join(dir, "package.json"), '{"type":"module"}');
      writeFileSync(join(dir, "profile-kit.js"), kit);
      writeFileSync(join(dir, "profile-copy.js"), copy);
      const script = `import assert from 'node:assert/strict'; import * as kit from ${JSON.stringify(pathToFileURL(join(dir, "profile-kit.js")).href)}; import * as copy from ${JSON.stringify(pathToFileURL(join(dir, "profile-copy.js")).href)}; ${probe.assertion}`;
      const run = () => spawnSync(process.execPath, ["--input-type=module", "--eval", script], { encoding: "utf8", timeout: 10_000 });
      const baseline = run();
      assert.equal(baseline.error, undefined);
      assert.equal(baseline.status, 0, baseline.stderr);
      const original = probe.target === "kit" ? kit : copy;
      assert.ok(original.includes(probe.from), `mutation point present for ${probe.name}`);
      assert.equal(original.split(probe.from).length, 2, "exactly one mutation site");
      writeFileSync(join(dir, `profile-${probe.target === "kit" ? "kit" : "copy"}.js`), original.replace(probe.from, probe.to));
      const mutated = run();
      assert.equal(mutated.error, undefined);
      assert.equal(mutated.status, 1, mutated.stderr);
      assert.match(mutated.stderr, /AssertionError/);
      assert.ok(mutated.stderr.includes(`${probe.name} mutant`), mutated.stderr);
      assert.doesNotMatch(mutated.stderr, /SyntaxError|ERR_MODULE_NOT_FOUND/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}
