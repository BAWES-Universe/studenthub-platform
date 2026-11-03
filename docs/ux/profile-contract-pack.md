# Profile contract pack — proposed adoption, not executable dispatch

**Historical source baseline:** `BAWES-Universe/studenthub-platform@d56843401d6ad77fc92ad77d81d32f82605d7b17` (2 November 2026). **Status:** docs-only proposal; no application change, test run, dispatch, merge, deployment or independent PASS is represented here. Read with [profile journey](profile-journey.md) and [minimal kit](kit-spec.md). The coordinator translates these proposals into the existing contract format only after preflight; this document changes no `.github` contract.

**Revision 3 reconciliation (3 November 2026):** current main checked at `8e358598da7db1a39624399cedf3181cf04e87a2`. SHU-417 landed in PR #375 (`7ed44b17b548241a7e78e1bc48fcd37e597353d3`); SHU-420 replaces SHU-418 for origin fields. The three docs incorporate Claude’s nine review corrections and the agreed revision 2/3 refinements. They still require independent review at their new documentation head.

The intended result is one person completing **view → edit one field → Save → understand the result → recover safely**, not another administration form or a framework rewrite. Basic self-profile ownership must not depend on a candidate business-role grant. Looking for work is profile status, not an authorization role. Other sensitive actions retain explicit review/confirm.

## 1. Source facts and boundaries

At the pinned baseline, `packages/profile/src/self-edit.ts`, `apps/gateway/src/profile-edit-http.ts` and `packages/db/src/person-profile-store.ts` support exactly nine self-edit fields: `displayName`, `arabicName`, `objective`, `intro`, `preferredTime`, `gender`, `birthDate`, `drivingLicence`, `jobSearchStatus`. Language preference is a separate existing capability. That nine-field statement is historical, not the implementation inventory: phone/handle landed with SHU-417; nationality/university/Kuwaiti-mother work is SHU-420. Re-pin the editable-field list and read-model summary after SHU-420 lands; derive counts rather than freezing nine edits or 19 rows. Background records are another existing flow; do not rewrite them into this field contract.

The existing `packages/safe-write-contract/README.md` describes an explicit preview binding both before and after, durable token consumption, ownership checks before reads and inside commit, and atomic receipt creation. Its historical opening “everything reads” is not current capability evidence. The current profile HTML flow posts to `/profile/edit/preview`, then `/profile/edit/confirm`, then redirects to `/profile`. These APIs and their existing callers remain compatible, apart from the explicitly tested U+0000 validator tightening. Browser single-Save is a **new contract**, not a new server-side preview hidden inside the old confirm request.

The current store reads platform-owned persisted fields; `readOwnPreferences` exposes only fields with a write timestamp. Clearing optional text persists SQL `NULL`. Imported presentation fallback and localized missing-value strings are therefore not interchangeable with stored baseline values. The new form must bind both the provenance/presentation the person saw and the persisted field comparison state. A display label such as “Not recorded” is never used as a database CAS operand. If an imported value changes while it remains the shown fallback, the baseline is stale even if the platform-owned field remains null; bind its source revision/value digest too, or prevent that unresolved fallback edit until a truthful baseline can be established.

### Field canonicalization and correction matrix

**Existing rules are retained except the explicit U+0000 tightening.** U2a adds a reason-returning validator, with `normalizePersonSelfEditValue` defined over the same rules. Reasons cover `required`, `length`, `name`, `arabic_name`, `spacing`, `characters`, `date`, `future`, `minimum_age`, `choice` and `contact_unavailable`. U+0000 becomes `characters`; this intentional preview/confirm exception gets a dedicated test. All other existing results and mutants remain compatible. `normalizePersonSelfEditValue` applies Unicode NFC and counts Unicode code points after NFC. Existing SQL constraints in migrations `0211_person_profiles.sql` and `0212_person_profiles_choices.sql` must agree with the new path. HTML `maxlength` counts UTF-16 units, unlike these rules: do not silently truncate or prematurely block valid supplementary characters. The authoritative limit is the server's code-point rule; any browser limit must be equivalence-tested.

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
| Language | Existing separate language preference capability | Do not sneak it into the field-write API or change its protocol. Localize this journey using the existing preference. |
| Phone / handle / new reference fields | Re-pin the landed SHU-417 and post-SHU-420 contracts | Phone follows SHU-417: normalize Arabic-Indic digits and supported separators; an eight-digit national number gets `+965`. Reject other ambiguous inputs. No phone draft echo on any failure/recovery surface, hidden input, log or diagnostic. Reference fields use approved identifiers, not invented free-text conversion. |

For every existing text field, NFC is allowed; **trim and collapse-whitespace are not allowed transformations**. Forbidden controls and bidi format controls remain correction-required under the actual validator. Escaping/bidi isolation is rendering, not a stored-value rewrite. No truncation. A normalization equivalent under NFC can share the same canonical request fingerprint; a meaning-changing input cannot. Test composed/decomposed letters, boundary lengths including supplementary characters, single/double spaces, NBSP edges, newline/control, U+0000 and bidi canaries. Preserve raw draft on authorized validation failure except phone; show the stored canonical value on success without adding raw values to shareable receipts/audit logs.

## 2. Adoption preflight and candidate path ownership

**Do before dispatch, not after the first implementation commit:** pin current main and candidate source, reconcile PR #237, inspect active attempts and queued pathsets plus open PRs, reserve all new and integration paths with owner/family/time/migration range, prove the named test environment can run, and freeze contract inputs/outputs. Historical non-overlap at this document's SHA is not a future reservation. The coordinator owns `contracts/reservations.md`; this pack does not edit it. Reconcile the existing parity/navigation documents rather than creating a competing inventory.

PR #237 is superseded; nothing is adopted. Its closure is coordinator-owned after SHU-417, not an action performed by this pack. Completeness recomputation remains queue 14. Do not merge its stale implementation or schema.

Candidate exact paths below are **not implementation permission**. Re-pin and reserve all ports before install. The queue at `8e358598…` holds gateway integration files, so U1 is new files only. No lack of overlap with named cards constitutes global clearance.

| Slice / dependency | Candidate paths | Completion boundary |
|---|---|---|
| **U1 minimal kit**, no dependency | New `apps/gateway/src/ui/profile-kit.ts`, `apps/gateway/src/ui/profile-copy.ts`, `apps/gateway/test/profile-kit.test.ts` | Scoped CSS string and escaped accessible primitives; equal en/ar keys and parameters; no existing file edits, routes, skip link, main or html. No served-CSS claim yet. |
| **U2a browser contract and existing store**, after SHU-420 | `packages/safe-write-contract/src/browser-write.ts`, `src/index.ts`, `test/browser-write.test.ts` in that package; `packages/profile/src/self-edit.ts`, `test/self-edit.test.ts`, `test/self-edit-mutations.mjs`; `packages/db/src/person-profile-store.ts`, `packages/db/test/postgres-person-profile.test.ts`; exact session-liveness/imported-fallback port seams reserved at install | Extend `PostgresPersonProfileStore.#commit`; no second browser-write store. Preserve existing `CommitOutcome` and consumers; a separate browser outcome returns the stored receipt. No migration expected; allocate the next free exact path only if proven necessary. |
| **U2b one-field Save**, after U1, U2a and queued holders of shared gateway paths | New `apps/gateway/src/profile-browser-edit-http.ts` and `apps/gateway/test/profile-browser-edit-http.test.ts`; `apps/gateway/src/index.ts`; exact runtime, notice and document-language seams (including `login-runtime.ts`/`web-ui.ts` if needed) reserved before install | Authorized one-field edit, Save, Cancel, errors, receipt-only recovery and truthful signed-cookie notice. At the checked queue, holders include SHU-420, SHU-198, SHU-196, SHU-189 and SHU-188. Recheck actual effective pathsets. |
| **U3a coherent profile journey**, after U2b | `apps/gateway/src/web-ui.ts`, `apps/gateway/test/web-ui.test.ts`, `apps/gateway/src/index.ts`, `apps/gateway/src/ui/profile-copy.ts`, new `apps/gateway/test/profile-journey.test.ts` | Document-level language/direction, grouped profile and real Arabic. Serve `WEB_CSS + PROFILE_RECORDS_CSS + PROFILE_KIT_CSS` at existing `/assets/studenthub.css` in `index.ts`. Browser acceptance remains separate. |

Browser runner/driver/fixture files belong under `tools/browser-acceptance/`, outside the current TypeScript include. They are build-thread work after U3a, not gateway test files that import an unavailable Playwright dependency. Prove dependency/config/command setup before claiming runnable acceptance. Root manifests and compiler/CI config are not automatically in scope. DB tests must use `postgres-*.test.ts`; new gateway tests are discovered by `npm test`, not the fixed `test:web` list. Reserve any actual inventory integration seam; do not broaden path globs to evade checks.

Proposed browser route convention: **GET `/profile/edit/:field`**, **POST `/profile/edit/:field/save`**. This is a future route namespace; existing source does not implement it. Target is derived from authenticated self, not a freely selectable person identifier. Retain old `/profile/edit/preview`, `/profile/edit/confirm` and receipt routes unchanged. The coordinator may select another namespace before dispatch only by updating all three docs and the route contract together.

## 3. U2a normative browser-write protocol

### Binding and operation identity

The render-time signed single-use token is the operation identity. There is no independent `idempotencyKey`, `csrfToken` or new seven-day retention policy. This is a **declared browser extension of SHU-82**, not a claim that its current preview/confirm change-bound contract already covers a value not yet entered. Preserve `Origin` + `Sec-Fetch-Site`, actor binding, safe cookies, no-store responses and non-leaking errors.

Each render issues a fresh random signed `tokenId` and derived `tokenRef`, with HMAC signing-key version, purpose/contract version, actor, self target, exactly one field, issue/expiry times and baseline digest. The baseline covers persisted null/presence/value and the shown imported fallback source/value digest or revision. Default first-write lifetime is five minutes; `now >= expiresAt` refuses a new write. Reject forged/substituted bindings, duplicate form keys, unexpected fields, unsupported content types and oversized bodies.

The first successful commit atomically binds the canonical payload's `changeSetDigest` to that token. Same token and different canonical payload returns `409 token_payload_mismatch`, with no write. Bind actor/purpose/target/field and normalization version; NFC equivalence is allowed only under those frozen semantics. Cross-process deduplication uses the existing `authorization_mutation_audit_safe_write_token` unique index plus the advisory-locked transaction, never process-local memory.

### Authorization, replay and first-write order

1. Validate token authenticity and binding. Reauthorize before any receipt, current-value or draft disclosure. Revoked/expired sessions receive a generic response, never existence/replay detail. Apply the same authorization discipline to save, replay, read-only status and notice reads.
2. Acquire the existing serialization lock. The session-liveness port must also catch revocation between precheck and lock; revalidate at the protected boundary before sensitive lookup or mutation. This is self-profile authorization, not a candidate business-role grant.
3. Look up the receipt by `tokenRef` and compare the canonical payload where a submitted payload exists. A match returns the **original receipt**; mismatched payload returns 409. Replay precedes freshness/expiry rejection and does not mutate, spend again or audit again. Commit A, later edit B, replay A returns A's receipt, never B's value labelled as A's result.
4. **Only the no-receipt first-write branch** checks unused token and expiry against current database wall-clock time **after acquiring the lock** (`clock_timestamp()`, not transaction-start time), then persisted baseline, then the freshly read imported-fallback baseline. Recheck the current field policy and authorization through the reserved ports. Unknown/expired verification evidence or a spent token with no recoverable receipt never permits a fresh write.
5. In that one transaction, spend the token, mutate exactly one field, and write audit/receipt/payload digest together. Separate concurrent connections yield one mutation, one audit and one receipt. A loser finding the committed operation returns its receipt rather than a stale-baseline failure. Cover no-ops explicitly.
6. Confirmed transaction failure rolls all mutation/audit/receipt/token effects back. A lost connection around COMMIT is **unknown**, not proof of rollback. Reconcile the durable receipt; never mint a new operation automatically or inherit the existing catch-means-nothing-written assumption.

Preserve existing `CommitOutcome` and preview/confirm APIs; the browser result is a separate type carrying the stored receipt for `committed`/`already_committed`, plus `token_payload_mismatch`, `state_changed`, `expired`, `not_authorized`, `unknown` and unavailable-recovery outcomes. Extend the existing store rather than duplicating its commit path.

### Read-only recovery and evidence retention

`receiptStatus(token)` is a separate authenticated read-only lookup that never enters the write executor. “Check save status” cannot consume an unspent token or initiate a write. A missing receipt yields pending/not-found/unknown as supported by evidence, not a new mutation. Any separately labelled explicit retry requires the original token and semantic payload; a changed draft is never automatically submitted.

A token past its write lifetime can recover its committed receipt while signature/key-version/binding evidence and the audit row remain verifiable and current authorization holds. Audit rows are not pruned by this slice, but their existence alone does not guarantee recovery forever. Missing verification evidence yields `recovery_unavailable`/unknown, never a new write; no indefinite signing-key-retention duty or new purge job is created.

Receipt/audit metadata stay allowlisted references, field code, digests/versions and timestamps, not raw names, dates, phone, authentication subjects or drafts.

### Notice and user recovery contract

A successful POST redirects 303 to `/profile#field-{key}`. Carry an opaque receipt reference in a short-lived signed **Secure, HttpOnly, SameSite=Strict, path-scoped cookie**, bound to actor, session, receipt and verified expiry. The cookie does not authorize receipt access. The profile read reauthorizes, reads the receipt and clears the cookie on render. No value or token enters a URL.

Show a stored-value success only if a fresh authorized value reproduces the receipt's `changeSetDigest` using the **same canonical change-set representation and algorithm**, not a bare-value hash. Otherwise confirm the original operation without its value and label the separately read value as current. Missing/invalid/consumed notice yields a neutral current-only view. A two-tab test proves one tab's notice never names another tab's field/value falsely.

Invalid: authorized draft, field error and focus; nothing committed. Conflict: current value and authorized draft beside it, with a fresh token and deliberate retry choice; never auto-overwrite. **Phone is the exception in every state:** never echo its draft in invalid/conflict/unknown/recovery pages, hidden fields, logs or diagnostics; explain re-entry honestly. A read-only status lookup needs no retained phone draft. Expired/revoked sessions disclose neither current values nor draft. No automatic replay after sign-in.

Cancel is a GET that discards the unsaved field without writing. Back/forward must not resubmit. Native POST rerendering can preserve non-phone authorized drafts; no server-side draft service, persistent browser storage or cross-login/reload survival is promised. These are single-field forms; section grouping is visual, not multi-field Save.

## 4. Required named tests and truthful evidence

All names below prefixed `BW-` / `PJ-` are **proposed acceptance names**, not claims that tests already exist.

- `BW-token-binding`: signature forgery, purpose/version/actor/target/field substitution, extra field, duplicate keys, expiry on first write.
- `BW-canonicalization`: every matrix rule, NFC-equivalent replay, meaning-changing refusals, clear-to-null, text/SQL boundary agreement and historical birth-date rendering.
- `BW-receipt-before-baseline`: commit A, later edit B, replay A returns original receipt without mutation; consumed/expired issued-token recovery, absent-receipt expired-token refusal.
- `BW-idempotency-conflict`: same token with changed canonical value returns `409 token_payload_mismatch`; field/target/intent substitution fails binding, no second commit.
- `BW-concurrent-one-commit`: two connections/processes, identical request, exactly one mutation/audit/token consumption/receipt; include same-value no-op and waiting-transaction race.
- `BW-unknown-commit`: drop response after actual COMMIT, reconcile the original token through read-only status, then explicitly retry only a known rollback, prove one durable result; separately fail before commit and prove retry succeeds once.
- `BW-atomic-failures`: inject mutation/audit/receipt/token persistence failures and assert rollback, including authorization revocation during the race window.
- `BW-boundary-clock-and-fallback`: token expires while waiting for lock (database wall-clock), session revoked during the wait, imported fallback changed; each refuses a first write.
- `BW-status-zero-write`: valid unspent token, committed token and unknown token; status never changes profile/audit/token rows.
- `BW-notice-and-phone-privacy`: signed cookie binding/expiry/Secure flags, missing/invalid notices, digest-representation agreement, two-tab notice substitution, and phone-canary absence across all error/recovery surfaces.
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
npm run test:profile:mutations
```

`test:db` builds then uses `tools/test-runner/run.mjs --db`; discovery asserts its baseline inventory. New gateway tests run through `npm test`; the fixed `test:web` list does not cover them automatically. No current `npm run test:profile-browser` or Playwright script is claimed. The browser command is established only when its dependencies/configuration/driver exist. Record the actual command, runner version, PostgreSQL version, migrated schema and final candidate SHA in evidence. Pinned CI `.github/workflows/ci.yml` uses `postgres:17-alpine`; use a real disposable PostgreSQL 17 matching that baseline and required migration features (including collation/NFC support). Confirm deployment-version compatibility separately rather than assuming the briefing’s PostgreSQL 16 or an unknown production version. A mock is not concurrency or migration proof. No database configured or skipped tests = **not run**, not PASS. Do not run migrations against production/live data for this exercise.

## 5. Browser acceptance driver — proposed executable interface

The proposed runner and its driver/fixture modules live under `tools/browser-acceptance/`, outside gateway TypeScript compilation. The following is a TypeScript Playwright-style spec **embedded only in Markdown**, not an installed runner. It becomes runnable when the build thread supplies `@playwright/test`, config, a dedicated disposable deployed/preview candidate and an implementation of the interface below. No fake login credentials or production admin endpoint is implied.

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
  dropResponseAfterCommitThenCheckReadOnlyStatus(): Promise<void>;
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
          if (scenario === 'unknown-commit') await d.dropResponseAfterCommitThenCheckReadOnlyStatus();
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

The adopted test must add a visible-focus keyboard walk (not replace clicks with a fake fixture success), and complete the fault/two-tab scenarios from the matrix. Any DOM/URL deviation must update the shared kit, journey, contract and test together. Candidate fixture filename `tools/browser-acceptance/profile-journey-fixture.ts` joins the build thread's proposed reservation only if this smaller fixture port is used; it is not an extra file in this docs pack.

State fixtures must exercise actual behavior (phone drafts are never echoed in invalid/conflict/unknown fixtures): **ready** populated own profile; **empty** optional fields missing with truthful actions; **invalid** real rejected save and retained draft; **conflict** another tab's committed edit and retained authorized draft; **unavailable** controlled dependency failure; **expired session** actual expired/revoked session without profile/draft disclosure. For invalid/conflict state preparation, define the measured no-write window after necessary fixture setup and ensure the failed action itself is separately measured as zero writes. Screenshot assertions do not replace the behavioral assertions. Supplement with zoom/long-content checks from the kit. All journey-owned labels, help, errors, notices and empty strings use the shared reviewed Arabic dictionary; user data/proper names and intentional email/phone values are not translation failures. The rest of the site is not claimed localized.

**Evidence ledger:** each named check = passed / failed / not run; exact SHA; environment/command; artifacts; test counts and skipped counts; reviewer family; unresolved defects. Attach screenshots, trace and durable one-write evidence to PR/Linear. Rendered-HTML acceptance may permit landing under normal gates; only a browser pass on the exact candidate earns **UX accepted**. No runner means “landed, not UX accepted,” not an owner-testing task.

## 6. Contributor and coordinator handoff safeguards

This docs-only pack carries no implementation/dispatch authority. Before implementation, record the reservation and open the required docs-first draft PR/Lease. A 48-hour quiet reservation is **stale**, not released; explicit owner/session reconciliation and recorded release precede reassignment. Later pushes from superseded owners are blocked. Record every contributing model family; a reviewer must come from a non-contributing family. Mixed-family contribution requires a third independent family or waits. This pack's internal author checks are not cross-family review.

All required checks actually run at final head before merge; skipped database/browser jobs are not proof. Eligible is not merged: use the existing serialized landing mechanism or recorded no-armed-card landing window, respecting each actor's authority. Docs-only lanes still obey stale/release and coordinated landing rules; omitting them from a short list does not waive them.

Scheduling adoption note only: preserve the existing flat `after` graph. Failure isolation skips only **confirmed terminal, reconciled** stopped attempts; unknown liveness, commit/landing or revert outcome remains global HOLD until durable evidence resolves it. Overlap preflight uses normalized effective globs (initial scope plus revision-added paths), real glob intersection and transitive dependency reachability; reject cycles. Exact string equality and queue order are insufficient. Shared migrations/exports/integration paths count. Install/re-cut only at the established idle episode boundary, not under an in-flight attempt. These are coordinator-owned safeguards, not new orchestrator work hidden in U1–U3a.

### Dispatch blockers still to resolve

1. Exact current path reservations, integration wiring/test inventory and migration allocation at dispatch.
2. Coordinator-owned closure of superseded PR #237 and inventory re-pin after SHU-420; nothing from #237 is adopted.
3. Prove the five-minute first-write token boundary, retained-evidence recovery, live session port and persisted/imported baseline against the real read model. No separate idempotency key or seven-day policy.
4. Real PostgreSQL test availability and approved isolated browser/auth/fixture driver.
5. Independent cross-family review of final contracts, Arabic and resulting implementation; no PASS supplied by this document.

