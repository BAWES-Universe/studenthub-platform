// Real StudentHub cards the coordinator may run, after the SHU-71 fixtures.
//
// A card lane is a fixture lane without a seeded defect: the same exact-path
// writer scope, the same review of the whole declared scope, the same tests
// run by the confined reviewer. What a fixture documents in its own files, a
// card states here: its paths, its acceptance check and its brief, the text
// the writer builds from and the reviewer holds the result to. All of it is
// pinned in reviewed code. config.json may name a card lane but never widen
// it (workspace-scope.mjs), and Linear text never reaches a prompt.
//
// A card may add workspace_mode: "repo". Its writer then gets the whole tree at
// the bound head, with dependencies installed by the host, and may still change
// only its paths. Without it the writer sees only its paths.

export const SHU197_PATHS = Object.freeze([
  "deploy/coolify/preflight.mjs",
  "deploy/coolify/integration-register.json",
  "deploy/coolify/integration-register.mjs",
  "docs/integrations.md",
  "deploy/coolify/test/config-schema.test.mjs",
  "deploy/coolify/test/integration-register.test.mjs",
]);

const SHU197_ACCEPTANCE = [
  "(1) a missing required variable, or an undeclared OIDC_/LOGIN_ variable, fails preflight with that variable named, and making any required variable optional makes a test in deploy/coolify/test/config-schema.test.mjs fail;",
  "(2) the committed register has all 27 entries INT-01..INT-27 with the brief's rotation state and disposition, and removing owner from any one entry makes a test in deploy/coolify/test/integration-register.test.mjs fail;",
  "(3) no secret value can appear in the register or in preflight output, and a test proves it;",
  "(4) every existing export and error message of preflight.mjs still holds and preflight.mjs imports nothing outside node: builtins.",
].join(" ");

// INT rows: id | integration | credential names (names only, never values) |
// rotation state | disposition | owner cards. Source: docs/parity/
// platform-ops-and-integrations.md §6 (PR #62, SHU-139), with Khalid's D-OP1
// decisions recorded on SHU-213 on 2026-10-04 (Xero, Jira tickets and the
// wallet are dropped).
const SHU197_REGISTER = `
INT-01 | Temporary AWS S3 upload | temporaryBucketResourceManager.key, temporaryBucketResourceManager.secret | rotate-revoke | replace | SHU-134, SHU-145
INT-02 | Primary AWS S3 storage | resourceManager.key, resourceManager.secret | rotate-revoke | replace | SHU-145, SHU-122
INT-03 | AWS MediaConvert | (unrecorded) | operator-check | pending | SHU-123, SHU-213
INT-04 | AWS Textract OCR | AWS_TEXTRACT_ACCESS_KEY_ID, AWS_TEXTRACT_SECRET_ACCESS_KEY | operator-check | keep | SHU-145
INT-05 | AWS SQS event leg | eventManager.sqsKey, eventManager.sqsSecret | operator-check | pending | SHU-199, SHU-213
INT-06 | Cloudinary | CLOUDINARY_API_KEY, CLOUDINARY_API_SECRET | operator-check | drop | SHU-145, SHU-122
INT-07 | Algolia | algolia.appId, algolia.apiKey | rotate-revoke | replace | SHU-127, SHU-122
INT-08 | Auth0 | (none) | none | drop | SHU-124, SHU-122
INT-09 | Google identity | (none) | operator-check | drop | SHU-124
INT-10 | Apple identity | (none) | operator-check | drop | SHU-124
INT-11 | reCAPTCHA | reCaptcha.secretKey | rotate-revoke | pending | SHU-124, SHU-197
INT-12 | SMS gateway | (unrecorded) | rotate-revoke | keep | SHU-189, SHU-197
INT-13 | OneSignal push | oneSignalCandidateAPIKey | operator-check | replace | SHU-188, SHU-189
INT-14 | SMTP mail transport | MAIL_USERNAME, MAIL_PASSWORD | rotate-revoke | keep | SHU-189, SHU-197
INT-15 | Ipstack geolocation | ipstack.accessKey | rotate-revoke | pending | SHU-199, SHU-213
INT-16 | Google Maps and Places | GOOGLE_MAPS_API_KEY | operator-check | keep | SHU-199
INT-17 | Mixpanel | (unrecorded) | db-state-unknown | pending | SHU-199, SHU-213
INT-18 | Segment | (unrecorded) | db-state-unknown | pending | SHU-199, SHU-213
INT-19 | Staff-configured outbound webhooks | (none) | db-state-unknown | keep | SHU-190, SHU-199
INT-20 | Legacy Sentry | SENTRY_DSN | rotate-revoke | keep | SHU-90, SHU-198
INT-21 | Slack logging and reports | slack.url | rotate-revoke | replace | SHU-198, SHU-189
INT-22 | Xero | (unrecorded) | rotate-revoke | drop | SHU-213
INT-23 | Yeastar voicemail microservice | microserviceApiKey | rotate-revoke | pending | SHU-129, SHU-213
INT-24 | Jira | jira.email, jira.apiToken | rotate-revoke | drop | SHU-213
INT-25 | Wallet service | walletManager.apiKey | operator-check | drop | SHU-213
INT-26 | PDF, Excel, QR and headless-browser libraries | (none) | none | keep | SHU-196
INT-27 | Legacy MySQL, Redis and wallet database | (unrecorded) | rotate-revoke | replace | SHU-97, SHU-122
`.trim();

const SHU197_BRIEF = `Card SHU-197 (slice X1 of SHU-192): typed platform configuration and an integration register.

Goal. Deployment preflight validates a typed, closed configuration schema at startup, and the repository carries a checked-in register of every third-party integration the legacy StudentHub app used, with its owner, the names (never values) of its credentials, its rotation state and its cutover disposition. The register describes integrations; nothing connects to any of them.

1. Typed configuration, in deploy/coolify/preflight.mjs.
- The production image copies preflight.mjs into deploy/coolify/ with only two sibling files (gateway-entrypoint.sh and assert-image-content.mjs; see the Dockerfile, outside your scope), so keep the schema inside preflight.mjs and import nothing but node: builtins.
- Export CONFIG_SCHEMA: one frozen entry per variable preflight reads, with name, required (boolean), kind ("url", "url-list", "host-list", "string" or "literal") and secret (boolean). Required, in this order: DATABASE_URL, OIDC_ISSUER, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET, OIDC_CALLBACK_URL, OIDC_AUTHORIZATION_URL, OIDC_TOKEN_URL, OIDC_JWKS_URL, LOGIN_ALLOWED_RETURN_URLS. Also declared, as today: HOST (literal 0.0.0.0) and PLATFORM_DATABASE_HOSTS (optional). DATABASE_URL and OIDC_CLIENT_SECRET are secret.
- REQUIRED_DEPLOYMENT_ENV stays exported with exactly the nine names above in that order, derived from CONFIG_SCHEMA. deploy/coolify/deployment-env-manifest.mjs and deploy/coolify/test/deployment.test.mjs (both outside your scope) depend on it and on every current error message, which must not change.
- Closed schema: a variable whose name starts with OIDC_ or LOGIN_ and that CONFIG_SCHEMA does not declare fails validateDeploymentEnv with "unknown configuration variable <NAME>".
- Every error names the variable and never contains a value.

2. The register.
- deploy/coolify/integration-register.json: { "schemaVersion": 1, "integrations": [...] } with exactly the 27 rows below, in order. Each entry: id, name, owner (the first owner card), owner_cards (all of them), credential_names (array of names; empty for "(none)", where the integration needs no secret, and for "(unrecorded)", where the inventory did not record the names, which notes must then say), rotation_state, disposition, notes (one short sentence of your own, no values, no URLs).
- rotation_state is one of rotate-revoke, operator-check, db-state-unknown, none. disposition is one of keep, replace, drop, pending. "pending" means the owner has not decided; it blocks retiring the legacy service (SHU-122) and connecting the integration.
- deploy/coolify/integration-register.mjs exports validateRegister(register) returning { ok, errors }, where each error names the entry id and field. It refuses a missing or empty field, an unknown enum value, a duplicate id, and any string that looks like a secret value or a location: a URL, an email address, an IP address, or a run of 20 or more letters and digits that has both a letter and a digit.
- docs/integrations.md: a short plain-language page with one table row per entry (id, integration, owner, rotation state, disposition), saying the JSON file is the source of truth.

Rows (id | integration | credential names | rotation state | disposition | owner cards):
${SHU197_REGISTER}

3. Tests, with node:test and node:assert only, importing only files in your scope and node: builtins (no dist/, no packages).
- deploy/coolify/test/config-schema.test.mjs: start from a complete valid environment written out in the test; for each of the nine required names, written out literally in the test (never read back from CONFIG_SCHEMA or REQUIRED_DEPLOYMENT_ENV, or the mutation would pass), deleting it fails with its name; an undeclared OIDC_ variable fails with its name; a secret value given in each secret variable never appears in any error message.
- deploy/coolify/test/integration-register.test.mjs: the committed register validates; for every entry, removing owner fails validation and names that entry; the 27 ids and each row's rotation state and disposition match the table above, written out in the test; the register file contains no value-like string; docs/integrations.md lists every id.

Out of scope: the Dockerfile, the env manifest, deployment.test.mjs, any network call or credential, any change outside the paths you are given.`;

// The second card reuses SHU-197's six paths: it hardens the validators that
// card shipped. The register and its documentation are in scope only so the
// writer's workspace can run the register tests; the brief keeps them unchanged.
export const SHU294_PATHS = SHU197_PATHS;

const SHU294_ACCEPTANCE = [
  "(1) each of these mutations makes a test in deploy/coolify/test/config-schema.test.mjs or deploy/coolify/test/integration-register.test.mjs fail: dropping the LOGIN_ prefix from the unknown-variable check; skipping URL parsing of url and url-list values; dropping the empty list-part check; dropping, one at a time, the URL, email, IP address and long-token rules of the register's value check; dropping the duplicate-id check; dropping the rotation_state check; dropping the disposition check;",
  "(2) a url or url-list value whose scheme is not http or https fails with \"<NAME> must be a valid <kind>\", and https values still pass;",
  "(3) every PLATFORM_DATABASE_HOSTS item must be a hostname, or it fails with \"PLATFORM_DATABASE_HOSTS must be a valid host-list\"; an empty value is still accepted;",
  "(4) a trailing or doubled comma in a url-list or host-list fails with the variable named, and a test pins it;",
  "(5) every existing export, error message and test still holds, integration-register.json and docs/integrations.md are byte-identical, preflight.mjs imports only node: builtins, and no error message contains a configured value.",
].join(" ");

const SHU294_BRIEF = `Card SHU-294: harden the deployment config schema and integration register validators.

Goal. Card SHU-197 added a typed configuration schema to deploy/coolify/preflight.mjs and an integration register with its validator, deploy/coolify/integration-register.mjs. Its review found checks that no test protects, and three gaps. This card closes them. It adds tests and tightens validation; it changes no deployment value and connects to nothing.

1. Tests that protect existing checks. Today these mutations survive the card's own tests: add tests in deploy/coolify/test/config-schema.test.mjs and deploy/coolify/test/integration-register.test.mjs so that each one fails.
- In validateDeploymentEnv: an undeclared LOGIN_ variable (for example LOGIN_UNDECLARED) must fail with "unknown configuration variable LOGIN_UNDECLARED", so dropping the LOGIN_ half of the prefix check fails a test. A value that does not parse as a URL in a url variable (for example OIDC_ISSUER) and in the url-list variable must fail with "<NAME> must be a valid <kind>", so skipping the URL parsing fails a test. An empty part in a list must fail too (see 4).
- In validateRegister: a value that looks like a URL, an email address, an IP address, or a run of 20 or more letters and digits containing both, placed in a string field of one entry, must each fail with that entry's id and field named, so removing any one of those four rules fails a test. A duplicate id must fail. An unknown rotation_state and an unknown disposition must each fail.
- Write the expected values and messages out literally in the tests.

2. URL schemes, in deploy/coolify/preflight.mjs. A url or url-list value must use http: or https:. Any other scheme (for example javascript:, ftp:, file:, data:) fails with the existing message "<NAME> must be a valid <kind>". Keep accepting http: here: the gateway's own runtime check owns the https rule for OIDC_CALLBACK_URL, and deploy/coolify/test/deployment.test.mjs (outside your scope) expects its message, "OIDC_CALLBACK_URL must use https", for an http callback. DATABASE_URL keeps its own postgres check and stays out of this rule.

3. Host names, in deploy/coolify/preflight.mjs. Every PLATFORM_DATABASE_HOSTS item must be a hostname: dot-separated labels of letters, digits and hyphens, each 1 to 63 characters and not starting or ending with a hyphen, 253 characters at most in all. Otherwise fail with "PLATFORM_DATABASE_HOSTS must be a valid host-list". An empty or unset value is still accepted, and "reporting-db, isolated-platform-db" (used by deployment.test.mjs) still passes.

4. Trailing commas stay strict. A trailing or doubled comma in LOGIN_ALLOWED_RETURN_URLS or PLATFORM_DATABASE_HOSTS already fails; keep that, and pin it with a test that checks the variable is named.

Constraints.
- Every current export, error message and test must keep passing. deploy/coolify/deployment-env-manifest.mjs and deploy/coolify/test/deployment.test.mjs (both outside your scope) depend on them.
- preflight.mjs imports nothing but node: builtins (the production image copies it alone).
- No error message may contain a configured value.
- deploy/coolify/integration-register.json and docs/integrations.md must stay byte-identical. They are in your workspace so the register tests can run.
- Tests use node:test and node:assert only and import only files in your scope and node: builtins.

Out of scope: the Dockerfile, the env manifest, deployment.test.mjs, compose files, any network call or credential, any change outside the paths you are given.`;

// The third card tidies the same validators after SHU-294's review: same six
// paths, register and documentation again unchanged.
export const SHU295_PATHS = SHU197_PATHS;

const SHU295_ACCEPTANCE = [
  "(1) an optional url or url-list variable that is unset or blank is skipped by every url check, while a set one is still checked; a test declares such a variable through a schema the test builds or an exported helper, and fails if the skip is removed;",
  "(2) each rule of validateDeploymentEnv (http or https scheme, URL parsing, empty list part, hostname) is checked in exactly one place, and removing that one check makes a test in deploy/coolify/test/config-schema.test.mjs fail;",
  "(3) a PLATFORM_DATABASE_HOSTS item longer than 253 characters whose labels are each 63 characters or fewer fails with \"PLATFORM_DATABASE_HOSTS must be a valid host-list\", and dropping the 253-character cap fails a test;",
  "(4) every existing export, error message and test still holds, the order of errors for any single wrong variable is unchanged, integration-register.mjs, integration-register.json and docs/integrations.md are byte-identical, preflight.mjs imports only node: builtins, and no error message contains a configured value.",
].join(" ");

const SHU295_BRIEF = `Card SHU-295: tidy the deploy preflight checks after the validator hardening.

Goal. Card SHU-294 hardened validateDeploymentEnv in deploy/coolify/preflight.mjs: url and url-list values must be http or https, and PLATFORM_DATABASE_HOSTS items must be hostnames. Its review left three small notes. This card settles them. It changes no deployment value and connects to nothing.

1. Optional url variables. The url check SHU-294 added runs before the old per-variable loop and assumes every url-kind variable is set. Today all of them are required and the missing-variable check runs first, so nothing breaks. But an optional url left unset would be reported as invalid, and an optional url-list would throw a TypeError on .split. Make every url check skip a url-kind variable that is not required and is unset or blank, exactly as the old loop already skips such variables. A variable that is set is still checked in full. Pin this with a test. CONFIG_SCHEMA itself has no optional url today, and you must not add one or change any schema entry. So either let validateDeploymentEnv take the schema as an optional second argument that defaults to CONFIG_SCHEMA, or export a small helper the test can call with its own entries. Keep every current call validateDeploymentEnv(env) working unchanged.

2. One place per rule. The url and url-list values, the empty list-part check and the host-list check are now validated twice: in the new early checks and again in the old loop near the end of validateDeploymentEnv. Because of that, removing either copy of the empty-part guard goes unnoticed. Keep each rule in exactly one place, and make sure removing it fails a test in deploy/coolify/test/config-schema.test.mjs. An error for any single wrong variable must keep its current message, and the order in which the checks report must not change for any single wrong variable. DATABASE_URL keeps its own postgres check, and OIDC_CALLBACK_URL keeps passing http (the gateway owns the https rule; deploy/coolify/test/deployment.test.mjs, outside your scope, expects its message).

3. The 253-character host-name cap. isHostname rejects names longer than 253 characters, but no test pins it, because the existing long case is already caught by the 63-character label rule. Add a test with five 63-character labels joined by dots (319 characters) that expects "PLATFORM_DATABASE_HOSTS must be a valid host-list", so dropping the cap fails it.

Constraints.
- Every current export, error message and test must keep passing. deploy/coolify/deployment-env-manifest.mjs and deploy/coolify/test/deployment.test.mjs (both outside your scope) depend on them.
- preflight.mjs imports nothing but node: builtins (the production image copies it alone).
- No error message may contain a configured value.
- deploy/coolify/integration-register.mjs, deploy/coolify/integration-register.json and docs/integrations.md must stay byte-identical. They are in your workspace only so the register tests can run.
- Tests use node:test and node:assert only and import only files in your scope and node: builtins. Write expected messages out literally.

Out of scope: the Dockerfile, the env manifest, deployment.test.mjs, compose files, CONFIG_SCHEMA's entries, any network call or credential, any change outside the paths you are given.`;

// The fourth card is the first whole-tree card: organization owners edit
// their own profile (slice O2). Its writer holds the bound tree with
// dependencies installed, so it can typecheck and run the suite, and may still
// change only these paths. Until reviewers run commands, the card PR's CI runs
// typecheck, test and test:db, and the review desk judges the exact head.
export const SHU160_PATHS = Object.freeze([
  "packages/organizations/src/profile-writes.ts",
  "packages/organizations/src/index.ts",
  "packages/organizations/test/profile-writes.test.ts",
  "packages/organizations/test/profile-writes-mutations.mjs",
  "packages/db/migrations/0150_organization_profile.sql",
  "packages/db/src/postgres-organization-profile-store.ts",
  "packages/db/src/index.ts",
  "packages/db/test/postgres-organization-profile.test.ts",
  "packages/db/test/postgres-authz-store.test.ts",
  "apps/gateway/src/organization-profile.ts",
  "apps/gateway/src/index.ts",
  "apps/gateway/src/login-runtime.ts",
  "apps/gateway/src/organization-documents-runtime.ts",
  "apps/gateway/test/organization-profile-http.test.ts",
  "packages/private-documents/src/organization-documents.ts",
  "package.json",
]);

const SHU160_ACCEPTANCE = [
  "(1) every profile field (Arabic and English name, descriptions, website) is written only through preview, confirm and receipt on the existing safe-write contract, and letting the website bypass preview makes the runSafeWriteConformance check for the profile write fail;",
  "(2) the logo and the commercial licence are private objects delivered only by authorized, expiring links, and marking the licence public-read makes the private-delivery negative-control test fail;",
  "(3) only the organization's owner may write; a recruiter or any other grant gets not_found, never 403, and accepting it makes the recruiter-write-refused test fail;",
  "(4) no document key or URL ever appears in a receipt, and letting one in makes the receipt-whitelist test fail;",
  "(5) an owner can never edit another organization, and allowing it makes the cross-org test fail;",
  "(6) every write is audited in the same transaction as the change, migration 0150 is additive and its audit constraint still accepts every existing row and every operation 0147 and 0148 added, and packages/organizations/test/profile-writes-mutations.mjs applies mutations (1) to (5) and each fails its named test;",
  "(7) npm run typecheck and npm test pass, the new tests run from package.json's test and test:db commands, the mutation script runs as its own npm script chained into test, and nothing outside the card's paths changes.",
].join(" ");

const SHU160_BRIEF = `Card SHU-160: organization owners edit their own profile through safe write (slice O2).

You are working in the StudentHub platform monorepo at the bound head. Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Read first:
- docs/parity/organizations-stores-and-contacts.md, especially row OR-03, finding OR-F10, slice O2 in section 11 and decision D-OR1.
- The safe-write path card SHU-84 added for the language preference: packages/safe-write-contract (including src/conformance.ts and runSafeWriteConformance), packages/db/src/safe-write-store.ts, packages/db/migrations/0147_person_language_safe_write.sql, apps/gateway/src/language-preference.ts and apps/gateway/test/language-preference.test.ts. Follow that pattern exactly.
- packages/organizations (the O1 read model), packages/organizations/test/mutations.mjs (the mutation-script pattern) and packages/private-documents (private storage with authorized, expiring delivery).

Goal. An organization owner can edit their own organization's name (Arabic and English), descriptions and website. Every one of those fields goes through the existing safe-write path: preview, then confirm, then a receipt, the same contract as the language preference. The owner can also replace or remove the logo and upload a commercial-licence document. Both are stored as private objects through the existing private-documents storage and delivered only by authorized, expiring links, never by a public URL (finding OR-F10). Every write is audited in the same transaction as the change, following the existing authorization_mutation_audit pattern.

Acceptance. Each item is pinned by a mutation in packages/organizations/test/profile-writes-mutations.mjs that makes a named test fail. Model the script on packages/organizations/test/mutations.mjs: apply each mutation to the built module, run the named test, expect it to fail, and restore.
(1) Bypass preview for website: the runSafeWriteConformance check for the profile write fails.
(2) Mark the licence public-read: the private-delivery negative-control test fails.
(3) Accept a recruiter or any other non-owner grant on write: the recruiter-write-refused test fails. A non-owner gets not_found, never 403.
(4) Let a document key or URL into the receipt: the receipt-whitelist test fails.
(5) Edit an organization other than the caller's own: the cross-org test fails.
Use synthetic fixtures only.

Your paths, and what each may hold:
- packages/organizations/src/profile-writes.ts (new)
- packages/organizations/src/index.ts (exports only)
- packages/organizations/test/profile-writes.test.ts (new)
- packages/organizations/test/profile-writes-mutations.mjs (new)
- packages/db/migrations/0150_organization_profile.sql (new; additive; any widened audit constraint must still accept every existing row and every operation 0147 and 0148 added)
- packages/db/src/postgres-organization-profile-store.ts (new)
- packages/db/src/index.ts (exports only)
- packages/db/test/postgres-organization-profile.test.ts (new)
- packages/db/test/postgres-authz-store.test.ts: only add "0150_organization_profile" after "0148_candidate_profile_records" in both schema_migrations lists
- apps/gateway/src/organization-profile.ts (new; modelled on language-preference.ts)
- apps/gateway/src/index.ts (route wiring only)
- apps/gateway/src/login-runtime.ts (wiring only: construct the profile service next to the language preference, from the same stores and safe-write key)
- apps/gateway/src/organization-documents-runtime.ts (new, only if the logo and licence need their own storage wiring; model it on apps/gateway/src/candidate-documents-runtime.ts)
- apps/gateway/test/organization-profile-http.test.ts (new)
- packages/private-documents/src/organization-documents.ts (new, only if an organization document kind is needed; do not modify existing private-documents files)
- package.json: only append the new built test files to the existing test and test:db commands, and add a test:organization-profile:mutations script that runs the mutation script, chained into test after test:organizations:mutations. Never change dependencies.

Out of scope: company self-activation (OR-04), staff or admin organization editing (O5), any UI beyond what the route needs, any change to packages/safe-write-contract or the login code, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-71: the first whole-tree card's builder stopped after six of its 45
// minutes with part of the brief done and returned FAILED, which ends a
// single-run episode. Both writer adapters say what each stage is for.
export const WRITER_FINISH_RULE = "Finish the whole brief before you return. Unfinished work is never a reason to return: keep working until every acceptance item holds. Take the time the work needs; your run allows far more than a first pass. Use BLOCKED only for an in-scope blocker you cannot resolve, and FAILED only for a run failure outside your work, such as a broken toolchain; never use either for work you have not finished yet.";

export const CARD_CONTRACTS = Object.freeze({
  "SHU-197": Object.freeze({
    initial_build_paths: SHU197_PATHS,
    revision_paths: SHU197_PATHS,
    acceptance: SHU197_ACCEPTANCE,
    brief: SHU197_BRIEF,
  }),
  "SHU-294": Object.freeze({
    initial_build_paths: SHU294_PATHS,
    revision_paths: SHU294_PATHS,
    acceptance: SHU294_ACCEPTANCE,
    brief: SHU294_BRIEF,
  }),
  "SHU-295": Object.freeze({
    initial_build_paths: SHU295_PATHS,
    revision_paths: SHU295_PATHS,
    acceptance: SHU295_ACCEPTANCE,
    brief: SHU295_BRIEF,
  }),
  "SHU-160": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU160_PATHS,
    revision_paths: SHU160_PATHS,
    acceptance: SHU160_ACCEPTANCE,
    brief: SHU160_BRIEF,
  }),
});

export function cardContract(issueId) {
  return typeof issueId === "string" && Object.hasOwn(CARD_CONTRACTS, issueId) ? CARD_CONTRACTS[issueId] : null;
}

// The writer and the reviewer of a card both get its brief. Fixtures have none:
// their files are their contract.
export function cardBrief(issueId) {
  return cardContract(issueId)?.brief ?? null;
}
