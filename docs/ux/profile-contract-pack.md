# Profile contract pack — proposed adoption, not executable dispatch

**Source baseline:** `BAWES-Universe/studenthub-platform@d56843401d6ad77fc92ad77d81d32f82605d7b17` (2 November 2026). **Status:** docs-only proposal; no application change, test run, dispatch, merge, deployment or independent PASS is represented here. Read with [profile journey](profile-journey.md) and [minimal kit](kit-spec.md). The coordinator translates these proposals into the existing contract format only after preflight; this document changes no `.github` contract.

The intended result is one person completing **view → edit one field → Save → understand the result → recover safely**, not another administration form or a framework rewrite. Basic self-profile ownership must not depend on a candidate business-role grant. Looking for work is profile status, not an authorization role. Other sensitive actions retain explicit review/confirm.

## 1. Source facts and boundaries

At the pinned baseline, `packages/profile/src/self-edit.ts`, `apps/gateway/src/profile-edit-http.ts` and `packages/db/src/person-profile-store.ts` support exactly nine self-edit fields: `displayName`, `arabicName`, `objective`, `intro`, `preferredTime`, `gender`, `birthDate`, `drivingLicence`, `jobSearchStatus`. Language preference is a separate existing capability. Phone/handle and origin/nationality/university/mother fields under current work are **not** silently adopted as landed. Background records are another existing flow; do not rewrite them into this field contract.

The existing `packages/safe-write-contract/README.md` describes an explicit preview binding both before and after, durable token consumption, ownership checks before reads and inside commit, and atomic receipt creation. Its historical opening “everything reads” is not current capability evidence. The current profile HTML flow posts to `/profile/edit/preview`, then `/profile/edit/confirm`, then redirects to `/profile`. These APIs and their existing callers remain unchanged. Browser single-Save is a **new contract**, not a new server-side preview hidden inside the old confirm request.

The current store reads platform-owned persisted fields; `readOwnPreferences` exposes only fields with a write timestamp. Clearing optional text persists SQL `NULL`. Imported presentation fallback and localized missing-value strings are therefore not interchangeable with stored baseline values. The new form must bind both the provenance/presentation the person saw and the persisted field comparison state. A display label such as “Not recorded” is never used as a database CAS operand. If an imported value changes while it remains the shown fallback, the baseline is stale even if the platform-owned field remains null; bind its source revision/value digest too, or prevent that unresolved fallback edit until a truthful baseline can be established.

### Field canonicalization and correction matrix

**Current rules are retained, not broadened by design prose.** `normalizePersonSelfEditValue` applies Unicode NFC and counts Unicode code points after NFC. Existing SQL constraints in migrations `0211_person_profiles.sql` and `0212_person_profiles_choices.sql` must agree with the new path. HTML `maxlength` counts UTF-16 units, unlike these rules: do not silently truncate or prematurely block valid supplementary characters. The authoritative limit is the server's code-point rule; any browser limit must be equivalence-tested.

| Field | Allowed canonical representation | Correction required / current limits |
|---|---|---|
| `displayName` | NFC only | Required, at most 255 code points; current name grammar requires at least two letter/mark words, ASCII single-space separators and permitted internal apostrophe/hyphen/period. Do not invent a new minimum/maximum word count or silently repair spelling. |
| `arabicName` | NFC; explicit empty input clears to null | At most 255; same name grammar and existing Arabic-letter requirement. This is not a new Arabic-only-letter restriction: preserve the actual validator. |
| `objective` | NFC; empty clears | At most 100; edge whitespace, repeated whitespace and forbidden controls need correction, not trimming. |
| `intro` | NFC; empty clears | At most 5,000; despite the current textarea, newlines/control characters and repeated whitespace are currently rejected. Multiline prose needs a separately reviewed validator/storage change, not a UI promise. |
| `preferredTime` | NFC; empty clears | At most 100; same existing whitespace/control restrictions. Do not reinterpret natural-language availability as a schedule. |
| `gender` | Exact codes `male`, `female`, `other` | No case-folding, translated labels as stored values or implicit blank. |
| `birthDate` | Exact valid Gregorian `YYYY-MM-DD` | No rollover, locale guessing, timezone day shift or clearing. New edits enforce minimum age 16 using the existing Asia/Kuwait date policy; no maximum age. Historical stored dates remain renderable, including older people; read rendering must not run write eligibility validation or crash. |
| `drivingLicence` | Exact transport strings `true` / `false`, persisted boolean | No truthy coercion of `yes`, `1`, or empty. |
| `jobSearchStatus` | Exact `not_looking`, `active`, `open_to_offers` | No role/grant mutation or translated label persistence. |
| Language | Existing separate language preference capability | Do not sneak it into the nine-field API or change its protocol. Localize this journey using the existing preference. |
| Phone / new reference fields | Deferred until their actual landed contracts are reconciled | E.164 is not blanket permission to guess country or strip significant digits; require explicit approved country interpretation. Reference fields use existing approved identifiers, not invented free-text conversion. |

For every existing text field, NFC is allowed; **trim and collapse-whitespace are not allowed transformations**. Forbidden controls and bidi format controls remain correction-required under the actual validator. Escaping/bidi isolation is rendering, not a stored-value rewrite. No truncation. A normalization equivalent under NFC can share the same canonical request fingerprint; a meaning-changing input cannot. Test composed/decomposed letters, boundary lengths including supplementary characters, single/double spaces, NBSP edges, newline/control and bidi canaries. Preserve raw draft on authorized validation failure; show the stored canonical value on success without adding raw values to shareable receipts/audit logs.

## 2. Adoption preflight and candidate path ownership

**Do before dispatch, not after the first implementation commit:** pin current main and candidate source, reconcile PR #237, inspect active attempts and queued pathsets plus open PRs, reserve all new and integration paths with owner/family/time/migration range, prove the named test environment can run, and freeze contract inputs/outputs. Historical non-overlap at this document's SHA is not a future reservation. The coordinator owns `contracts/reservations.md`; this pack does not edit it. Reconcile the existing parity/navigation documents rather than creating a competing inventory.

PR #237 (“Candidates edit their own profile fields through the safe write”) is a coordinator-owned adoption decision **before U2b**: adopt compatible pieces after review or close/supersede with a note. Do not merge its stale implementation/schema as a prerequisite. U2a's protocol, today's nine-field storage and current source baseline govern reconciliation.

Below are **candidate exact paths, not granted implementation scope**. Existing-file names must be verified at dispatch; reserve the minimum actual set and expand/re-cut explicitly when a required seam is missing. New migration number is deliberately not invented: allocator must reserve its exact filename before work. Source and test counts below are planning inventories, not a 400-line cap; store and page are separate cards by default. A combined card needs a written reason and runnable acceptance, not an arbitrary line allowance.

| Slice / dependency | Candidate implementation and test paths | Completion boundary |
|---|---|---|
| **U1 minimal kit**, independent of U2a | `apps/gateway/src/ui/tokens.ts`; `apps/gateway/src/ui/shell.ts`; `apps/gateway/src/ui/profile-primitives.ts`; `apps/gateway/src/ui/profile-copy.ts`; `apps/gateway/test/profile-ui-kit.test.ts`; integration `apps/gateway/src/web-ui.ts` | Only shell/section/row/control/buttons/errors/saved/empty for this journey. `ui/tokens.ts` exports scoped CSS text consumed by the existing `/assets/studenthub.css` string response; no new browser bundler or filesystem CSS-copy step. Adding an unserved stylesheet is not completion. No general design-system expansion. Render tests prove both language directions and accessible relationships. |
| **U2a browser contract + store**, independent of U1 | `packages/safe-write-contract/src/browser-write.ts`; `packages/safe-write-contract/src/index.ts`; `packages/safe-write-contract/test/browser-write.test.ts`; `packages/db/src/person-profile-browser-write-store.ts`; `packages/db/src/index.ts`; `packages/db/test/person-profile-browser-write-store.test.ts`; narrowly necessary policy reuse in `packages/profile/src/self-edit.ts`; exact allocated additive migration; affected build/test inventory paths identified below | Protocol and PostgreSQL atomicity proven; no HTML/page implementation. Existing preview/confirm behavior and schema validators stay compatible. If store scope exceeds a reviewable unit, split contract/store with explicit dependency, not a page-plus-store shortcut. |
| **U2b one-field Save**, after U1 + U2a and PR #237 reconciliation | `apps/gateway/src/profile-browser-edit-http.ts`; `apps/gateway/test/profile-browser-edit-http.test.ts`; route/composition seams `apps/gateway/src/index.ts`, `apps/gateway/src/web-ui.ts`; existing runtime injection seam identified at dispatch | One edit form, one field, one Save, Cancel, authorized draft-preserving recovery and receipt-backed success. No multi-field atomicity claim. |
| **U3a coherent profile journey**, after U1 + U2b | `apps/gateway/src/web-ui.ts`; `apps/gateway/src/ui/profile-copy.ts`; `apps/gateway/test/profile-journey.test.ts`; `apps/gateway/test/profile-journey.browser.spec.ts`; `apps/gateway/test/profile-journey-driver.ts` | View hierarchy, current truthful copy and real Arabic; six-state rendered tests. Browser evidence separately gates “UX accepted.” Browser files are proposed future paths, not files delivered by this docs pack. |

Shared `web-ui.ts`, copy, exports, migrations, package/build scripts and test inventory are **integration seams**, not invisible free edits. U1 and U2a can be independent only if their final effective reservations do not overlap; U2b/U3a serialize their shared edits. Inspect `tools/test-runner/discover.mjs` and its baseline inventory before adding tests; reserve any required exact inventory/build path. Root `package.json`, package manifests, `tsconfig.build.json`, and CI files are conditional seams, not automatic permission. Do not broaden to `apps/**` or `packages/**` merely to avoid preflight.

Proposed browser route convention: **GET `/profile/edit/:field`**, **POST `/profile/edit/:field/save`**. This is a future route namespace; existing source does not implement it. Target is derived from authenticated self, not a freely selectable person identifier. Retain old `/profile/edit/preview`, `/profile/edit/confirm` and receipt routes unchanged. The coordinator may select another namespace before dispatch only by updating all three docs and the route contract together.

## 3. U2a normative browser-write protocol

### Binding and request identity

A read-only form render reauthorizes the caller and issues a signed, expiring, purpose/version-specific token. Bind actor, self target, exactly one allowed field, baseline digest (including persisted null/empty semantics and displayed fallback provenance), issued/expiry times and nonce. The server—not hidden inputs—chooses authority. Never bind only the server's freshly reread submit-time value. A submitted added/substituted field or target is refused; no multi-field array or partial success path exists.

Save posts token + field value + high-entropy idempotency key using the exact documented request shape. Reject duplicate form keys, unexpected fields, unsupported content types and oversized requests. Preserve strict same-origin/CSRF defenses, safe session cookie handling, no-store responses, escaping and non-leaking errors.

Key scope is actor + browser-write operation. Durable fingerprint includes contract version, target, field, canonical payload and original token/baseline identity. **Same key with a different target, field, token intent or canonical value is `409 IDEMPOTENCY_CONFLICT`**, not a new operation. NFC-equivalent raw strings may match only under the frozen normalization version. Do not scope the key by target or field in a way that makes their substitution invisible. **Recommended adoption defaults:** five-minute first-write token lifetime, matching `DEFAULT_TOKEN_LIFETIME_MS = 5 * 60 * 1000` in the pinned `packages/safe-write-contract/src/safe-write.ts`; expiry comparison is inclusive (`now >= expiresAt` refuses a new write). Use at least seven days of durable idempotency-key/fingerprint-to-receipt recovery metadata as a **new proposed policy**, not an inherited setting. The current person-profile store reads receipts from mutation audit and has no receipt-pruning policy in that source; do not delete audit history or introduce a purge job through this slice. Recovery metadata may remain longer until a separately approved retention policy exists. Preserve durable token-consumption evidence so later eviction never makes the old token reusable. Record these defaults in the adopted contract and test boundary clocks; UI copy must not promise recovery beyond actual retained evidence.

### Order and transaction

1. Authenticate, validate origin/CSRF and reauthorize current access **before any sensitive baseline read, conflict detail or receipt recovery**. Revoked/expired sessions receive a generic response with no current values, no old draft echo and no existence/replay detail. Basic self access uses the real self policy, not an invented candidate grant.
2. Validate token authenticity/purpose/version/actor/target/field binding and strict input shape; canonicalize using the frozen per-field policy. Check an existing durable key record and compare the fingerprint **before baseline freshness checks**. Lookup must be authorized; guessed keys are not receipt access tokens.
3. For a matching committed record, return the **original** receipt. Reauthorize receipt reads as well. This recovery never mutates, reruns CAS, spends another token or emits another audit event. A validly signed previously issued token that is now consumed or past its original write expiry can recover its own committed receipt while its retained binding is verifiable and current authorization holds. Token expiry may not convert a confirmed write into stale failure. Invalid/forged binding cannot recover, and a missing receipt plus expired/consumed token never permits a new mutation. If necessary verification/retention evidence has expired, report unavailable/unknown safely; do not regenerate a write.
4. With no matching committed record, enforce unexpired unused token and current field policy. In **one database transaction**, serialize/reserve the actor-operation-key, recheck current authorization, compare the signed baseline, mutate exactly one field, consume token, insert safe audit row and durable receipt/fingerprint. Unique constraints and locks must resolve two concurrent requests across separate processes. A committed key discovered after waiting returns its receipt, not stale baseline. A no-op still cannot consume the same token twice.
5. Failure of mutation, audit, receipt or token persistence rolls the whole transaction back. A true rollback remains retryable; a lost connection around COMMIT is **unknown**, not asserted rollback. Retry the original key and original request to establish whether it committed. Never generate a new key automatically to escape an uncertain result.

Receipt/audit metadata remain positionally allowlisted references, field code, digest/version and timestamps—not raw name/date, authentication subject/email, draft or current record contents. A success UI can show the stored value through an authorized response/read; that does not expand the shareable receipt schema. If a later edit already changed the field, distinguish the original operation's confirmed result from the current value; don't falsely present a newer value as the saved payload.

### User recovery contract

Invalid: preserve authorized raw draft, field error and focus; nothing committed. Conflict: after reauthorization, show baseline/current/draft with clear choice to reload current or deliberately retry against a newly shown baseline; never silently overwrite or auto-refresh token then write. Unavailable/unknown outcome: keep authorized draft and original request identity, explain uncertainty, recover receipt first. Expired session/revoked: generic sign-in/no-longer-available surface, no sensitive echo or automatic replay after re-login. Cancel does not write. Back/forward restores a safe view/form but must not resubmit automatically. Use native form-POST rerendering for authorized validation/conflict/error draft retention. This pilot does not require a server-side draft table/service, browser persistent storage or cross-login restoration. Do not put values in URLs. Reload/logout survival is not promised; explain reentry honestly when recovery is unavailable. Cancel discards an unsaved field draft without writing; an optional navigation warning must be bounded and accessible. These are field forms; section grouping is visual, not a multi-field Save.

## 4. Required named tests and truthful evidence

All names below prefixed `BW-` / `PJ-` are **proposed acceptance names**, not claims that tests already exist.

- `BW-token-binding`: signature forgery, purpose/version/actor/target/field substitution, extra field, duplicate keys, expiry on first write.
- `BW-canonicalization`: every matrix rule, NFC-equivalent replay, meaning-changing refusals, clear-to-null, text/SQL boundary agreement and historical birth-date rendering.
- `BW-receipt-before-baseline`: commit A, later edit B, replay A returns original receipt without mutation; consumed/expired issued-token recovery, absent-receipt expired-token refusal.
- `BW-idempotency-conflict`: same actor/operation/key with changed canonical value, field, target or intent returns 409, no second commit.
- `BW-concurrent-one-commit`: two connections/processes, identical request, exactly one mutation/audit/token consumption/receipt; include same-value no-op and waiting-transaction race.
- `BW-unknown-commit`: drop response after actual COMMIT, retry original key, prove one durable result; separately fail before commit and prove retry succeeds once.
- `BW-atomic-failures`: inject mutation/audit/receipt/token persistence failures and assert rollback, including authorization revocation during the race window.
- `BW-no-leaks-after-revocation`: before submit, before conflict detail, before receipt replay/read; generic response contains no canary current/draft/receipt contents.
- `BW-stale-baseline`: two tabs, imported fallback change, null-vs-empty handling; no silent overwrite.
- `BW-origin-and-session`: hostile/missing origin, cross-site request, session expiry and wrong actor; zero mutations.
- `PJ-six-states`, `PJ-arabic-copy-and-bidi`, `PJ-keyboard-navigation`, `PJ-retry-double-submit`, `PJ-history`: the browser matrix below.
- Existing explicit preview/confirm regression suites remain mandatory. Attack each important guarantee with a deliberately faulty implementation/mutation, checking the intended assertion fails rather than an earlier unrelated guard.

Verified commands in root `package.json` at the source SHA (listed **not executed**):

```sh
npm run typecheck
npm test
npm run test:db
npm run test:web
npm run test:profile:mutations
```

`test:db` builds then uses `tools/test-runner/run.mjs --db`; discovery asserts its baseline inventory. `test:web` expects built outputs (build first as required by the adopted check plan). No current `npm run test:profile-browser` or Playwright script is claimed. The browser command is established only when its dependencies/configuration/driver exist. Record the actual command, runner version, PostgreSQL version, migrated schema and final candidate SHA in evidence. Pinned CI `.github/workflows/ci.yml` uses `postgres:17-alpine`; use a real disposable PostgreSQL 17 matching that baseline and required migration features (including collation/NFC support). Confirm deployment-version compatibility separately rather than assuming the briefing’s PostgreSQL 16 or an unknown production version. A mock is not concurrency or migration proof. No database configured or skipped tests = **not run**, not PASS. Do not run migrations against production/live data for this exercise.

## 5. Browser acceptance driver — proposed executable interface

The following is a TypeScript Playwright-style spec **embedded only in Markdown**, not an installed runner. It becomes runnable when the build thread supplies `@playwright/test`, config, a dedicated disposable deployed/preview candidate and an implementation of the interface below. No fake login credentials or production admin endpoint is implied.

Fixture/admin prerequisites: synthetic principals with deterministic language/fields; approved isolated session injection through the real authentication boundary; test-only seeded database and audit counters; controlled revocation/expiry and service failure; a server-side fault that commits then drops the response; isolated cleanup. Admin controls stay outside public application routes and must fail closed outside test environments. Pin candidate SHA and synthetic data revision. The driver must use real browser clicks/keyboard and inspect durable database evidence—not replace application actions with mocks or merely return true. Each assertion method throws on mismatch and saves diagnostics. Implementations and complete selectors must be reviewed before marking any test run.

```ts
import { test, type Page } from '@playwright/test';
import { makeProfileDriver } from './profile-journey-driver'; // PROPOSED, not present

type Language = 'en' | 'ar';
type State = 'ready' | 'empty' | 'invalid' | 'conflict' | 'unavailable' | 'expired-session';
interface ProfileDriver {
  setup(input: { language: Language; state: State }): Promise<void>;
  openProfile(): Promise<void>;
  // Uses Tab/Shift+Tab/Enter/Space, asserts visible focus at every step.
  keyboardViewEditSaveErrorCancel(): Promise<void>;
  assertState(state: State): Promise<void>;
  assertLanguageAndDirection(language: Language): Promise<void>;
  assertNoUntranslatedJourneyStrings(): Promise<void>;
  assertMixedDirectionValues(): Promise<void>;
  assertNoHorizontalOverflowOrClippedActions(): Promise<void>;
  backForwardWithoutWrite(): Promise<void>;
  screenshot(name: string): Promise<void>;
  doubleSubmitSameRequest(): Promise<void>;
  twoTabsStaleDraft(): Promise<void>;
  dropResponseAfterCommitThenRetryOriginalRequest(): Promise<void>;
  assertSingleDurableOutcome(): Promise<void>;
  assertNoWrites(): Promise<void>;
  teardown(): Promise<void>;
}
// makeProfileDriver(page: Page, { candidateSha: string }): Promise<ProfileDriver>
// Driver must verify candidateSha against deployment evidence; never default to main.
const sha = process.env.PROFILE_CANDIDATE_SHA;
if (!sha || !/^[0-9a-f]{40}$/.test(sha)) throw new Error('Exact candidate SHA required');
const states: State[] = ['ready','empty','invalid','conflict','unavailable','expired-session'];
for (const language of ['en', 'ar'] as const) {
  for (const width of [320, 390, 1280]) {
    for (const state of states) {
      test(`PJ-six-states ${language} ${width} ${state}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const d: ProfileDriver = await makeProfileDriver(page, { candidateSha: sha });
        try {
          await d.setup({ language, state });
          await d.openProfile();
          await d.assertState(state);
          await d.assertLanguageAndDirection(language);
          await d.assertNoUntranslatedJourneyStrings();
          await d.assertMixedDirectionValues();
          await d.assertNoHorizontalOverflowOrClippedActions();
          await d.screenshot(`profile-${sha}-${language}-${width}-${state}`);
          await d.assertNoWrites(); // Setup admin writes excluded from measured window.
        } finally { await d.teardown(); }
      });
    }
    test(`PJ-keyboard-history ${language} ${width}`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      const d: ProfileDriver = await makeProfileDriver(page, { candidateSha: sha });
      try {
        await d.setup({ language, state: 'ready' });
        await d.openProfile();
        await d.keyboardViewEditSaveErrorCancel();
        await d.backForwardWithoutWrite(); // Compare counters before/after history, not all-time zero.
      } finally { await d.teardown(); }
    });
    for (const scenario of ['double-submit','two-tabs','unknown-commit'] as const) {
      test(`PJ-recovery ${language} ${width} ${scenario}`, async ({ page }) => {
        await page.setViewportSize({ width, height: 900 });
        const d: ProfileDriver = await makeProfileDriver(page, { candidateSha: sha });
        try {
          await d.setup({ language, state: 'ready' });
          await d.openProfile();
          if (scenario === 'double-submit') await d.doubleSubmitSameRequest();
          if (scenario === 'two-tabs') await d.twoTabsStaleDraft();
          if (scenario === 'unknown-commit') await d.dropResponseAfterCommitThenRetryOriginalRequest();
          await d.assertSingleDurableOutcome(); // two-tabs: only first tab writes; second stays conflict.
          await d.screenshot(`recovery-${sha}-${language}-${width}-${scenario}`);
        } finally { await d.teardown(); }
      });
    }
  }
}
```

### Concrete browser example: real DOM actions and assertions

This example supplements—not replaces—the full matrix above. It uses the kit's agreed IDs and proposed URLs. The only fixture port is synthetic authenticated setup, durable result inspection and cleanup; clicks, invalid input, navigation, success and Cancel are asserted directly. It is **not runnable in this docs-only PR**: the adopted runner must implement `profileFixture` against its isolated auth/database environment and install Playwright. The English example should also be parameterized with the journey dictionary for Arabic rather than locating Arabic controls by English labels. `seed` establishes the fixture before the measured window. `writeEvidence` returns counts for profile operations after that seed, not setup SQL.

```ts
import { test, expect } from '@playwright/test';
import { profileFixture } from './profile-journey-fixture'; // PROPOSED fixture port
// profileFixture(page, { candidateSha }) returns:
// seed({ language, displayName }): Promise<void> -- authenticated synthetic self only
// writeEvidence(): Promise<{ storedDisplayName: string; mutations: number;
//                            audits: number; receipts: number; consumedTokens: number }>
// cleanup(): Promise<void>
test('PJ-save-invalid-cancel through actual profile DOM', async ({ page }) => {
  const candidateSha = process.env.PROFILE_CANDIDATE_SHA;
  if (!candidateSha || !/^[0-9a-f]{40}$/.test(candidateSha)) throw new Error('Exact SHA required');
  const fixture = await profileFixture(page, { candidateSha });
  try {
    await fixture.seed({ language: 'en', displayName: 'Noor Al-Sabah' });
    await page.goto('/profile'); // baseURL must point at the verified isolated candidate.
    await expect(page.locator('#profile-summary')).toContainText('Noor Al-Sabah');
    await page.locator('#profile-summary a[href="/profile/edit/displayName"]').click();
    await expect(page).toHaveURL(/\/profile\/edit\/displayName$/);
    const form = page.locator('#profile-edit-form');
    await expect(form).toHaveAttribute('method', /post/i);
    await expect(form).toHaveAttribute('action', '/profile/edit/displayName/save');
    await expect(page.locator('#field-displayName')).toHaveValue('Noor Al-Sabah');
    await page.locator('#field-displayName').fill('Noor Al-Hamad');
    await form.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page).toHaveURL(/\/profile(?:\?[^#]*)?(?:#.*)?$/);
    await expect(page.locator('#profile-notice')).toBeVisible();
    await expect(page.locator('#profile-notice')).toContainText('Noor Al-Hamad');
    await expect(page.locator('#profile-summary')).toContainText('Noor Al-Hamad');
    const committed = await fixture.writeEvidence();
    expect(committed).toEqual({ storedDisplayName: 'Noor Al-Hamad', mutations: 1,
      audits: 1, receipts: 1, consumedTokens: 1 });

    await page.locator('#profile-summary a[href="/profile/edit/displayName"]').click();
    await page.locator('#field-displayName').fill('Noor  Al-Hamad'); // forbidden double space
    await page.locator('#profile-edit-form').getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('#profile-error-summary')).toBeVisible();
    await expect(page.locator('#field-displayName')).toHaveValue('Noor  Al-Hamad');
    await expect(page.locator('#field-displayName')).toHaveAttribute('aria-invalid', 'true');
    await expect(page.locator('#field-displayName')).toHaveAttribute('aria-describedby', /field-displayName-error/);
    await expect(page.locator('#field-displayName-error')).toBeVisible();
    expect(await fixture.writeEvidence()).toEqual(committed); // invalid save wrote nothing
    await page.locator('#profile-edit-form').getByRole('link', { name: 'Cancel', exact: true }).click();
    await expect(page).toHaveURL(/\/profile(?:#.*)?$/);
    await expect(page.locator('#profile-summary')).toContainText('Noor Al-Hamad');
    expect(await fixture.writeEvidence()).toEqual(committed); // Cancel wrote nothing
    await page.locator('#profile-summary a[href="/profile/edit/displayName"]').click();
    await expect(page.locator('#field-displayName')).toHaveValue('Noor Al-Hamad');
  } finally { await fixture.cleanup(); }
});
```

The adopted test must add a visible-focus keyboard walk (not replace clicks with a fake fixture success), and complete the fault/two-tab scenarios from the matrix. Any DOM/URL deviation must update the shared kit, journey, contract and test together. Candidate fixture filename `apps/gateway/test/profile-journey-fixture.ts` joins U3a's proposed reservation only if this smaller fixture port is used; it is not an extra file in this docs pack.

State fixtures must exercise actual behavior: **ready** populated own profile; **empty** optional fields missing with truthful actions; **invalid** real rejected save and retained draft; **conflict** another tab's committed edit and retained authorized draft; **unavailable** controlled dependency failure; **expired session** actual expired/revoked session without profile/draft disclosure. For invalid/conflict state preparation, define the measured no-write window after necessary fixture setup and ensure the failed action itself is separately measured as zero writes. Screenshot assertions do not replace the behavioral assertions. Supplement with zoom/long-content checks from the kit. All journey-owned labels, help, errors, notices and empty strings use the shared reviewed Arabic dictionary; user data/proper names and intentional email/phone values are not translation failures. The rest of the site is not claimed localized.

**Evidence ledger:** each named check = passed / failed / not run; exact SHA; environment/command; artifacts; test counts and skipped counts; reviewer family; unresolved defects. Attach screenshots, trace and durable one-write evidence to PR/Linear. Rendered-HTML acceptance may permit landing under normal gates; only a browser pass on the exact candidate earns **UX accepted**. No runner means “landed, not UX accepted,” not an owner-testing task.

## 6. Contributor and coordinator handoff safeguards

This docs-only pack carries no implementation/dispatch authority. Before implementation, record the reservation and open the required docs-first draft PR/Lease. A 48-hour quiet reservation is **stale**, not released; explicit owner/session reconciliation and recorded release precede reassignment. Later pushes from superseded owners are blocked. Record every contributing model family; a reviewer must come from a non-contributing family. Mixed-family contribution requires a third independent family or waits. This pack's internal author checks are not cross-family review.

All required checks actually run at final head before merge; skipped database/browser jobs are not proof. Eligible is not merged: use the existing serialized landing mechanism or recorded no-armed-card landing window, respecting each actor's authority. Docs-only lanes still obey stale/release and coordinated landing rules; omitting them from a short list does not waive them.

Scheduling adoption note only: preserve the existing flat `after` graph. Failure isolation skips only **confirmed terminal, reconciled** stopped attempts; unknown liveness, commit/landing or revert outcome remains global HOLD until durable evidence resolves it. Overlap preflight uses normalized effective globs (initial scope plus revision-added paths), real glob intersection and transitive dependency reachability; reject cycles. Exact string equality and queue order are insufficient. Shared migrations/exports/integration paths count. Install/re-cut only at the established idle episode boundary, not under an in-flight attempt. These are coordinator-owned safeguards, not new orchestrator work hidden in U1–U3a.

### Dispatch blockers still to resolve

1. Exact current path reservations, integration wiring/test inventory and migration allocation at dispatch.
2. PR #237 adoption/supersession and any intervening phone/reference-field changes.
3. Adopt the recommended five-minute token / at-least-seven-day recovery defaults (or record a justified alternative), and prove persisted/imported baseline representation against the real read model.
4. Real PostgreSQL test availability and approved isolated browser/auth/fixture driver.
5. Independent cross-family review of final contracts, Arabic and resulting implementation; no PASS supplied by this document.
