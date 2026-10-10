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

// SHU-300 splits SHU-160 after its second run: one episode built all of O2 and
// one revision, and the verifier blocked both heads, mostly on the document
// half. This card is the text half; the brief names each pitfall the verifier
// found so the build avoids it the first time.
export const SHU300_PATHS = Object.freeze([
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
  "apps/gateway/test/organization-profile-http.test.ts",
  "package.json",
]);

const SHU300_ACCEPTANCE = [
  "(1) the Arabic and English name, the descriptions and the website are written only through preview, confirm and receipt on the existing safe-write contract, and runSafeWriteConformance runs over the profile write's own builder, so letting the website bypass preview makes that conformance test fail;",
  "(2) only the organization's owner may write; a recruiter or any other grant gets not_found, never 403; the owner decision is one function the Postgres store calls inside its commit transaction, and accepting a recruiter there makes the recruiter-write-refused test fail;",
  "(3) an owner can never edit another organization; the same function decides it, and allowing it makes the cross-org test fail;",
  "(4) the store's commit compares the previewed value inside the transaction through a function it calls there and refuses with state_changed when the value moved; making that compare always succeed makes the stale-confirm test fail; grants are read FOR SHARE under the organization lock, and a racing duplicate confirm returns token_already_used;",
  "(5) every write is audited in the same transaction as the change with hashed organization references (organizationAuditRef, never a raw id), migration 0150 is additive and its audit constraint still accepts every existing row and every operation 0147 and 0148 added;",
  "(6) packages/organizations/test/profile-writes-mutations.mjs applies mutations (1) to (4), each makes its named test fail, and the script itself passes on the unmutated code;",
  "(7) npm run typecheck and npm test pass, the new tests run from package.json's test and test:db commands, the mutation script runs as its own npm script chained into test, and nothing outside the card's paths changes.",
].join(" ");

const SHU300_BRIEF = `Card SHU-300: organization owners edit their organization's name, descriptions and website through safe write (slice O2a, the text half of O2).

You are working in the StudentHub platform monorepo at the bound head. Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Read first:
- docs/parity/organizations-stores-and-contacts.md, especially row OR-03, slice O2 in section 11 and decision D-OR1.
- The safe-write path for the language preference, which this card copies: packages/safe-write-contract (types.ts, safe-write.ts, conformance.ts), packages/db/src/safe-write-store.ts, packages/db/migrations/0147_person_language_safe_write.sql, apps/gateway/src/language-preference.ts, apps/gateway/test/language-preference.test.ts and how apps/gateway/src/login-runtime.ts constructs it.
- packages/organizations (the O1 read model), packages/organizations/test/mutations.mjs (the mutation-script pattern) and packages/db/src/authorization-audit.ts (organizationAuditRef).

Goal. An organization owner can edit their own organization's name (Arabic and English), descriptions and website. Each field goes through the existing safe-write path: preview, then confirm, then a receipt, the same contract as the language preference. The logo and the commercial licence are NOT part of this card; a later card adds them.

Pitfalls a previous attempt at this slice hit. Avoid each one:
- Audit rows: target_org_refs holds SHA-256 hex references and has a check constraint since migration 0004. Write organizationAuditRef(orgId), never the raw id, or every confirm fails with 23514.
- Lost update: an organization can have several owners. The store's commit must compare the previewed value (expectedBefore) inside the same transaction and return state_changed when it moved, as PostgresSafeWriteStore does. An unconditional INSERT ... ON CONFLICT DO UPDATE is wrong. If you take an advisory lock, key it on the organization, not the principal.
- Conformance: run runSafeWriteConformance over the profile write's own builder, the function the gateway route actually calls, not over the raw createSafeWrite factory. Otherwise a bypass in the profile code cannot fail it.
- Mutation script: copy packages/organizations/test/mutations.mjs exactly, including its --test-name-pattern form (a "^" prefix and a trailing space, not "$"), so each mutant run selects its named test. Check by hand that each mutant really fails its test and that the script passes on the unmutated code.
- HTTP: follow language-preference.ts for headers (x-content-type-options nosniff, referrer-policy no-referrer), body parsing and the try/catch around the handler, and have the HTTP test call the real handler.
- The Postgres test must exercise the store against the database (test:db), not grep the SQL file.

What this card's own first run got wrong. Its reviewer blocked it for these; fix each one:
- Mutations must hit the code production runs. The owner check and the stale-state compare were helpers in profile-writes.ts that only the test's fake store called, while the Postgres store made its own decisions in SQL, so breaking the real checks left every test green and every mutation still "killed". Keep each decision in one exported function in packages/organizations/src/profile-writes.ts, give that function to PostgresOrganizationProfileStore through its constructor (login-runtime.ts wires it in; packages/db must not import packages/organizations, and dependencies stay unchanged), and have the store call it inside the commit transaction on the rows it read there. The store's grants query selects the caller's grant rows without filtering by role or organization, so the role and organization decision is the injected function's, not the SQL's. The mutations in (2) to (4) change those functions, and the unit tests drive them through the real profile write.
- Revocation race: under the organization advisory lock, read the caller's grants with SELECT ... FOR SHARE, so a concurrent revocation either commits first or waits for this write.
- Duplicate confirm: if two confirms of one token race, the unique index on the audit token raises 23505. Catch it inside the store and return token_already_used, never an error or a 503.
- Migration 0150: add the same halves check that 0147 adds (auth_audit_safe_write_halves) for the new operation, so a value-present audit row without a token reference is refused.
- Cover a successful commit in the Postgres test: assert its audit row exists with the hashed organization reference and the expected operation.
- package.json: leave every existing script's text as it is. Append the new built test files at the END of the existing node --test lists in test and test:db, add the test:organization-profile:mutations script, and add " && npm run test:organization-profile:mutations" as its own step right after "npm run test:organizations:mutations" in test. Do not edit test:organizations:mutations itself, packages/organizations/test/organizations.test.ts or packages/organizations/test/mutations.mjs. Run npm test to the end before you return.

Acceptance. Each item is pinned by a mutation in packages/organizations/test/profile-writes-mutations.mjs that makes a named test fail.
(1) Let the website bypass preview: the runSafeWriteConformance test for the profile write fails.
(2) Accept a recruiter or any other non-owner grant on write, in the owner function the store calls: the recruiter-write-refused test fails. A non-owner gets not_found, never 403.
(3) Accept another organization's grant, in that same function: the cross-org test fails.
(4) Make the state compare the store calls always succeed: the stale-confirm test fails.
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
- apps/gateway/src/login-runtime.ts (wiring only: construct the profile service next to the language preference, from the same pool and safe-write key)
- apps/gateway/test/organization-profile-http.test.ts (new)
- package.json: only append the new built test files to the existing test and test:db commands, and add a test:organization-profile:mutations script that runs the mutation script, chained into test after test:organizations:mutations. Never change dependencies.

Out of scope: the logo and the commercial licence, company self-activation (OR-04), staff or admin organization editing (O5), any UI beyond what the route needs, any change to packages/safe-write-contract or the login code, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-301 is the document half of slice O2, after SHU-300 landed the text half.
// SHU-160's second run built a first pass of it, and the verifier blocked it for
// a parallel module, missing cross-site checks and a delivery path the candidate
// documents route already owns. The brief names each so the build avoids them.
export const SHU301_PATHS = Object.freeze([
  "packages/private-documents/src/index.ts",
  "apps/gateway/src/organization-documents-http.ts",
  "apps/gateway/src/organization-documents-runtime.ts",
  "apps/gateway/src/index.ts",
  "apps/gateway/test/organization-documents-http.test.ts",
  "apps/gateway/test/organization-documents-mutations.mjs",
  "package.json",
]);

const SHU301_ACCEPTANCE = [
  "(1) an organization owner can upload, replace and remove the organization's logo (company-logo) and commercial licence (commercial-licence) through the existing PrivateDocuments class, with no parallel storage module, and fetch either only through an authorized, expiring delivery link; serving a document without a valid, unexpired link makes the private-delivery negative-control test fail;",
  "(2) every response carries only the document's id, type, mime type, size and version, never a storage key, a data field or a URL other than the delivery link the delivery operation returns, and letting a key or URL into an upload, replace or remove response makes the response-whitelist test fail;",
  "(3) a cookie-authenticated upload, replace, remove or delivery-link request needs the exact configured Origin, is refused when sec-fetch-site is cross-site, and needs the right content type, as the candidate documents route does; dropping the origin check makes the cross-site-upload test fail;",
  "(4) only the organization's owner may change or fetch its documents; a recruiter, a candidate, another organization's owner or an anonymous caller gets not_found, never 403, and mapping that refusal to 403 makes the non-owner test fail;",
  "(5) organization delivery links use their own path, which handleCandidateDocuments does not claim, and verify with the organization service's own key; candidate delivery links and every existing private-documents and candidate-documents test are unchanged;",
  "(6) apps/gateway/test/organization-documents-mutations.mjs applies mutations (1) to (4), each makes its named test fail, and the script itself passes on the unmutated code;",
  "(7) npm run typecheck and npm test pass, the new test runs from package.json's test command, the mutation script runs as its own npm script chained into test, and nothing outside the card's paths changes.",
].join(" ");

const SHU301_BRIEF = `Card SHU-301: organization owners replace the logo and upload the commercial licence as private documents (slice O2b, the document half of O2).

You are working in the StudentHub platform monorepo at the bound head. Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/.

Read first:
- docs/parity/organizations-stores-and-contacts.md, especially row OR-03, finding OR-F10 and slice O2 in section 11.
- packages/private-documents/src/index.ts. PrivateDocuments already supports organization documents: the company-logo and commercial-licence types, an organization scope (orgId with no personId), an org-owner authorization check through resolveActiveContext, upload, replace, remove, issueDelivery and deliver. This card uses that class.
- apps/gateway/src/candidate-documents-http.ts and apps/gateway/src/candidate-documents-runtime.ts: how the gateway reads the session credential, checks Origin and sec-fetch-site, limits and parses bodies, sets security headers, maps errors to a closed vocabulary, and builds the service from the DOCUMENT_* environment.
- apps/gateway/src/index.ts: how handleCandidateDocuments and handleOrganizationProfile are mounted.
- packages/private-documents/test/mutations.mjs and packages/organizations/test/profile-writes-mutations.mjs: the mutation-script pattern.

Goal. An organization's owner can upload, replace and remove the organization's logo and commercial licence, and fetch either one through an authorized, expiring link, never a public URL (finding OR-F10). The stored document of each type for an organization is the source of truth; there is no database change.

Pitfalls the first attempt at this slice hit. Avoid each one:
- Do not add a parallel document module. Use PrivateDocuments as it is. The only change allowed in packages/private-documents/src/index.ts is an optional delivery path option for the PrivateDocuments constructor, used by issueDelivery, deliver and handleDelivery. Its default must stay "/private-documents/delivery", so every candidate link stays byte-identical and every existing private-documents test passes unchanged.
- Delivery path: handleCandidateDocuments claims every URL that starts with /candidate-documents or /private-documents/, and it is mounted before any organization route. Organization delivery links therefore need their own path outside both prefixes, for example /organization-documents/delivery, set through that option. They must verify with the organization service's own signing key.
- Cross-site requests: every cookie-authenticated request that changes a document or issues a delivery link must check the exact configured Origin, refuse sec-fetch-site cross-site, and require application/json (or the exact upload content type you define), as the candidate route does. The delivery GET itself is the only request that may skip the Origin check, and only because its signed, expiring link is the authority.
- Not found: a non-owner, another organization's owner or an anonymous caller gets 404 not_found, never 403. PrivateDocuments raises denied for all of these, so the route maps denied to not_found.
- Responses: return only id, type, mime, size and version for a document, and the url and expiresAt that issueDelivery returns for a delivery request. Never return the stored data, the scope, a storage key or any other URL.
- Wiring: build the organization service in apps/gateway/src/organization-documents-runtime.ts from the same DOCUMENT_* environment and stores the candidate runtime uses, with the same session-based authenticate. When that environment is absent, return undefined and the route answers 503 unavailable, as the candidate route does.

Acceptance. Each item is pinned by a mutation in apps/gateway/test/organization-documents-mutations.mjs that makes a named test fail. Model the script on packages/organizations/test/profile-writes-mutations.mjs: build first, apply each mutation to the built module under dist/, run the named test with the same --test-name-pattern form (a "^" prefix and a trailing space after the full test name), expect it to fail, and restore. Check by hand that each mutant really fails its test and that the script passes on the unmutated code.
(1) Serve a document without a valid, unexpired delivery link: the private-delivery negative-control test fails.
(2) Let a storage key or URL into an upload, replace or remove response: the response-whitelist test fails.
(3) Drop the Origin check: the cross-site-upload test fails.
(4) Map a non-owner's refusal to 403: the non-owner test fails.
Use synthetic fixtures only: a temporary FileDocumentStore and an in-memory authz store and session store, as the existing private-documents tests do. The HTTP test calls the real handler.

Your paths, and what each may hold:
- packages/private-documents/src/index.ts: only the optional delivery path option described above
- apps/gateway/src/organization-documents-http.ts (new; modelled on candidate-documents-http.ts)
- apps/gateway/src/organization-documents-runtime.ts (new; modelled on candidate-documents-runtime.ts)
- apps/gateway/src/index.ts: route wiring only, mounted after handleCandidateDocuments
- apps/gateway/test/organization-documents-http.test.ts (new)
- apps/gateway/test/organization-documents-mutations.mjs (new)
- package.json: leave every existing script's text as it is. Append the new built test file at the END of the node --test list in test, add a test:organization-documents:mutations script that runs the mutation script, and add " && npm run test:organization-documents:mutations" as its own step right after "npm run test:organization-profile:mutations" in test. Never change dependencies.

Out of scope: any profile text field (SHU-300 did those), any database migration, company self-activation (OR-04), staff or admin organization editing (O5), any UI beyond what the route needs, any change to the candidate documents route or packages/safe-write-contract, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-305 is the first write slice of O5 (SHU-163): staff and admin set or
// clear an organization's status override through safe write, on SHU-300's
// pattern. The brief carries what SHU-300's reviewer blocked, so the build
// starts from the pattern that passed.
export const SHU305_PATHS = Object.freeze([
  "packages/organizations/src/status-writes.ts",
  "packages/organizations/src/organizations.ts",
  "packages/organizations/src/index.ts",
  "packages/organizations/test/status-writes.test.ts",
  "packages/organizations/test/status-writes-mutations.mjs",
  "packages/db/migrations/0184_organization_status_override.sql",
  "packages/db/src/postgres-organization-status-store.ts",
  "packages/db/src/index.ts",
  "packages/db/test/postgres-organization-status.test.ts",
  "packages/db/test/postgres-authz-store.test.ts",
  "apps/gateway/src/organization-status.ts",
  "apps/gateway/src/index.ts",
  "apps/gateway/src/login-runtime.ts",
  "apps/gateway/test/organization-status-http.test.ts",
  "package.json",
]);

const SHU305_ACCEPTANCE = [
  "(1) an organization's status override (active, under_review, inactive, or none to clear it) is written only through preview, confirm and receipt on the existing safe-write contract, and runSafeWriteConformance runs over the status write's own builder, so letting the status bypass preview makes that conformance test fail;",
  "(2) only a staff or admin grant that covers the organization (on the organization itself, or a subtree grant on an ancestor such as the operator organization) may write; an org-owner, a recruiter, a candidate or any other grant gets not_found, never 403; an operator organization itself is never a target; the decision is one function the Postgres store calls inside its commit transaction, and accepting an org-owner there makes the owner-write-refused test fail;",
  "(3) the store's commit compares the previewed value inside the transaction through a function it calls there and refuses with state_changed when the value moved; making that compare always succeed makes the stale-confirm test fail; grants are read FOR SHARE under the organization lock, and a racing duplicate confirm returns token_already_used;",
  "(4) once the platform holds a status record for an organization, OrganizationRepository derives that organization's status from it for every audience (employer, staff, admin) through deriveOrganizationStatus, and a cleared record falls back to the counter derivation rather than the imported override; ignoring the stored record makes the stored-override-wins test fail;",
  "(5) every write is audited in the same transaction as the change with hashed organization references (organizationAuditRef, never a raw id) under the new operation organization.status.safe_write; migration 0184 is additive, and its audit constraints and summary function still accept every existing row and every operation migrations 0147 to 0183 added;",
  "(6) packages/organizations/test/status-writes-mutations.mjs applies mutations (1) to (4), each makes its named test fail, and the script itself passes on the unmutated code;",
  "(7) npm run typecheck and npm test pass, the new tests run from package.json's test and test:db commands, the mutation script runs as its own npm script chained into test, and nothing outside the card's paths changes.",
].join(" ");

const SHU305_BRIEF = `Card SHU-305: staff and admin change an organization's status through safe write (slice O5a, the first write slice of O5).

You are working in the StudentHub platform monorepo at the bound head. Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Read first:
- docs/parity/organizations-stores-and-contacts.md: the status rule in section 1 (point 2), finding OR-F2, row OR-08 and slice O5 in section 11.
- SHU-300's organization profile write, which this card copies and which passed review: packages/organizations/src/profile-writes.ts and its tests and mutation script, packages/db/src/postgres-organization-profile-store.ts, packages/db/migrations/0150_organization_profile.sql, apps/gateway/src/organization-profile.ts, apps/gateway/test/organization-profile-http.test.ts, and how apps/gateway/src/login-runtime.ts constructs it.
- packages/organizations/src/organizations.ts: statusOverride, deriveOrganizationStatus, ORGANIZATION_DIRECTORY_ROLES, DEFAULT_OPERATOR_ORG_IDS and OrganizationRepository.
- packages/contracts/src/authz/context.ts (listEffectiveContexts) and packages/contracts/src/authz/organization.ts: how a subtree grant on an ancestor covers a descendant organization.
- packages/db/migrations/0183_candidate_bank_details.sql: the latest definitions of the audit constraints and of authorization_audit_summary_valid, which your migration must extend, not replace with an older copy.

Goal. Staff and admin can set an organization's status override to active, under_review or inactive, or clear it, through the existing safe-write path: preview, then confirm, then a receipt, the same contract as the organization profile. The value is stored in the platform database, and the read model then shows it to every audience, so employer, staff and admin always see the same status (finding OR-F2).

Design:
- Store the override in a new table organization_status_overrides (org_id text primary key referencing organizations(id) on delete cascade, status text null with a check constraint allowing only active, under_review and inactive, updated_at timestamptz). NULL means cleared. In the safe-write field vocabulary, the one field is "status", and clearing is the value "none".
- Who may write: one exported decision function in packages/organizations/src/status-writes.ts takes the caller's grant rows (org_id, role, scope), the target organization id and the target's ancestor ids, and allows the write only when a grant with role staff or admin is on the target itself, or is a subtree grant on one of its ancestors. An operator organization (DEFAULT_OPERATOR_ORG_IDS) is never a target. Everything else, including org-owner and recruiter, is refused, and the route answers 404 not_found, never 403.
- Read model: give OrganizationRepository an optional port that returns the platform's status record for an organization: absent (no record), cleared, or a status. When a record exists, the repository derives status from it instead of from the imported company_status_override: a status wins, and a cleared record falls back to the counter derivation. With no record, behaviour is exactly as today. Keep one derivation: route the stored record through deriveOrganizationStatus (for example by setting the row's override before deriving), never a second status function. Existing organizations and directory tests must pass unchanged.

Pitfalls SHU-300's reviewer blocked. Avoid each one:
- Mutations must hit the code production runs. Keep the grant decision and the stale-state compare as exported functions in status-writes.ts, give them to PostgresOrganizationStatusStore through its constructor (login-runtime.ts wires them in; packages/db must not import packages/organizations, and dependencies stay unchanged), and have the store call them inside the commit transaction on the rows it read there. The store's grants query selects the caller's grant rows (org_id, role, scope) without filtering by role or organization, and its ancestry query reads the organization chain, so the decision is the injected function's, not the SQL's.
- Audit rows: write organizationAuditRef(orgId) in target_org_refs, never the raw id.
- Lost update: two staff members can race. The commit compares the previewed value (expectedBefore) inside the transaction through the injected compare and returns state_changed when it moved. Take an advisory lock keyed on the organization, and read the caller's grants with SELECT ... FOR SHARE under it, so a concurrent revocation either commits first or waits for this write.
- Duplicate confirm: if two confirms of one token race, the unique index on the audit token raises 23505. Catch it inside the store and return token_already_used, never an error or a 503.
- Migration 0184: add organization.status.safe_write to every constraint and to authorization_audit_summary_valid where organization.profile.safe_write appears, with target_org_refs cardinality > 0, the safe-write halves check, the receipt shape with fields exactly ["status"], and unique indexes on its token and receipt as 0150 adds for the profile. Start from 0183's definitions so every operation and every existing row stays valid.
- Conformance: run runSafeWriteConformance over the status write's own builder, the function the gateway route calls, not over the raw createSafeWrite factory.
- Mutation script: copy packages/organizations/test/profile-writes-mutations.mjs, including its --test-name-pattern form (a "^" prefix and a trailing space, not "$"). Check by hand that each mutant really fails its named test and that the script passes on the unmutated code.
- HTTP: follow organization-profile.ts for the session, Origin and content-type checks, headers, body parsing, error mapping and the try/catch around the handler, and have the HTTP test call the real handler.
- The Postgres test must exercise the store against the database (test:db), including one successful commit whose audit row has the hashed organization reference and the new operation, and one refused org-owner write.

Acceptance. Each item is pinned by a mutation in packages/organizations/test/status-writes-mutations.mjs that makes a named test fail.
(1) Let the status bypass preview: the runSafeWriteConformance test for the status write fails.
(2) Accept an org-owner grant in the decision function the store calls: the owner-write-refused test fails.
(3) Make the state compare the store calls always succeed: the stale-confirm test fails.
(4) Ignore the stored record in OrganizationRepository: the stored-override-wins test fails.
Use synthetic fixtures only.

Your paths, and what each may hold:
- packages/organizations/src/status-writes.ts (new)
- packages/organizations/src/organizations.ts: only the optional status-record port on OrganizationRepository and applying it before deriveOrganizationStatus
- packages/organizations/src/index.ts (exports only)
- packages/organizations/test/status-writes.test.ts (new)
- packages/organizations/test/status-writes-mutations.mjs (new)
- packages/db/migrations/0184_organization_status_override.sql (new; additive)
- packages/db/src/postgres-organization-status-store.ts (new)
- packages/db/src/index.ts (exports only)
- packages/db/test/postgres-organization-status.test.ts (new)
- packages/db/test/postgres-authz-store.test.ts: only add "0184_organization_status_override" after "0183_candidate_bank_details" in both schema_migrations lists
- apps/gateway/src/organization-status.ts (new; modelled on organization-profile.ts)
- apps/gateway/src/index.ts (route wiring only)
- apps/gateway/src/login-runtime.ts (wiring only: construct the status service next to the organization profile, from the same pool and safe-write key)
- apps/gateway/test/organization-status-http.test.ts (new)
- package.json: leave every existing script's text as it is. Append the new built test files at the END of the existing node --test lists in test and test:db, add a test:organization-status:mutations script that runs the mutation script, and add " && npm run test:organization-status:mutations" as its own step right after "npm run test:organization-documents:mutations" in test. Never change dependencies.

Out of scope: creating organizations or sub-organizations, commercial terms, account-manager assignment, approved-to-hire, the status-change email or any notification, any UI beyond what the route needs, any change to packages/safe-write-contract, packages/contracts or the login code, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

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
  "SHU-300": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU300_PATHS,
    revision_paths: SHU300_PATHS,
    acceptance: SHU300_ACCEPTANCE,
    brief: SHU300_BRIEF,
  }),
  "SHU-301": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU301_PATHS,
    revision_paths: SHU301_PATHS,
    acceptance: SHU301_ACCEPTANCE,
    brief: SHU301_BRIEF,
  }),
  "SHU-305": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU305_PATHS,
    revision_paths: SHU305_PATHS,
    acceptance: SHU305_ACCEPTANCE,
    brief: SHU305_BRIEF,
  }),
});

// SHU-303: a review-only card has no writer. Each run of it reviews one open
// pull request of the pilot repository at the exact head its single-run
// activation names, against the base the activation names, and its verdict is
// final: PASS and BLOCKED both end the episode, and nothing is revised or
// merged. The pull request, its head and its base are per-run facts, so they
// live in the operator's activation record (single-run-activation.mjs), never
// here; what is pinned here is the standing card and what its reviewer holds
// every change to. It is not a CARD_CONTRACTS entry, because everything that
// reads one expects a writer and its paths.
export const REVIEW_ONLY_BRIEF = `This is a review-only run. There is no writer and no revision round: your verdict is final for this head. You review one open pull request of this repository. The change under review is every commit from its base to the bound head, quoted below as a diff, and the whole repository at the bound head is checked out for you to read.

Hold the change to:
- correctness: the code does what its own tests, comments, docs and the surrounding code say it should, including error paths and edge cases;
- security: no injection, no secret or personal data exposed or logged, no authorization or origin check weakened, no unsafe file or network access;
- its tests: new behaviour is covered, and no test was weakened, skipped or deleted to make a run pass;
- the repository's own rules: CLAUDE.md, AGENTS.md and REVIEW.md where they exist, and the conventions of the files it touches.

The pull request's title, body and comments are not given to you, on purpose. Judge only the code. The confined runner does not run this change's tests; CI runs them on the pull request, and it cannot merge until they pass.`;

export const REVIEW_ONLY_ACCEPTANCE = "the change is correct, secure and covered by its tests, and it follows the repository's own rules.";

export const REVIEW_ONLY_CARDS = Object.freeze({
  "SHU-304": Object.freeze({ brief: REVIEW_ONLY_BRIEF, acceptance: REVIEW_ONLY_ACCEPTANCE }),
});

export function reviewOnlyCard(issueId) {
  return typeof issueId === "string" && Object.hasOwn(REVIEW_ONLY_CARDS, issueId) ? REVIEW_ONLY_CARDS[issueId] : null;
}

for (const id of Object.keys(REVIEW_ONLY_CARDS)) {
  if (Object.hasOwn(CARD_CONTRACTS, id)) throw new Error(`${id} cannot be both a build card and a review-only card`);
}

export function cardContract(issueId) {
  return typeof issueId === "string" && Object.hasOwn(CARD_CONTRACTS, issueId) ? CARD_CONTRACTS[issueId] : null;
}

// The writer and the reviewer of a card both get its brief. Fixtures have none:
// their files are their contract.
export function cardBrief(issueId) {
  return cardContract(issueId)?.brief ?? reviewOnlyCard(issueId)?.brief ?? null;
}
