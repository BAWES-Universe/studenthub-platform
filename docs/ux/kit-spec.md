# Own-profile SSR kit: implementation specification

**Status:** proposed design specimens, not shipped application code or a UX acceptance claim. Scope: one authenticated person's profile summary → one-field edit → result/recovery. Read with [profile journey](profile-journey.md) and [browser-write contract](profile-contract-pack.md). No framework migration, JavaScript dependency, CDN, icon package, or build step is introduced by this specification.

## 1. Baseline and visual direction

Source inspected at [`d56843401d6ad77fc92ad77d81d32f82605d7b17`](https://github.com/BAWES-Universe/studenthub-platform/blob/d56843401d6ad77fc92ad77d81d32f82605d7b17/apps/gateway/src/web-ui.ts): document rendering at line 92, own-profile rendering at lines 329–374, and shared stylesheet at lines 377–383. The gateway already uses Inter/system fonts, blue `#2256e8`, dark text `#172433`, light canvas `#f7f9fc`, white cards, and same-origin `/assets/studenthub.css`. Preserve those recognizable choices and existing StudentHub brand markup. Inter is a preference, not a font download requirement; installed system fonts must work, including Arabic.

The change is hierarchy and interaction, not a new brand. Summary first; focused editor second. Do not repeat each value beside an always-open input. Show looking-for-work once in the identity summary; it is a person attribute, not a role. Do not use gaming decoration, decorative metrics, completion scores, generic dashboard widgets, or assume shadcn is installed. Remove contradictory read-only/import-only claims only inside this journey when editing really is enabled. Freshness and unavailable-state meaning remain accurate.

Retain the gateway context/navigation, but put this kit under a route-local `.profile-ui` wrapper; do not alter other workspace, company, login, or bank pages. The CSS below is a scoped addition to the existing served stylesheet, not an inline `<style>` block. Its shell replaces profile-specific layout classes inside that wrapper, rather than mixing both layouts. The document must have only one `<main>` and one skip target.

## 2. Tokens and layout

Proposed additions are named `--p-*`. Baseline palette values above are inherited identity; stronger control border, success, and error colors below are new accessibility-oriented specifications, not claims about existing brand tokens.

```css
.profile-ui {
  --p-ink: #172433; --p-muted: #566579;
  --p-canvas: #f7f9fc; --p-surface: #ffffff;
  --p-blue: #2256e8; --p-blue-hover: #1641be;
  --p-line: #dfe5ef; --p-control-line: #64748b;
  --p-focus: #a74400; --p-error: #a31515;
  --p-error-bg: #fff4f4; --p-success: #17643b;
  --p-success-bg: #effaf3;
  --p-space-1: .25rem; --p-space-2: .5rem;
  --p-space-3: .75rem; --p-space-4: 1rem;
  --p-space-6: 1.5rem; --p-space-8: 2rem;
  --p-radius: .65rem; --p-card-radius: 1rem;
  color: var(--p-ink); background: var(--p-canvas);
  font: 1rem/1.5 Inter, ui-sans-serif, system-ui, sans-serif;
  text-align: start;
}
.profile-ui *, .profile-ui *::before, .profile-ui *::after {
  box-sizing: border-box;
}
.profile-ui .p-shell {
  max-inline-size: 76rem; margin-inline: auto;
  padding: 1rem; display: grid; gap: 1.5rem;
  grid-template-columns: minmax(0, 1fr);
}
.profile-ui .p-main { min-inline-size: 0; max-inline-size: 56rem; }
.profile-ui .p-stack { display: grid; gap: 1.5rem; }
.profile-ui .p-header { display: grid; gap: .5rem; }
.profile-ui h1 { font-size: clamp(1.75rem, 4vw, 2.5rem); line-height: 1.2; }
.profile-ui h2 { font-size: 1.25rem; line-height: 1.35; }
.profile-ui h1, .profile-ui h2, .profile-ui p { margin: 0; }
.profile-ui p { color: inherit; }
.profile-ui .p-hint, .profile-ui .p-meta { color: var(--p-muted); }
.profile-ui .p-hint { font-size: .9375rem; }
.profile-ui .p-meta { font-size: .875rem; }
.profile-ui .p-card {
  padding: 1rem; border: 1px solid var(--p-line);
  border-radius: var(--p-card-radius); background: var(--p-surface);
  min-inline-size: 0;
}
.profile-ui .p-fields { margin: 1rem 0 0; }
.profile-ui .p-row {
  display: grid; gap: .25rem; padding-block: 1rem;
  border-block-start: 1px solid var(--p-line); min-inline-size: 0;
}
.profile-ui dt { color: var(--p-muted); font-size: .9375rem; margin: 0; }
.profile-ui dd { margin: 0; font-weight: 400; min-inline-size: 0; }
.profile-ui .p-value { overflow-wrap: anywhere; white-space: pre-wrap; }
.profile-ui .p-row-actions { margin-block-start: .5rem; }
.profile-ui .p-field { display: grid; gap: .5rem; min-inline-size: 0; }
.profile-ui label, .profile-ui legend { font-weight: 650; }
.profile-ui .p-control {
  display: block; inline-size: 100%; max-inline-size: 100%;
  min-inline-size: 0; min-block-size: 2.75rem;
  padding: .625rem .75rem; border: 1px solid var(--p-control-line);
  border-radius: var(--p-radius); background: var(--p-surface);
  color: var(--p-ink); font: inherit;
}
.profile-ui textarea.p-control { min-block-size: 8rem; resize: vertical; }
.profile-ui select.p-control { appearance: auto; }
.profile-ui .p-choice-group { border: 0; margin: 0; padding: 0; }
.profile-ui .p-choice-group legend { padding: 0; margin-block-end: .5rem; }
.profile-ui .p-choice {
  display: flex; align-items: center; gap: .75rem;
  min-block-size: 2.75rem; padding-block: .5rem; font-weight: 400;
}
.profile-ui .p-choice input {
  flex: 0 0 auto; inline-size: 1.25rem; block-size: 1.25rem;
  margin: 0; accent-color: var(--p-blue);
}
.profile-ui .p-actions { display: flex; flex-wrap: wrap; gap: .75rem; }
.profile-ui .p-button, .profile-ui .p-edit {
  display: inline-flex; align-items: center; justify-content: center;
  min-block-size: 2.75rem; padding: .625rem 1rem;
  border: 1px solid var(--p-control-line); border-radius: var(--p-radius);
  background: var(--p-surface); color: var(--p-ink);
  font: inherit; font-weight: 650; text-align: center;
  text-decoration: none; cursor: pointer; overflow-wrap: anywhere;
}
.profile-ui .p-primary { background: var(--p-blue); border-color: var(--p-blue); color: white; }
.profile-ui .p-primary:hover { background: var(--p-blue-hover); }
.profile-ui .p-edit { color: var(--p-blue); text-decoration: underline; }
.profile-ui a { text-underline-offset: .2em; }
.profile-ui :is(a, button, input, select, textarea):focus-visible,
.profile-ui [tabindex="-1"]:focus {
  outline: 3px solid var(--p-focus); outline-offset: 3px;
}
.profile-ui [aria-invalid="true"] { border: 2px solid var(--p-error); }
.profile-ui .p-error { color: var(--p-error); font-weight: 650; }
.profile-ui .p-notice { padding: 1rem; border: 1px solid; border-radius: var(--p-radius); }
.profile-ui .p-notice-error { color: var(--p-error); background: var(--p-error-bg); }
.profile-ui .p-notice-success { color: var(--p-success); background: var(--p-success-bg); }
.profile-ui .p-empty { border: 1px dashed var(--p-control-line); padding: 1rem; border-radius: var(--p-radius); }
.profile-ui .p-skip { position: absolute; inset-inline-start: 1rem; inset-block-start: -10rem; }
.profile-ui .p-skip:focus { inset-block-start: 1rem; z-index: 5; background: white; padding: 1rem; }
@media (min-width: 50rem) {
  .profile-ui .p-shell { grid-template-columns: 12rem minmax(0, 1fr); padding: 2rem; }
  .profile-ui .p-card { padding: 1.5rem; }
  .profile-ui .p-row { grid-template-columns: minmax(8rem, 1fr) minmax(0, 2fr); gap: 1rem; }
}
@media (prefers-reduced-motion: reduce) {
  .profile-ui *, .profile-ui *::before, .profile-ui *::after {
    animation: none !important; transition: none !important; scroll-behavior: auto !important;
  }
}
```

Do not add fixed heights, horizontal scroll containers, clipped card overflow, sticky Save bars, or letter-spacing to Arabic. At 320/390 CSS px the shell and rows stack; buttons wrap and field values break without widening the viewport. At desktop keep the reading measure bounded; no two-column editing form. Test zoom, long Arabic/Latin content, and native date/select widgets; CSS alone is not proof of fit. Text must meet 4.5:1 contrast (3:1 for qualifying large text), control boundaries and focus 3:1 against adjacent colors. Decorative separators may be faint but must not be the sole indication of an input. Test forced colors; retain native controls and visible outlines. There is no motion requirement.

## 3. Rendering boundaries and shell

All `{{...}}` below are **notation**, not an installed template engine. `text` means escaped HTML text; `attr` means escaped quoted attribute. Encode `& < > " '`; never interpolate raw profile text, error text, field labels, translations, or tokens as HTML. Values from validated contracts still need output escaping. `textarea` content also escapes `<` and `&` to prevent closing-tag injection. Attribute names, tag names, class names, IDs, and field keys are compile-time/allowlisted. Do not generate HTML from Markdown in profile values.

URL placeholders are server-built same-origin allowlisted routes, then attribute-escaped; HTML escaping does not make a `javascript:` URL safe. Do not trust a hidden target/field as authority. No actual signing key, cookie, credential, or token belongs in this document. Static snippets deliberately contain placeholders, not usable secrets.

Set actual document `lang` and `dir` from validated locale (`en/ltr` or `ar/rtl`), with server-resolved translations from the journey dictionary. If retained gateway chrome remains English, explicitly mark that chrome `lang="en" dir="ltr"`; do not label English strings Arabic. Profile controls, errors, notices and navigation within this journey use the selected language. Avoid assigning direction based on raw user input. Use `<bdi dir="auto">` for mixed-direction values; phone/email-like values use `dir="ltr"` when those fields eventually exist.

```html
<!-- Inside existing document body; no second main or duplicate skip link. -->
<div class="profile-ui" lang="{{locale:attr}}" dir="{{direction:attr}}">
  <a class="p-skip" href="#main">{{nav.skip:text}}</a>
  <!-- Retain existing StudentHub header/brand; localized profile-owned navigation. -->
  <div class="p-shell">
    <nav aria-label="{{nav.main:text}}">
      <a class="p-edit" href="/profile" aria-current="page">{{nav.profile:text}}</a>
    </nav>
    <main id="main" class="p-main p-stack" aria-labelledby="profile-heading">
      <header class="p-header">
        <h1 id="profile-heading">{{nav.profile:text}}</h1>
        <p>{{help.privacy:text}}</p>
      </header>
      <div id="profile-summary" class="p-stack">
        <section id="section-personal" class="p-card" aria-labelledby="personal-heading">
          <h2 id="personal-heading">{{section.personal:text}}</h2>
          <dl class="p-fields">
            <div class="p-row">
              <dt>{{field.displayName:text}}</dt>
              <dd>
                <bdi class="p-value" dir="auto">{{displayName:text}}</bdi>
                <p class="p-meta">{{accurateFreshness:text}}</p>
                <div class="p-row-actions">
                  <a class="p-edit" href="{{editDisplayNameUrl:attr}}">{{editDisplayName:text}}</a>
                </div>
              </dd>
            </div>
          </dl>
        </section>
      </div>
    </main>
  </div>
</div>
```

Copy binding to the journey's real dictionary is explicit: `editDisplayName` is `action.editField` (or `title.edit` in the heading), with translated `field.displayName`; `accurateFreshness` chooses `meta.imported`, `meta.updated` or `meta.notImported` from actual provenance; `error.displayName` selects the actual server error's `error.required`, `error.length`, `error.name`, `error.spacing`, `error.characters` or `error.invalid`; `addFieldAction` is `action.addField`; `localizedSavedReceipt` is the complete `status.saved` or `status.cleared` message populated with the translated field label and stored value. Interpolate parameters into the translated message as text, then escape; do not concatenate English fragments. Other copy placeholders use dictionary keys directly. Future phone/checkbox placeholders are intentionally unbound and must never render in this slice; any later field requires its own approved real translations. Structure IDs agreed with the journey: `section-personal`, `section-work`, `section-background`, `section-details`; empty sections are omitted rather than filled with fictional data. Each section heading ID is unique. Give Edit links a distinct visible label, e.g. “Edit display name”, using the equivalent complete Arabic phrase, not repeated ambiguous “Edit”. Render Edit only if this field is currently editable by this actor through the approved contract. Language's existing preference contract is not silently migrated by this kit.

## 4. One-field editor and controls

Replace the summary with the focused editor on a navigable server-rendered page (no modal requirement). Keep the profile context and a return link. One visible field and **one Save** submit. The form's `action` below is the future U2a/U2b route chosen in the contract, NOT the existing `/profile/edit/preview` route relabeled as a one-step save. The contract pack proposes `GET /profile/edit/:field` and `POST /profile/edit/:field/save`; these are new route seams, not baseline endpoints. Until U2a is implemented and verified, existing explicit preview/confirm remains unchanged.

```html
<section class="p-card p-stack" aria-labelledby="profile-edit-heading">
  <h1 id="profile-edit-heading">{{editDisplayName:text}}</h1>
  <form id="profile-edit-form" class="p-stack" method="post"
        action="{{approvedOneFieldWriteRoute:attr}}">
    <input type="hidden" name="field" value="displayName">
    <input type="hidden" name="formToken" value="{{serverIssuedBoundToken:attr}}">
    <input type="hidden" name="csrfToken" value="{{serverIssuedCsrfToken:attr}}">
    <input type="hidden" name="idempotencyKey" value="{{serverIssuedOperationKey:attr}}">
    <div class="p-field">
      <label for="field-displayName">{{field.displayName:text}}</label>
      <p id="field-displayName-hint" class="p-hint">{{help.name:text}}</p>
      <input class="p-control" id="field-displayName" name="value" type="text"
             dir="auto" autocomplete="name"
             value="{{authorizedDraftOrStoredValue:attr}}"
             aria-describedby="field-displayName-hint">
    </div>
    <div class="p-actions">
      <button class="p-button p-primary" type="submit">{{action.save:text}}</button>
      <a class="p-button" href="{{safeSummaryReturnUrl:attr}}">{{action.cancel:text}}</a>
    </div>
  </form>
</section>
```

Hidden names are proposed form-wire names to reconcile with U2a, not a claim that current handlers accept them. Server validates authentication, authorization, CSRF/origin, signed expiring purpose/version/actor/target/allowed-field/baseline token, canonicalization and payload-bound idempotency. Hidden fields and native validation do not provide those guarantees. Use POST for writes; Cancel is GET and must never commit. Do not put draft values or signed form tokens into query strings, analytics, or logs.

Control variants below **replace** the editor's single field, never accumulate into a multi-field Save. Labels/help/error IDs follow `field-{allowlistedKey}`. Use server-contract lengths/enums/requiredness, not arbitrary browser-only restrictions. Do not add native `maxlength`: HTML counts UTF-16 code units while this backend counts Unicode code points, so it would reject some valid supplementary Unicode. Show localized `help.limit` (255 for names, 5000 for intro), validate authoritatively on the server and preserve the entire authorized draft. Any optional client count must match backend code-point semantics and must not truncate input. Native validation is supplemental; server errors are authoritative. Preserve authorized draft text on correction without truncation. NFC normalization follows the contract; do not trim or collapse whitespace unless the field contract explicitly allows it. The current intro contract rejects control characters/newlines: a textarea is not permission to store multiline content. Preserve such a draft on the correction page and show its localized rule; broadening that contract is separate work.

```html
<!-- Select: exact enums verified in pinned web-ui.ts lines 367–369; localized labels. -->
<label for="field-jobSearchStatus">{{field.jobSearchStatus:text}}</label>
<select class="p-control" id="field-jobSearchStatus" name="value" required>
  <option value="">{{help.chooseStatus:text}}</option>
  <option value="not_looking">{{value.notLooking:text}}</option>
  <option value="active">{{value.active:text}}</option>
  <option value="open_to_offers">{{value.open:text}}</option>
</select>
<!-- Render `selected` only as a static attribute after exact enum comparison. -->

<label for="field-birthDate">{{field.birthDate:text}}</label>
<p id="field-birthDate-hint" class="p-hint">{{help.date:text}}</p>
<input class="p-control" id="field-birthDate" name="value" type="date"
       autocomplete="bday" value="{{isoDateOrEmpty:attr}}"
       aria-describedby="field-birthDate-hint">

<label for="field-intro">{{field.intro:text}}</label>
<textarea class="p-control" id="field-intro" name="value" dir="auto"
          rows="6">{{introDraft:text}}</textarea>

<fieldset class="p-choice-group">
  <legend>{{field.drivingLicence:text}}</legend>
  <label class="p-choice" for="field-drivingLicence">
    <input id="field-drivingLicence" type="radio" name="value" value="true" required>
    {{value.yes:text}}
  </label>
  <label class="p-choice" for="field-drivingLicence-no">
    <input id="field-drivingLicence-no" type="radio" name="value" value="false" required>
    {{value.no:text}}
  </label>
</fieldset>
```

Render `checked`/`selected` from exact validated comparisons; never from arbitrary attribute strings. Do not preselect “No” for an unavailable boolean. For dates, native presentation may follow browser locale; transmitted value is ISO date, not a timezone-shifted timestamp. Server rejects impossible/rolled-over dates and applies the minimum-age-16 rule without inventing an upper age cap. Do not silently reinterpret locale-formatted strings. For gender, use the current explicit enum and translated labels; a radio group gets its own legend and first-radio target as above.

Two additional reusable specimens are deliberately **not current profile fields**:

```html
<!-- Future phone only after projection + write contract + journey approval exist. -->
<label for="field-phone">{{futurePhoneLabel:text}}</label>
<p id="field-phone-hint" class="p-hint">{{explicitCountryAndFormatHint:text}}</p>
<input class="p-control" id="field-phone" name="value" type="tel"
       inputmode="tel" autocomplete="tel" dir="ltr"
       value="{{authorizedPhoneDraft:attr}}" aria-describedby="field-phone-hint">

<!-- Optional presentation preference, never silently mapped to a profile boolean. -->
<label class="p-choice" for="profile-example-checkbox">
  <input id="profile-example-checkbox" type="checkbox" name="examplePreference" value="true">
  {{futureCheckboxLabel:text}}
</label>
```

Phone is not `type="number"`; preserve `+`, leading zeros and entered formatting during correction. Never infer a different country silently. No phone input is emitted until its schema/contract lands. A checkbox is valid only where the approved contract defines unchecked as false and has no unknown state. Do not pair hidden `false` and checkbox `true` with the same name and depend on ambiguous parser ordering. Current driving-licence unknown/yes/no semantics use radio choices, not this checkbox. The checkbox specimen demonstrates visual treatment, not an extra saved preference.

## 5. Error, receipt and empty state

Validation: return the same one-field editor with escaped authorized draft, error summary before the form, specific inline error and associations. Add `aria-invalid="true"` and append the error ID to that control's `aria-describedby`. For groups, apply error description to the fieldset and relevant inputs. Do not expose raw exceptions or sensitive values.

```html
<section id="profile-error-summary" class="p-notice p-notice-error"
         aria-labelledby="profile-error-heading" tabindex="-1">
  <h2 id="profile-error-heading">{{state.invalid:text}}</h2>
  <a href="#field-displayName">{{error.displayName:text}}</a>
</section>
<!-- Place within p-field after its input, only on invalid response. -->
<p id="field-displayName-error" class="p-error">{{error.displayName:text}}</p>
<!-- Invalid input additionally has:
 aria-invalid="true"
 aria-describedby="field-displayName-hint field-displayName-error" -->

<section id="profile-notice" class="p-notice p-notice-success"
         aria-labelledby="profile-notice-heading" tabindex="-1">
  <h2 id="profile-notice-heading">{{nav.profile:text}}</h2>
  <p><bdi class="p-value" dir="auto">{{localizedSavedReceipt:text}}</bdi></p>
</section>

<div class="p-empty">
  <p>{{state.empty:text}}</p>
  <a class="p-edit" href="{{authorizedEditUrl:attr}}">{{addFieldAction:text}}</a>
</div>
```

A receipt notice appears only after durable confirmed success, displaying stored canonical value, not the raw submitted guess. Do not display success on a timeout/unknown outcome; offer safe receipt recovery with the original operation identity. No automatic new-key retry. A legitimately empty stored value has its own translated description, not a fabricated value. Missing/unavailable source values are not the same as user-cleared empty values. Empty-state Add appears only for an editable field; unavailable or revoked data must not be echoed.

Conflict keeps the authorized draft and presents the current value with explicit review/reload choice; do not silently overwrite, auto-merge, or disable Save indefinitely. Expired session is a sign-in/recovery state without private draft echo; unavailable is a generic non-disclosing state when authorization fails. Detailed copy and six-state flow live in the journey; transactional/retry semantics live in the contract pack.

## 6. Focus, localization and acceptance boundary

- Standard SSR page navigation works without script. Give each response a descriptive translated document title; error title starts with its error meaning. Put error summary or saved notice early in main reading order. Native links to `#field-*` remain usable.
- For invalid full-page response, render `autofocus` on **only** `profile-error-summary` (a focusable `tabindex="-1"` element); ready edit may focus its first control. A saved response can focus `profile-notice`. This is conditional HTML, never all three at once. Browser/assistive-technology behavior must be checked; `tabindex` alone does not move focus. If native autofocus is unreliable, document that finding and implement only an approved same-origin CSP-compatible progressive focus helper. Essential correction remains accessible in source order without it.
- Cancel returns to the corresponding summary field/section anchor; browser Back/Forward must not unexpectedly submit again. Do not depend on transient client state for drafts/receipts. A status region added during a JS enhancement may use `role="status"`; a full-page static notice is not guaranteed announced just because it has a live-region attribute.
- Every input has a visible label; every radio group has a legend; hints/errors have stable IDs. Requiredness is conveyed in localized visible copy, not color alone. Buttons/links and choice labels provide at least 44 CSS px block-size targets. Do not use placeholders as labels, fake select controls, disabled-until-valid Save, positive tabindex, or focus traps.
- Arabic comes from the real dictionary in [profile journey](profile-journey.md), including every hint, error, choice and notice. No raw English `Yes`, `Save`, timestamps or enum codes in the Arabic journey. Localize dates for display but preserve canonical values in controls and contracts. Use complete translated phrases rather than concatenating words around values.
- Verify 320 px, 390 px and desktop at the exact candidate, keyboard view/edit/save/error/cancel, focus, mixed-direction values, long names, zoom, back/forward and ready/empty/invalid/conflict/unavailable/expired states. Preserve existing company directory behavior; no broad CSS selectors or layout regressions outside the profile wrapper.

**Evidence for this document:** source and v3 plan read; design/spec review only. No application code, tests, screenshot, browser run or deployment was executed for this kit. No contrast/RTL/device acceptance is claimed from these specimens. Rendered-HTML checks can support “landed”; only the exact-candidate browser evidence prescribed in the journey supports “UX accepted”. Independent cross-family review remains required; this author is not that independent reviewer.
