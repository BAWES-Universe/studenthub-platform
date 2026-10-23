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
  "(4) once the platform holds a status record for an organization, OrganizationRepository derives that organization's status from it for every audience (employer, staff, admin) and in every read (the organization card, sub-organizations and the company list) through deriveOrganizationStatus, including an inactive status and an organization with no approved snapshot, and a cleared record falls back to the counter derivation rather than the imported override; the live gateway passes the store's status reader to the repository; ignoring the stored record makes the stored-override-wins test fail;",
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
- Read model: give OrganizationRepository an optional constructor port, statusRecords, whose read(orgId) returns the platform's status record for an organization: absent (no record), cleared, or a status (active, under_review or inactive). Keep one derivation: give deriveOrganizationStatus an optional second argument, the record, rather than writing a second status function. A stored status wins; a cleared record skips the imported company_status_override and falls back to the counter derivation; an absent record, or no argument, keeps today's behaviour exactly. Never write the stored status into company_status_override: the legacy codes there are only 10 (active) and 9 (under_review), so inactive cannot be expressed that way and 0 means no override.
- Apply the record wherever status is derived: read (the status field, and for staff and admin the statusOverride field, which shows the stored status, or not_recorded when cleared), listSubOrganizations and the company list entries.
- No approved snapshot: the live gateway's snapshot adapter is unconfigured, so today every row is undefined and every field is not_imported. A stored status must still show there: status (and statusOverride for staff and admin) come from the record, while every other field and the snapshot provenance stay not_imported. A cleared or absent record with no snapshot leaves status not_imported. Test the stored record with and without a snapshot, and with inactive. Existing organizations and directory tests must pass unchanged.
- Live wiring: login-runtime.ts constructs the status store from DATABASE_URL, passes its status reader to OrganizationRepository as statusRecords whether or not the safe-write key is set, and constructs the status write service from the same store only when the key is set (as the organization profile does), so live reads consult the new table. The store exposes that reader as a method that reads organization_status_overrides; the Postgres test reads a committed write back through it, and the HTTP test reads the result of a confirmed write through an OrganizationRepository given the same port.

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
- packages/organizations/src/organizations.ts: only the optional statusRecords port on OrganizationRepository, the optional record argument of deriveOrganizationStatus, and applying the record wherever status is derived
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
- apps/gateway/src/login-runtime.ts (wiring only: construct the status store next to the organization profile store, pass its status reader to OrganizationRepository, and construct the status service from it when the safe-write key is set)
- apps/gateway/test/organization-status-http.test.ts (new)
- package.json: leave every existing script's text as it is. Append the new built test files at the END of the existing node --test lists in test and test:db, add a test:organization-status:mutations script that runs the mutation script, and add " && npm run test:organization-status:mutations" as its own step right after "npm run test:organization-documents:mutations" in test. Never change dependencies.

Out of scope: creating organizations or sub-organizations, commercial terms, account-manager assignment, approved-to-hire, the status-change email or any notification, any UI beyond what the route needs, any change to packages/safe-write-contract, packages/contracts or the login code, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-308 follows SHU-305: Sentry found that the company list and the
// sub-organization list read each organization's stored status with its own
// query. A small, read-only card, and the first a card run lands itself
// (SHU-306).
export const SHU308_PATHS = Object.freeze([
  "packages/organizations/src/organizations.ts",
  "packages/organizations/test/status-batch-reads.test.ts",
  "packages/organizations/test/status-batch-reads-mutations.mjs",
  "packages/db/src/postgres-organization-status-store.ts",
  "packages/db/test/postgres-organization-status.test.ts",
  "package.json",
]);

const SHU308_ACCEPTANCE = [
  "(1) listOrganizations reads the stored status of every organization it shows with one readMany call and no read call when the port has readMany; reading per organization makes the directory-reads-once test fail;",
  "(2) listSubOrganizations does the same for the children it shows; reading per child makes the sub-list-reads-once test fail;",
  "(3) an organization id missing from the readMany result is absent, so an imported override still shows; treating it as cleared makes the missing-means-absent test fail;",
  "(4) a port without readMany keeps working through read, and every existing organizations and directory test passes unchanged;",
  "(5) PostgresOrganizationStatusStore.readMany returns status, cleared and absent correctly in one query and makes no query for an empty list, pinned by a test:db test;",
  "(6) packages/organizations/test/status-batch-reads-mutations.mjs applies mutations (1) to (3), each makes its named test fail, and the script passes on the unmutated code;",
  "(7) npm run typecheck and npm test pass, the new test runs from package.json's test command, the mutation script runs as its own npm script chained into test, and nothing outside the card's paths changes.",
].join(" ");

const SHU308_BRIEF = `Card SHU-308: read organization status records in one query per list (a follow-up to slice O5a, SHU-305).

You are working in the StudentHub platform monorepo at the bound head. Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Read first:
- packages/organizations/src/organizations.ts: OrganizationStatusRecord, OrganizationStatusRecords, deriveOrganizationStatus, and OrganizationRepository's read, listSubOrganizations and listOrganizations.
- packages/db/src/postgres-organization-status-store.ts: read(orgId), the method the live gateway uses as the repository's statusRecords port (apps/gateway/src/login-runtime.ts passes the store itself).
- packages/organizations/test/status-writes.test.ts and status-writes-mutations.mjs: how a test imports a mutated build through an environment variable, and the --test-name-pattern form (a "^" prefix and a trailing space).
- packages/db/test/postgres-organization-status.test.ts: the Postgres test you extend.

Goal. Today listOrganizations and listSubOrganizations call statusRecords.read once per organization inside their loops, so a list of N organizations makes N database queries. Make each list read the stored status of the organizations it shows in one call. What every caller sees stays exactly the same.

Design:
- Add an optional method to OrganizationStatusRecords: readMany(orgIds: readonly string[]): Promise<ReadonlyMap<string, OrganizationStatusRecord>>. An id with no entry in the map is absent ({kind:"absent"}), never cleared.
- In listOrganizations, first decide which organizations will be shown (the covered, top-level ones the loop keeps today), then, when the port has readMany, call it once with exactly those ids and take each record from the map; when it has no readMany, call read per id as today. Do the same in listSubOrganizations for the children that pass the per-child authorization. Call readMany only when there is at least one id. The single-organization read keeps calling read.
- PostgresOrganizationStatusStore gets readMany: an empty list returns an empty map without a query; otherwise one SELECT org_id, status FROM organization_status_overrides WHERE org_id = ANY($1::text[]), mapping a NULL status to cleared and a value to status. Ids with no row are left out of the map.
- Leave snapshot reads (readSnapshot), the per-child authorization, sorting, filtering, paging and every result field as they are.

Tests (packages/organizations/test/status-batch-reads.test.ts, new; synthetic fixtures only, built like the existing directory tests):
- "SHU-308/AC-01 directory-reads-once": a counting port with read and readMany; a staff directory of at least three covered companies calls readMany exactly once with those ids and read zero times, and each entry's status comes from the map.
- "SHU-308/AC-02 sub-list-reads-once": the same for a parent with at least two visible children.
- "SHU-308/AC-03 missing-means-absent": a company with an imported override and no entry in the readMany map shows the imported override's status.
- One more test: a port with only read still gives the same results.
The test imports organizations through an environment variable (SHU308_ORG_MODULE) when it is set, as status-writes.test.ts does with SHU305_ORG_MODULE.

Mutations (packages/organizations/test/status-batch-reads-mutations.mjs, modelled on status-writes-mutations.mjs, applied to dist/organizations.js; each anchor must bind exactly once):
(1) listOrganizations ignores readMany and reads per organization: AC-01 fails.
(2) listSubOrganizations ignores readMany and reads per child: AC-02 fails.
(3) a missing map entry becomes {kind:"cleared"}: AC-03 fails.
The script runs the suite unmutated first and last, and prints "3/3 SHU-308 mutations killed".

Postgres test (append to packages/db/test/postgres-organization-status.test.ts): write one organization's status, clear a second one, leave a third without a row, then readMany over all three plus an unknown id returns status, cleared, and no entry for the other two; readMany([]) returns an empty map.

Your paths, and what each may hold:
- packages/organizations/src/organizations.ts: only the optional readMany on OrganizationStatusRecords and its use in listOrganizations and listSubOrganizations
- packages/organizations/test/status-batch-reads.test.ts (new)
- packages/organizations/test/status-batch-reads-mutations.mjs (new)
- packages/db/src/postgres-organization-status-store.ts: only the readMany method
- packages/db/test/postgres-organization-status.test.ts: only the appended test
- package.json: leave every existing script's text as it is. Append dist/packages/organizations/test/status-batch-reads.test.js at the END of the node --test list in test, add a test:organization-status-batch:mutations script that runs the mutation script, and add " && npm run test:organization-status-batch:mutations" as its own step right after "npm run test:organization-status:mutations" in test. Never change dependencies.

Out of scope: snapshot reads, the authorization calls, any migration, any gateway file, any write path, any change to packages/contracts or packages/safe-write-contract, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox, say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-309 settles the non-blocking notes left on SHU-295's run (#228): the
// same six deploy-validator paths, validators and tests only. The second card
// a card run lands by itself (SHU-306).
export const SHU309_PATHS = SHU197_PATHS;

const SHU309_ACCEPTANCE = [
  "(1) LOGIN_ALLOWED_RETURN_URLS is split by listParts only, an empty part still fails with \"LOGIN_ALLOWED_RETURN_URLS must be a valid url-list\", and the \"must include\" check is unchanged;",
  "(2) a blank string item in owner_cards or credential_names reports \"<id> <field> has a blank item\", an empty credential_names array is still accepted, and removing the check makes a test in deploy/coolify/test/integration-register.test.mjs fail;",
  "(3) only a non-empty string id is checked for duplicates: two entries without an id report each one missing and no \"id is duplicated\" error, while a repeated real id still reports \"<id> id is duplicated\", each pinned by a test;",
  "(4) a test reads the id column of docs/integrations.md's table and asserts it equals the register's ids in order, so an extra, missing or reordered row fails it;",
  "(5) every other export, error message and test still holds, integration-register.json and docs/integrations.md are byte-identical, preflight.mjs imports only node: builtins, and no error message contains a configured value.",
].join(" ");

const SHU309_BRIEF = `Card SHU-309: tidy the deploy preflight and integration register leftovers.

Goal. Cards SHU-197, SHU-294 and SHU-295 built and hardened validateDeploymentEnv in deploy/coolify/preflight.mjs and validateRegister in deploy/coolify/integration-register.mjs. The last review left four small notes. This card settles them. It changes no deployment value, no register entry and no documentation, and connects to nothing.

1. One split. validateDeploymentEnv splits LOGIN_ALLOWED_RETURN_URLS a second time with .split(",").map(trim) for the "must include" check. Reuse listParts (or the parts the url loop already produced). The empty-part rule and every message stay as they are.

2. Blank array items. validateRegister accepts owner_cards: [" "] or credential_names: [""], because isEmpty only looks at the array's length. Report a blank string item (empty or only whitespace) in either array field as "<id> <field> has a blank item", where <id> is the label the function already uses. An empty credential_names array stays allowed, and an empty owner_cards array keeps its current "missing or empty" error. Pin both arrays with tests.

3. Missing ids. When two entries both lack an id, the second also gets "entry-2 id is duplicated", because the missing id is added to the seen set. Check and record only ids that are non-empty strings. Each missing id keeps its "id is missing or empty" error, and a repeated real id keeps "<id> id is duplicated". Pin both.

4. Docs drift. The test "integration documentation lists every id" only proves each register id appears somewhere in docs/integrations.md, so a stale extra row is never caught. Replace it with a test that reads the ID column of the table (the rows that start with "| INT-") and asserts it equals the register's ids in order.

Constraints.
- Every other export, error message and test must keep passing. deploy/coolify/deployment-env-manifest.mjs and deploy/coolify/test/deployment.test.mjs (both outside your scope) depend on them.
- preflight.mjs imports nothing but node: builtins (the production image copies it alone).
- No error message may contain a configured value.
- deploy/coolify/integration-register.json and docs/integrations.md must stay byte-identical. They are in your workspace so the register tests can run.
- Tests use node:test and node:assert only and import only files in your scope and node: builtins. Write expected messages out literally.

Out of scope: the try/catch around new URL("/profile", env.OIDC_CALLBACK_URL) (it is reachable through a caller-supplied schema and keeps its message), CONFIG_SCHEMA's entries, the Dockerfile, the env manifest, deployment.test.mjs, compose files, any network call or credential, any change outside the paths you are given.

In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-311 settles the two notes left on SHU-309's run (#255) and its review:
// the same six deploy-validator paths, one validator and its tests. The third
// card a card run lands by itself, and the first with SHU-310's thread
// settling on.
export const SHU311_PATHS = SHU197_PATHS;

const SHU311_ACCEPTANCE = [
  "(1) with a caller-supplied schema that leaves out LOGIN_ALLOWED_RETURN_URLS (and an env without it), or marks it optional while it is unset or blank, validateDeploymentEnv throws exactly \"LOGIN_ALLOWED_RETURN_URLS must include https://studenthub.example.test/profile\" for the test env's callback, never a TypeError, pinned by a test in deploy/coolify/test/config-schema.test.mjs for both shapes;",
  "(2) with a caller-supplied schema that declares OIDC_CALLBACK_URL with a kind other than url (for example string; leaving it out is refused earlier as an unknown OIDC_ variable), a callback whose protocol is not http: or https: (for example ftp://studenthub.example.test/login/callback) throws exactly \"OIDC_CALLBACK_URL must be a valid URL\", pinned by a test, and that message never contains the callback;",
  "(3) for the default CONFIG_SCHEMA every result and message is unchanged, and every existing test in config-schema.test.mjs, integration-register.test.mjs and deploy/coolify/test/deployment.test.mjs still passes unchanged;",
  "(4) integration-register.json, integration-register.mjs, integration-register.test.mjs and docs/integrations.md are byte-identical, preflight.mjs imports only node: builtins, and no error message contains a secret (DATABASE_URL, OIDC_CLIENT_SECRET) or URL credentials: the must-include message names the derived /profile URL with its username and password stripped, as it does today.",
].join(" ");

const SHU311_BRIEF = `Card SHU-311: keep the deploy preflight's return-URL check safe with a caller-supplied schema.

Goal. validateDeploymentEnv(env, schema = CONFIG_SCHEMA) in deploy/coolify/preflight.mjs checks that LOGIN_ALLOWED_RETURN_URLS includes the /profile URL derived from OIDC_CALLBACK_URL. Two gaps show only with a caller-supplied schema (the second argument tests pass). This card closes both. It changes no deployment value, no schema entry and no message text for the default schema, and connects to nothing.

1. Missing return URLs. allowedReturnUrls is set only inside the url loop. When the schema leaves LOGIN_ALLOWED_RETURN_URLS out (and the env has no such variable, since an undeclared LOGIN_ variable is already refused), or marks it optional and it is unset or blank, allowedReturnUrls stays undefined and allowedReturnUrls.includes throws a TypeError. Treat it as an empty list, so the existing check reports "LOGIN_ALLOWED_RETURN_URLS must include <profile url>" with the same credential stripping it does today.

2. Non-http callbacks. new URL("/profile", env.OIDC_CALLBACK_URL) accepts any absolute URL. The default schema already refuses a callback that is not http(s), but a caller-supplied schema that declares OIDC_CALLBACK_URL with another kind (for example string) lets ftp:// and similar through (leaving it out of the schema is not a path: an undeclared OIDC_ variable is refused first), and its origin then reaches the "must include" message. Before deriving /profile, refuse a callback whose protocol is not http: or https: with the existing message "OIDC_CALLBACK_URL must be a valid URL".

Tests (deploy/coolify/test/config-schema.test.mjs, node:test and node:assert only): build each caller-supplied schema from CONFIG_SCHEMA (filter out or replace one entry; never change CONFIG_SCHEMA itself) and the file's validEnv(), and assert the exact messages for: the schema without LOGIN_ALLOWED_RETURN_URLS, LOGIN_ALLOWED_RETURN_URLS optional and blank, and OIDC_CALLBACK_URL declared as kind string with an ftp callback. Write expected messages out literally.

Constraints.
- Every other export, error message and test must keep passing. deploy/coolify/deployment-env-manifest.mjs and deploy/coolify/test/deployment.test.mjs (both outside your scope) depend on them.
- preflight.mjs imports nothing but node: builtins (the production image copies it alone).
- No error message may contain a secret (DATABASE_URL, OIDC_CLIENT_SECRET) or URL credentials. The "must include" message names the derived /profile URL, with username and password stripped as today.
- Only deploy/coolify/preflight.mjs and deploy/coolify/test/config-schema.test.mjs change. The other four paths are in your workspace so their tests can run, and must stay byte-identical.

Out of scope: CONFIG_SCHEMA's entries, the integration register and its docs, the Dockerfile, the env manifest, deployment.test.mjs, compose files, any network call or credential, any change outside the paths you are given.

In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-313 and SHU-314 are the first committed card queue (SHU-312): one
// install runs them in this order, each from main after the one before it
// merged. SHU-313 records the status event SHU-163 asks for (a follow-up to
// SHU-305); SHU-314 is slice O5b, the admin-only commercial-terms write.
export const SHU313_PATHS = Object.freeze([
  "packages/organizations/src/status-writes.ts",
  "packages/organizations/test/status-events.test.ts",
  "packages/organizations/test/status-events-mutations.mjs",
  "packages/db/migrations/0191_organization_status_events.sql",
  "packages/db/src/postgres-organization-status-store.ts",
  "packages/db/test/postgres-organization-status.test.ts",
  "packages/db/test/postgres-authz-store.test.ts",
  "apps/gateway/src/login-runtime.ts",
  "package.json",
]);

const SHU313_ACCEPTANCE = [
  "(1) a committed status write whose new stored value differs from the previous one records exactly one organization status event in the same transaction as the change and its audit row, carrying the organization id, the previous and new status (null for cleared) and the write's receipt reference; the decision of whether and what to record is one exported function in status-writes.ts that the Postgres store calls inside the commit; making it record an unchanged value makes the unchanged-no-event test fail;",
  "(2) the event carries the transition, not only the destination; dropping the previous status makes the transition-recorded test fail;",
  "(3) clearing (value none) is recorded as a null new status; recording \"none\" literally makes the clear-is-null test fail;",
  "(4) a refused (not_own_record), stale (state_changed) or duplicate (token_already_used) confirm records no event, and the receipt reference is unique in the event table, pinned by a test:db test;",
  "(5) migration 0191 only creates the event table (no constraint, function or audit change), and every existing status, organizations and directory test passes unchanged;",
  "(6) packages/organizations/test/status-events-mutations.mjs applies mutations (1) to (3), each makes its named test fail, and the script itself passes on the unmutated code;",
  "(7) npm run typecheck and npm test pass, the new test runs from package.json's test command, the mutation script runs as its own npm script chained into test, and nothing outside the card's paths changes.",
].join(" ");

const SHU313_BRIEF = `Card SHU-313: record exactly one organization status event per committed status change (a follow-up to slice O5a, SHU-305).

You are working in the StudentHub platform monorepo at the bound head. Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Read first:
- docs/parity/organizations-stores-and-contacts.md: section 4.2 and the status-change email in section 6 (what a later delivery card will send), row OR-08.
- packages/organizations/src/status-writes.ts: organizationStatusDecision and organizationStatusStateDecision, the pattern for a pure function the store is given.
- packages/db/src/postgres-organization-status-store.ts: #commit, which takes the advisory lock, reads the current value, upserts organization_status_overrides and inserts the audit row in one transaction.
- packages/organizations/test/status-writes.test.ts and status-writes-mutations.mjs: how a test imports a mutated build through an environment variable, and the --test-name-pattern form (a "^" prefix and a trailing space).
- packages/db/test/postgres-organization-status.test.ts: the Postgres test you extend.

Goal. Every committed status change leaves exactly one durable event that a later card can deliver as the account-live notification. The event is written in the same transaction as the change, so a rolled-back write leaves none and a committed write never lacks one. Nothing is sent.

Design:
- Migration 0191 creates organization_status_events (id bigserial primary key, org_id text not null referencing organizations(id) on delete cascade, receipt_ref text not null unique, from_status text null and to_status text null, each checked against active, under_review and inactive, a check that from_status IS DISTINCT FROM to_status, occurred_at timestamptz not null default clock_timestamp(), delivered_at timestamptz null). It changes no existing table, constraint or function.
- In status-writes.ts export organizationStatusEvent(before: string | null, value: string): { from: OrganizationStatus | null; to: OrganizationStatus | null } | null. Here before is the stored value read inside the transaction (null when cleared or absent), and value is the safe-write value ("none" means cleared, so to is null). It returns null when from equals to.
- PostgresOrganizationStatusStore takes it as a new required constructor option, event, next to decision and stateDecision (packages/db must not import packages/organizations). In #commit, after the state compare and the upsert, call it with the value read under the lock, and when it returns an event, insert one row with input.receipt.receiptRef. Keep one insert per commit. Any error, including 23505, rolls the whole transaction back as today, so no event survives a refused or duplicate confirm.
- login-runtime.ts passes organizationStatusEvent to the store; the Postgres test passes it too.
- Do not change the safe-write contract, the audit operation, the route or the read model.

Tests (packages/organizations/test/status-events.test.ts, new; synthetic fixtures only):
- "SHU-313/AC-01 unchanged-no-event": organizationStatusEvent returns null for active then active, for null then "none", and for every same-value pair.
- "SHU-313/AC-02 transition-recorded": under_review then active gives from under_review, to active; null then inactive gives from null, to inactive.
- "SHU-313/AC-03 clear-is-null": active then "none" gives from active, to null.
- One more test drives the real status write builder through an in-memory store (as status-writes.test.ts does) whose commit calls organizationStatusEvent and records events: one changing confirm records one event, a second identical write records none, and a stale confirm records none.
The test imports status-writes through an environment variable (SHU313_TEST_MODULE) when it is set.

Mutations (packages/organizations/test/status-events-mutations.mjs, modelled on status-writes-mutations.mjs, applied to dist/status-writes.js; each anchor must bind exactly once):
(1) the equality check is removed: AC-01 fails.
(2) from is always null: AC-02 fails.
(3) "none" is not mapped to null: AC-03 fails.
The script runs the suite unmutated first and last, and prints "3/3 SHU-313 mutations killed". Keep the anchors of status-writes-mutations.mjs and status-batch-reads-mutations.mjs binding exactly once.

Postgres test (append to packages/db/test/postgres-organization-status.test.ts): a committed change records exactly one event whose receipt_ref equals the audit row's request_ref and whose from and to are right; writing the same value again records none; a stale confirm, a refused org-owner write and a duplicate confirm of one token each leave the event count unchanged; clearing records to_status NULL.

Your paths, and what each may hold:
- packages/organizations/src/status-writes.ts: only organizationStatusEvent
- packages/organizations/test/status-events.test.ts (new)
- packages/organizations/test/status-events-mutations.mjs (new)
- packages/db/migrations/0191_organization_status_events.sql (new; creates one table only)
- packages/db/src/postgres-organization-status-store.ts: only the event constructor option and the one insert in #commit
- packages/db/test/postgres-organization-status.test.ts: only the event option in the store's construction and the appended tests
- packages/db/test/postgres-authz-store.test.ts: only add "0191_organization_status_events" after "0184_organization_status_override" in both schema_migrations lists
- apps/gateway/src/login-runtime.ts: only passing organizationStatusEvent to the status store
- package.json: leave every existing script's text as it is. Append dist/packages/organizations/test/status-events.test.js at the END of the node --test list in test, add a test:organization-status-events:mutations script that runs the mutation script, and add " && npm run test:organization-status-events:mutations" as its own step right after "npm run test:organization-status-batch:mutations" in test. Never change dependencies.

Out of scope: sending any email or message, choosing recipients, a worker or delivery loop, marking events delivered, which transitions a later card notifies on, the Segment event, any change to the audit operations or packages/safe-write-contract, the read model, the route, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox, say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

export const SHU314_PATHS = Object.freeze([
  "packages/organizations/src/commercial-terms-writes.ts",
  "packages/organizations/src/organizations.ts",
  "packages/organizations/src/index.ts",
  "packages/organizations/test/commercial-terms-writes.test.ts",
  "packages/organizations/test/commercial-terms-writes-mutations.mjs",
  "packages/db/migrations/0192_organization_commercial_terms.sql",
  "packages/db/src/postgres-organization-commercial-terms-store.ts",
  "packages/db/src/index.ts",
  "packages/db/test/postgres-organization-commercial-terms.test.ts",
  "packages/db/test/postgres-authz-store.test.ts",
  "apps/gateway/src/organization-commercial-terms.ts",
  "apps/gateway/src/index.ts",
  "apps/gateway/src/login-runtime.ts",
  "apps/gateway/test/organization-commercial-terms-http.test.ts",
  "package.json",
]);

const SHU314_ACCEPTANCE = [
  "(1) an organization's hourly rate and bonus commission (an exact decimal, or none to clear it) are written only through preview, confirm and receipt on the existing safe-write contract, and runSafeWriteConformance runs over the commercial-terms write's own builder, so letting a value bypass preview makes that conformance test fail;",
  "(2) only an admin grant that covers the organization (on the organization itself, or a subtree grant on an ancestor such as the operator organization) may write; a staff, finance, org-owner, recruiter, candidate or any other grant gets not_found, never 403; an operator organization itself is never a target; the decision is one function the Postgres store calls inside its commit transaction, and accepting a staff grant there makes the staff-write-refused test fail;",
  "(3) the store's commit compares the previewed value inside the transaction through a function it calls there and refuses with state_changed when the value moved; making that compare always succeed makes the stale-confirm test fail; grants are read FOR SHARE under the organization lock, and a racing duplicate confirm returns token_already_used;",
  "(4) the audience field lists are unchanged: hourlyRate for employer, staff and admin, bonusCommission for admin only; a staff or employer read of an organization with a stored bonus commission has no bonusCommission field and the stored value appears nowhere in it; giving the staff audience the admin field list makes the staff-projection-whitelist test fail;",
  "(5) once the platform holds a commercial-terms record for an organization, OrganizationRepository uses it for hourlyRate and bonusCommission in place of the snapshot value, a cleared record makes the organization's own value not recorded so a sub-organization falls back to its parent (the parent's stored value first, then its snapshot), an absent record keeps today's behaviour exactly, and a stored value shows even with no approved snapshot; the live gateway passes the store's reader to the repository; ignoring the stored record makes the stored-terms-win test fail;",
  "(6) every write is audited in the same transaction as the change with hashed organization references (organizationAuditRef, never a raw id) under the new operation organization.commercial_terms.safe_write; migration 0192 is additive, and its audit constraints and summary function still accept every existing row and every operation earlier migrations added;",
  "(7) packages/organizations/test/commercial-terms-writes-mutations.mjs applies mutations (1) to (5), each makes its named test fail, and the script itself passes on the unmutated code;",
  "(8) npm run typecheck and npm test pass, the new tests run from package.json's test and test:db commands, the mutation script runs as its own npm script chained into test, and nothing outside the card's paths changes.",
].join(" ");

const SHU314_BRIEF = `Card SHU-314: an admin sets an organization's commercial terms through safe write (slice O5b, the second write slice of O5).

You are working in the StudentHub platform monorepo at the bound head. Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Read first:
- docs/parity/organizations-stores-and-contacts.md: section 2.1 (commercial terms and rate inheritance), section 3 (who sees company_hourly_rate and company_bonus_commission), row OR-07 and slice O5 in section 11.
- SHU-305's status write, which this card copies and which passed review: packages/organizations/src/status-writes.ts, its test and mutation script, packages/db/src/postgres-organization-status-store.ts, packages/db/migrations/0184_organization_status_override.sql, apps/gateway/src/organization-status.ts, apps/gateway/test/organization-status-http.test.ts, and how apps/gateway/src/login-runtime.ts constructs it.
- SHU-300's organization profile store (packages/db/src/postgres-organization-profile-store.ts and 0150) for a write with more than one field.
- packages/pay-contracts/src/bank-write.ts: how a builder checks a value at preview and again at confirm and answers invalid_value.
- packages/organizations/src/organizations.ts: ORGANIZATION_FIELDS_BY_AUDIENCE, projectOrganizationFields, inheritedDecimal, decimal, OrganizationStatusRecords (the port shape to copy) and OrganizationRepository.read.
- packages/db/migrations/0184_organization_status_override.sql (or any later migration on main that redefines them): the latest definitions of the audit constraints and of authorization_audit_summary_valid, which your migration must extend, not replace with an older copy.

Goal. An admin can set or clear an organization's hourly rate and bonus commission through the existing safe-write path: preview, then confirm, then a receipt. The values are stored in the platform database, and the read model then shows them, so the live gateway (whose approved snapshot is unconfigured) can show terms an admin set. Who may see which term does not change.

Design:
- Store each term as its own row in a new table organization_commercial_terms (org_id text referencing organizations(id) on delete cascade, field text with a check constraint allowing only hourly_rate and bonus_commission, value text null with a check constraint matching ^[0-9]{1,10}(\\.[0-9]{1,6})?$, updated_at timestamptz, primary key (org_id, field)). No row means absent and a NULL value means cleared. Keep the value as exact decimal text, never a float. The safe-write fields are "hourly_rate" and "bonus_commission", and clearing is the value "none".
- Values: one exported function in packages/organizations/src/commercial-terms-writes.ts says whether a value is valid for a field (the decimal pattern above, or "none"). The builder checks it at preview and at confirm and answers invalid_value, as bank-write.ts does. The gateway rejects a malformed body with 400 before that. Add no range rule beyond the pattern: the spec decides none.
- Who may write: one exported decision function in commercial-terms-writes.ts takes the caller's grant rows (org_id, role, scope), the target organization id and the target's ancestor ids, and allows the write only when a grant with role admin is on the target itself, or is a subtree grant on one of its ancestors. An operator organization (DEFAULT_OPERATOR_ORG_IDS) is never a target. Everything else, including staff and finance, is refused, and the route answers 404 not_found, never 403. Sub-organizations are valid targets.
- Read model: give OrganizationRepository an optional constructor port, commercialTerms, whose read(orgId) returns, for each of hourlyRate and bonusCommission, absent, cleared, or a value. Keep one inheritance rule: extend inheritedDecimal (or wrap it) so that (a) an own stored value wins; (b) an own cleared record makes the own value not recorded; (c) an own absent record keeps today's snapshot logic; and when the own value is not recorded, a sub-organization falls back to its parent, where a stored parent value wins, a cleared parent record is not recorded, and an absent parent record keeps today's parent-snapshot logic. A top-level organization with no own value is not recorded. A stored value must show even when the approved snapshot is missing (row undefined), as SHU-305 did for status. Every other field and the snapshot provenance stay not_imported. With no port, or every record absent, every existing organizations, directory and status test passes unchanged.
- Visibility: leave ORGANIZATION_FIELDS_BY_AUDIENCE and ORGANIZATION_AUDIENCE_BY_ROLE as they are. Employer and staff never receive bonusCommission, even when it is stored.
- Live wiring: login-runtime.ts constructs the commercial-terms store from DATABASE_URL and passes its reader to OrganizationRepository as commercialTerms whether or not the safe-write key is set. It constructs the write service from the same store only when the key is set, as it does for the status store.

Pitfalls SHU-300's and SHU-305's reviewers blocked. Avoid each one:
- Mutations must hit the code production runs. Keep the writer decision, the value check and the stale-state compare as exported functions in commercial-terms-writes.ts, give the decision and the compare to the Postgres store through its constructor (login-runtime.ts wires them in; packages/db must not import packages/organizations; dependencies stay unchanged), and have the store call them inside the commit transaction on the rows it read there. The grants query selects the caller's grant rows without filtering by role or organization, and the ancestry query reads the organization chain.
- Audit rows: write organizationAuditRef(orgId) in target_org_refs, never the raw id. The receipt and the audit carry the field name, never the value.
- Lost update: take an advisory lock keyed on the organization, read the caller's grants with SELECT ... FOR SHARE under it, and compare expectedBefore for the one field being written inside the transaction; return state_changed when it moved.
- Duplicate confirm: catch 23505 from the unique token index inside the store and return token_already_used.
- Migration 0192: add organization.commercial_terms.safe_write to every constraint and to authorization_audit_summary_valid where organization.status.safe_write appears. Use target_org_refs cardinality > 0, the safe-write halves check, the receipt shape with fields of length 1 and fields->>0 IN ('hourly_rate','bonus_commission'), and unique indexes on its token and its receipt, as 0184 adds for status. Start from the latest definitions on main (0184's today; 0191 changes none), so every operation and every existing row stays valid.
- Conformance: run runSafeWriteConformance over the commercial-terms write's own builder, the function the gateway route calls.
- Mutation script: copy packages/organizations/test/status-writes-mutations.mjs, including its --test-name-pattern form (a "^" prefix and a trailing space, not "$") and the environment-variable import (SHU314_TEST_MODULE, SHU314_ORG_MODULE). Check by hand that each mutant really fails its named test and that the script passes on the unmutated code.
- Other cards' anchors: npm test runs every existing mutation script, and each requires its anchor to bind exactly once in dist/. Keep the anchors of packages/organizations/test/mutations.mjs binding, in particular the parent-rate fallback line \`return parent[sourceField] === null ? unavailable(name, "not_recorded") : available(name, decimal(parent[sourceField]));\` and the \`"org-owner": "employer",\` entry, as well as those of directory-mutations.mjs, status-writes-mutations.mjs and status-batch-reads-mutations.mjs. Change your code's shape, never their scripts.
- HTTP: copy organization-status.ts for the session, Origin and content-type checks, headers, body parsing (exactly orgId, field, value), error mapping and the try/catch, under /organization/commercial-terms/preview, /confirm and the receipt read. Have the HTTP test call the real handler.
- The Postgres test must exercise the store against the database (test:db), including one successful commit whose audit row has the hashed organization reference and the new operation, one refused staff write, and a value read back through the store's reader.

Acceptance. Each item is pinned by a mutation in packages/organizations/test/commercial-terms-writes-mutations.mjs that makes a named test fail.
(1) Let a value bypass preview: "SHU-314/AC-01 conformance" fails.
(2) Accept a staff grant in the decision function the store calls: "SHU-314/AC-02 staff-write-refused" fails.
(3) Make the state compare the store calls always succeed: "SHU-314/AC-03 stale-confirm" fails.
(4) Give the staff audience the admin field list (anchor: \`const names = ORGANIZATION_FIELDS_BY_AUDIENCE[audience];\` in projectOrganizationFields): "SHU-314/AC-04 staff-projection-whitelist" fails. That test asserts the exact field lists of employer and staff, and that a staff and an employer read of an organization with a stored bonus commission have no bonusCommission key and do not contain the stored value anywhere in JSON.stringify of the view.
(5) Ignore the stored record in the read model: "SHU-314/AC-05 stored-terms-win" fails. Also test: a cleared sub-organization rate falls back to a stored parent rate; and a stored value shows with no approved snapshot.
The script prints "5/5 SHU-314 mutations killed". Use synthetic fixtures only.

Your paths, and what each may hold:
- packages/organizations/src/commercial-terms-writes.ts (new)
- packages/organizations/src/organizations.ts: only the optional commercialTerms port on OrganizationRepository, its record types, and applying the records in the hourlyRate and bonusCommission derivation
- packages/organizations/src/index.ts (exports only)
- packages/organizations/test/commercial-terms-writes.test.ts (new)
- packages/organizations/test/commercial-terms-writes-mutations.mjs (new)
- packages/db/migrations/0192_organization_commercial_terms.sql (new; additive)
- packages/db/src/postgres-organization-commercial-terms-store.ts (new)
- packages/db/src/index.ts (exports only)
- packages/db/test/postgres-organization-commercial-terms.test.ts (new)
- packages/db/test/postgres-authz-store.test.ts: only add "0192_organization_commercial_terms" after "0191_organization_status_events" in both schema_migrations lists
- apps/gateway/src/organization-commercial-terms.ts (new; modelled on organization-status.ts)
- apps/gateway/src/index.ts (route wiring only, mounted after handleOrganizationStatus)
- apps/gateway/src/login-runtime.ts (wiring only: construct the store next to the status store, pass its reader to OrganizationRepository, and construct the service from it when the safe-write key is set)
- apps/gateway/test/organization-commercial-terms-http.test.ts (new)
- package.json: leave every existing script's text as it is. Append the new built test files at the END of the existing node --test lists in test and test:db, add a test:organization-commercial-terms:mutations script that runs the mutation script, and add " && npm run test:organization-commercial-terms:mutations" as its own step right after "npm run test:organization-status-events:mutations" in test. Never change dependencies.

Out of scope: currency_code, approved_to_hire, the rule that a company rate is not below its candidates' rates, which audiences see hourly rate, any finance-role write, creating organizations, account managers, status events or notifications (the previous card, SHU-313, added the status events; leave them as they are), any UI beyond what the route needs, any change to packages/safe-write-contract, packages/contracts or the login code, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-315 is slice O5d: the approved-to-hire half of OR-08, the same
// staff-or-admin safe write as SHU-305's status write.
export const SHU315_PATHS = Object.freeze([
  "packages/organizations/src/approved-to-hire-writes.ts",
  "packages/organizations/src/organizations.ts",
  "packages/organizations/src/index.ts",
  "packages/organizations/test/approved-to-hire-writes.test.ts",
  "packages/organizations/test/approved-to-hire-writes-mutations.mjs",
  "packages/db/migrations/0193_organization_approved_to_hire.sql",
  "packages/db/src/postgres-organization-approved-to-hire-store.ts",
  "packages/db/src/index.ts",
  "packages/db/test/postgres-organization-approved-to-hire.test.ts",
  "packages/db/test/postgres-authz-store.test.ts",
  "apps/gateway/src/organization-approved-to-hire.ts",
  "apps/gateway/src/index.ts",
  "apps/gateway/src/login-runtime.ts",
  "apps/gateway/test/organization-approved-to-hire-http.test.ts",
  "package.json",
]);

const SHU315_ACCEPTANCE = [
  "(1) an organization's approved-to-hire flag (the value true or false) is written only through preview, confirm and receipt on the existing safe-write contract, any other value is refused with invalid_value at preview and at confirm, and runSafeWriteConformance runs over the approved-to-hire write's own builder, so letting a value bypass the check makes the \"SHU-315/AC-01 conformance\" test fail;",
  "(2) only a staff or admin grant that covers the organization (on the organization itself, or a subtree grant on an ancestor such as the operator organization) may write; an org-owner, recruiter, finance, candidate or any other grant gets not_found, never 403; an operator organization itself is never a target; the decision is one exported function the Postgres store calls inside its commit transaction, and accepting any role there makes the \"SHU-315/AC-02 employer-write-refused\" test fail;",
  "(3) the store's commit compares the previewed value inside the transaction through an exported function it calls there and refuses with state_changed when the stored value moved; making that compare always succeed makes the \"SHU-315/AC-03 stale-confirm\" test fail; grants are read FOR SHARE under the organization's advisory lock, and a racing or repeated confirm of one token returns token_already_used;",
  "(4) once the platform holds an approved-to-hire record for an organization, OrganizationRepository.read shows it as approvedToHire in the employer, staff and admin views (the audiences that show the field today; ORGANIZATION_FIELDS_BY_AUDIENCE is unchanged), a stored false overrides a snapshot true and the reverse, a stored value shows with no approved snapshot, and an absent record keeps today's behaviour exactly; ignoring the stored record in the projection makes the \"SHU-315/AC-04 stored-flag-wins\" test fail;",
  "(5) the staff and admin directory (listOrganizations) shows the stored value in each entry's approvedToHire and its approvedToHire filter matches on it, the records are read with one readMany call per list, and ignoring the stored record in directoryEntry makes the \"SHU-315/AC-05 directory-filter-uses-stored\" test fail;",
  "(6) every write is audited in the same transaction as the change with organizationAuditRef (never a raw organization id) under the new operation organization.approved_to_hire.safe_write, the receipt and the audit carry the field name only; migration 0193 is additive apart from widening the audit constraints and authorization_audit_summary_valid from 0192's definitions, and still accepts every existing row and every operation earlier migrations added; \"0193_organization_approved_to_hire\" follows \"0192_organization_commercial_terms\" in both schema_migrations lists; no notification or email is sent;",
  "(7) packages/organizations/test/approved-to-hire-writes-mutations.mjs applies mutations (1) to (5), each makes its named test fail, the script passes on the unmutated code, and every existing mutation script's anchors still bind exactly once;",
  "(8) npm run typecheck and npm test pass, the new tests run from package.json's test and test:db commands, the mutation script runs as its own npm script test:organization-approved-to-hire:mutations chained into test right after test:organization-commercial-terms:mutations, and nothing outside the card's paths changes.",
].join(" ");

const SHU315_BRIEF = `Card SHU-315: staff or admin sets an organization's approved-to-hire flag through safe write (slice O5d, the approved-to-hire half of OR-08).

You are working in the StudentHub platform monorepo at the bound head. Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Read first:
- docs/parity/organizations-stores-and-contacts.md: section 3 (company_approved_to_hire is visible to every audience), section 4.2 (approved_to_hire is set by staff and admin Update, gates filterByApprovedToHire, and has no transition route), row OR-08 in section 7 and slice O5 in section 11.
- SHU-305's status write, which is the closest model (staff or admin, one field): packages/organizations/src/status-writes.ts (organizationStatusDecision, organizationStatusStateDecision), packages/db/src/postgres-organization-status-store.ts (read, readMany, forPrincipal, #commit), apps/gateway/src/organization-status.ts and its HTTP test.
- SHU-314's commercial-terms write, the latest copy of the same pattern, which passed review: packages/organizations/src/commercial-terms-writes.ts (a value check run at preview and confirm), its test and commercial-terms-writes-mutations.mjs, packages/db/src/postgres-organization-commercial-terms-store.ts, packages/db/migrations/0192_organization_commercial_terms.sql, packages/db/test/postgres-organization-commercial-terms.test.ts, apps/gateway/src/organization-commercial-terms.ts, apps/gateway/test/organization-commercial-terms-http.test.ts, and its wiring in apps/gateway/src/login-runtime.ts and apps/gateway/src/index.ts.
- packages/organizations/src/organizations.ts: ORGANIZATION_FIELDS_BY_AUDIENCE (approvedToHire is in EMPLOYER_FIELDS, so the employer, staff and admin views all show it), plainField, projectOrganizationFields, directoryEntry, matchesDirectoryFilters, OrganizationStatusRecords (the port shape to copy, including readMany) and how listOrganizations batch-reads status records (SHU-308).

Goal. Staff or an admin can set an organization's approved-to-hire flag through the existing safe-write path: preview, then confirm, then a receipt. The value is stored in the platform database, and the read model and the directory then use it in place of the snapshot value, so the live gateway (whose approved snapshot is unconfigured) can show and filter on a flag staff set. Who sees the field does not change. Nothing is sent: no email, no notification, no event.

Design:
- Migration 0193 creates organization_approved_to_hire (org_id text primary key referencing organizations(id) on delete cascade, approved boolean not null, updated_at timestamptz not null default clock_timestamp()). No row means absent. There is no cleared state: the flag is either set (true) or cleared (false), like the legacy not-null boolean column.
- Values: the safe-write field is "approved_to_hire" and the value is exactly "true" or "false" (policy maxValueLength 5). One exported function in packages/organizations/src/approved-to-hire-writes.ts says whether a value is valid; the builder checks it at preview and at confirm and answers invalid_value, as buildOrganizationCommercialTermsWrite does. The gateway rejects a malformed body with 400 before that.
- Who may write: one exported decision function takes the caller's grant rows (org_id, role, scope), the target organization id and its ancestor ids, and allows the write only when a grant with role staff or admin is on the target itself or is a subtree grant on one of its ancestors. An operator organization (DEFAULT_OPERATOR_ORG_IDS) is never a target. Copy organizationStatusDecision's logic (write it in this file, do not import it, so its mutation hits only this card). Everything else is refused and the route answers 404 not_found, never 403. Sub-organizations are valid targets.
- Stale state: an exported compare function (current, expected) => boolean, called by the store inside the transaction on the value it read there ("true", "false", or null when absent).
- Read model: give OrganizationRepository an optional constructor port, approvedToHire, with read(orgId) and readMany(orgIds) returning { kind: "absent" } or { kind: "value", value: boolean } (export the record and port types from organizations.ts). In read, a stored value replaces the approvedToHire field (available, with the existing sourceField) for every audience whose field list contains it, including when the snapshot row is undefined; an absent record leaves plainField's result untouched. In listOrganizations, read the shown organizations' records with one readMany call (as SHU-308 does for status), pass each record to directoryEntry, and let a stored value replace the entry's approvedToHire, so matchesDirectoryFilters filters on it unchanged. listSubOrganizations and SubOrganizationSummary do not change (they carry no approvedToHire). With no port, or every record absent, every existing organizations, directory, status and commercial-terms test passes unchanged.
- Live wiring: login-runtime.ts constructs the store from DATABASE_URL next to the commercial-terms store, passes it to OrganizationRepository as approvedToHire whether or not the safe-write key is set, closes it with the others, and constructs the write service from it only when the key is set.

Pitfalls earlier reviewers blocked. Avoid each one:
- Mutations must hit the code production runs. Keep the value check, the decision and the stale compare as exported functions in approved-to-hire-writes.ts, give the decision and the compare to the Postgres store through its constructor (login-runtime.ts wires them in; packages/db must not import packages/organizations; dependencies stay unchanged), and have the store call them inside the commit transaction on the rows it read there. The grants query selects the caller's grant rows without filtering by role or organization, and the ancestry query reads the organization chain.
- Audit rows: organizationAuditRef(orgId) in target_org_refs, never the raw id; the receipt and the audit carry the field name, never the value (before_summary is { valuePresent }).
- Lost update: take an advisory lock keyed on the organization (pg_advisory_xact_lock(hashtextextended($1,315))), read the caller's grants FOR SHARE under it, and compare expectedBefore inside the transaction; return state_changed when it moved.
- Duplicate confirm: check the token reference in the audit table inside the transaction and also catch 23505 from the unique token index; both return token_already_used.
- Migration 0193: start from 0192's text (the latest definitions on main; 0191 changes none) and add organization.approved_to_hire.safe_write wherever organization.commercial_terms.safe_write appears: the operation check, the target_org_refs cardinality > 0 branch, the safe-write halves check, and the safe-write branch of authorization_audit_summary_valid with fields equal to ["approved_to_hire"]. Add unique indexes on its token and its receipt, as 0192 does. Drop nothing else, so every operation and every existing row stays valid.
- Conformance: run runSafeWriteConformance over the approved-to-hire write's own builder, the function the gateway route calls (pass a check that accepts the suite's values, as SHU-314's test does).
- Mutation script: copy packages/organizations/test/commercial-terms-writes-mutations.mjs, including its --test-name-pattern form (a "^" prefix and a trailing space, not "$") and the environment-variable imports (SHU315_TEST_MODULE for approved-to-hire-writes.js, SHU315_ORG_MODULE for organizations.js). Check by hand that each mutant really fails its named test and that the script passes on the unmutated code.
- Other cards' anchors in dist/organizations.js. npm test runs every existing mutation script and each requires its anchor to bind exactly once; your change to organizations.ts is where they are at risk. Keep each of these exactly once, and change your code's shape, never their scripts:
  - status-writes-mutations.mjs: \`if (record?.kind === "status")\`. Do not name your record \`record\`.
  - commercial-terms-writes-mutations.mjs: \`const names = ORGANIZATION_FIELDS_BY_AUDIENCE[audience];\` and \`if (own.kind === "value")\`. Do not write \`own.kind === "value"\` anywhere; name your record something like approvedRecord.
  - status-batch-reads-mutations.mjs: \`const batchRecords = shown.length > 0 && this.#statusRecords?.readMany\` and \`batchRecords.get(org.id) ?? { kind: "absent" }\`. Use a different variable name for your batch (no identifier ending in batchRecords) so neither line is repeated.
  - directory-mutations.mjs: the directoryEntry literal must keep \`subOrganizationCount,\` immediately followed by \`legalName:\` (add nothing between them); keep \`const row = snapshotRow(await this.#source.readSnapshot(org.id), org.id, null);\`, \`availableValue(entry.status) !== filters.status\`, the \`.filter((context) => context.role === request.role && within.has(context.orgId)\` line, the companyParentOf continue and the entries.slice line as they are.
  - mutations.mjs (SHU-159): \`"org-owner": "employer",\`, the parent-rate fallback line, \`const override = statusOverride(row);\` and the status and hierarchy guards.
  - apps/gateway/test/company-directory-mutations.mjs anchors company-directory.js and web-ui.js, and packages/observability/test/mutations.mjs anchors lines of apps/gateway/src/index.js (the response close, telemetry.record and inSpan lines): add one route line in index.ts and touch none of those.
- HTTP: copy organization-commercial-terms.ts for the session, Origin and content-type checks, headers, body parsing (exactly orgId, field and value, field "approved_to_hire", value "true" or "false"), error mapping and the try/catch, under /organization/approved-to-hire/preview, /confirm and the receipt read /organization/approved-to-hire/{orgId}/receipts/{receiptRef}. Mount it in index.ts right after handleOrganizationCommercialTerms. Have the HTTP test call the real handler.
- The Postgres test must exercise the store against the database (test:db): one successful staff commit whose audit row has the hashed organization reference and the new operation and whose value reads back through read and readMany; one refused org-owner write; a stale confirm; and a duplicate confirm of one token.

Acceptance. Each item is pinned by a mutation in packages/organizations/test/approved-to-hire-writes-mutations.mjs that makes a named test fail.
(1) Make the value check accept anything: "SHU-315/AC-01 conformance" fails (it asserts a preview of "yes" is invalid_value and runs the conformance suite).
(2) Accept any role in the decision function the store calls (anchor: \`row.role === "staff" || row.role === "admin"\` in approved-to-hire-writes.js): "SHU-315/AC-02 employer-write-refused" fails. That test also checks an org-owner and a recruiter grant on the target, a self (not subtree) staff grant on the parent, and an operator target.
(3) Make the state compare always succeed: "SHU-315/AC-03 stale-confirm" fails.
(4) Ignore the stored record in projectOrganizationFields: "SHU-315/AC-04 stored-flag-wins" fails. It reads as employer (org-owner), staff and admin, with a snapshot of true and a stored false, and with no snapshot and a stored true.
(5) Ignore the stored record in directoryEntry: "SHU-315/AC-05 directory-filter-uses-stored" fails. It lists with approvedToHire true and false filters over organizations whose stored value disagrees with their snapshot, and counts one readMany call per list.
The script prints "5/5 SHU-315 mutations killed". Use synthetic fixtures only.

Your paths, and what each may hold:
- packages/organizations/src/approved-to-hire-writes.ts (new)
- packages/organizations/src/organizations.ts: only the optional approvedToHire port on OrganizationRepository, its record types, and applying the record to the approvedToHire field in read and in the directory
- packages/organizations/src/index.ts (exports only)
- packages/organizations/test/approved-to-hire-writes.test.ts (new)
- packages/organizations/test/approved-to-hire-writes-mutations.mjs (new)
- packages/db/migrations/0193_organization_approved_to_hire.sql (new)
- packages/db/src/postgres-organization-approved-to-hire-store.ts (new; modelled on the commercial-terms store, with read and readMany)
- packages/db/src/index.ts (exports only)
- packages/db/test/postgres-organization-approved-to-hire.test.ts (new)
- packages/db/test/postgres-authz-store.test.ts: only add "0193_organization_approved_to_hire" after "0192_organization_commercial_terms" in both schema_migrations lists
- apps/gateway/src/organization-approved-to-hire.ts (new)
- apps/gateway/src/index.ts (one route line after handleOrganizationCommercialTerms, and its import)
- apps/gateway/src/login-runtime.ts (wiring only)
- apps/gateway/test/organization-approved-to-hire-http.test.ts (new)
- package.json: leave every existing script's text as it is. Append dist/packages/organizations/test/approved-to-hire-writes.test.js and dist/apps/gateway/test/organization-approved-to-hire-http.test.js at the END of the node --test list in test, and dist/packages/db/test/postgres-organization-approved-to-hire.test.js at the END of the node --test --test-concurrency=1 list in test:db; add a test:organization-approved-to-hire:mutations script that runs the mutation script, and add " && npm run test:organization-approved-to-hire:mutations" as its own step right after "npm run test:organization-commercial-terms:mutations" in test. Never change dependencies.

Out of scope: the status write, status events and any notification or email, the account-live email, the Segment event, commercial terms, which audiences see approvedToHire, the onboarding approval that sets the flag at creation (O3), creating organizations, sub-organization summaries, any UI beyond what the route needs, any change to packages/safe-write-contract, packages/contracts or the login code, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-316 is slice O9a: the notes half of O9 (OR-27), companies only. It
// appends through the safe-write contract, which fits an append: a note has
// no prior value, so the preview shows before = null and the single-use token
// makes a repeated confirm add nothing.
export const SHU316_PATHS = Object.freeze([
  "packages/organizations/src/organization-notes.ts",
  "packages/organizations/src/index.ts",
  "packages/organizations/test/organization-notes.test.ts",
  "packages/organizations/test/organization-notes-mutations.mjs",
  "packages/db/migrations/0194_organization_notes.sql",
  "packages/db/src/postgres-organization-notes-store.ts",
  "packages/db/src/index.ts",
  "packages/db/test/postgres-organization-notes.test.ts",
  "packages/db/test/postgres-authz-store.test.ts",
  "apps/gateway/src/organization-notes.ts",
  "apps/gateway/src/index.ts",
  "apps/gateway/src/login-runtime.ts",
  "apps/gateway/test/organization-notes-http.test.ts",
  "package.json",
]);

const SHU316_ACCEPTANCE = [
  "(1) a note is added to an organization only through preview, confirm and receipt on the existing safe-write contract (field \"note\", preview before null), and runSafeWriteConformance runs over the note write's own builder, so letting the preview report no changes makes the \"SHU-316/AC-01 conformance\" test fail;",
  "(2) only a staff or admin grant that covers the organization (on the organization itself, or a subtree grant on an ancestor such as the operator organization) may add or list notes; an org-owner, recruiter, finance, candidate or any other grant gets not_found, never 403, for both; an operator organization itself is never a target; the decision is one exported function the Postgres store calls inside its commit transaction and before it reads any note for a list, and accepting an org-owner grant there makes the \"SHU-316/AC-02 employer-refused\" test fail;",
  "(3) a note's text is non-empty, has no leading or trailing whitespace, is at most 2000 characters and contains no control character other than tab, line feed and carriage return; anything else is refused with invalid_value at preview and at confirm by an exported value check the builder runs; dropping the control-character rule makes the \"SHU-316/AC-03 note-text-rejected\" test fail;",
  "(4) staff and admin list an organization's notes newest first (created time descending, then note id descending), each with its note id, text, author principal id and created time, through one exported view function the gateway applies to the store's rows; reversing its order makes the \"SHU-316/AC-04 newest-first\" test fail;",
  "(5) that view carries exactly noteId, text, authorPrincipalId and createdAt for each note and never the organization id or the receipt reference; copying the stored row into the view makes the \"SHU-316/AC-05 list-view-whitelist\" test fail;",
  "(6) notes are append-only: no route, store method or SQL edits or deletes one, a database trigger refuses UPDATE, a repeated confirm of one token adds no second note (token_already_used); each add inserts the note and its audit row in one transaction with organizationAuditRef (never a raw organization id) under the new operation organization.note.safe_write, and neither the audit row nor the receipt contains the note text; migration 0194 creates the notes table and its trigger and otherwise only widens the audit constraints and authorization_audit_summary_valid from 0193's definitions, still accepting every existing row and every operation earlier migrations added; \"0194_organization_notes\" follows \"0193_organization_approved_to_hire\" in both schema_migrations lists;",
  "(7) packages/organizations/test/organization-notes-mutations.mjs applies mutations (1) to (5), each makes its named test fail, the script passes on the unmutated code, and every existing mutation script's anchors still bind exactly once;",
  "(8) npm run typecheck and npm test pass, the new tests run from package.json's test and test:db commands, the mutation script runs as its own npm script test:organization-notes:mutations chained into test right after test:organization-approved-to-hire:mutations, and nothing outside the card's paths changes.",
].join(" ");

const SHU316_BRIEF = `Card SHU-316: staff and admin add notes to an organization, append-only and audited (slice O9a, the organization-notes half of OR-27).

You are working in the StudentHub platform monorepo at the bound head, which includes SHU-315 (migration 0193, the approved-to-hire write). Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Read first:
- docs/parity/organizations-stores-and-contacts.md: the note table and "Note shape" in section 2.2, row OR-27 in section 7, slice O9 in section 11, and decision D-OR3 in section 12 (StudentHub keeps notes attached to records; the follow-up CRM, OR-10, is not this card).
- packages/safe-write-contract/src/types.ts and safe-write.ts: the contract this card uses for the append. It already rejects an empty value, edge whitespace and a value longer than the policy's maxValueLength, and its single-use token is what makes a repeated confirm add nothing.
- SHU-315's approved-to-hire write and SHU-314's commercial-terms write, which this card copies: packages/organizations/src/approved-to-hire-writes.ts and commercial-terms-writes.ts, their tests and mutation scripts, packages/db/src/postgres-organization-commercial-terms-store.ts (forPrincipal, readReceipt, #commit), packages/db/migrations/0193_organization_approved_to_hire.sql, packages/db/test/postgres-organization-commercial-terms.test.ts, apps/gateway/src/organization-commercial-terms.ts and its HTTP test, and the wiring in apps/gateway/src/login-runtime.ts and apps/gateway/src/index.ts.
- packages/db/migrations/0004_create_authorization_mutation_audit.sql: the append-only trigger pattern.

Goal. Staff and admins covering an organization can add a note to it and read its notes, newest first. A note is a record of who wrote what and when: it is never edited or deleted, and every add leaves an audit row that says a note was added without repeating it.

Contract choice (decided; do not reopen). The note is added through the existing safe-write contract, not the idempotency contract. The safe-write contract fits an append: the field is "note", readField returns null (an append has no prior value), so the preview shows before null and after the text, and the store's commit refuses with state_changed if expectedBefore is not null. The single-use token, checked inside the transaction and backed by a unique index, makes a repeated or racing confirm return token_already_used, so a double submit adds one note. The idempotency contract (packages/idempotency-contract) has no Postgres store and no organization use yet, and the safe-write path gives preview, receipt and the audit shape every organization write already uses. Concurrent adds by two people both land; there is no stale-state compare beyond expectedBefore being null.

Design:
- Migration 0194 creates organization_notes (id bigserial primary key, org_id text not null references organizations(id) on delete cascade, author_principal_id text not null, body text not null with a check that it is between 1 and 2000 characters and equals btrim(body), receipt_ref text not null unique, created_at timestamptz not null default clock_timestamp()) and an index on (org_id, created_at desc, id desc). author_principal_id has no foreign key, so a note outlives changes to its author. Add a BEFORE UPDATE row trigger that raises (as 0004 does for the audit table). Add no DELETE or TRUNCATE trigger: packages/db/test/postgres-authz-store.test.ts truncates organizations with CASCADE, and organization deletion is slice O6's.
- Values: in packages/organizations/src/organization-notes.ts, ORGANIZATION_NOTE_FIELDS is ["note"] and the policy's maxValueLength is 2000. One exported value check accepts the field "note" with text that contains no control character other than tab, line feed and carriage return (so no NUL, which Postgres text rejects, and no DEL); the contract itself rejects empty, edge-whitespace and over-length text. The builder runs the check at preview and confirm and answers invalid_value, as buildOrganizationCommercialTermsWrite does.
- Who may add and list: one exported decision function, the same shape as SHU-315's (staff or admin, on the target or a subtree grant on an ancestor, never an operator organization), written in this file. The store calls it inside the commit transaction for an add, and before reading any note for a list; a refused list returns null and the route answers 404 not_found.
- List view: one exported function takes the store's rows (id, author_principal_id, body, created_at, and whatever else the store selects) and returns notes ordered by created time descending, then id descending, each exactly { noteId, text, authorPrincipalId, createdAt } (noteId as a string, createdAt as an ISO string). The store may also ORDER BY in SQL, but the gateway always applies this function. Return every note; there is no paging in this card.
- Store (packages/db/src/postgres-organization-notes-store.ts, modelled on the commercial-terms store): constructor takes the pool or connection string, the decision, recordRef and principalRef. forPrincipal returns a SafeWriteStore whose readField returns null for "note"; #commit takes pg_advisory_xact_lock(hashtextextended($1,316)) on the organization, reads the caller's grants FOR SHARE and the ancestry, calls the decision, checks the token reference in the audit table, requires expectedBefore null, inserts the note with the receipt's receiptRef and the raw principal id as author, and inserts the audit row (organizationAuditRef(orgId) in target_org_refs, before_summary { valuePresent: false }, after_summary the receipt shape with fields ["note"] and the tokenRef) in one transaction; 23505 becomes token_already_used. readReceipt is as the commercial-terms store's. list(principalId, orgId) reads grants and ancestry, calls the decision, and returns null or the rows. There is no update or delete method.
- Live wiring: login-runtime.ts constructs the store from DATABASE_URL next to the approved-to-hire store, closes it with the others, and constructs the notes service (preview, confirm, receipt and list) only when the safe-write key is set, as for the other organization writes.

Pitfalls earlier reviewers blocked. Avoid each one:
- Mutations must hit the code production runs: the value check, the decision and the list view are exported from organization-notes.ts; the decision reaches the store through its constructor (packages/db must not import packages/organizations; dependencies stay unchanged), and the gateway's list calls the view function on the store's rows.
- Audit rows and receipts: organizationAuditRef, never the raw organization id; the field name "note", never the text. The Postgres test asserts JSON.stringify of the audit row contains neither the text nor the raw organization id.
- Migration 0194: start from 0193's text (the latest definitions on main) and add organization.note.safe_write wherever organization.approved_to_hire.safe_write appears: the operation check, the target_org_refs cardinality > 0 branch, the safe-write halves check, and the safe-write branch of authorization_audit_summary_valid with fields equal to ["note"]. Add unique indexes on its token and its receipt, as 0192 and 0193 do. The operation name follows the codebase's convention that every receipt-bearing safe-write operation ends in .safe_write. Drop nothing else.
- Conformance: run runSafeWriteConformance over the note write's own builder (pass a check that accepts the suite's values, as SHU-314's test does).
- Mutation script: copy packages/organizations/test/commercial-terms-writes-mutations.mjs, including its --test-name-pattern form (a "^" prefix and a trailing space, not "$") and the environment-variable import (SHU316_TEST_MODULE for organization-notes.js). All five mutations target dist/organization-notes.js. Check by hand that each mutant really fails its named test and that the script passes on the unmutated code.
- Other cards' anchors: this card does not change organizations.ts, so the anchors of mutations.mjs, directory-mutations.mjs, status-writes-mutations.mjs, status-batch-reads-mutations.mjs, commercial-terms-writes-mutations.mjs and approved-to-hire-writes-mutations.mjs stay as they are. In apps/gateway/src/index.ts, packages/observability/test/mutations.mjs anchors the response close, telemetry.record and inSpan lines: add one route line and its import and touch none of those.
- HTTP (apps/gateway/src/organization-notes.ts): copy organization-commercial-terms.ts for the session, Origin and content-type checks, headers, error mapping and the try/catch. POST /organization/notes/preview and /organization/notes/confirm take exactly orgId, field ("note") and value (the text), plus token on confirm; GET /organization/notes/{orgId}/receipts/{receiptRef} reads a receipt; GET /organization/notes/{orgId} returns { notes } from the view function, or 404 not_found when the store returns null. Raise the body limit to 16384 bytes so a 2000-character note with escapes and a token fits. Mount it in index.ts right after the approved-to-hire route. Have the HTTP test call the real handler, including an employer list that gets 404.
- The Postgres test must exercise the store against the database (test:db): a staff add whose audit row has the hashed organization reference, the new operation and no text; an admin add through a subtree grant on the operator organization; a refused org-owner add and list; a duplicate confirm of one token leaving one note; two notes listed newest first; and an UPDATE of a note refused by the trigger.

Acceptance. Each item is pinned by a mutation in packages/organizations/test/organization-notes-mutations.mjs that makes a named test fail.
(1) Let the builder's preview report no changes (as status-writes-mutations.mjs's first mutation does, anchored on the builder's call to the contract's preview): "SHU-316/AC-01 conformance" fails.
(2) Accept an org-owner grant in the decision function: "SHU-316/AC-02 employer-refused" fails. That test drives the real builder through an in-memory store that calls the decision on commit and on list, and also checks a recruiter grant, a self staff grant on the parent, and an operator target.
(3) Drop the control-character rule from the value check: "SHU-316/AC-03 note-text-rejected" fails. It previews and confirms text with a NUL and with a bell character and gets invalid_value, accepts text with a line feed, and refuses whitespace-only, edge-whitespace and 2001-character text.
(4) Reverse the view's order: "SHU-316/AC-04 newest-first" fails. It gives rows in ascending order, including two with the same created time.
(5) Copy the stored row into the view (for example a spread of the row): "SHU-316/AC-05 list-view-whitelist" fails. It asserts the exact keys of each note and that the organization id and the receipt reference appear nowhere in JSON.stringify of the view.
The script prints "5/5 SHU-316 mutations killed". Use synthetic fixtures only.

Your paths, and what each may hold:
- packages/organizations/src/organization-notes.ts (new)
- packages/organizations/src/index.ts (exports only)
- packages/organizations/test/organization-notes.test.ts (new)
- packages/organizations/test/organization-notes-mutations.mjs (new)
- packages/db/migrations/0194_organization_notes.sql (new)
- packages/db/src/postgres-organization-notes-store.ts (new)
- packages/db/src/index.ts (exports only)
- packages/db/test/postgres-organization-notes.test.ts (new)
- packages/db/test/postgres-authz-store.test.ts: only add "0194_organization_notes" after "0193_organization_approved_to_hire" in both schema_migrations lists
- apps/gateway/src/organization-notes.ts (new)
- apps/gateway/src/index.ts (one route line after the approved-to-hire route, and its import)
- apps/gateway/src/login-runtime.ts (wiring only)
- apps/gateway/test/organization-notes-http.test.ts (new)
- package.json: leave every existing script's text as it is. Append dist/packages/organizations/test/organization-notes.test.js and dist/apps/gateway/test/organization-notes-http.test.js at the END of the node --test list in test, and dist/packages/db/test/postgres-organization-notes.test.js at the END of the node --test --test-concurrency=1 list in test:db; add a test:organization-notes:mutations script that runs the mutation script, and add " && npm run test:organization-notes:mutations" as its own step right after "npm run test:organization-approved-to-hire:mutations" in test. Never change dependencies.

Out of scope: notes on contacts, candidates, requests or any other subject (the typed subject reference is for later cards; this table is organization notes only), note types (Internal Note, Phone Call and so on), editing or deleting a note, the follow-up CRM (OR-10, D-OR3), exports, the read model and directory in organizations.ts, any notification, any UI beyond what the routes need, any change to packages/safe-write-contract, packages/idempotency-contract, packages/contracts or the login code, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-317 is the create half of FI-01 (slice F1): staff or an admin records a
// pay contract through the safe-write contract. A contract is many fields that
// must land together, so it is ONE contract field whose value is the canonical
// JSON of the whole contract, as SHU-182's bank details are one field for
// bank, IBAN and beneficiary name. A create has no prior value, so the preview
// shows before = null, as SHU-316's note append does.
export const SHU317_PATHS = Object.freeze([
  "packages/pay-contracts/src/contract-writes.ts",
  "packages/pay-contracts/src/contracts.ts",
  "packages/pay-contracts/src/index.ts",
  "packages/pay-contracts/test/contract-writes.test.ts",
  "packages/pay-contracts/test/contract-writes-mutations.mjs",
  "packages/db/migrations/0195_pay_contract_create_safe_write.sql",
  "packages/db/src/postgres-pay-contract-store.ts",
  "packages/db/src/postgres-pay-contract-safe-write-store.ts",
  "packages/db/src/index.ts",
  "packages/db/test/postgres-pay-contract-safe-write.test.ts",
  "packages/db/test/postgres-authz-store.test.ts",
  "apps/gateway/src/pay-contracts-http.ts",
  "apps/gateway/src/index.ts",
  "apps/gateway/src/login-runtime.ts",
  "apps/gateway/test/pay-contracts-http.test.ts",
  "package.json",
]);

const SHU317_ACCEPTANCE = [
  "(1) a pay contract is created only through preview, confirm and receipt on the existing safe-write contract, as one field \"pay_contract\" whose value is the canonical JSON of the whole contract (preview before null); a value that is not the canonical encoding of a contract PayContracts accepts, names an inactive or unknown currency, or names a candidate without a candidate grant is refused with invalid_value at preview and at confirm by an exported check the builder runs, and runSafeWriteConformance runs over the create write's own builder, so making that check accept anything makes the \"SHU-317/AC-01 conformance\" test fail;",
  "(2) only a staff or admin grant that covers the contract's company (on the company itself, or a subtree grant on an ancestor such as the operator organization) may create; an org-owner, recruiter, finance, candidate or any other grant gets not_found, never 403; an operator organization itself is never a target; the decision is one exported function the Postgres store calls inside its commit transaction, and accepting any role there makes the \"SHU-317/AC-02 employer-write-refused\" test fail;",
  "(3) the company a contract binds is the organization the request names: a value whose companyId differs from the request's orgId is refused with invalid_value at preview and at confirm, and the store's commit throws on a mismatch; dropping that comparison from the check makes the \"SHU-317/AC-03 company-bound\" test fail;",
  "(4) the check refuses at preview a contract whose period overlaps a non-deleted contract of the same candidate at the same store, reading the candidate's contracts through a port, so a person never approves a contract that cannot be stored; dropping the overlap test from the check makes the \"SHU-317/AC-04 overlap-refused-at-preview\" test fail;",
  "(5) inside the commit the contract is created by PayContracts.create itself, on the commit's own transaction, so its overlap invariant still holds under a race: a clashing contract stored between preview and confirm makes the confirm answer state_changed and leaves no second contract; letting the exported creator rethrow overlapping_contract instead of answering state_changed makes the \"SHU-317/AC-05 racing-overlap-state-changed\" test fail;",
  "(6) each create commits in one transaction the contract, PayContracts' own pay_contract.create audit row (pay model and contract counts) and a receipt row under the new operation pay_contract.create.safe_write with organizationAuditRef(companyId) and fields [\"pay_contract\"]; no audit row and no receipt contains an amount, a rate, the transfer cost, the raw company id or the raw candidate id; a repeated or racing confirm of one token returns token_already_used and creates one contract; migration 0195 only widens the audit constraints and authorization_audit_summary_valid from 0194's definitions (the latest on main), still accepting every existing row and every operation earlier migrations added; \"0195_pay_contract_create_safe_write\" follows \"0194_organization_notes\" in both schema_migrations lists;",
  "(7) packages/pay-contracts/test/contract-writes-mutations.mjs applies mutations (1) to (5), each makes its named test fail, the script passes on the unmutated code, and every existing mutation script's anchors still bind exactly once;",
  "(8) npm run typecheck and npm test pass, the new tests run from package.json's test and test:db commands, the mutation script runs as its own npm script test:pay-contract-writes:mutations chained into test right after test:organization-notes:mutations, and nothing outside the card's paths changes.",
].join(" ");

const SHU317_BRIEF = `Card SHU-317: staff or admin creates a pay contract through safe write (slice F1, the create half of FI-01).

You are working in the StudentHub platform monorepo at the bound head, which includes SHU-315 (migration 0193, the approved-to-hire write) and SHU-316 (migration 0194, organization notes). Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Read first:
- docs/parity/finance-contracts-and-payroll.md: section 2 (the contract and its three pay models), row FI-01 in section 6, slice F1 in section 10, and decision D-FI1 in section 11. D-FI1 (when the platform takes over money movement) is still open; it governs when money moves, not whether a contract can be recorded, and this card moves no money.
- packages/pay-contracts/src/contracts.ts (PayContracts.create, normalizeEditable, overlaps, assertNoOverlap, PayContractError), types.ts (PayContract, ContractTerms, PayContractStore, PayContractTransaction, FinanceReferenceResolver) and memory-store.ts (InMemoryPayContractStore, InMemoryFinanceReferenceResolver). This card does not change the contract rules; it puts the existing service behind a safe write.
- packages/pay-contracts/src/bank-write.ts: SHU-182's multi-field safe write. Bank, IBAN and beneficiary name are ONE field whose value is canonical JSON, checked by an async check (catalogueBankDetailsCheck) at preview and again at confirm, and only the canonical encoding of normalized details is a storable value (parseBankDetailsValue). This card copies that mapping.
- packages/db/src/postgres-pay-contract-store.ts: PostgresPayContractStore, transactionFor (the per-client PayContractTransaction, whose lockPair takes the candidate-and-store advisory lock) and PostgresFinanceReferenceResolver. packages/db/src/postgres-bank-details-store.ts (#isCandidate) and packages/db/migrations/0182_pay_contracts.sql.
- The organization safe writes this card copies for authorization, receipts and HTTP: packages/organizations/src/organization-notes.ts (SHU-316, the append with before null) and commercial-terms-writes.ts (organizationCommercialTermsDecision), packages/db/src/postgres-organization-commercial-terms-store.ts (forPrincipal, readReceipt, #grants, #ancestors, #commit), packages/db/migrations/0194_organization_notes.sql, apps/gateway/src/organization-commercial-terms.ts and its HTTP test, and the wiring in apps/gateway/src/login-runtime.ts and apps/gateway/src/index.ts.

Goal. Staff or an admin covering a company can record a pay contract for it through the safe-write path: preview, then confirm, then a receipt. The contract is stored by the existing PayContracts service, so every rule SHU-182 enforces (the three pay models, exact decimals, the company amount covering the candidate amount, the active-currency rule, the no-overlap invariant per candidate and store, the audit row) holds unchanged. Nothing is paid, generated or sent.

Contract mapping (decided; do not reopen):
- One field, "pay_contract". Its value is the canonical JSON of the normalized create input: the keys autoGenerate, candidateId, companyId, currencyId, endDate (omitted when the contract is open-ended), startDate, status, storeId, terms and transferCost, in that alphabetical order, and terms with its own keys in alphabetical order (for example candidateHourlyRate, companyHourlyRate, payModel). Money values are canonicalDecimal's three-place form, currencyId is lower case, autoGenerate is a boolean, status is "active" or "inactive", and the whole is JSON.stringify output with no whitespace. The policy is { allowed: ["pay_contract"], maxValueLength: 1024 }.
- The record is the company: personRef is payContractCompanyRecordRef(companyId). readField returns null for "pay_contract" (a create has no prior value), so the preview shows before null and after the value, and the commit refuses with state_changed if expectedBefore is not null.
- The single-use token, checked inside the commit and backed by a unique index, makes a repeated or racing confirm return token_already_used and create one contract.
- The confirm's response is the receipt only. The new contract is found by reading (SHU-319); do not widen the receipt.

Design:
- packages/pay-contracts/src/contracts.ts changes only in two ways: add \`export\` to the existing overlaps function, and add one exported function normalizePayContractCreate(input: unknown) (with an exported NormalizedPayContractCreate type) that does exactly what create() does today before its currency check (closedObject over FIELDS, the three party ids, normalizeEditable) and returns the normalized fields; create() calls it in place of those lines. Behaviour, error codes and every existing test stay the same.
- packages/pay-contracts/src/contract-writes.ts (new) exports:
  - PAY_CONTRACT_CREATE_FIELD ("pay_contract") and PAY_CONTRACT_CREATE_POLICY;
  - payContractCreateValue(normalized): the canonical string above;
  - payContractCompanyRecordRef(companyId) and payContractPrincipalRef(principalId), sha256 refs in the "studenthub:<domain>:v1\\0" form bank-write.ts uses, with the domains "pay-contract-company-record" and "pay-contract-principal";
  - PayContractGrantRow ({ org_id, role, scope }) and payContractWriteDecision(rows, companyId, ancestors, operators): true only when operators does not include companyId and a grant with role staff or admin is on companyId itself or is a subtree grant on one of its ancestors. operators is a required parameter: this package cannot import packages/organizations (it builds first and does not depend on it), so login-runtime.ts passes DEFAULT_OPERATOR_ORG_IDS from @studenthub/organizations;
  - payContractCreateCheck({ references, contracts, candidates }) returning (companyId, value) => Promise<boolean>. It parses the value, runs normalizePayContractCreate, and accepts only when payContractCreateValue of the result equals the value exactly, the result's companyId equals companyId, references.resolve("currency", currencyId) is active (a resolver that throws makes the request fail, not answer invalid_value, as catalogueBankDetailsCheck does), candidates.isCandidate(candidateId) is true, and no contract from contracts.listForCandidate(candidateId) with the same storeId and a status other than "deleted" overlaps the new period (use the exported overlaps). Any PayContractError with status 400 from normalization is a false, never a throw;
  - acceptAnyPayContractCreateValue, for the conformance run;
  - buildPayContractCreateWrite({ store, secret, check, companyId, policy?, clock?, tokenLifetimeMs? }): wraps createSafeWrite as buildBankDetailsWrite does; at preview and at confirm it first asks store.ownedRecord(principalRef) and answers not_own_record when it is not the request's personRef (so a caller without a covering staff or admin grant learns nothing about candidates or existing contracts from the check), and only then calls check(companyId, value), answering invalid_value when it is false;
  - payContractCreator(references) returning (store: PayContractStore, actorId, companyId, value) => Promise<{ ok: true } | { ok: false; reason: "state_changed" }>: it parses the value, throws a TypeError when its companyId differs from companyId, calls new PayContracts(store, references).create(actorId, parsed), and answers state_changed when that throws a PayContractError whose code is "overlapping_contract" or whose status is 400 (the currency was retired between confirm's check and the commit); anything else propagates.
- packages/db/src/postgres-pay-contract-store.ts: only add \`export\` to transactionFor. Do not export it from packages/db/src/index.ts.
- packages/db/src/postgres-pay-contract-safe-write-store.ts (new), PostgresPayContractSafeWriteStore, modelled on the commercial-terms store. Its constructor takes the pool or connection string, decision ((rows, companyId, ancestors) => boolean), creator (the shape payContractCreator returns), recordRef and principalRef. Methods:
  - forCompany(principalId, companyId): a SafeWriteStore whose ownedRecord checks the caller's grants and the company's ancestry against the decision, whose readField returns null for "pay_contract", and whose commit runs #commit when the principal and record match (otherwise not_own_record);
  - readReceipt(principalId, companyId, receiptRef), as the commercial-terms store's, for the new operation and fields ["pay_contract"];
  - isCandidate(principalId): true when the principal holds a grant with role candidate (the query #isCandidate in the bank-details store runs);
  - #commit: BEGIN; pg_advisory_xact_lock(hashtextextended($1,317)) on the company id; the caller's grants FOR SHARE and the company's ancestry; the decision (refused: not_own_record); the token reference in the audit table for pay_contract.create.safe_write (found: token_already_used); expectedBefore must be null (else state_changed); then call the creator with a PayContractStore bound to this client (get and listForCandidate query on the client, and transaction(work) runs work(transactionFor(client)) with no BEGIN or COMMIT of its own, because #commit owns them); a refusal from the creator rolls back and returns it; then insert the receipt row (request_ref the receiptRef, actor_principal_ref and target_principal_ref the input's principalRef, target_org_refs [organizationAuditRef(companyId)], before_summary { valuePresent: false }, after_summary the receipt shape with fields ["pay_contract"] and the tokenRef); COMMIT. 23505 becomes token_already_used.
- Migration 0195_pay_contract_create_safe_write.sql adds no table.
- HTTP (apps/gateway/src/pay-contracts-http.ts, new): POST /pay-contracts/create/preview and /pay-contracts/create/confirm take exactly orgId, field ("pay_contract") and value (a string of at most 1024 characters), plus token on confirm; GET /pay-contracts/create/{orgId}/receipts/{receiptRef} reads a receipt. The gateway does not parse the value; the builder's check judges it. Body limit 8192 bytes. Export createPayContracts(ports) and handlePayContracts(req, res, service, origin); later cards add routes to this module.
- Live wiring (login-runtime.ts): construct PostgresPayContractStore, a PostgresFinanceReferenceResolver for pay contracts and PostgresPayContractSafeWriteStore from DATABASE_URL whether or not the safe-write key is set (as the commercial-terms store is), with decision (rows, org, ancestors) => payContractWriteDecision(rows, org, ancestors, DEFAULT_OPERATOR_ORG_IDS) and creator payContractCreator(that resolver); close all three with the others; construct the write service, with check payContractCreateCheck({ references: that resolver, contracts: the PostgresPayContractStore, candidates: the safe-write store }), only when the key is set. Mount handlePayContracts in apps/gateway/src/index.ts right after SHU-316's organization-notes route.

Pitfalls earlier reviewers blocked. Avoid each one:
- Mutations must hit the code production runs. Keep the check, the decision and the creator as exported functions in contract-writes.ts; the decision and the creator reach the Postgres store through its constructor (login-runtime.ts wires them in), and the gateway builds the check from payContractCreateCheck. packages/db must not import packages/organizations and must not import contract-writes' functions directly; dependencies stay unchanged. The grants query selects the caller's grant rows without filtering by role or organization, and the ancestry query reads the organization chain.
- One transaction: the contract, PayContracts' pay_contract.create row and the receipt row commit or roll back together. Do not call PayContracts on the pool or through PostgresPayContractStore.transaction inside #commit; that opens a second transaction.
- Audit and receipts carry no money. The pay_contract.create row keeps its existing closed shape ({ payModel, contractCount }); the receipt row carries the field name only. The Postgres test asserts JSON.stringify of both rows contains none of the test's rates, totals or transfer cost and neither the raw company id nor the raw candidate id.
- Migration 0195: start from 0194's text (SHU-316's migration, the latest definitions on main; read the file on your branch, never an older copy) and add pay_contract.create.safe_write wherever organization.note.safe_write appears: the operation check, the target_org_refs cardinality > 0 branch, the safe-write halves check, and the safe-write branch of authorization_audit_summary_valid with fields equal to ["pay_contract"]. Keep every operation 0194 admits, including organization.approved_to_hire.safe_write and organization.note.safe_write, and the pay_contract.create/update/remove branch unchanged. Add unique indexes on its token and its receipt, as 0192 to 0194 do. Drop nothing else.
- Conformance: run runSafeWriteConformance over buildPayContractCreateWrite with acceptAnyPayContractCreateValue (the suite uses its own field and values).
- Mutation script: copy packages/pay-contracts/test/mutations.mjs's form: mutate the root build dist/packages/pay-contracts/src/contract-writes.js, run the suite dist/packages/pay-contracts/test/contract-writes.test.js with --test-reporter=tap and --test-name-pattern=^<name> (a "^" prefix and a trailing space, not "$"), and require "not ok", the named test and an AssertionError. The test file imports from "../src/index.js". Name each test "SHU-317/AC-0N <name> " followed by a description. Check by hand that each mutant really fails its named test and that the script passes on the unmutated code.
- Other cards' anchors. npm test runs every existing mutation script and each requires its anchor to bind exactly once. Keep each of these exactly once, and change your code's shape, never their scripts:
  - packages/pay-contracts/test/mutations.mjs anchors dist/packages/pay-contracts/src/contracts.js on \`c.status !== "deleted" && c.id !== candidate.id && overlaps(c, candidate)\` (assertNoOverlap: leave it as it is; your normalizePayContractCreate must not repeat it), memory-store.js on \`if (rows.has(contract.id))\`, bank-write.js on \`await checked(request) ? implementation.preview(request)\`, \`await checked(request) ? implementation.confirm(request)\`, \`return bankDetailsValue(details) === value ? Object.freeze(details) : undefined;\` and \`rows.some((row) => row.role === "candidate")\`, resolution.js and bank.js lines, and apps/gateway/src/bank-details.js. Do not change memory-store.ts, bank-write.ts, bank.ts, resolution.ts or bank-details.ts.
  - packages/db/test/bank-details-mutations.mjs and safe-write-mutations.mjs anchor postgres-bank-details-store.js and safe-write-store.js: do not change either.
  - packages/observability/test/mutations.mjs anchors lines of apps/gateway/src/index.js (the response close, telemetry.record and inSpan lines): add one route line in index.ts and its import and touch none of those.
- The Postgres test must exercise the store against the database (test:db): a staff commit that creates one contract readable through PostgresPayContractStore.get, with both audit rows as above; an admin create through a subtree grant on the operator organization; a refused org-owner create that leaves no contract and no audit row; a duplicate confirm of one token leaving one contract; a clashing contract inserted between preview and confirm giving state_changed; and a receipt that reads back through readReceipt.

Acceptance. Each item is pinned by a mutation in packages/pay-contracts/test/contract-writes-mutations.mjs that makes a named test fail.
(1) Make the value check accept every value: "SHU-317/AC-01 conformance" fails. It previews and confirms a value with its keys out of order, one with transferCost "1.5" (not canonical), one naming a retired currency and one naming a principal with no candidate grant, each getting invalid_value, and runs the conformance suite.
(2) Accept any role in payContractWriteDecision (anchor: \`row.role === "staff" || row.role === "admin"\` in contract-writes.js): "SHU-317/AC-02 employer-write-refused" fails. That test drives the real builder through an in-memory SafeWriteStore whose ownedRecord and commit call the decision, and checks an org-owner, a recruiter and a finance grant on the company, a self (not subtree) staff grant on the parent, and the operator organization as a target.
(3) Drop the companyId comparison from the check: "SHU-317/AC-03 company-bound" fails. It previews, for company A, a canonical value whose companyId is company B and expects invalid_value.
(4) Drop the overlap test from the check: "SHU-317/AC-04 overlap-refused-at-preview" fails. It previews a contract overlapping a stored active one for the same candidate and store and expects invalid_value, and accepts one at a different store and one after a deleted contract's period.
(5) Make the creator rethrow overlapping_contract: "SHU-317/AC-05 racing-overlap-state-changed" fails. It previews, stores a clashing contract in the InMemoryPayContractStore, confirms, and expects state_changed with exactly one contract stored.
The script prints "5/5 SHU-317 mutations killed". Use synthetic fixtures only.

Your paths, and what each may hold:
- packages/pay-contracts/src/contract-writes.ts (new)
- packages/pay-contracts/src/contracts.ts: only \`export\` on overlaps, and normalizePayContractCreate with its type, called by create()
- packages/pay-contracts/src/index.ts (exports only)
- packages/pay-contracts/test/contract-writes.test.ts (new)
- packages/pay-contracts/test/contract-writes-mutations.mjs (new)
- packages/db/migrations/0195_pay_contract_create_safe_write.sql (new)
- packages/db/src/postgres-pay-contract-store.ts: only \`export\` on transactionFor
- packages/db/src/postgres-pay-contract-safe-write-store.ts (new)
- packages/db/src/index.ts (exports only)
- packages/db/test/postgres-pay-contract-safe-write.test.ts (new)
- packages/db/test/postgres-authz-store.test.ts: only add "0195_pay_contract_create_safe_write" after "0194_organization_notes" in both schema_migrations lists
- apps/gateway/src/pay-contracts-http.ts (new)
- apps/gateway/src/index.ts (one route line after the organization-notes route, and its import)
- apps/gateway/src/login-runtime.ts (wiring only)
- apps/gateway/test/pay-contracts-http.test.ts (new)
- package.json: leave every existing script's text as it is. Append dist/packages/pay-contracts/test/contract-writes.test.js and dist/apps/gateway/test/pay-contracts-http.test.js at the END of the node --test list in test, and dist/packages/db/test/postgres-pay-contract-safe-write.test.js at the END of the node --test --test-concurrency=1 list in test:db; add a test:pay-contract-writes:mutations script that runs the mutation script, and add " && npm run test:pay-contract-writes:mutations" as its own step right after "npm run test:organization-notes:mutations" in test. Never change dependencies.

Out of scope: updating or ending a contract (SHU-318), reading contracts (SHU-319), effective-rate resolution, transfers, payouts, bank files, invoices, the weekly auto-generate job, stores as a platform table (O7), any change to the contract rules in PayContracts, bank details, the read model in packages/organizations, any notification or email, any UI beyond what the routes need, any change to packages/safe-write-contract, packages/contracts or the login code, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-318 is the rest of FI-01: staff or an admin changes a pay contract's
// terms or ends it (a soft delete), each through the safe-write contract on
// SHU-317's pattern. The record is now the contract itself, so the preview
// shows the contract's current terms as before and a confirm of a stale
// preview is refused.
export const SHU318_PATHS = Object.freeze([
  "packages/pay-contracts/src/contract-changes.ts",
  "packages/pay-contracts/src/contracts.ts",
  "packages/pay-contracts/src/index.ts",
  "packages/pay-contracts/test/contract-changes.test.ts",
  "packages/pay-contracts/test/contract-changes-mutations.mjs",
  "packages/db/migrations/0196_pay_contract_change_safe_write.sql",
  "packages/db/src/postgres-pay-contract-safe-write-store.ts",
  "packages/db/test/postgres-pay-contract-change.test.ts",
  "packages/db/test/postgres-authz-store.test.ts",
  "apps/gateway/src/pay-contracts-http.ts",
  "apps/gateway/src/login-runtime.ts",
  "apps/gateway/test/pay-contracts-change-http.test.ts",
  "package.json",
]);

const SHU318_ACCEPTANCE = [
  "(1) a pay contract's terms are changed only through preview, confirm and receipt on the existing safe-write contract, as one field \"pay_contract_terms\" whose value is the canonical JSON of the editable fields, and a contract is ended only through the field \"pay_contract_removal\" whose value is exactly \"removed\"; any other value is refused with invalid_value at preview and at confirm by an exported check the builder runs, and runSafeWriteConformance runs over the change write's own builder, so making the terms check accept anything makes the \"SHU-318/AC-01 conformance\" test fail;",
  "(2) the overlap invariant keeps: a terms change that would overlap another non-deleted contract of the same candidate at the same store is refused at preview with invalid_value, and when the clash lands between preview and confirm the confirm answers state_changed with the contract unchanged; letting the exported changer rethrow overlapping_contract instead of answering state_changed makes the \"SHU-318/AC-02 overlap-on-update-refused\" test fail;",
  "(3) the store's commit locks the contract row, compares its current canonical terms with the previewed before inside the transaction through an exported function it calls there, and refuses with state_changed when they differ (for both fields); making that compare always succeed makes the \"SHU-318/AC-03 stale-confirm\" test fail;",
  "(4) the preview's before is the contract's current terms, rendered by one exported function that produces exactly the canonical value a resubmission of those terms would carry (end date included when present); dropping the end date from it makes the \"SHU-318/AC-04 before-is-current\" test fail;",
  "(5) a terms change may keep a currency the catalogue has since retired only when it is the contract's current currency; a change to any other inactive or unknown currency is refused with invalid_value; letting the check accept a retired currency that is not the current one makes the \"SHU-318/AC-05 retired-currency-refused\" test fail;",
  "(6) only a staff or admin grant covering the contract's company (SHU-317's payContractWriteDecision, called by the store inside its commit transaction) may change or end it; any other grant, an unknown contract and an ended contract all get not_found, never 403; candidate, company and store never change; each change commits PayContracts' own pay_contract.update or pay_contract.remove row and a receipt row under the new operation pay_contract.update.safe_write or pay_contract.remove.safe_write with organizationAuditRef of the contract's company in one transaction, none of which contains an amount, the raw company id or the raw candidate id; a repeated confirm of one token returns token_already_used; migration 0196 only widens the audit constraints and authorization_audit_summary_valid from 0195's definitions, still accepting every existing row and every operation earlier migrations added; \"0196_pay_contract_change_safe_write\" follows \"0195_pay_contract_create_safe_write\" in both schema_migrations lists;",
  "(7) packages/pay-contracts/test/contract-changes-mutations.mjs applies mutations (1) to (5), each makes its named test fail, the script passes on the unmutated code, and every existing mutation script's anchors, including SHU-317's in contract-writes.js, still bind exactly once;",
  "(8) npm run typecheck and npm test pass, the new tests run from package.json's test and test:db commands, the mutation script runs as its own npm script test:pay-contract-changes:mutations chained into test right after test:pay-contract-writes:mutations, and nothing outside the card's paths changes.",
].join(" ");

const SHU318_BRIEF = `Card SHU-318: staff or admin updates or ends a pay contract through safe write (slice F1, the rest of FI-01).

You are working in the StudentHub platform monorepo at the bound head, which includes SHU-317 (migration 0195, the pay-contract create through safe write). Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Read first:
- docs/parity/finance-contracts-and-payroll.md: section 2, rows FI-01 and FI-04 in section 6 (auto_generate is an editable field PayContracts already validates), slice F1 in section 10, and D-FI1 in section 11 (open; this card moves no money).
- packages/pay-contracts/src/contracts.ts: PayContracts.update (UPDATABLE fields, its contract_changed refusal when the currency row moved, the overlap check under lockPair), PayContracts.remove (the soft delete), assertCurrency (an unchanged historical currency may stay), and normalizePayContractCreate, which SHU-317 added.
- SHU-317's create, which this card extends: packages/pay-contracts/src/contract-writes.ts (payContractWriteDecision, payContractCreateValue, payContractCreateCheck, buildPayContractCreateWrite, payContractCreator, payContractPrincipalRef), its test and contract-writes-mutations.mjs, packages/db/src/postgres-pay-contract-safe-write-store.ts, packages/db/migrations/0195_pay_contract_create_safe_write.sql, apps/gateway/src/pay-contracts-http.ts and its HTTP test, and the wiring in apps/gateway/src/login-runtime.ts.
- SHU-315's stale compare, the model for this card's: packages/organizations/src/approved-to-hire-writes.ts and its store's #commit.

Goal. Staff or an admin covering a contract's company can change its terms or end it through the safe-write path, and each preview shows the contract as it is now. A confirm whose preview is stale, or whose change would now overlap another contract, is refused rather than applied. PayContracts.update and PayContracts.remove still own the rules and their audit rows; this card adds the preview, the token, the stale check and the receipt around them. Nothing is paid or sent.

Contract mapping (decided; do not reopen):
- The record is the contract: personRef is payContractRecordRef(contractId) (domain "pay-contract-record"); the principal ref is SHU-317's payContractPrincipalRef.
- Two fields on that record. "pay_contract_terms": the value is the canonical JSON of the editable fields autoGenerate, currencyId, endDate (omitted when open-ended), startDate, status, terms and transferCost, keys in alphabetical order at both levels, encoded exactly as SHU-317's create value is (without candidateId, companyId and storeId, which never change). "pay_contract_removal": the value is exactly "removed". The policy is { allowed: ["pay_contract_terms", "pay_contract_removal"], maxValueLength: 1024 }.
- readField returns, for either field, the canonical terms value of the current non-deleted contract (payContractEditableValue), and null when there is none. So the removal preview shows the current terms as before and "removed" as after, and a removal previewed against one version of the contract is refused if its terms changed before the confirm.
- Migration: yes, 0196. Each action gets its own receipt operation, matching the existing pay_contract.update and pay_contract.remove pair: pay_contract.update.safe_write with fields ["pay_contract_terms"], pay_contract.remove.safe_write with fields ["pay_contract_removal"].

Design:
- packages/pay-contracts/src/contracts.ts changes in one way only: add one exported function normalizePayContractUpdate(input: unknown) (normalizeEditable over closedObject(input, UPDATABLE)) and have update() call it in place of that expression. Behaviour, error codes and every existing test stay the same.
- packages/pay-contracts/src/contract-changes.ts (new; import from contract-writes.ts what you reuse, do not copy it) exports:
  - PAY_CONTRACT_TERMS_FIELD, PAY_CONTRACT_REMOVAL_FIELD, PAY_CONTRACT_CHANGE_POLICY and payContractRecordRef;
  - payContractTermsValue(fields): the canonical string of normalized editable fields, and payContractEditableValue(contract: PayContract): the same string rendered from a stored contract; for any contract, payContractTermsValue(normalizePayContractUpdate(JSON.parse(payContractEditableValue(contract)))) equals payContractEditableValue(contract);
  - payContractStateDecision(current, expected): current === expected;
  - payContractChangeCheck({ references, contracts }) returning (contractId, field, value, before: string | null) => Promise<boolean>. For "pay_contract_removal" it accepts exactly "removed" when before is not null. For "pay_contract_terms" it requires before not null, the value to be the canonical encoding of normalizePayContractUpdate's result, the currency to be either the currency in before or active in the catalogue (a resolver that throws makes the request fail), and no other non-deleted contract of the same candidate at the same store (read with contracts.get(contractId), then contracts.listForCandidate) to overlap the new period. A PayContractError with status 400 is a false, never a throw;
  - acceptAnyPayContractChangeValue, for the conformance run;
  - buildPayContractChangeWrite({ store, secret, check, contractId, policy?, clock?, tokenLifetimeMs? }): wraps createSafeWrite; at preview and at confirm it first asks store.ownedRecord(principalRef) and answers not_own_record when it is not the request's personRef (so a caller who may not see the contract learns nothing from the check), then reads before with store.readField and calls check(contractId, field, value, before), answering invalid_value when it is false;
  - payContractChanger(references) returning (store: PayContractStore, actorId, contractId, field, value) => Promise<{ ok: true } | { ok: false; reason: "state_changed" | "not_own_record" }>: for the terms field it calls new PayContracts(store, references).update(actorId, contractId, JSON.parse(value)), for the removal field .remove(actorId, contractId); a PayContractError with code overlapping_contract or contract_changed, or with status 400, answers state_changed, one with code not_found answers not_own_record, and anything else propagates.
- packages/db/src/postgres-pay-contract-safe-write-store.ts gains constructor options changer and stateDecision and three methods:
  - forContract(principalId, contractId): a SafeWriteStore whose ownedRecord reads the contract, refuses when it is missing or deleted, and otherwise asks the decision about the caller's grants and the contract company's ancestry; whose readField returns the current canonical terms (passed in through the constructor as editableValue, the function payContractEditableValue) or null; and whose commit runs #commitChange;
  - readChangeReceipt(principalId, contractId, receiptRef), for both new operations, scoped to the contract's company's organizationAuditRef and personRef payContractRecordRef(contractId);
  - #commitChange: BEGIN; pg_advisory_xact_lock(hashtextextended($1,318)) on the contract id; the contract row FOR UPDATE (through transactionFor(client).find); a missing or deleted contract is not_own_record; the caller's grants FOR SHARE and the company's ancestry; the decision (not_own_record); the token reference in the audit table for the field's operation (token_already_used); stateDecision(editableValue(current), expectedBefore) (state_changed); the changer on a PayContractStore bound to this client as SHU-317's #commit binds one; a refusal rolls back and is returned; then the receipt row (target_org_refs [organizationAuditRef(companyId)], before_summary { valuePresent: true }, after_summary the receipt shape with the field and the tokenRef); COMMIT. 23505 becomes token_already_used.
- HTTP (apps/gateway/src/pay-contracts-http.ts): POST /pay-contracts/change/preview and /pay-contracts/change/confirm take exactly contractId (a UUID), field and value, plus token on confirm; GET /pay-contracts/change/{contractId}/receipts/{receiptRef} reads a receipt. Same session, Origin, content-type, header, error-mapping and try/catch handling as SHU-317's routes in the same module; handlePayContracts serves them, so index.ts does not change.
- Live wiring (login-runtime.ts): pass changer payContractChanger(the pay-contract resolver), stateDecision payContractStateDecision and editableValue payContractEditableValue to the existing PostgresPayContractSafeWriteStore, and build the change service with payContractChangeCheck only when the safe-write key is set.

Pitfalls earlier reviewers blocked. Avoid each one:
- Mutations must hit the code production runs: the check, the changer, the stale compare and the editable-value renderer are exported from contract-changes.ts and reach the store through its constructor or the gateway; packages/db does not import them directly and does not import packages/organizations; dependencies stay unchanged.
- One transaction: the change, PayContracts' own audit row and the receipt row commit or roll back together, on the client #commitChange opened.
- No money in audit rows or receipts: the Postgres test asserts JSON.stringify of every audit row the change wrote contains none of the test's rates, totals or transfer cost and neither the raw company id nor the raw candidate id.
- Migration 0196: start from 0195's text (the latest definitions on main) and add pay_contract.update.safe_write and pay_contract.remove.safe_write wherever pay_contract.create.safe_write appears: the operation check, the target_org_refs cardinality > 0 branch, the safe-write halves check, and the safe-write branch of authorization_audit_summary_valid, with fields equal to ["pay_contract_terms"] and ["pay_contract_removal"] respectively. Add unique indexes on each operation's token and receipt. Drop nothing else.
- Conformance: run runSafeWriteConformance over buildPayContractChangeWrite with acceptAnyPayContractChangeValue.
- Mutation script: copy SHU-317's packages/pay-contracts/test/contract-writes-mutations.mjs, mutating dist/packages/pay-contracts/src/contract-changes.js and running dist/packages/pay-contracts/test/contract-changes.test.js. Name each test "SHU-318/AC-0N <name> " followed by a description. Check by hand that each mutant really fails its named test and that the script passes on the unmutated code.
- Other cards' anchors. Keep each exactly once:
  - SHU-317's contract-writes-mutations.mjs anchors contract-writes.js, including \`row.role === "staff" || row.role === "admin"\` in payContractWriteDecision: do not change contract-writes.ts (it is not one of your paths) and do not repeat that text in contract-changes.ts; reuse the decision.
  - packages/pay-contracts/test/mutations.mjs anchors contracts.js on \`c.status !== "deleted" && c.id !== candidate.id && overlaps(c, candidate)\`, and memory-store.js, bank-write.js, bank.js, resolution.js and apps/gateway/src/bank-details.js lines: change contracts.ts only as above, and none of the others.
  - packages/observability/test/mutations.mjs anchors apps/gateway/src/index.js: this card does not change index.ts.
- The Postgres test must exercise the store against the database (test:db): a staff terms change whose two audit rows are as above and whose contract reads back changed; a removal that leaves the contract with status deleted and makes a second preview not_found; an org-owner change refused with the contract unchanged; a stale confirm after another change; an overlap created between preview and confirm giving state_changed; and a duplicate confirm of one token.

Acceptance. Each item is pinned by a mutation in packages/pay-contracts/test/contract-changes-mutations.mjs that makes a named test fail.
(1) Make the terms check accept every value: "SHU-318/AC-01 conformance" fails. It previews and confirms a terms value with keys out of order, one carrying candidateId, and a removal value of "deleted", each getting invalid_value, and runs the conformance suite.
(2) Make the changer rethrow overlapping_contract: "SHU-318/AC-02 overlap-on-update-refused" fails. It previews a change, stores a clashing contract in the InMemoryPayContractStore, confirms, and expects state_changed with the contract unchanged; it also expects invalid_value for a change that already overlaps at preview.
(3) Make payContractStateDecision always return true: "SHU-318/AC-03 stale-confirm" fails. It drives the real builder through an in-memory SafeWriteStore whose commit calls the compare on the current contract.
(4) Drop endDate from payContractEditableValue: "SHU-318/AC-04 before-is-current" fails. It previews a change of a contract with an end date and expects before to equal payContractTermsValue of that contract's normalized fields.
(5) Let the check accept a retired currency that is not the contract's current one (anchor: the comparison of the value's currency with before's currency in contract-changes.js, made to accept any currency): "SHU-318/AC-05 retired-currency-refused" fails. It refuses a switch to a retired currency and accepts an unchanged retired current currency.
The script prints "5/5 SHU-318 mutations killed". Use synthetic fixtures only.

Your paths, and what each may hold:
- packages/pay-contracts/src/contract-changes.ts (new)
- packages/pay-contracts/src/contracts.ts: only normalizePayContractUpdate, called by update()
- packages/pay-contracts/src/index.ts (exports only)
- packages/pay-contracts/test/contract-changes.test.ts (new)
- packages/pay-contracts/test/contract-changes-mutations.mjs (new)
- packages/db/migrations/0196_pay_contract_change_safe_write.sql (new)
- packages/db/src/postgres-pay-contract-safe-write-store.ts: the new options and methods above; SHU-317's create path unchanged
- packages/db/test/postgres-pay-contract-change.test.ts (new)
- packages/db/test/postgres-authz-store.test.ts: only add "0196_pay_contract_change_safe_write" after "0195_pay_contract_create_safe_write" in both schema_migrations lists
- apps/gateway/src/pay-contracts-http.ts: the change routes and service
- apps/gateway/src/login-runtime.ts (wiring only)
- apps/gateway/test/pay-contracts-change-http.test.ts (new)
- package.json: leave every existing script's text as it is. Append dist/packages/pay-contracts/test/contract-changes.test.js and dist/apps/gateway/test/pay-contracts-change-http.test.js at the END of the node --test list in test, and dist/packages/db/test/postgres-pay-contract-change.test.js at the END of the node --test --test-concurrency=1 list in test:db; add a test:pay-contract-changes:mutations script that runs the mutation script, and add " && npm run test:pay-contract-changes:mutations" as its own step right after "npm run test:pay-contract-writes:mutations" in test. Never change dependencies.

Out of scope: creating contracts (SHU-317), reading or listing contracts (SHU-319), restoring an ended contract, changing a contract's candidate, company or store, effective-rate resolution, transfers, payouts, bank files, invoices, the weekly auto-generate job, any change to the contract rules in PayContracts, any notification or email, any UI beyond what the routes need, any change to packages/safe-write-contract, packages/contracts or the login code, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-319 is FI-02 ("see my contract") and the staff list: read-only. Who
// sees which half of a contract is one exported decision and one whitelist
// projection, so a mutation that leaks a field or widens a role fails a test.
export const SHU319_PATHS = Object.freeze([
  "packages/pay-contracts/src/contract-reads.ts",
  "packages/pay-contracts/src/index.ts",
  "packages/pay-contracts/test/contract-reads.test.ts",
  "packages/pay-contracts/test/contract-reads-mutations.mjs",
  "packages/db/src/postgres-pay-contract-store.ts",
  "packages/db/src/postgres-pay-contract-safe-write-store.ts",
  "packages/db/test/postgres-pay-contract-reads.test.ts",
  "apps/gateway/src/pay-contracts-http.ts",
  "apps/gateway/src/login-runtime.ts",
  "apps/gateway/test/pay-contracts-read-http.test.ts",
  "package.json",
]);

const SHU319_ACCEPTANCE = [
  "(1) an org-owner or finance grant covering a company lists that company's contracts in the company view: for each, exactly id, candidateId, companyId, storeId, startDate, endDate (when present), currencyId, autoGenerate, status and terms with only the company side (hourly: payModel and companyHourlyRate; fixed_price: payModel, companyTotal and completionPercentage; monthly_salary: payModel, companyTotal and salaryDay); candidateHourlyRate, candidateTotal, transferCost and the timestamps never appear; projecting by copying the stored contract or its terms makes the \"SHU-319/AC-01 company-view-whitelist\" test fail;",
  "(2) a principal holding a candidate grant lists their own contracts in the candidate view: for each, exactly id, companyId, storeId, startDate, endDate (when present), currencyId, status and terms with only the candidate side (hourly: payModel and candidateHourlyRate; fixed_price: payModel, candidateTotal and completionPercentage; monthly_salary: payModel, candidateTotal and salaryDay); companyHourlyRate, companyTotal, transferCost, autoGenerate, candidateId and the timestamps never appear; copying the stored terms into it makes the \"SHU-319/AC-02 candidate-view-whitelist\" test fail;",
  "(3) the access decision is one exported function: a staff or admin grant covering the company gives the full view, an org-owner or finance grant covering it gives the company view, and a recruiter, candidate or any other grant gets null and the route answers 404 not_found, never 403; an operator organization is never a target; giving a recruiter the company view makes the \"SHU-319/AC-03 employer-roles-limited\" test fail;",
  "(4) covering means a grant on the company itself or a subtree grant on one of its ancestors, the rule every organization read and write uses; treating a self grant on the parent as covering makes the \"SHU-319/AC-04 self-grant-on-parent-not-covering\" test fail;",
  "(5) every list leaves out contracts with status deleted and orders by start date descending, then id ascending, through one exported list function the gateway applies to the store's rows; listing a deleted contract makes the \"SHU-319/AC-05 deleted-hidden\" test fail;",
  "(6) the full view carries every PayContract field except deletedAt; the decision runs before any contract is read (a refused caller causes no contract query); the reads write nothing and add no audit row; there is no migration in this card;",
  "(7) packages/pay-contracts/test/contract-reads-mutations.mjs applies mutations (1) to (5), each makes its named test fail, the script passes on the unmutated code, and every existing mutation script's anchors, including SHU-317's and SHU-318's, still bind exactly once;",
  "(8) npm run typecheck and npm test pass, the new tests run from package.json's test and test:db commands, the mutation script runs as its own npm script test:pay-contract-reads:mutations chained into test right after test:pay-contract-changes:mutations, and nothing outside the card's paths changes.",
].join(" ");

const SHU319_BRIEF = `Card SHU-319: company members and staff read pay contracts (slice F1, FI-02 and the staff list), read-only.

You are working in the StudentHub platform monorepo at the bound head, which includes SHU-317 and SHU-318 (migrations 0195 and 0196, the pay-contract create, change and end through safe write). Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Read first:
- docs/parity/finance-contracts-and-payroll.md: section 2 (the amount columns per pay model) and rows FI-01 and FI-02 in section 6. docs/parity/ui-journeys/employer.md rows /contract-list and /contract-view (lines 69 and 70): the employer screens show company rates, completion_percentage and salary_day.
- packages/pay-contracts/src/types.ts: PayContract, HourlyTerms, FixedPriceTerms and MonthlySalaryTerms are the fields this card projects. packages/pay-contracts/src/contracts.ts: PayContracts.listForCandidate (filters deleted, orders start date descending then id).
- SHU-317's packages/pay-contracts/src/contract-writes.ts (payContractWriteDecision and its grant-row shape) and packages/db/src/postgres-pay-contract-safe-write-store.ts (#grants, #ancestors, isCandidate); SHU-316's list route in apps/gateway/src/organization-notes.ts (a GET that answers 404 when the store returns null, and its view function); and apps/gateway/src/pay-contracts-http.ts.
- packages/contracts/src/authz/context.ts: a grant applies at its organization, and a subtree grant at every descendant.

Goal. People who need a contract can read it, and each sees only its side. Staff and admins covering a company see everything. The company's owner and finance people see what the company pays and the contract's shape, never what the candidate is paid or the transfer cost (the margin and the payout are not the employer's). A candidate sees their own contracts and what they are paid, never what the company is charged. Everyone else learns nothing, not even that a contract exists. Nothing is written.

Design:
- packages/pay-contracts/src/contract-reads.ts (new) exports:
  - PayContractView = "full" | "company" | "candidate";
  - payContractReadAccess(rows, companyId, ancestors, operators): "full" | "company" | null. It returns null when operators includes companyId; "full" when a staff or admin grant covers the company; otherwise "company" when an org-owner or finance grant covers it; otherwise null. Write the covering test once, as a helper both branches call (anchor for mutation (4): \`row.scope === "subtree" && ancestors.includes(row.org_id)\`), and the company roles once (anchor for mutation (3): \`row.role === "org-owner" || row.role === "finance"\`). operators is required, as in SHU-317;
  - projectPayContract(contract, view): builds a new frozen object from named fields only, per the acceptance (never a spread or Object.assign of the contract or its terms). The full view is every PayContract field except deletedAt, terms included whole;
  - payContractListView(contracts, view): drops status "deleted", orders by startDate descending then id ascending, and projects each.
- Store reads. packages/db/src/postgres-pay-contract-store.ts gains listForCompany(companyId) (the existing COLUMNS and fromRow, WHERE company_org_id = $1; it returns deleted rows too, and the list function drops them). PostgresPayContractSafeWriteStore gains readAccess(principalId, companyId), which reads the caller's grants and the company's ancestry with its existing helpers and returns the injected readDecision's answer (a new constructor option, (rows, companyId, ancestors) => PayContractView | null), and uses its existing isCandidate for the candidate list. listForCompany is a class method, not part of the PayContractStore interface, so SHU-317's bound store and InMemoryPayContractStore do not change.
- HTTP (apps/gateway/src/pay-contracts-http.ts): GET /pay-contracts/company/{orgId} answers { view, contracts } after readAccess allows it (404 not_found when it returns null, before any contract is read), with contracts from payContractListView(listForCompany rows, view); GET /pay-contracts/mine answers { contracts } in the candidate view from listForCandidate when isCandidate is true, and 404 not_found otherwise. Both need a session (401 without one), are GET only, and send the module's no-store headers. A refused or unknown company is 404; a covering caller whose company has no contracts gets 200 with an empty list.
- Live wiring (login-runtime.ts): pass readDecision (rows, org, ancestors) => payContractReadAccess(rows, org, ancestors, DEFAULT_OPERATOR_ORG_IDS) to the existing PostgresPayContractSafeWriteStore; the read service is built whether or not the safe-write key is set (reads need no key), from the stores SHU-317 constructs from DATABASE_URL.
- No migration. pay_contracts has no index on company_org_id; at this volume a scan is fine, so do not add one here.

Pitfalls earlier reviewers blocked. Avoid each one:
- Mutations must hit the code production runs: the gateway applies payContractListView (and so projectPayContract) to the store's rows on every list, and the store calls the injected readDecision; packages/db does not import contract-reads.ts directly and does not import packages/organizations; dependencies stay unchanged.
- Whitelist, not blacklist: the tests assert the exact key sets per view and pay model, and that JSON.stringify of a company view contains neither the candidate amount nor the transfer cost strings and a candidate view contains neither the company amount nor the transfer cost strings. Pick distinct synthetic amounts so the assertion is meaningful.
- Decide before reading: the HTTP test's fake store records calls and asserts a refused caller causes no listForCompany call.
- Mutation script: copy SHU-317's contract-writes-mutations.mjs, mutating dist/packages/pay-contracts/src/contract-reads.js and running dist/packages/pay-contracts/test/contract-reads.test.js. Name each test "SHU-319/AC-0N <name> " followed by a description. Check by hand that each mutant really fails its named test and that the script passes on the unmutated code.
- Other cards' anchors. Keep each exactly once: SHU-317's contract-writes-mutations.mjs (contract-writes.js) and SHU-318's contract-changes-mutations.mjs (contract-changes.js): do not change either source file and do not repeat \`row.role === "staff" || row.role === "admin"\` in a way that matters to them (each script counts only its own file, but keep your role tests in your own helper). packages/pay-contracts/test/mutations.mjs anchors contracts.js, memory-store.js, bank-write.js, bank.js, resolution.js and apps/gateway/src/bank-details.js: do not change any of them. packages/observability/test/mutations.mjs anchors apps/gateway/src/index.js: this card does not change index.ts.
- The Postgres test must exercise the stores against the database (test:db): listForCompany returns that company's rows only (deleted ones included, for the list function to drop); readAccess answers "full" for a staff subtree grant on the operator organization, "company" for an org-owner self grant and for a finance subtree grant on the parent, and null for a recruiter grant and for a self org-owner grant on the parent.

Acceptance. Each item is pinned by a mutation in packages/pay-contracts/test/contract-reads-mutations.mjs that makes a named test fail.
(1) Copy the stored terms into the company view (for example \`terms: contract.terms\` or a spread): "SHU-319/AC-01 company-view-whitelist" fails. It projects one contract of each pay model and asserts the exact keys and the absent strings.
(2) Copy the stored terms into the candidate view: "SHU-319/AC-02 candidate-view-whitelist" fails, with the same checks for the candidate side.
(3) Add recruiter to the company roles (anchor: \`row.role === "org-owner" || row.role === "finance"\`): "SHU-319/AC-03 employer-roles-limited" fails. That test also checks a candidate grant, a staff grant elsewhere and the operator organization as a target.
(4) Drop the subtree condition from the covering helper (anchor: \`row.scope === "subtree" && ancestors.includes(row.org_id)\`): "SHU-319/AC-04 self-grant-on-parent-not-covering" fails.
(5) Keep deleted contracts in payContractListView: "SHU-319/AC-05 deleted-hidden" fails. It also checks the order with two contracts on the same start date.
The script prints "5/5 SHU-319 mutations killed". Use synthetic fixtures only.

Your paths, and what each may hold:
- packages/pay-contracts/src/contract-reads.ts (new)
- packages/pay-contracts/src/index.ts (exports only)
- packages/pay-contracts/test/contract-reads.test.ts (new)
- packages/pay-contracts/test/contract-reads-mutations.mjs (new)
- packages/db/src/postgres-pay-contract-store.ts: only listForCompany
- packages/db/src/postgres-pay-contract-safe-write-store.ts: only the readDecision option and readAccess
- packages/db/test/postgres-pay-contract-reads.test.ts (new)
- apps/gateway/src/pay-contracts-http.ts: the two read routes and the read service
- apps/gateway/src/login-runtime.ts (wiring only)
- apps/gateway/test/pay-contracts-read-http.test.ts (new)
- package.json: leave every existing script's text as it is. Append dist/packages/pay-contracts/test/contract-reads.test.js and dist/apps/gateway/test/pay-contracts-read-http.test.js at the END of the node --test list in test, and dist/packages/db/test/postgres-pay-contract-reads.test.js at the END of the node --test --test-concurrency=1 list in test:db; add a test:pay-contract-reads:mutations script that runs the mutation script, and add " && npm run test:pay-contract-reads:mutations" as its own step right after "npm run test:pay-contract-changes:mutations" in test. Never change dependencies.

Out of scope: any write, migration or index; sub-organization roll-up (a company's list is its own contracts; a sub-organization's are read by naming it); paging; reading one contract by id; candidate or store details beyond their ids; effective-rate resolution; transfers, payouts, invoices; exports; any UI beyond what the routes need; any change to packages/safe-write-contract, packages/contracts or the login code; the lockfile; and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-320 is the bank half of OR-25 (slice O8): the legacy bank row's payment
// codes, recorded on the catalogue's bank items through the catalogue's own
// admin write path. It is the foundation the payout cards (F3) will read; it
// generates no bank file.
export const SHU320_PATHS = Object.freeze([
  "packages/reference-catalogue/src/bank-payment-details.ts",
  "packages/reference-catalogue/src/types.ts",
  "packages/reference-catalogue/src/catalogue.ts",
  "packages/reference-catalogue/src/memory-store.ts",
  "packages/reference-catalogue/src/index.ts",
  "packages/reference-catalogue/test/bank-payment-details.test.ts",
  "packages/reference-catalogue/test/bank-payment-details-mutations.mjs",
  "packages/db/migrations/0197_catalogue_bank_payment_details.sql",
  "packages/db/src/postgres-catalogue-store.ts",
  "packages/db/test/postgres-catalogue-bank-payment-details.test.ts",
  "packages/db/test/postgres-authz-store.test.ts",
  "apps/gateway/src/catalogue-http.ts",
  "apps/gateway/test/catalogue-bank-payment-details-http.test.ts",
  "package.json",
]);

const SHU320_ACCEPTANCE = [
  "(1) an admin records a catalogue bank's payment details, exactly swiftCode, ibanBankCode, abkCode and transferType, all four required, in one write; swiftCode, ibanBankCode and abkCode are trimmed and upper-cased first, and transferType is trimmed and compared as given; swiftCode must have the ISO 9362 shape (four letters, two letters, two letters or digits, and optionally three more letters or digits: 8 or 11 characters); anything else is refused with 400 invalid_swift_code; accepting any 8 to 11 letters or digits makes the \"SHU-320/AC-01 swift-shape\" test fail;",
  "(2) transferType is exactly local, international or within_bank, refused otherwise with 400 invalid_transfer_type; ibanBankCode is exactly four letters or digits (invalid_iban_bank_code) and abkCode a whole number from 0 to 100 written in digits (invalid_abk_code; legacy bank_code_abk is a number with max 100); accepting any string as a transfer type makes the \"SHU-320/AC-02 transfer-type-closed\" test fail;",
  "(3) only the admin role writes payment details; staff, recruiter, org-owner, finance and candidate actors get 403 catalogue_write_forbidden, the catalogue's existing answer for a refused writer; the role rule is one exported function the service calls; accepting staff makes the \"SHU-320/AC-03 admin-only\" test fail;",
  "(4) details are written only on an active item of type bank: a deleted bank, another catalogue type's item and an unknown id get 404 catalogue_item_not_found; the service checks this before calling the store; dropping the active check makes the \"SHU-320/AC-04 active-bank-only\" test fail;",
  "(5) the input is a closed object: any key besides the four, or a non-string value, is refused with 400 invalid_bank_payment_details; accepting an extra key makes the \"SHU-320/AC-05 closed-input\" test fail;",
  "(6) any authorized actor reads a bank's payment details (active or deleted bank, as resolveHistorical reads), and a bank without them reads as 404 bank_payment_details_not_found; each write records the writer's principalRef in created_by_ref and updated_by_ref, as catalogue_items does; migration 0197 adds one table and its checks and changes no existing table, constraint or function, and authorization_mutation_audit is untouched; the bank list and CatalogueItem are unchanged; \"0197_catalogue_bank_payment_details\" follows \"0196_pay_contract_change_safe_write\" in both schema_migrations lists;",
  "(7) packages/reference-catalogue/test/bank-payment-details-mutations.mjs applies mutations (1) to (5), each makes its named test fail, the script passes on the unmutated code, and every existing mutation script's anchors, including packages/reference-catalogue/test/mutations.mjs's in catalogue.js and memory-store.js, still bind exactly once;",
  "(8) npm run typecheck and npm test pass, the new tests run from package.json's test and test:db commands, the mutation script runs as its own npm script test:catalogue-bank-payment-details:mutations chained into test right after test:pay-contract-reads:mutations, and nothing outside the card's paths changes.",
].join(" ");

const SHU320_BRIEF = `Card SHU-320: admin records a bank's SWIFT, IBAN bank code, ABK code and transfer type (slice O8, the bank half of OR-25).

You are working in the StudentHub platform monorepo at the bound head, which includes SHU-317, SHU-318 and SHU-319 (migrations 0195 and 0196). Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Read first:
- docs/parity/organizations-stores-and-contacts.md: the bank row in section 2.2 (bank_iban_code, bank_swift_code, bank_code_abk, bank_transfer_type local / international / within-bank, soft delete), the Bank row in section 5, row OR-25 in section 7 ("admin write, others read") and slice O8 in section 11. docs/parity/ui-journeys/admin.md ADMIN-FO-13 (bank-form requires every displayed field; the server also checks bank_transfer_type in range). docs/parity/profile-and-private-documents.md section on IBAN (a Kuwaiti IBAN must contain a known bank_iban_code). docs/parity/bank-file-contract/README.md is still proposed: read it for context only; nothing here generates a file.
- The catalogue's existing write path, which this card follows: packages/reference-catalogue/src/catalogue.ts (ReferenceCatalogue.create, update and remove; requireWriter and WRITE_ROLES; requireId; CatalogueError), types.ts (CatalogueStore, CatalogueItem, CatalogueActor), memory-store.ts (InMemoryCatalogueStore), packages/db/src/postgres-catalogue-store.ts, packages/db/migrations/0146_reference_catalogue.sql (created_by_ref and updated_by_ref record who wrote a row), apps/gateway/src/catalogue-http.ts (authorizedActor from the actor assertion, the JSON body reader, CatalogueError to status), and apps/gateway/test/catalogue-http.test.ts (how an actor assertion is made for a test).
- packages/reference-catalogue/test/mutations.mjs: the mutation-script form this card copies (it mutates the package build under packages/reference-catalogue/dist and runs the suite with --test).

Goal. An admin can record, for a bank in the reference catalogue, the four codes the legacy bank row holds for payments: its SWIFT code, the bank code that appears in its IBANs, its ABK code and its transfer type. Every signed-in actor can read them. They are validated types, not free text, so later payout work can rely on them. No bank file is generated and no IBAN is checked against them in this card.

Contract choice (decided; do not reopen). This is a catalogue write, on the catalogue's own path, not a safe write: the catalogue's actor comes from the actor assertion on its routes, its writes record the writer in created_by_ref and updated_by_ref, a refused writer gets 403 catalogue_write_forbidden, and it writes no authorization_mutation_audit row. So this card does not touch the audit constraints the safe-write cards widen. It differs from create, update and remove in one way: OR-25 makes bank data an admin write, so the writer role here is admin only, through its own exported rule, while WRITE_ROLES (staff and admin) stays as it is for every other catalogue write.

Design:
- packages/reference-catalogue/src/bank-payment-details.ts (new) exports:
  - BANK_TRANSFER_TYPES = ["local", "international", "within_bank"] and the BankTransferType type;
  - BankPaymentDetails { bankId, swiftCode, ibanBankCode, abkCode, transferType, updatedAt };
  - normalizeBankPaymentDetails(value: unknown): { swiftCode, ibanBankCode, abkCode, transferType }. A closed object of exactly those four keys, each a string (else CatalogueError invalid_bank_payment_details, 400); swiftCode, ibanBankCode and abkCode trimmed and upper-cased, transferType trimmed and compared as given; swiftCode must match /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}([A-Z0-9]{3})?$/ (invalid_swift_code), ibanBankCode /^[A-Z0-9]{4}$/ (invalid_iban_bank_code), abkCode /^(100|[1-9]?[0-9])$/ (invalid_abk_code; legacy common/models/Bank.php: bank_code_abk number, max 100), and transferType must be one of BANK_TRANSFER_TYPES (invalid_transfer_type), all 400 (legacy stores LCL, SWF and TRF for local, international and within-bank; a later bank-file card maps them);
  - canWriteBankPaymentDetails(role): true only for "admin".
- types.ts: CatalogueStore gains readBankPaymentDetails(bankId) => Promise<BankPaymentDetails | undefined> and writeBankPaymentDetails(bankId, details & { actorRef, now }) => Promise<BankPaymentDetails | undefined>. Both implementers change: InMemoryCatalogueStore and PostgresCatalogueStore.
- catalogue.ts: ReferenceCatalogue gains bankPaymentDetails(actor, id) and setBankPaymentDetails(actor, id, raw). setBankPaymentDetails throws CatalogueError("catalogue_write_forbidden", 403) unless canWriteBankPaymentDetails(actor.role); requireId(id); normalizes the input; reads the item with this.store.resolveById("bank", id) and throws catalogue_item_not_found (404) unless it exists with status active; then calls writeBankPaymentDetails and throws catalogue_item_not_found if that returns undefined (the bank was deleted in between). bankPaymentDetails needs any actor, requireId, resolveById("bank", id) to exist (any status), and readBankPaymentDetails; absent details throw CatalogueError("bank_payment_details_not_found", 404).
- memory-store.ts: a map keyed by bank id. The memory store must not itself refuse a deleted bank: the service's check is the one the AC-04 mutation removes, so a second check here would let that mutant survive. The Postgres store keeps its own guard in SQL, which the Postgres test covers.
- Migration 0197_catalogue_bank_payment_details.sql creates catalogue_bank_payment_details (bank_id uuid primary key references catalogue_items(id), swift_code text not null with the SWIFT pattern as a CHECK, iban_bank_code text not null CHECK ~ '^[A-Z0-9]{4}$', abk_code text not null CHECK ~ '^(100|[1-9]?[0-9])$', transfer_type text not null CHECK IN ('local','international','within_bank'), created_by_ref and updated_by_ref char(64) not null with the 0146 hex check, created_at and updated_at timestamptz not null) and a BEFORE INSERT OR UPDATE row trigger that raises unless the referenced catalogue_items row has catalogue_type 'bank'.
- PostgresCatalogueStore.writeBankPaymentDetails is one statement: INSERT ... SELECT the values FROM catalogue_items WHERE id = $1 AND catalogue_type = 'bank' AND status = 'active' ON CONFLICT (bank_id) DO UPDATE SET the four codes, updated_by_ref and updated_at, RETURNING the row (keep created_by_ref and created_at on update). No row returned means undefined. readBankPaymentDetails selects by bank_id.
- HTTP (apps/gateway/src/catalogue-http.ts): PUT /catalogue/bank/{id}/payment-details calls setBankPaymentDetails with the JSON body and answers 200 with the details; GET /catalogue/bank/{id}/payment-details calls bankPaymentDetails and answers 200 with them. Both come after authorizedActor, as every non-list catalogue route does, and before the final 404; CatalogueError maps to its status as today. Match only parts[1] === "bank" and parts[3] === "payment-details" with four parts; every existing route keeps its behaviour.

Pitfalls earlier reviewers blocked. Avoid each one:
- Mutations must hit the code production runs: the test file imports from "@studenthub/reference-catalogue" (the package build, as catalogue.test.ts does), and the mutation script mutates packages/reference-catalogue/dist/bank-payment-details.js and dist/catalogue.js, which the gateway also runs.
- Other cards' anchors. packages/reference-catalogue/test/mutations.mjs requires each of these to bind exactly once in the package build: in catalogue.js \`...input, status: "pending", submittedAt: now\` and \`const WRITE_ROLES = new Set(["staff", "admin"]);\`; in memory-store.js the softDeleteItem lines \`const next = Object.freeze({ ...current, status: "deleted", deletedAt: now, updatedAt: now });\` followed by \`this.#items.set(id, next);\`, and \`key > after.sortKey || (key === after.sortKey && row.id > after.id)\`. Leave those lines and WRITE_ROLES as they are and do not repeat them. packages/observability/test/mutations.mjs anchors apps/gateway/src/index.js: this card does not change index.ts. apps/gateway/test/company-directory-mutations.mjs and context-navigation-mutations.mjs anchor other gateway files: do not touch them.
- The anchors this card's own mutations use must each bind once in their file: the SWIFT pattern literal and \`return role === "admin";\` in bank-payment-details.js, the BANK_TRANSFER_TYPES membership test, the key check of the closed object, and the active check \`bank?.status !== "active"\` in catalogue.js.
- Mutation script: copy packages/reference-catalogue/test/mutations.mjs's form (--test, --test-reporter=tap, --test-name-pattern=^<name> with a trailing space, "not ok", AssertionError, restore in finally). Name each test "SHU-320/AC-0N <name> " followed by a description. Check by hand that each mutant really fails its named test and that the script passes on the unmutated code.
- Migration 0197 adds one table and one trigger function and trigger. It does not touch authorization_mutation_audit, its constraints or authorization_audit_summary_valid, and it does not alter catalogue_items.
- The Postgres test must exercise the store against the database (test:db): a write and an overwrite that read back (created_by_ref kept, updated_by_ref changed); a write on a deleted bank and on a currency item each returning undefined; a direct INSERT naming a non-bank item refused by the trigger; and a row with a 9-character SWIFT refused by its CHECK.

Acceptance. Each item is pinned by a mutation in packages/reference-catalogue/test/bank-payment-details-mutations.mjs that makes a named test fail.
(1) Replace the SWIFT pattern with /^[A-Z0-9]{8,11}$/: "SHU-320/AC-01 swift-shape" fails. It accepts "DEUTDEFF", "deutdeff500" (stored "DEUTDEFF500") and refuses "DEUTDEFF5", "1EUTDEFF" and "DEUT12FF".
(2) Accept any string as transferType: "SHU-320/AC-02 transfer-type-closed" fails. It refuses "within-bank", "LOCAL" and "" and accepts each of the three types.
(3) Make canWriteBankPaymentDetails accept staff: "SHU-320/AC-03 admin-only" fails. It checks staff, recruiter, org-owner, finance and candidate actors.
(4) Drop the active check in setBankPaymentDetails: "SHU-320/AC-04 active-bank-only" fails. It writes to a deleted bank and expects catalogue_item_not_found, and checks a currency item's id and an unknown id.
(5) Let the closed-object check pass extra keys: "SHU-320/AC-05 closed-input" fails. It sends a fifth key, a missing key and a numeric abkCode.
The script prints "5/5 SHU-320 mutations killed". Use synthetic fixtures only.

Your paths, and what each may hold:
- packages/reference-catalogue/src/bank-payment-details.ts (new)
- packages/reference-catalogue/src/types.ts: only the two CatalogueStore methods
- packages/reference-catalogue/src/catalogue.ts: only bankPaymentDetails and setBankPaymentDetails, and their imports
- packages/reference-catalogue/src/memory-store.ts: only the two store methods and their map
- packages/reference-catalogue/src/index.ts (exports only)
- packages/reference-catalogue/test/bank-payment-details.test.ts (new)
- packages/reference-catalogue/test/bank-payment-details-mutations.mjs (new)
- packages/db/migrations/0197_catalogue_bank_payment_details.sql (new)
- packages/db/src/postgres-catalogue-store.ts: only the two store methods
- packages/db/test/postgres-catalogue-bank-payment-details.test.ts (new)
- packages/db/test/postgres-authz-store.test.ts: only add "0197_catalogue_bank_payment_details" after "0196_pay_contract_change_safe_write" in both schema_migrations lists
- apps/gateway/src/catalogue-http.ts: only the two routes
- apps/gateway/test/catalogue-bank-payment-details-http.test.ts (new)
- package.json: leave every existing script's text as it is. Append dist/packages/reference-catalogue/test/bank-payment-details.test.js and dist/apps/gateway/test/catalogue-bank-payment-details-http.test.js at the END of the node --test list in test, and dist/packages/db/test/postgres-catalogue-bank-payment-details.test.js at the END of the node --test --test-concurrency=1 list in test:db; add a test:catalogue-bank-payment-details:mutations script that runs the mutation script, and add " && npm run test:catalogue-bank-payment-details:mutations" as its own step right after "npm run test:pay-contract-reads:mutations" in test. Never change dependencies.

Out of scope: bank files, payment advice and payouts (F3, blocked); checking a candidate's IBAN against a bank's IBAN code; changing the bank list, CatalogueItem or any other catalogue type; a history of past codes; the WRITE_ROLES of other catalogue writes; brands, malls, tags or countries; any notification; any UI beyond what the routes need; any change to packages/safe-write-contract, packages/contracts or the login code; the lockfile; and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-323 to SHU-326 are the fourth committed card queue (SHU-312). SHU-323
// closes the gap SHU-316 left on purpose: organization notes refuse UPDATE in
// the database, but a direct DELETE, a TRUNCATE or the ON DELETE CASCADE from a
// hard-deleted organization can still remove them. It mirrors the audit
// ledger's own triggers (migration 0004).
export const SHU323_PATHS = Object.freeze([
  "packages/db/migrations/0198_organization_notes_refuse_delete.sql",
  "packages/db/test/postgres-organization-notes-append-only.test.ts",
  "packages/db/test/postgres-authz-store.test.ts",
  "packages/db/test/postgres-reference-catalogue.test.ts",
  "package.json",
]);

const SHU323_ACCEPTANCE = [
  "(1) migration 0198 recreates the existing row trigger organization_notes_no_update as BEFORE UPDATE OR DELETE ... FOR EACH ROW on organization_notes, so a direct DELETE of a note raises \"organization notes are append-only\" with SQLSTATE 55000 and removes nothing; leaving DELETE out of that trigger makes the \"SHU-323/AC-01 delete-refused\" database test fail;",
  "(2) a new statement trigger organization_notes_no_truncate, BEFORE TRUNCATE ... FOR EACH STATEMENT, refuses TRUNCATE organization_notes and a TRUNCATE organizations CASCADE that reaches it, with the same error; leaving it out makes the \"SHU-323/AC-02 truncate-refused\" database test fail;",
  "(3) deleting an organization that has notes fails, because the foreign key's ON DELETE CASCADE deletes its notes row by row and the row trigger refuses each; the organization and its notes stay; deleting an organization with no notes still succeeds; dropping the row trigger's DELETE event makes the \"SHU-323/AC-03 noted-organization-delete-refused\" database test fail;",
  "(4) UPDATE of a note is still refused, adding and listing notes behave as before and SHU-316's tests pass unchanged; the organization_notes table, its columns, foreign key and indexes are unchanged; 0198 changes no other table, does not touch authorization_mutation_audit, its constraints or authorization_audit_summary_valid; \"0198_organization_notes_refuse_delete\" follows the newest earlier migration (\"0197_catalogue_bank_payment_details\" once the third card queue has landed) in both schema_migrations lists;",
  "(5) test isolation still works: the beforeEach hooks of postgres-authz-store.test.ts and postgres-reference-catalogue.test.ts, which TRUNCATE organizations with CASCADE, disable organization_notes_no_truncate before that TRUNCATE and re-enable it in a finally block, as postgres-authz-store.test.ts already does for authorization_mutation_audit_no_truncate, and change nothing else in those hooks;",
  "(6) this card changes no TypeScript source, so it has no mutation script: each database test is the pin, and the final message says, for each of tests (1) to (3), why it fails against 0194's triggers alone;",
  "(7) npm run typecheck and npm test pass, the new database test runs from package.json's test:db command, and nothing outside the card's paths changes.",
].join(" ");

const SHU323_BRIEF = `Card SHU-323: organization notes refuse DELETE and TRUNCATE in the database (a follow-up to slice O9a, SHU-316).

You are working in the StudentHub platform monorepo at the bound head, which includes SHU-316 (migration 0194, organization notes) and the third card queue (SHU-317 to SHU-320, migrations 0195 to 0197). Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Read first:
- packages/db/migrations/0194_organization_notes.sql (lines 1 to 8): organization_notes, its foreign key org_id REFERENCES organizations(id) ON DELETE CASCADE, the function organization_notes_no_update() and the BEFORE UPDATE row trigger organization_notes_no_update.
- packages/db/migrations/0004_create_authorization_mutation_audit.sql (the end of the file): the audit ledger's append-only pattern this card mirrors, one function raising with ERRCODE '55000', a BEFORE UPDATE OR DELETE row trigger and a BEFORE TRUNCATE statement trigger.
- packages/db/test/postgres-organization-notes.test.ts: SHU-316's database test (how it makes organizations, principals and notes with random ids, and its UPDATE test).
- packages/db/test/postgres-authz-store.test.ts (its beforeEach, about line 107) and packages/db/test/postgres-reference-catalogue.test.ts (its beforeEach, line 18): both TRUNCATE organizations with CASCADE between tests. A TRUNCATE CASCADE fires the BEFORE TRUNCATE triggers of every table it reaches, including organization_notes, even when that table is empty, so both hooks would fail once this card's trigger exists. This is why SHU-316 added no DELETE or TRUNCATE trigger.
- packages/db/src/migrate.ts: migrations run in filename order, each in its own transaction.

Goal. Organization notes are append-only by contract (SHU-316: no route, store method or SQL edits or deletes one). The database should hold that line too, as it does for the audit ledger: no DELETE, no TRUNCATE and no cascaded delete from an organization removes a note. Organizations are soft-deleted under the lifecycle contract (slice O6, SHU-326), so refusing to hard-delete an organization that has notes costs nothing the product uses. Nothing in packages/ or apps/ deletes organizations today; only test cleanup does.

Design (decided; do not reopen):
- Migration 0198_organization_notes_refuse_delete.sql, in this order:
  - CREATE OR REPLACE FUNCTION organization_notes_no_update() RETURNS trigger, plpgsql, raising 'organization notes are append-only' USING ERRCODE = '55000' (the same message as today, so SHU-316's UPDATE test still matches /append-only/; the errcode is 0004's).
  - DROP TRIGGER organization_notes_no_update ON organization_notes; CREATE TRIGGER organization_notes_no_update BEFORE UPDATE OR DELETE ON organization_notes FOR EACH ROW EXECUTE FUNCTION organization_notes_no_update(). The name stays, so nothing else needs to know it changed.
  - CREATE TRIGGER organization_notes_no_truncate BEFORE TRUNCATE ON organization_notes FOR EACH STATEMENT EXECUTE FUNCTION organization_notes_no_update().
  - Nothing else. Keep the foreign key as it is: with the row trigger firing on DELETE, the cascade itself is refused, which is what this card wants; switching it to RESTRICT is not needed and would change 0194's table.
- Test isolation. In postgres-authz-store.test.ts's beforeEach, add "ALTER TABLE organization_notes DISABLE TRIGGER organization_notes_no_truncate" before the TRUNCATE and the matching ENABLE in the existing finally block, next to the audit trigger's pair. In postgres-reference-catalogue.test.ts's beforeEach, wrap its TRUNCATE the same way (disable, then TRUNCATE in try, enable in finally). Disabling a trigger is owner administration, as the existing comment in postgres-authz-store.test.ts says; production code never does it. Before you finish, grep every test under packages/ and apps/ for TRUNCATE and for DELETE FROM organizations. If a file outside your paths would now fail (a TRUNCATE that reaches organization_notes, or a DELETE of an organization that has notes), do not change it: stop and report BLOCKED naming the file and line.
- The new database test packages/db/test/postgres-organization-notes-append-only.test.ts runs against the real database and never truncates organizations itself. It makes its own organizations under a random operator id, as SHU-316's test does, and inserts its note rows directly with SQL (INSERT INTO organization_notes (org_id, author_principal_id, body, receipt_ref) with a synthetic 64-hex receipt_ref), so the noted organization has no grant row (grants reference organizations without a cascade and would refuse the organization delete for another reason, which would make test (3) pass for the wrong reason). Its tests, each named "SHU-323/AC-0N <name> " followed by a description:
  - (1) delete-refused: DELETE FROM organization_notes WHERE id = the note's id rejects with code "55000" and /append-only/, and the note is still there; also DELETE FROM organization_notes WHERE org_id = that organization rejects. It also reads pg_trigger for organization_notes_no_update and asserts (tgtype & 8) <> 0 (fires on DELETE) and (tgtype & 16) <> 0 (still fires on UPDATE).
  - (2) truncate-refused: on one client, BEGIN, then TRUNCATE organization_notes rejects with code "55000", then ROLLBACK; the same for TRUNCATE organizations CASCADE. Run each attempt inside BEGIN and ROLLBACK so that, if the trigger were missing, the rollback keeps the tables intact for the tests after it. It also asserts from pg_trigger that organization_notes_no_truncate exists with (tgtype & 32) <> 0.
  - (3) noted-organization-delete-refused: DELETE FROM organizations WHERE id = the noted organization rejects with /append-only/, and both the organization and its note remain; DELETE FROM organizations WHERE id = a second organization with no notes and no grants succeeds.
  - (4) update-still-refused: UPDATE organization_notes SET body = 'changed' rejects with code "55000", and the body is unchanged.

Pitfalls earlier reviewers blocked. Avoid each one:
- Copy no audit constraint text: this card does not touch authorization_mutation_audit, its constraints or authorization_audit_summary_valid. Later cards in this queue that do must copy them from the newest migration in the tree; 0198 must give them nothing to copy.
- Migration list: add "0198_organization_notes_refuse_delete" to both schema_migrations lists in postgres-authz-store.test.ts, immediately after the newest earlier entry (read the lists and the migrations directory on your branch; "0197_catalogue_bank_payment_details" when the third queue has landed). Nothing else in that file changes except the beforeEach pair above.
- No test may leave a trigger disabled: re-enable in finally, as the existing audit pair does.
- Other cards' anchors: this card changes no TypeScript source and no file any mutation script reads, so every mutation script's anchors stay as they are.

Acceptance. Each item is pinned by a named database test; CI runs them.
(1) Leave DELETE out of the row trigger: "SHU-323/AC-01 delete-refused" fails.
(2) Leave out the TRUNCATE trigger: "SHU-323/AC-02 truncate-refused" fails.
(3) Leave DELETE out of the row trigger: "SHU-323/AC-03 noted-organization-delete-refused" fails (the cascade deletes the note and the organization goes).
(4) "SHU-323/AC-04 update-still-refused" keeps SHU-316's UPDATE rule pinned under the recreated trigger.
In your final message, say for each of (1) to (3) why it fails against 0194's triggers alone. Use synthetic fixtures only.

Your paths, and what each may hold:
- packages/db/migrations/0198_organization_notes_refuse_delete.sql (new)
- packages/db/test/postgres-organization-notes-append-only.test.ts (new)
- packages/db/test/postgres-authz-store.test.ts: only "0198_organization_notes_refuse_delete" in both schema_migrations lists, and the organization_notes_no_truncate disable and enable pair in beforeEach
- packages/db/test/postgres-reference-catalogue.test.ts: only the disable, try and finally enable around its beforeEach TRUNCATE
- package.json: leave every existing script's text as it is. Append dist/packages/db/test/postgres-organization-notes-append-only.test.js at the END of the node --test --test-concurrency=1 list in test:db. Never change dependencies.

Out of scope: note types (SHU-324), any TypeScript change, any change to the notes store, routes or read model, organization deletion (SHU-326), changing the foreign key, notes on any other subject, any change to packages/safe-write-contract or packages/contracts, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-324 is slice O9b: each organization note records one type from the
// legacy note's closed list. The type rides in the safe-write field name, so
// the token, the receipt and the audit row carry it as closed vocabulary and
// never the note text, and SHU-316's untyped field "note" stays the Internal
// Note it has always been.
export const SHU324_PATHS = Object.freeze([
  "packages/organizations/src/organization-notes.ts",
  "packages/organizations/test/organization-note-types.test.ts",
  "packages/organizations/test/organization-note-types-mutations.mjs",
  "packages/organizations/test/organization-notes.test.ts",
  "packages/db/migrations/0199_organization_note_types.sql",
  "packages/db/src/postgres-organization-notes-store.ts",
  "packages/db/test/postgres-organization-note-types.test.ts",
  "packages/db/test/postgres-organization-notes.test.ts",
  "packages/db/test/postgres-authz-store.test.ts",
  "apps/gateway/src/organization-notes.ts",
  "apps/gateway/src/login-runtime.ts",
  "apps/gateway/test/organization-notes-http.test.ts",
  "apps/gateway/test/organization-note-types-http.test.ts",
  "package.json",
]);

const SHU324_ACCEPTANCE = [
  "(1) every organization note records exactly one type from the closed list internal_note, phone_call, email, meeting, interview and task, chosen when it is added through the existing safe-write path by its field: \"note\" adds an Internal Note (SHU-316's field, unchanged), and \"note_phone_call\", \"note_email\", \"note_meeting\", \"note_interview\" and \"note_task\" add the other five; one exported function maps a field to its type, the builder, the store's commit and the gateway use it, and mapping every field to internal_note makes the \"SHU-324/AC-01 field-names-type\" test fail;",
  "(2) a typed note's text obeys exactly SHU-316's rules (non-empty, no edge whitespace, at most 2000 characters, no control character other than tab, line feed and carriage return), checked at preview and at confirm by the same exported value check; letting a typed field skip the text rule makes the \"SHU-324/AC-02 typed-note-text-rejected\" test fail;",
  "(3) the list returns each note's type: the view carries exactly noteId, text, authorPrincipalId, createdAt and noteType, newest first as before, and never the organization id or the receipt reference; replacing the stored type with a constant in the view makes the \"SHU-324/AC-03 list-returns-type\" test fail;",
  "(4) a row with no type reads as internal_note, and every note that existed before migration 0199 is an Internal Note (the column's default); making a missing type fail or read as anything else makes the \"SHU-324/AC-04 untyped-reads-internal\" test fail;",
  "(5) a stored type outside the closed list is refused by the view (it throws) rather than shown; passing an unknown stored type through makes the \"SHU-324/AC-05 unknown-stored-type-refused\" test fail;",
  "(6) notes stay append-only and a note's type never changes (the existing UPDATE trigger refuses it, and no route, store method or SQL changes it); authorization is unchanged (a staff or admin grant covering the organization adds and lists, every other grant gets not_found); each typed add commits the note with its type and one audit row in one transaction under the existing operation organization.note.safe_write, whose receipt fields are the field name ([\"note_phone_call\"] and so on), so the type enters the audit only as that closed field name and never the note text; migration 0199 adds the note_type column (NOT NULL, default internal_note, CHECK in the closed list) and otherwise only widens the organization.note.safe_write branch of authorization_audit_summary_valid to the six field names, copied from the newest migration in the tree, still accepting every existing row and every operation earlier migrations added; \"0199_organization_note_types\" follows \"0198_organization_notes_refuse_delete\" in both schema_migrations lists;",
  "(7) packages/organizations/test/organization-note-types-mutations.mjs applies mutations (1) to (5), each makes its named test fail, the script passes on the unmutated code, and every existing mutation script's anchors, including SHU-316's five in organization-notes.js, still bind exactly once and still kill their tests;",
  "(8) npm run typecheck and npm test pass, the new tests run from package.json's test and test:db commands, the mutation script runs as its own npm script test:organization-note-types:mutations chained into test right after test:catalogue-bank-payment-details:mutations, and nothing outside the card's paths changes.",
].join(" ");

const SHU324_BRIEF = `Card SHU-324: organization notes carry a note type (slice O9b, the note-type half of OR-27).

You are working in the StudentHub platform monorepo at the bound head, which includes SHU-316 (migration 0194, organization notes), the third card queue (SHU-317 to SHU-320, migrations 0195 to 0197) and SHU-323 (migration 0198, notes refuse DELETE and TRUNCATE). Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Read first:
- docs/parity/organizations-stores-and-contacts.md: the note row in section 2.2 (note_type is one of Internal Note, Phone Call, Email, Meeting, Interview, Task), row OR-27 in section 7 and slice O9 in section 11.
- SHU-316's notes, which this card extends: packages/organizations/src/organization-notes.ts (ORGANIZATION_NOTE_FIELDS, ORGANIZATION_NOTE_POLICY, organizationNoteValue, organizationNoteDecision, organizationNotesView, buildOrganizationNoteWrite), packages/organizations/test/organization-notes.test.ts and organization-notes-mutations.mjs, packages/db/src/postgres-organization-notes-store.ts (forPrincipal, list, readReceipt, #commit), packages/db/migrations/0194_organization_notes.sql and SHU-323's 0198, packages/db/test/postgres-organization-notes.test.ts, apps/gateway/src/organization-notes.ts (request, createOrganizationNotes) and apps/gateway/test/organization-notes-http.test.ts, and the store's wiring in apps/gateway/src/login-runtime.ts.
- packages/safe-write-contract/src/safe-write.ts: the token's change-set digest covers the field and the value, so a type carried in the field name cannot be swapped between preview and confirm.
- The newest migration in packages/db/migrations on your branch that redefines authorization_audit_summary_valid (list the directory; it is 0197 or later once the third queue has landed, and 0198 does not redefine it): its text is the one you extend.

Goal. Staff and admins who add a note to an organization say what kind of note it is (an internal note, a phone call, an email, a meeting, an interview or a task), and the list shows each note's type. A note added the SHU-316 way, and every note that existed before, is an Internal Note. A note's type is chosen once and never changes, as its text never changes.

Contract mapping (decided; do not reopen):
- The type is the field. ORGANIZATION_NOTE_TYPES is ["internal_note", "phone_call", "email", "meeting", "interview", "task"]. The six fields are "note" (internal_note: SHU-316's field keeps its meaning) and "note_phone_call", "note_email", "note_meeting", "note_interview" and "note_task". There is no "note_internal_note": one field per type. ORGANIZATION_NOTE_FIELDS becomes those six fields, and ORGANIZATION_NOTE_POLICY allows them with maxValueLength 2000 as before.
- Why the field and not a second value: the safe-write change set is one field and one value, and its token digests both, so the type is bound to what the person previewed; a type sent beside the change would not be. The receipt's fields and the audit row's after_summary.fields carry the field name, a closed vocabulary, so the audit says which kind of note was added without the text.
- The HTTP body stays exactly orgId, field and value (plus token on confirm); field may be any of the six.

Design:
- packages/organizations/src/organization-notes.ts (keep SHU-316's anchors; see the pitfalls):
  - export ORGANIZATION_NOTE_TYPES and the OrganizationNoteType type, the six fields as above, and organizationNoteTypeOf(field: string): OrganizationNoteType | undefined (undefined for anything not one of the six fields). Write the map once, as a frozen object from field to type.
  - export organizationTypedNoteValue(field, value): true only when organizationNoteTypeOf(field) is not undefined and organizationNoteValue("note", value) is true. Leave organizationNoteValue's body exactly as it is, so SHU-316's control-character mutation still reaches every typed field through it. The builder's default check becomes organizationTypedNoteValue.
  - OrganizationNoteRow gains note_type?: string. Export organizationNoteTypeOfRow(value: string | undefined): OrganizationNoteType, returning "internal_note" when the value is undefined, the value when it is one of ORGANIZATION_NOTE_TYPES, and throwing a TypeError otherwise. organizationNotesView adds noteType: organizationNoteTypeOfRow(row.note_type) as the last key of each note, and keeps the rest of its object literal and its sort as they are.
- Migration 0199_organization_note_types.sql:
  - ALTER TABLE organization_notes ADD COLUMN note_type text NOT NULL DEFAULT 'internal_note' CONSTRAINT organization_notes_note_type_check CHECK (note_type IN ('internal_note','phone_call','email','meeting','interview','task')). Every existing row becomes internal_note; adding a column with a constant default fires no row trigger, so SHU-316's and SHU-323's triggers do not get in the way, and they keep refusing any later UPDATE, so a type never changes.
  - CREATE OR REPLACE FUNCTION authorization_audit_summary_valid copied from the newest migration that defines it, with one change only: the branch (audit_operation='organization.note.safe_write' AND summary->'fields'='["note"]'::jsonb) becomes (audit_operation='organization.note.safe_write' AND summary->'fields'->>0 IN ('note','note_phone_call','note_email','note_meeting','note_interview','note_task')). The existing jsonb_array_length(summary->'fields')=1 check keeps it to one field. No operation, cardinality, halves or index changes: the operation is still organization.note.safe_write and its token and receipt indexes already exist.
- packages/db/src/postgres-organization-notes-store.ts: the constructor gains a required option noteType: (field: string) => string | undefined (login-runtime.ts passes organizationNoteTypeOf; packages/db must not import packages/organizations). forPrincipal's readField returns null for any field. #commit replaces its "note"-only consistency check with: noteType(i.field) is not undefined and the receipt's fields are exactly [i.field], else a TypeError; it inserts note_type = noteType(i.field) with the note and writes after_summary.fields [i.field]. readReceipt accepts a receipt whose fields are one field that noteType knows. list also selects note_type. Nothing else in the store changes: the lock, the grants FOR SHARE, the decision, the token check, expectedBefore null and the 23505 handling stay as they are.
- apps/gateway/src/organization-notes.ts: request accepts a field that is one of ORGANIZATION_NOTE_FIELDS (imported from @studenthub/organizations) instead of exactly "note"; everything else stays.
- apps/gateway/src/login-runtime.ts: pass noteType: organizationNoteTypeOf to the existing PostgresOrganizationNotesStore. Nothing else.

Pitfalls earlier reviewers blocked. Avoid each one:
- SHU-316's anchors in dist/organization-notes.js must each still bind exactly once, and its mutation script must still pass: \`implementation.preview(r)\` (the builder's call; keep one preview call), \`(row.role === "staff" || row.role === "admin")\` (do not touch the decision), \`field === "note" && !/[\\x00-\\x08\\x0b\\x0c\\x0e-\\x1f\\x7f]/.test(value)\` (organizationNoteValue stays as it is; do not repeat the pattern in your typed check, call organizationNoteValue), the sort comparator \`new Date(b.created_at).getTime() - new Date(a.created_at).getTime() || Number(b.id) - Number(a.id)\`, and \`({ noteId: String(row.id),\` (add noteType at the end of that literal). Check by running node packages/organizations/test/organization-notes-mutations.mjs after npm run build.
- SHU-316's tests change only where the view gained a key: in packages/organizations/test/organization-notes.test.ts, the exact key list in "SHU-316/AC-05 list-view-whitelist" becomes ["noteId","text","authorPrincipalId","createdAt","noteType"]; in apps/gateway/test/organization-notes-http.test.ts, the expected list body gains noteType:"internal_note" (its fake rows carry no type). Change nothing else in either file.
- Mutations must hit the code production runs: the field map, the typed check and the view are in organization-notes.ts; the store gets the map through its constructor and the gateway applies the view on every list. Dependencies stay unchanged.
- Audit and receipts: the field name only, never the text. The Postgres test asserts JSON.stringify of a typed note's audit row contains neither the text nor the raw organization id, and that its after_summary.fields is ["note_phone_call"].
- Migration 0199: copy authorization_audit_summary_valid from the newest migration in the tree that defines it at build time (never 0194's or another older copy), so every branch the third queue added (pay_contract.create.safe_write and the rest) survives. Change only the note branch. Add "0199_organization_note_types" to both schema_migrations lists in postgres-authz-store.test.ts right after "0198_organization_notes_refuse_delete".
- Mutation script: copy packages/organizations/test/organization-notes-mutations.mjs, including its --test-name-pattern form (a "^" prefix and a trailing space, not "$") and the environment-variable import (SHU324_TEST_MODULE for organization-notes.js; the test file imports ../src/organization-notes.js and switches to that module when the variable is set). All five mutations target dist/organization-notes.js. Name each test "SHU-324/AC-0N <name> " followed by a description. Check by hand that each mutant really fails its named test and that the script passes on the unmutated code.
- Other cards' anchors: this card does not change organizations.ts, apps/gateway/src/index.ts or any other organizations source, so mutations.mjs, directory-mutations.mjs, the status, commercial-terms and approved-to-hire scripts and packages/observability/test/mutations.mjs stay bound.
- The Postgres test must exercise the store against the database (test:db), with random ids and no TRUNCATE of organizations (SHU-323's trigger refuses it): a staff add of each of the six fields stores the matching note_type, readable through list; its audit row has fields [field], the operation organization.note.safe_write and no text; a row inserted without note_type reads internal_note; an INSERT with note_type 'sms' is refused by the CHECK; an UPDATE of note_type is refused with /append-only/; a refused org-owner add of a typed note leaves no note; a typed receipt reads back through readReceipt.

Acceptance. Each item is pinned by a mutation in packages/organizations/test/organization-note-types-mutations.mjs that makes a named test fail.
(1) Map every field to internal_note in the field map: "SHU-324/AC-01 field-names-type" fails. It drives the real builder through an in-memory SafeWriteStore whose commit records organizationNoteTypeOf(field) with the text, adds one note of each field and expects the six types; it also expects invalid_value for the fields "note_sms" and "note_internal_note" at preview.
(2) Let a typed field skip the text rule (anchor: the call organizationNoteValue("note", value) in organizationTypedNoteValue, made true): "SHU-324/AC-02 typed-note-text-rejected" fails. It previews and confirms "note_phone_call" text with a NUL and with a bell character and gets invalid_value, and accepts a phone-call note with a line feed.
(3) Replace organizationNoteTypeOfRow(row.note_type) in the view with "internal_note": "SHU-324/AC-03 list-returns-type" fails. It views rows of several types and asserts each noteType, the exact key list and that neither the organization id nor the receipt reference appears.
(4) Make organizationNoteTypeOfRow throw (or return anything but internal_note) for undefined: "SHU-324/AC-04 untyped-reads-internal" fails.
(5) Let organizationNoteTypeOfRow return an unknown value as it is: "SHU-324/AC-05 unknown-stored-type-refused" fails. It expects the view of a row with note_type "sms" to throw.
The script prints "5/5 SHU-324 mutations killed". Use synthetic fixtures only.

Your paths, and what each may hold:
- packages/organizations/src/organization-notes.ts: the types, the field map, organizationNoteTypeOf, organizationTypedNoteValue, organizationNoteTypeOfRow, note_type on the row type, noteType in the view, the six fields in ORGANIZATION_NOTE_FIELDS, and the builder's default check
- packages/organizations/test/organization-note-types.test.ts (new)
- packages/organizations/test/organization-note-types-mutations.mjs (new)
- packages/organizations/test/organization-notes.test.ts: only the AC-05 exact key list
- packages/db/migrations/0199_organization_note_types.sql (new)
- packages/db/src/postgres-organization-notes-store.ts: only the noteType option and its uses above
- packages/db/test/postgres-organization-note-types.test.ts (new)
- packages/db/test/postgres-organization-notes.test.ts: only add noteType: organizationNoteTypeOf (imported from @studenthub/organizations alongside its existing imports) to the existing PostgresOrganizationNotesStore constructor call, which the required option would otherwise break
- packages/db/test/postgres-authz-store.test.ts: only add "0199_organization_note_types" after "0198_organization_notes_refuse_delete" in both schema_migrations lists
- apps/gateway/src/organization-notes.ts: only the request's field check
- apps/gateway/src/login-runtime.ts: only the noteType option
- apps/gateway/test/organization-notes-http.test.ts: only noteType in the expected list body
- apps/gateway/test/organization-note-types-http.test.ts (new; calls the real handler: a typed preview and confirm, an unknown field refused with invalid_request, and a list showing noteType)
- package.json: leave every existing script's text as it is. Append dist/packages/organizations/test/organization-note-types.test.js and dist/apps/gateway/test/organization-note-types-http.test.js at the END of the node --test list in test, and dist/packages/db/test/postgres-organization-note-types.test.js at the END of the node --test --test-concurrency=1 list in test:db; add a test:organization-note-types:mutations script that runs the mutation script, and add " && npm run test:organization-note-types:mutations" as its own step right after "npm run test:catalogue-bank-payment-details:mutations" in test (if that step is absent, right after "npm run test:organization-notes:mutations" and any pay-contract steps that follow it). Never change dependencies.

Out of scope: changing a note's type or text, deleting a note, notes on contacts, candidates or any other subject, filtering or paging the list by type, display labels or translations of the types (the API returns the codes), the follow-up CRM (OR-10), exports, any change to the notes decision, its operation name or its token and receipt indexes, the read model and directory in organizations.ts, any notification, any UI beyond what the routes need, any change to packages/safe-write-contract, packages/contracts or the login code, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-325 is slice O8c: the per-company brand list of OR-23 (legacy brand rows
// carry company_id). Catalogue brands stay the catalogue's; this card adds an
// organization's links to them. A link is a plain audited write, like a grant,
// not a safe write: there is no prior value to preview, and a repeated link is
// a no-op rather than a second change.
export const SHU325_PATHS = Object.freeze([
  "packages/organizations/src/organization-brands.ts",
  "packages/organizations/src/index.ts",
  "packages/organizations/test/organization-brands.test.ts",
  "packages/organizations/test/organization-brands-mutations.mjs",
  "packages/db/migrations/0200_organization_brands.sql",
  "packages/db/src/postgres-organization-brands-store.ts",
  "packages/db/src/index.ts",
  "packages/db/test/postgres-organization-brands.test.ts",
  "packages/db/test/postgres-authz-store.test.ts",
  "apps/gateway/src/organization-brands.ts",
  "apps/gateway/src/index.ts",
  "apps/gateway/src/login-runtime.ts",
  "apps/gateway/test/organization-brands-http.test.ts",
  "package.json",
]);

const SHU325_ACCEPTANCE = [
  "(1) only a staff or admin grant that covers the organization (on the organization itself, or a subtree grant on an ancestor such as the operator organization) may link a brand to it, unlink one or list its brands; an org-owner, recruiter, finance, candidate or any other grant gets not_found, never 403, for all three, before any brand or link is read; an operator organization itself is never a target; the decision is one exported function the Postgres store calls inside each write's transaction and before a list, and accepting any role there makes the \"SHU-325/AC-01 employer-refused\" test fail;",
  "(2) a brand belongs to at most one organization: linking an active catalogue brand already linked to another organization is refused with 409 brand_already_linked and changes nothing, through one exported link-outcome function the store calls on the link row it locked, backed by brand_id being the link table's primary key; letting that function relink a brand owned elsewhere makes the \"SHU-325/AC-02 owned-elsewhere-refused\" test fail; linking a brand already linked to the same organization answers 200 with changed false and writes nothing;",
  "(3) unlinking removes only the organization's own link: unlinking a brand that is not linked to the named organization (unlinked, or linked to another) answers 404 brand_link_not_found and changes nothing, through one exported unlink-outcome function the store calls; letting it remove another organization's link makes the \"SHU-325/AC-03 unlink-own-link-only\" test fail;",
  "(4) only an active catalogue item of type brand can be linked: an unknown id, a deleted brand or another catalogue type's item answers 404 brand_not_found (a malformed id 400 invalid_request); the list shows only the organization's brands that are still active in the catalogue, ordered by name then id, through one exported view function the gateway applies to the store's rows; keeping deleted brands in that view makes the \"SHU-325/AC-04 deleted-brand-hidden\" test fail;",
  "(5) the list view carries exactly brandId and name for each brand and never the organization id, the link time or who linked it; copying the stored row into the view makes the \"SHU-325/AC-05 list-view-whitelist\" test fail;",
  "(6) each link and unlink commits the link change and one audit row in one transaction, under the new operations organization.brand.link and organization.brand.unlink, with target_org_refs [organizationAuditRef(orgId)] and before and after summaries exactly { brandCount } (the organization's linked-brand count before and after), so no audit row carries a brand id, a brand name or a raw organization id; the catalogue's brand create, update and delete are unchanged; migration 0200 creates organization_brands and its trigger and otherwise only widens the audit constraints and authorization_audit_summary_valid, copied from the newest migration in the tree, still accepting every existing row and every operation earlier migrations added; \"0200_organization_brands\" follows \"0199_organization_note_types\" in both schema_migrations lists;",
  "(7) packages/organizations/test/organization-brands-mutations.mjs applies mutations (1) to (5), each makes its named test fail, the script passes on the unmutated code, and every existing mutation script's anchors still bind exactly once;",
  "(8) npm run typecheck and npm test pass, the new tests run from package.json's test and test:db commands, the mutation script runs as its own npm script test:organization-brands:mutations chained into test right after test:organization-note-types:mutations, and nothing outside the card's paths changes.",
].join(" ");

const SHU325_BRIEF = `Card SHU-325: staff and admin keep an organization's brand list (slice O8c, the per-company brand list of OR-23).

You are working in the StudentHub platform monorepo at the bound head, which includes SHU-316 (organization notes), the third card queue (SHU-317 to SHU-320, migrations 0195 to 0197), SHU-323 (0198) and SHU-324 (0199). Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Read first:
- docs/parity/organizations-stores-and-contacts.md: the brand row in section 2.2 (brand_uuid, company_id), section 4.3 (brands are hard-deleted in legacy with no dependency check), the Brand row in section 5 ("CRUD + per-company list" for staff) and the note under it (brands are scoped per company), row OR-23 in section 7 and slice O8 in section 11.
- The catalogue's brands, which this card links to and does not change: packages/reference-catalogue/src/types.ts and catalogue.ts (brand is a CatalogueType; items are uuid ids, active or soft-deleted; UUID_PATTERN), packages/db/migrations/0146_reference_catalogue.sql (catalogue_items) and packages/db/src/postgres-catalogue-store.ts, and apps/gateway/src/catalogue-http.ts (the brand routes stay as they are).
- The organization write this card copies for authorization, locking and HTTP: SHU-316's packages/organizations/src/organization-notes.ts (organizationNoteDecision, organizationNotesView), packages/db/src/postgres-organization-notes-store.ts (#grants, #ancestors, the advisory lock and FOR SHARE, list), apps/gateway/src/organization-notes.ts and its HTTP test, and the wiring in apps/gateway/src/login-runtime.ts and apps/gateway/src/index.ts.
- The direct audited write this card copies for the audit row: packages/db/src/postgres-pay-contract-store.ts (its INSERT INTO authorization_mutation_audit with requestAuditRef, principalAuditRef and organizationAuditRef) and packages/db/src/authorization-audit.ts.
- The newest migration in packages/db/migrations on your branch that redefines the audit constraints and authorization_audit_summary_valid (0199 once SHU-324 has landed): its text is the one you extend.

Goal. Staff or an admin covering an organization can attach catalogue brands to it, detach them and see its brands, as legacy staff could with a brand's company. A brand is one organization's at most. The catalogue still owns brands (their names, their creation and soft deletion); this card owns only which organization a brand belongs to. Every link and unlink leaves an audit row.

Contract choice (decided; do not reopen). A link is a direct audited write, as a grant is, not a safe write: there is no prior value to show in a preview, and the operations are idempotent in effect (linking an already-own brand is a no-op; unlinking needs the link). Each change writes one audit row in its own transaction under its own operation, and the summary is a closed count.

Design:
- packages/organizations/src/organization-brands.ts (new) exports:
  - OrganizationBrandGrantRow ({ org_id, role, scope }) and organizationBrandDecision(rows, orgId, ancestors, operators = DEFAULT_OPERATOR_ORG_IDS): true only when operators does not include orgId and a grant with role staff or admin is on orgId itself or is a subtree grant on one of its ancestors. Write it in this file (as SHU-315 and SHU-316 did), not imported, so its mutation hits only this card;
  - isOrganizationBrandId(value: unknown): a string matching the catalogue's UUID pattern;
  - organizationBrandLinkOutcome(currentOrgId: string | null, orgId: string): "link" when currentOrgId is null, "unchanged" when it equals orgId, "owned_elsewhere" otherwise;
  - organizationBrandUnlinkOutcome(currentOrgId: string | null, orgId: string): "unlink" only when currentOrgId equals orgId, else "not_linked";
  - OrganizationBrandRow ({ brand_id, name, status, and whatever else the store selects }) and organizationBrandsView(rows): drops rows whose status is not "active", orders by name (localeCompare) then brand id, and returns for each exactly { brandId, name }, built from named fields (never a spread of the row).
- Migration 0200_organization_brands.sql:
  - CREATE TABLE organization_brands (brand_id uuid PRIMARY KEY REFERENCES catalogue_items(id), org_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE, linked_by_ref char(64) NOT NULL CHECK (linked_by_ref ~ '^[0-9a-f]{64}$'), linked_at timestamptz NOT NULL DEFAULT clock_timestamp()) and an index on (org_id). The primary key is what makes a brand one organization's at most, including under a race.
  - A BEFORE INSERT OR UPDATE row trigger that raises unless the referenced catalogue_items row has catalogue_type 'brand' (as SHU-320's bank trigger does for banks).
  - The audit constraints, copied from the newest migration that defines them, with organization.brand.link and organization.brand.unlink added: to authorization_mutation_audit_operation_check; to the auth_audit_target_org_cardinality branch that requires cardinality(target_org_refs) = 1 (the branch pay_contract.create, pay_contract.update and pay_contract.remove are in); and to authorization_audit_summary_valid as a new branch accepting exactly a closed object { brandCount } whose value is a JSON number matching '^(0|[1-9][0-9]{0,17})$', as the pay_contract branch checks contractCount. They are not safe-write operations, so they go in neither auth_audit_safe_write_halves nor auth_audit_safe_write_self, and they need no token or receipt index. Drop nothing else.
- packages/db/src/postgres-organization-brands-store.ts (new), PostgresOrganizationBrandsStore. Its constructor takes the pool or connection string, decision ((rows, orgId, ancestors) => boolean), linkOutcome and unlinkOutcome (the shapes above). Export ORGANIZATION_BRAND_LINK_OPERATION and ORGANIZATION_BRAND_UNLINK_OPERATION. Methods:
  - link(principalId, orgId, brandId): BEGIN; pg_advisory_xact_lock(hashtextextended($1,325)) on orgId; the caller's grants FOR SHARE and the organization's ancestry; the decision (refused: { kind: "not_found" }); SELECT the catalogue item WHERE id = $1 AND catalogue_type = 'brand' AND status = 'active' FOR SHARE (none: { kind: "brand_not_found" }; FOR SHARE makes a concurrent catalogue soft delete wait); SELECT org_id FROM organization_brands WHERE brand_id = $1 FOR UPDATE; linkOutcome on that org_id or null ("unchanged": ROLLBACK and { kind: "unchanged" }; "owned_elsewhere": ROLLBACK and { kind: "owned_elsewhere" }); count the organization's links (brandCount before); INSERT the link with linked_by_ref principalAuditRef(principalId); INSERT the audit row (request_ref requestAuditRef of a fresh "organization_brand_" + randomUUID(), actor_principal_ref and target_principal_ref principalAuditRef(principalId), operation organization.brand.link, target_org_refs [organizationAuditRef(orgId)], before { brandCount: n }, after { brandCount: n + 1 }); COMMIT; { kind: "linked" }. A 23505 (another organization linked the same brand concurrently) rolls back and answers { kind: "owned_elsewhere" }.
  - unlink(principalId, orgId, brandId): the same lock, grants, ancestry and decision; the link row FOR UPDATE; unlinkOutcome ("not_linked": { kind: "link_not_found" }); count; DELETE the link; the audit row under organization.brand.unlink with before n and after n - 1; COMMIT; { kind: "unlinked" }. Unlinking does not require the brand to be active, so a link to a brand the catalogue has since deleted can still be removed.
  - list(principalId, orgId): grants, ancestry and the decision first (refused: null, before any link is read), then the organization's links joined to catalogue_items (brand_id, name, status), every row, for the view to filter.
  - There is no other write method, and nothing writes catalogue_items.
- HTTP (apps/gateway/src/organization-brands.ts, new): POST /organization/brands/link and POST /organization/brands/unlink take exactly orgId and brandId (a malformed body, an orgId outside the notes route's pattern or a brandId that is not isOrganizationBrandId answers 400 invalid_request); GET /organization/brands/{orgId} answers { brands } from organizationBrandsView, or 404 not_found when the store returns null. A link answers 200 { brandId, changed: true } or { brandId, changed: false }, 404 not_found or brand_not_found, or 409 brand_already_linked; an unlink answers 200 { brandId, changed: true }, 404 not_found or brand_link_not_found. Copy organization-notes.ts for the session cookie (401 without a session), the Origin and Sec-Fetch-Site checks on POST (403 origin_rejected), the content-type check, the no-store headers, the body limit (1024 bytes here) and the try/catch (an unexpected error answers 503 organization_brands_unavailable, as does a missing service). Export createOrganizationBrands(ports) and handleOrganizationBrands(req, res, service, origin).
- Live wiring: login-runtime.ts constructs PostgresOrganizationBrandsStore from DATABASE_URL with organizationBrandDecision, organizationBrandLinkOutcome and organizationBrandUnlinkOutcome, closes it with the others, and builds the service whether or not the safe-write key is set (these are not safe writes). Mount handleOrganizationBrands in apps/gateway/src/index.ts right after SHU-317's handlePayContracts route (if that route is absent, right after the organization-notes route).

Pitfalls earlier reviewers blocked. Avoid each one:
- Mutations must hit the code production runs: the decision and both outcome functions reach the store through its constructor, the gateway applies organizationBrandsView on every list, and packages/db must not import packages/organizations; dependencies stay unchanged. The grants query selects the caller's grant rows without filtering by role or organization, and the ancestry query reads the organization chain, so the decision is the injected function's, not the SQL's.
- Decide before reading: a refused caller is answered from grants and ancestry alone, so it cannot tell an unknown brand from a linked one. The HTTP test's fake store records calls and asserts a refused list reads no links.
- One transaction: the link change and its audit row commit or roll back together, on the client the method opened. An "unchanged" or refused link writes no audit row.
- Audit rows: { brandCount } only; the Postgres test asserts JSON.stringify of each audit row contains neither the brand id, the brand name nor the raw organization id.
- Migration 0200: copy the audit constraints and authorization_audit_summary_valid from the newest migration in the tree that defines them at build time (never 0194's or another older copy), so every operation and branch the earlier cards added survives, and add only what is listed above. Add "0200_organization_brands" to both schema_migrations lists in postgres-authz-store.test.ts right after "0199_organization_note_types".
- Mutation script: copy packages/organizations/test/organization-notes-mutations.mjs, including its --test-name-pattern form (a "^" prefix and a trailing space, not "$") and the environment-variable import (SHU325_TEST_MODULE for organization-brands.js). All five mutations target dist/organization-brands.js. Name each test "SHU-325/AC-0N <name> " followed by a description. Check by hand that each mutant really fails its named test and that the script passes on the unmutated code.
- Other cards' anchors: each mutation script counts its anchor in its own file, so \`row.role === "staff" || row.role === "admin"\` may appear in organization-brands.js, but do not change any other organizations source. packages/reference-catalogue/test/mutations.mjs and SHU-320's bank-payment-details-mutations.mjs anchor the catalogue's build: this card does not change packages/reference-catalogue or catalogue-http.ts. packages/observability/test/mutations.mjs anchors lines of apps/gateway/src/index.js (the response close, telemetry.record and inSpan lines): add one route line in index.ts and its import and touch none of those.
- Test data: random ids and no TRUNCATE of organizations (SHU-323's trigger refuses it on organization_notes); make catalogue brand items with SQL INSERT INTO catalogue_items as packages/db/test/postgres-pay-contracts.test.ts makes its currency.
- The Postgres test must exercise the store against the database (test:db): a staff link whose audit row has the new operation, the hashed organization reference and brandCount 0 then 1; an admin link through a subtree grant on the operator organization; the same brand linked to a second organization refused with owned_elsewhere and still the first organization's; a repeated link answering unchanged with no second audit row; a deleted brand, a currency item and an unknown id each brand_not_found; an INSERT INTO organization_brands naming a currency item refused by the trigger; an org-owner link, unlink and list refused; an unlink by the second organization's staff answering link_not_found and leaving the link; an unlink by the owner removing it with an organization.brand.unlink audit row; and a list that leaves out a brand the catalogue has soft-deleted.

Acceptance. Each item is pinned by a mutation in packages/organizations/test/organization-brands-mutations.mjs that makes a named test fail.
(1) Accept any role in organizationBrandDecision (anchor: \`row.role === "staff" || row.role === "admin"\` in organization-brands.js): "SHU-325/AC-01 employer-refused" fails. It drives an in-memory port that calls the decision, and checks org-owner, recruiter, finance and candidate grants on the organization, a self (not subtree) staff grant on the parent, and the operator organization as a target.
(2) Make organizationBrandLinkOutcome return "link" for a brand owned elsewhere: "SHU-325/AC-02 owned-elsewhere-refused" fails. It also expects "unchanged" for the same organization and "link" for no owner.
(3) Make organizationBrandUnlinkOutcome return "unlink" for any owner: "SHU-325/AC-03 unlink-own-link-only" fails. It expects "not_linked" for another organization's link and for no link.
(4) Keep deleted brands in organizationBrandsView: "SHU-325/AC-04 deleted-brand-hidden" fails. It also checks the order with two brands of the same name.
(5) Copy the stored row into the view (for example a spread of the row): "SHU-325/AC-05 list-view-whitelist" fails. It asserts the exact keys and that the organization id and the link time appear nowhere in JSON.stringify of the view.
The script prints "5/5 SHU-325 mutations killed". Use synthetic fixtures only.

Your paths, and what each may hold:
- packages/organizations/src/organization-brands.ts (new)
- packages/organizations/src/index.ts (exports only)
- packages/organizations/test/organization-brands.test.ts (new)
- packages/organizations/test/organization-brands-mutations.mjs (new)
- packages/db/migrations/0200_organization_brands.sql (new)
- packages/db/src/postgres-organization-brands-store.ts (new)
- packages/db/src/index.ts (exports only)
- packages/db/test/postgres-organization-brands.test.ts (new)
- packages/db/test/postgres-authz-store.test.ts: only add "0200_organization_brands" after "0199_organization_note_types" in both schema_migrations lists
- apps/gateway/src/organization-brands.ts (new)
- apps/gateway/src/index.ts (one route line after the pay-contracts route, and its import)
- apps/gateway/src/login-runtime.ts (wiring only)
- apps/gateway/test/organization-brands-http.test.ts (new; calls the real handler)
- package.json: leave every existing script's text as it is. Append dist/packages/organizations/test/organization-brands.test.js and dist/apps/gateway/test/organization-brands-http.test.js at the END of the node --test list in test, and dist/packages/db/test/postgres-organization-brands.test.js at the END of the node --test --test-concurrency=1 list in test:db; add a test:organization-brands:mutations script that runs the mutation script, and add " && npm run test:organization-brands:mutations" as its own step right after "npm run test:organization-note-types:mutations" in test. Never change dependencies.

Out of scope: stores, malls and store-brand association (O7), brand logos, creating, renaming or deleting brands (the catalogue's routes stay as they are), employer or candidate views of brands, a history of past links beyond the audit rows, moving a brand between organizations in one step (unlink, then link), anything in packages/reference-catalogue or catalogue-http.ts, the read model and directory in organizations.ts, any notification, any UI beyond what the routes need, any change to packages/safe-write-contract, packages/contracts or the login code, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-326 is slice O6a, the organization half of OR-11 (risk R3): an admin
// soft-deletes an organization through the safe-write contract, refused while
// live sub-organizations, live pay contracts or member grants remain. Store and
// transfer guards wait for their tables (O7, F2); member removal is O4. The
// guards run again inside the commit under a row lock on the organization,
// which every new grant, contract or sub-organization's foreign key waits on.
export const SHU326_PATHS = Object.freeze([
  "packages/organizations/src/deletion-writes.ts",
  "packages/organizations/src/organizations.ts",
  "packages/organizations/src/index.ts",
  "packages/organizations/test/deletion-writes.test.ts",
  "packages/organizations/test/deletion-writes-mutations.mjs",
  "packages/db/migrations/0201_organization_deletion.sql",
  "packages/db/src/postgres-organization-deletion-store.ts",
  "packages/db/src/index.ts",
  "packages/db/test/postgres-organization-deletion.test.ts",
  "packages/db/test/postgres-authz-store.test.ts",
  "apps/gateway/src/organization-deletion.ts",
  "apps/gateway/src/index.ts",
  "apps/gateway/src/login-runtime.ts",
  "apps/gateway/test/organization-deletion-http.test.ts",
  "package.json",
]);

const SHU326_ACCEPTANCE = [
  "(1) an organization is deleted only through preview, confirm and receipt on the existing safe-write contract, as the field \"deletion\" whose value is exactly \"deleted\" (preview before null); any other value is refused with invalid_value at preview and at confirm by an exported check the builder runs, and runSafeWriteConformance runs over the deletion write's own builder, so making that check accept anything makes the \"SHU-326/AC-01 conformance\" test fail;",
  "(2) only an admin grant that covers the organization (on the organization itself, or a subtree grant on an ancestor such as the operator organization) may delete it; staff, org-owner, recruiter, finance, candidate or any other grant gets not_found, never 403; an operator organization is never a target, so it can never be deleted; an unknown or already deleted organization is not_found; the decision is one exported function the Postgres store calls inside its commit transaction, and accepting staff there makes the \"SHU-326/AC-02 admin-only\" test fail;",
  "(3) the deletion is refused while the organization has a live sub-organization (a child organization with no deletion record), and the refusal names the blocker; dropping that guard from the exported blockers function makes the \"SHU-326/AC-03 live-sub-organizations-block\" test fail;",
  "(4) it is refused while the organization has a live pay contract (company_org_id the organization, status other than deleted); dropping that guard makes the \"SHU-326/AC-04 live-pay-contracts-block\" test fail;",
  "(5) it is refused while any grant row names the organization (any role, any scope; grants on its ancestors do not count); the guards are checked at preview, at confirm and again inside the commit transaction after the organization's row is locked FOR UPDATE, so a grant, contract or sub-organization added between preview and confirm makes the confirm answer state_changed and deletes nothing; dropping the grant guard makes the \"SHU-326/AC-05 member-grants-block\" test fail;",
  "(6) a deleted organization reads as not_found in OrganizationRepository.read and listSubOrganizations for every audience, and a deleted sub-organization is left out of its parent's list; ignoring the deletion record there makes the \"SHU-326/AC-06 deleted-reads-not-found\" test fail;",
  "(7) the staff and admin company directory leaves deleted organizations out and does not count deleted sub-organizations, reading deletion records with one call per list; ignoring them makes the \"SHU-326/AC-07 directory-hides-deleted\" test fail;",
  "(8) a deletion is a record, never a removal: the organization row, its notes, its brand links, its ended contracts and every other row stay, no code path issues DELETE FROM organizations, and organization_deletions refuses UPDATE and DELETE; each deletion commits the record and its receipt audit row in one transaction under the new operation organization.deletion.safe_write with organizationAuditRef (never a raw id) and fields [\"deletion\"]; a repeated or racing confirm of one token returns token_already_used; migration 0201 creates organization_deletions and its trigger and otherwise only widens the audit constraints and authorization_audit_summary_valid, copied from the newest migration in the tree, still accepting every existing row and every operation earlier migrations added; \"0201_organization_deletion\" follows \"0200_organization_brands\" in both schema_migrations lists;",
  "(9) packages/organizations/test/deletion-writes-mutations.mjs applies mutations (1) to (7), each makes its named test fail, the script passes on the unmutated code, and every existing mutation script, including mutations.mjs, directory-mutations.mjs, status-writes-mutations.mjs, status-batch-reads-mutations.mjs, commercial-terms-writes-mutations.mjs and approved-to-hire-writes-mutations.mjs, still binds each anchor exactly once and still passes;",
  "(10) npm run typecheck and npm test pass, the new tests run from package.json's test and test:db commands, the mutation script runs as its own npm script test:organization-deletion:mutations chained into test right after test:organization-brands:mutations, and nothing outside the card's paths changes.",
].join(" ");

const SHU326_BRIEF = `Card SHU-326: an admin soft-deletes an organization behind dependency guards (slice O6a, the organization half of OR-11; risk R3).

You are working in the StudentHub platform monorepo at the bound head, which includes SHU-316 (organization notes), the third card queue (SHU-317 to SHU-320, migrations 0195 to 0197, among them the pay-contract writes), SHU-323 (0198), SHU-324 (0199) and SHU-325 (0200, organization brands). Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Read first:
- docs/parity/organizations-stores-and-contacts.md: section 4.3 (legacy admin Delete refuses while stores, transfers or sub-companies exist, then soft-deletes), row OR-11 in section 7, finding OR-F4 in section 9 (no deletion produced an audit receipt) and slice O6 in section 11.
- SHU-305's status write and SHU-315's approved-to-hire write, the closest models (one field, safe write, a decision and an advisory lock): packages/organizations/src/status-writes.ts and approved-to-hire-writes.ts, their tests and mutation scripts, packages/db/src/postgres-organization-status-store.ts and postgres-organization-approved-to-hire-store.ts (forPrincipal, read, readMany, readReceipt, #grants, #ancestors, #commit), apps/gateway/src/organization-approved-to-hire.ts and its HTTP test, and their wiring in apps/gateway/src/login-runtime.ts and apps/gateway/src/index.ts.
- packages/organizations/src/organizations.ts: OrganizationRepository (#authorize, read, listSubOrganizations, listOrganizations), the optional ports statusRecords and approvedToHire and their record types (the shape your port copies), DEFAULT_OPERATOR_ORG_IDS and companyParentOf.
- The tables the guards read: packages/db/migrations/0001_create_authz_tables.sql (organizations.parent_org_id; grants.org_id references organizations with no cascade) and 0182_pay_contracts.sql (company_org_id, status active, inactive or deleted).
- The newest migration in packages/db/migrations on your branch that redefines the audit constraints and authorization_audit_summary_valid (0200 once SHU-325 has landed): its text is the one you extend.

Goal. An admin covering an organization can delete it, and the platform keeps every row: the deletion is a record that makes the organization read as not_found in the read model and the company directory. The admin previews the deletion, confirms it and gets a receipt, as with every other organization write. It is refused while the organization still has live sub-organizations, live pay contracts or any member grant, so a deletion never strands people, children or money. The operator organization can never be deleted.

Contract mapping (decided; do not reopen):
- The record is the organization: personRef is organizationDeletionRecordRef(orgId) (domain "organization-deletion-record"), the principal ref organizationDeletionPrincipalRef (domain "organization-deletion-principal"), sha256 refs in the "studenthub:<domain>:v1\\0" form organization-notes.ts uses.
- One field, "deletion", whose only valid value is "deleted"; the policy is { allowed: ["deletion"], maxValueLength: 7 }. readField returns null for an organization with no deletion record, so the preview shows before null and after "deleted", and the commit refuses with state_changed if expectedBefore is not null. A deleted organization is not the caller's record any more (ownedRecord returns null), so a second delete is not_found.
- Blockers are a closed list, in this order: "live_sub_organizations", "live_pay_contracts", "member_grants". Live sub-organizations are child organizations (parent_org_id the organization) with no deletion record; live pay contracts have company_org_id the organization and status other than deleted (active or inactive); member grants are grant rows whose org_id is the organization, of any role and scope. Store and transfer guards (legacy's other two) wait for their tables (O7, F2); say so in a comment, and do not invent them. Removing members is O4's audited grant revocation, not this card's.
- Why the safe-write contract cannot carry the blocker: its refusal reasons are a closed vocabulary. So the gateway asks the store for the blockers before calling the builder and answers 409 { error: "deletion_blocked", blockers } with the list; the builder and the commit refuse on their own as well (invalid_value at preview and confirm, state_changed in the commit), so a caller that skips the gateway's pre-check still cannot delete.

Design:
- packages/organizations/src/deletion-writes.ts (new) exports:
  - ORGANIZATION_DELETION_FIELDS (["deletion"]), ORGANIZATION_DELETION_POLICY, organizationDeletionRecordRef and organizationDeletionPrincipalRef;
  - organizationDeletionValue(field, value): field === "deletion" && value === "deleted";
  - OrganizationDeletionGrantRow ({ org_id, role, scope }) and organizationDeletionDecision(rows, orgId, ancestors, operators = DEFAULT_OPERATOR_ORG_IDS): true only when operators does not include orgId and a grant with role admin (anchor for mutation (2): \`row.role === "admin"\`) is on orgId itself or is a subtree grant on one of its ancestors. Write it in this file, not imported;
  - ORGANIZATION_DELETION_BLOCKERS, OrganizationDeletionCounts ({ liveSubOrganizations, livePayContracts, memberGrants }) and organizationDeletionBlockers(counts): the blockers whose count is above zero, in the fixed order, each tested on its own line (anchors for mutations (3) to (5): \`counts.liveSubOrganizations > 0\`, \`counts.livePayContracts > 0\` and \`counts.memberGrants > 0\`);
  - buildOrganizationDeletionWrite({ store, secret, policy?, clock?, tokenLifetimeMs?, check? }): wraps createSafeWrite as buildOrganizationApprovedToHireWrite does, awaiting the check (check?: (field, value) => boolean | Promise<boolean>, default organizationDeletionValue) at preview and at confirm and answering invalid_value when it is false;
  - organizationDeletionGuardedCheck(counts: (orgId) => Promise<OrganizationDeletionCounts>, orgId): a check that is true only when organizationDeletionValue(field, value) is true and organizationDeletionBlockers(await counts(orgId)) is empty; the gateway passes it as check. A counts function that throws makes the request fail, not answer invalid_value.
- packages/organizations/src/organizations.ts changes only in these ways:
  - export OrganizationDeletionRecords { isDeleted(orgId): Promise<boolean>; deletedAmong(orgIds: readonly string[]): Promise<ReadonlySet<string>> } and give OrganizationRepository an optional constructor port deletions of that type, kept in a private field;
  - in #authorize, immediately before its final \`return audience;\`, add one line that returns undefined when this.#deletions?.isDeleted(orgId) is true. read and listSubOrganizations both authorize through it, so a deleted organization is not_found for every audience and a deleted child is skipped in its parent's list;
  - in listOrganizations, after covered is built and before shown is built, read the deletion records of the covered ids with one deletedAmong call (only when there are covered ids and the port is set) and remove those ids from covered, so a deleted organization is neither shown nor counted as a sub-organization;
  - with no port, every existing organizations, directory, status, commercial-terms, approved-to-hire and status-batch test passes unchanged.
- Migration 0201_organization_deletion.sql:
  - CREATE TABLE organization_deletions (org_id text PRIMARY KEY REFERENCES organizations(id), receipt_ref text NOT NULL UNIQUE, deleted_at timestamptz NOT NULL DEFAULT clock_timestamp()). No ON DELETE clause: with a deletion record, a hard delete of the organization is refused by the foreign key. A BEFORE UPDATE OR DELETE row trigger raises (restoring is out of scope; the record is append-only, as SHU-323 made the notes).
  - The audit constraints and authorization_audit_summary_valid copied from the newest migration that defines them, with organization.deletion.safe_write added wherever organization.note.safe_write appears: the operation check, the target_org_refs cardinality > 0 branch, the safe-write halves check, and the safe-write branch of authorization_audit_summary_valid with fields equal to ["deletion"]. Unique indexes on its token and its receipt, as 0192 to 0194 add. Drop nothing else.
- packages/db/src/postgres-organization-deletion-store.ts (new), PostgresOrganizationDeletionStore, modelled on the approved-to-hire store. Constructor: the pool or connection string, decision ((rows, orgId, ancestors) => boolean), blockers ((counts) => readonly string[]), recordRef and principalRef. Export ORGANIZATION_DELETION_OPERATION. Methods:
  - forPrincipal(principalId, orgId): a SafeWriteStore whose ownedRecord answers the record only when the principal matches, the organization exists, has no deletion record and the decision allows; readField returns null for "deletion"; commit runs #commit when the principal and record match (otherwise not_own_record);
  - counts(orgId): the three counts, read without locks, for the builder's check;
  - blockers(principalId, orgId): the grants, ancestry and decision first (refused, unknown or deleted: null), then the injected blockers function over counts(orgId);
  - readReceipt(principalId, orgId, receiptRef), as the approved-to-hire store's, for the new operation and fields ["deletion"]; it keeps working after the deletion;
  - isDeleted(orgId) and deletedAmong(orgIds) (one query with = ANY), the read model's port;
  - #commit: BEGIN; pg_advisory_xact_lock(hashtextextended($1,326)) on the organization; SELECT id FROM organizations WHERE id = $1 FOR UPDATE (missing: not_own_record); a deletion record already present: not_own_record; the caller's grants FOR SHARE and the ancestry; the decision (not_own_record); the token reference in the audit table for organization.deletion.safe_write (token_already_used); expectedBefore must be null (state_changed); the counts read on this client after the row lock, and the injected blockers function (not empty: state_changed); INSERT the deletion record with the receipt's receiptRef; INSERT the receipt audit row (target_org_refs [organizationAuditRef(orgId)], before_summary { valuePresent: false }, after_summary the receipt shape with fields ["deletion"] and the tokenRef); COMMIT. 23505 becomes token_already_used.
- Why FOR UPDATE on the organization row: inserting a grant, a pay contract or a child organization checks its foreign key to organizations with FOR KEY SHARE on that row, which waits for this lock, and a transaction that inserted one first holds FOR KEY SHARE, which this lock waits for. So the guards read under the lock see every dependent that will ever be committed before the deletion, and none can be added between the guard and the commit.
- HTTP (apps/gateway/src/organization-deletion.ts, new): POST /organization/deletion/preview and /organization/deletion/confirm take exactly orgId, field ("deletion") and value (a string), plus token on confirm; GET /organization/deletion/{orgId}/receipts/{receiptRef} reads a receipt. Both POSTs first call store.blockers: null answers 404 not_found, a non-empty list 409 { error: "deletion_blocked", blockers }, and only an empty list goes on to the builder (built with check organizationDeletionGuardedCheck(store.counts, orgId)). Copy organization-approved-to-hire.ts for the session, Origin, content-type, headers, error mapping (state_changed and token errors 409) and the try/catch; body limit 8192 bytes. Export createOrganizationDeletion(ports) and handleOrganizationDeletion(req, res, service, origin). Mount it in index.ts right after SHU-325's handleOrganizationBrands route.
- Live wiring: login-runtime.ts constructs the store from DATABASE_URL next to the other organization stores with organizationDeletionDecision, organizationDeletionBlockers and the two refs, passes it to OrganizationRepository as deletions whether or not the safe-write key is set (so live reads hide deleted organizations), closes it with the others, and builds the deletion service only when the key is set.

Pitfalls earlier reviewers blocked. Avoid each one:
- Mutations must hit the code production runs: the value check, the decision and the blockers function are exported from deletion-writes.ts and reach the store through its constructor or the gateway; the read model's checks are in organizations.ts, which the gateway's repository runs; packages/db must not import packages/organizations; dependencies stay unchanged. The grants query selects the caller's grant rows without filtering by role or organization, the ancestry query reads the organization chain, and the counts query returns plain counts, so every decision is the injected function's, not the SQL's.
- Soft only: no DELETE FROM organizations, grants, notes, contracts or any other table anywhere in this card's code; the Postgres test asserts the organization row, its notes and its deleted pay contracts are still there after a deletion.
- Existing mutation suites must still pass, and organizations.ts is where they are at risk. Keep each of these exactly once in dist/organizations.js and change your code's shape, never their scripts:
  - mutations.mjs (SHU-159): \`"org-owner": "employer",\`, the parent-rate fallback line, \`const override = statusOverride(row);\`, \`if (override.state === "available")\`, \`if (parentOrgId !== null && children.length > 0)\`, the snapshot registry check, the #authorize resolution check \`if (resolution.kind !== "authorized" || resolution.context.orgId !== orgId\` with its continuation, and \`if (this.#operators.has(orgId))\` followed by \`return undefined;\`. Your #authorize line goes after these, before \`return audience;\`, and must not repeat them.
  - directory-mutations.mjs: \`.filter((context) => context.role === request.role && within.has(context.orgId)\`, \`child.parentOrgId === org.id && covered.has(child.id)\`, the listOrganizations resolution check, \`if (companyParentOf(organizations, org.id, this.#operators) !== null)\` with its continue, \`availableValue(entry.status) !== filters.status\`, the search normalization, \`subOrganizationCount,\` immediately followed by \`legalName:\`, \`entries.slice(start, start + ORGANIZATION_DIRECTORY_PAGE_SIZE)\` and \`const row = snapshotRow(await this.#source.readSnapshot(org.id), org.id, null);\`. Remove deleted ids from covered in a separate statement; do not edit those lines.
  - status-batch-reads-mutations.mjs: \`const batchRecords = shown.length > 0 && this.#statusRecords?.readMany\`, \`const batchRecords = visibleChildren.length > 0 && this.#statusRecords?.readMany\` and \`batchRecords.get(org.id) ?? { kind: "absent" }\`. Name your batch something that does not end in batchRecords (for example deletedIds).
  - status-writes-mutations.mjs: \`if (record?.kind === "status")\`; commercial-terms-writes-mutations.mjs: \`const names = ORGANIZATION_FIELDS_BY_AUDIENCE[audience];\` and \`if (own.kind === "value")\`; approved-to-hire-writes-mutations.mjs: \`if (name === "approvedToHire" && approvedRecord?.kind === "value")\` and the directoryEntry approvedToHire line. Do not name anything record, own or approvedRecord.
  - apps/gateway/test/company-directory-mutations.mjs and context-navigation-mutations.mjs anchor company-directory.js, context-navigation.js and web-ui.js: do not change them. packages/observability/test/mutations.mjs anchors lines of apps/gateway/src/index.js (the response close, telemetry.record and inSpan lines): add one route line in index.ts and its import and touch none of those.
  Run every one of those scripts after npm run build, not only yours.
- Migration 0201: copy the audit constraints and authorization_audit_summary_valid from the newest migration in the tree that defines them at build time (never 0194's or another older copy), so the operations and branches of every earlier card (the pay-contract safe writes, the note types, the brand links) survive. Add "0201_organization_deletion" to both schema_migrations lists in postgres-authz-store.test.ts right after "0200_organization_brands".
- Conformance: run runSafeWriteConformance over buildOrganizationDeletionWrite with a check that accepts the suite's values, as SHU-315's test does.
- Mutation script: copy packages/organizations/test/approved-to-hire-writes-mutations.mjs, including its --test-name-pattern form (a "^" prefix and a trailing space, not "$") and the environment-variable imports (SHU326_TEST_MODULE for deletion-writes.js, SHU326_ORG_MODULE for organizations.js). Mutations (1) to (5) target dist/deletion-writes.js and (6) and (7) dist/organizations.js. Name each test "SHU-326/AC-0N <name> " followed by a description. Check by hand that each mutant really fails its named test and that the script passes on the unmutated code.
- Test data: random ids and no TRUNCATE of organizations (SHU-323's trigger refuses it); make pay contracts with SQL INSERTs and a currency catalogue item as packages/db/test/postgres-pay-contracts.test.ts does.
- The Postgres test must exercise the store against the database (test:db): an admin, through a subtree grant on the operator organization, deletes a leaf organization with no dependents, after which the organization row is still there, isDeleted is true, the audit row has the new operation, the hashed organization reference and fields ["deletion"], the receipt reads back, and a second preview is not_own_record; a staff and an org-owner deletion refused; the operator organization refused; a parent with a live child blocked (live_sub_organizations), and allowed once the child is itself deleted; a live pay contract blocking (live_pay_contracts) while a deleted one does not; a member grant blocking (member_grants); a grant inserted between preview and confirm making the confirm answer state_changed with no deletion record; a duplicate confirm of one token; and an UPDATE or DELETE of an organization_deletions row, and a DELETE of a deleted organization, each refused.

Acceptance. Each item is pinned by a mutation in packages/organizations/test/deletion-writes-mutations.mjs that makes a named test fail.
(1) Make organizationDeletionValue accept any value: "SHU-326/AC-01 conformance" fails. It expects invalid_value for "yes", "Deleted" and the field "status", and runs the conformance suite.
(2) Accept staff in the decision (anchor: \`row.role === "admin"\`, made \`(row.role === "admin" || row.role === "staff")\`): "SHU-326/AC-02 admin-only" fails. It drives the real builder through an in-memory SafeWriteStore whose ownedRecord and commit call the decision, and checks staff, org-owner, recruiter and finance grants on the organization, a self (not subtree) admin grant on the parent, and the operator organization as a target.
(3) Drop \`counts.liveSubOrganizations > 0\` (made false): "SHU-326/AC-03 live-sub-organizations-block" fails.
(4) Drop \`counts.livePayContracts > 0\`: "SHU-326/AC-04 live-pay-contracts-block" fails.
(5) Drop \`counts.memberGrants > 0\`: "SHU-326/AC-05 member-grants-block" fails. It also previews with no dependents, adds a grant to the in-memory counts, confirms through a commit that calls organizationDeletionBlockers, and expects state_changed and no deletion.
(6) Remove the deletion check from #authorize: "SHU-326/AC-06 deleted-reads-not-found" fails. It reads a deleted organization as staff, admin and org-owner, lists a parent whose child is deleted, and lists a deleted parent's sub-organizations.
(7) Stop removing deleted ids from covered in listOrganizations: "SHU-326/AC-07 directory-hides-deleted" fails. It lists a directory with a deleted company and a live company whose one sub-organization is deleted (subOrganizationCount 0), and counts one deletedAmong call per list.
The script prints "7/7 SHU-326 mutations killed". Use synthetic fixtures only.

Your paths, and what each may hold:
- packages/organizations/src/deletion-writes.ts (new)
- packages/organizations/src/organizations.ts: only the OrganizationDeletionRecords port, its private field and constructor option, the #authorize line and the directory's deletedAmong read and covered removal
- packages/organizations/src/index.ts (exports only)
- packages/organizations/test/deletion-writes.test.ts (new)
- packages/organizations/test/deletion-writes-mutations.mjs (new)
- packages/db/migrations/0201_organization_deletion.sql (new)
- packages/db/src/postgres-organization-deletion-store.ts (new)
- packages/db/src/index.ts (exports only)
- packages/db/test/postgres-organization-deletion.test.ts (new)
- packages/db/test/postgres-authz-store.test.ts: only add "0201_organization_deletion" after "0200_organization_brands" in both schema_migrations lists
- apps/gateway/src/organization-deletion.ts (new)
- apps/gateway/src/index.ts (one route line after the organization-brands route, and its import)
- apps/gateway/src/login-runtime.ts (wiring only)
- apps/gateway/test/organization-deletion-http.test.ts (new; calls the real handler: 401, origin, 404 for a refused caller, 409 deletion_blocked with its blockers, a preview, confirm and receipt, and a stale confirm)
- package.json: leave every existing script's text as it is. Append dist/packages/organizations/test/deletion-writes.test.js and dist/apps/gateway/test/organization-deletion-http.test.js at the END of the node --test list in test, and dist/packages/db/test/postgres-organization-deletion.test.js at the END of the node --test --test-concurrency=1 list in test:db; add a test:organization-deletion:mutations script that runs the mutation script, and add " && npm run test:organization-deletion:mutations" as its own step right after "npm run test:organization-brands:mutations" in test. Never change dependencies.

Out of scope: restoring or purging a deleted organization, hard deletion of anything, deleting stores, contacts or memberships, removing members or revoking grants (O4), store and transfer guards (O7, F2: their tables do not exist), refusing later writes, grants or contracts that name a deleted organization (other routes do not consult deletion records yet; name this in your final message as a follow-up), hiding deleted organizations from workspace contexts or context navigation, the status-change email or any notification, any UI beyond what the routes need, any change to packages/safe-write-contract, packages/contracts or the login code, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-71: the first whole-tree card's builder stopped after six of its 45
// minutes with part of the brief done and returned FAILED, which ends a
// single-run episode. Both writer adapters say what each stage is for.
export const WRITER_FINISH_RULE = "Finish the whole brief before you return. Unfinished work is never a reason to return: keep working until every acceptance item holds. Take the time the work needs; your run allows far more than a first pass. Use BLOCKED only for an in-scope blocker you cannot resolve, and FAILED only for a run failure outside your work, such as a broken toolchain; never use either for work you have not finished yet. Lack of time is never a reason to return BLOCKED or FAILED: start by reading the files the brief names with your tools, and never return either before you have used your tools on the work; such an answer is recorded as no attempt.";

// SHU-327 to SHU-329 are the fifth committed card queue (SHU-312), the
// follow-up to SHU-326 agreed with the independent reviewer on its pull
// request. SHU-327 is slice O6b (risk R3): every organization-scoped write
// refuses a soft-deleted organization, at preview and again in its commit
// under a shared lock on the organization row. The commit check takes the row lock in
// its own statement, before it reads the deletion records, because a row lock
// that waits does not refresh a subquery's snapshot in the same statement.
export const SHU327_PATHS = Object.freeze([
  "packages/db/src/organization-liveness.ts",
  "packages/db/src/postgres-organization-status-store.ts",
  "packages/db/src/postgres-organization-commercial-terms-store.ts",
  "packages/db/src/postgres-organization-approved-to-hire-store.ts",
  "packages/db/src/postgres-organization-notes-store.ts",
  "packages/db/src/postgres-organization-brands-store.ts",
  "packages/db/src/postgres-pay-contract-safe-write-store.ts",
  "packages/db/src/postgres-organization-profile-store.ts",
  "packages/db/test/postgres-organization-deletion-guards.test.ts",
  "packages/db/test/organization-deletion-guards-mutations.mjs",
  "package.json",
]);

const SHU327_ACCEPTANCE = [
  "(1) a new module packages/db/src/organization-liveness.ts exports organizationLive(client, orgId, lock = false): it reads the organization row (with FOR SHARE when lock is true) in one statement, answers false when the row is missing, and only then reads organization_deletions in a second statement, answering false when a record exists; it is not exported from packages/db/src/index.ts;",
  "(2) each of the seven organization-scoped write stores (status, commercial terms, approved-to-hire, notes, brands, pay-contract creation and organization profile) refuses a deleted organization before any authorization decision is applied: the check that serves ownedRecord (or, for brands, link, unlink and list) calls organizationLive without the lock, so a preview, a link or an unlink of a deleted organization answers not_found exactly as an unknown organization does; each store has a named Postgres test \"SHU327_PG_<STORE>_PREVIEW\" that deletes the organization first and fails when that call is removed;",
  "(3) each of the six safe-write commits (status, commercial terms, approved-to-hire, notes, pay-contract creation and organization profile), right after its existing advisory lock and before its decision, calls organizationLive(client, orgId, true) and refuses with not_own_record when it is false, so nothing is written; brands' link and unlink get the same refusal through their locked authorization check inside the transaction; each store has a named Postgres race test \"SHU327_PG_<STORE>_RACE\" in which a deletion is held open in another transaction while the write reaches its commit, and the write is refused with nothing written once the deletion commits; removing the store's commit check makes its race test fail;",
  "(4) dropping FOR SHARE from organizationLive makes every race test fail, because the write then reads no deletion record, waits only on its foreign key and lands on the deleted organization;",
  "(5) reads that already hid a deleted organization are unchanged, live organizations behave exactly as before in every store, and the existing Postgres tests of all seven stores and of SHU-326 pass unchanged; pay-contract changes (SHU-318) are untouched;",
  "(6) packages/db/test/organization-deletion-guards-mutations.mjs applies one mutation for each check in (2) and (3) and for the lock in (4), each makes its named test fail by assertion, the script passes on the unmutated code, and bank-details-mutations.mjs and safe-write-mutations.mjs still bind each anchor exactly once and pass;",
  "(7) npm run typecheck and npm test pass, the new Postgres test and the new mutation script run from test:db, and nothing outside the card's paths changes.",
].join(" ");

const SHU327_BRIEF = `Card SHU-327: organization writes refuse a deleted organization (slice O6b, the follow-up to SHU-326; risk R3).

You are working in the StudentHub platform monorepo at the bound head, which includes SHU-326 (migration 0201, organization_deletions, soft delete) and every earlier organization card. Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Why. SHU-326 made a deleted organization read as not_found, but writes still authorize from grants and ancestry alone. An admin whose subtree grant sits above a deleted organization can still change its status, commercial terms or approved-to-hire flag, add notes, link or unlink brands, create a pay contract for it, and an owner can still edit its profile, by calling the endpoint directly.

Read first:
- packages/db/src/postgres-organization-deletion-store.ts: #allowed (the organization exists and has no deletion record), #commit (an advisory lock, then SELECT ... FOR UPDATE on the organization row, then the record) and isDeleted/deletedAmong.
- The seven stores in this card's paths, each one's #allowed (or, for the profile store, #ownsOrganization) and #commit; the brands store's link and unlink, which authorize inside their own transaction through #allowed(c, principalId, orgId, true); the pay-contract store's #commit, which calls the injected creator. Leave #commitChange (contract changes) alone.
- packages/db/test/postgres-organization-deletion.test.ts and each store's own Postgres test (postgres-organization-status, -commercial-terms, -approved-to-hire, -notes, -brands, -profile and postgres-pay-contract-safe-write): how each store is constructed, how fixtures are made with random ids, and how pay contracts need a currency catalogue item.
- packages/db/test/bank-details-mutations.mjs: the Postgres mutation script pattern this card copies.

Design:
- packages/db/src/organization-liveness.ts (new): export async function organizationLive(c: pg.Pool | pg.PoolClient, orgId: string, lock = false): Promise<boolean>. First statement: SELECT id FROM organizations WHERE id = $1, with " FOR SHARE" appended when lock is true; no row is false. Second, separate statement: SELECT 1 FROM organization_deletions WHERE org_id = $1; a row is false. Keep them two statements: in READ COMMITTED a row lock that waits does not give a NOT EXISTS subquery in the same statement a fresh snapshot, so one statement would miss a deletion that committed while it waited. Say this in a comment.
- In each store, the unlocked check: the method that answers ownedRecord (#allowed, or the profile store's #ownsOrganization) returns false at once when await organizationLive(c, orgId) is false, before reading grants. In the pay-contract store, #allowed also serves contract changes, which stay as they are: put the check in the create path's ownedRecord instead, before #allowed. In the brands store, #allowed passes its own lock argument through: organizationLive(c, orgId, lock), so link and unlink lock the row inside their transaction and list does not.
- In each safe-write #commit, as its own line right after the existing pg_advisory_xact_lock call: if (!await organizationLive(client, orgId, true)) throw new Refusal("not_own_record"); (use each store's own names for the client and the organization; in the pay-contract store the organization is company). Nothing is inserted and the creator is never called for a deleted organization.
- Why this is race-free: SHU-326's deletion commit locks the organization row FOR UPDATE before it inserts its record. A write that reaches its commit check first holds FOR SHARE until it commits, so the deletion waits for it; a write that arrives while a deletion holds the row waits, then reads the committed record in its second statement and refuses.
- Error mapping is unchanged: not_own_record already answers 404 not_found through each gateway route.

Tests:
- packages/db/test/postgres-organization-deletion-guards.test.ts (new), run in test:db. Fixtures: an operator organization, a company under it and an admin with a subtree admin grant on the operator organization (the profile store needs an org-owner grant on the company instead; insert it directly and delete the organization by inserting its organization_deletions row, since SHU-326's guard refuses a deletion while a grant names it). Delete an organization by INSERT INTO organization_deletions (org_id, receipt_ref) with a random 64-hex receipt_ref.
- For each store, "SHU327_PG_<STORE>_PREVIEW ..." (STORE one of STATUS, TERMS, APPROVED, NOTES, BRANDS, PAYCONTRACT, PROFILE): a write to a live company previews (or links) as before; after its deletion, the preview (or link and unlink) answers not_found and nothing is written.
- For each store, "SHU327_PG_<STORE>_RACE ...": preview the write while the company is live; on a second client, BEGIN, lock the company row FOR UPDATE and insert its deletion record, without committing; start the confirm (or the link) without awaiting it; poll pg_stat_activity, bounded to 10 seconds, until a backend other than the test's own waits with wait_event_type 'Lock', and fail by assertion if none does; then COMMIT the second client, await the write, and assert it was refused (not_own_record, or not_found for brands) and that no row was written (no status override, terms, approved-to-hire row, note, brand link, pay contract or profile row, and no audit row for its token).
- Name every test with its token first and a space after it, so the mutation script can select it with --test-name-pattern=^TOKEN followed by a space. Release every client and end every pool, even when a test fails.
- packages/db/test/organization-deletion-guards-mutations.mjs (new): copy bank-details-mutations.mjs (DATABASE_URL required, the unmutated suite first, each mutation rewrites a built file under packages/db/dist in place, the named test must fail by assertion, the original restored before the next and in a finally). Mutations: for each store, remove the unlocked check (its PREVIEW test fails) and remove the commit check (its RACE test fails; for brands, the one call serves both, so its single mutation must fail BRANDS_PREVIEW and its lock argument made false must fail BRANDS_RACE); and in organization-liveness.js, drop " FOR SHARE" (STATUS_RACE fails). Take each anchor from the built JavaScript, not the TypeScript (tsc reprints the code), and assert it binds exactly once.
- package.json: leave every existing script's text as it is, except append dist/packages/db/test/postgres-organization-deletion-guards.test.js at the END of the node --test --test-concurrency=1 list in test:db, and add " && node packages/db/test/organization-deletion-guards-mutations.mjs" right after "node packages/db/test/bank-details-mutations.mjs" in test:db. Never change dependencies.

Out of scope: /workspace and context navigation (SHU-328), restoring or purging a deleted organization, any migration, pay-contract changes (SHU-318; a deleted organization has no live contracts), grant writes (O4, not built), store and transfer guards (O7, F2), the read model and directory in organizations.ts, the deletion store and its routes, any in-memory store, any UI, any change to packages/safe-write-contract, packages/contracts or the login code, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-328 is slice O6c (risk R2): /workspace leaves deleted organizations out
// of its context list and refuses a deleted one as the active selection. An
// admin's subtree grant above a deleted organization still reaches it through
// listEffectiveContexts, because SHU-326 refuses a deletion only while a grant
// names the organization itself.
export const SHU328_PATHS = Object.freeze([
  "apps/gateway/src/context-navigation.ts",
  "apps/gateway/src/login-runtime.ts",
  "apps/gateway/test/context-navigation.test.ts",
  "apps/gateway/test/context-navigation-mutations.mjs",
]);

const SHU328_ACCEPTANCE = [
  "(1) when an organization is selected and it is deleted, /workspace answers 403 context_forbidden, exactly as for a selection the person holds no grant for; removing that refusal makes \"SHU328_NAV_ACTIVE\" fail;",
  "(2) the context list leaves deleted organizations out, reading deletion records with one deletedAmong call per request over the listed organizations and none when the list is empty; removing that filter makes \"SHU328_NAV_LIST\" fail;",
  "(3) both tests reach the deleted organization through a subtree grant on its parent, and a live sibling under the same grant stays listed and selectable;",
  "(4) with no deletions port, the navigation behaves exactly as before, and every existing navigation test passes unchanged; a deletions port that throws answers the existing 503 context_unavailable;",
  "(5) context-navigation-mutations.mjs gains the two mutants for (1) and (2), each makes its named test fail by assertion, its existing mutants still bind exactly once and pass, and the script passes on the unmutated code;",
  "(6) the live runtime passes the deletion store to the navigation; npm run typecheck and npm test pass; nothing outside the card's paths changes.",
].join(" ");

const SHU328_BRIEF = `Card SHU-328: workspace contexts leave out a deleted organization (slice O6c, a follow-up to SHU-326; risk R2).

You are working in the StudentHub platform monorepo at the bound head, which includes SHU-326 (soft delete: organization_deletions, OrganizationDeletionRecords and PostgresOrganizationDeletionStore). Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/.

Why. SHU-326 refuses a deletion while any grant names the organization itself, but listEffectiveContexts (packages/contracts/src/authz/context.ts) fans a subtree grant out to every descendant. So an admin whose subtree grant sits above a deleted organization still sees it in /workspace and can select it. Everything opened from there already reads as not found, but the list and the selection should not offer it.

Read first:
- apps/gateway/src/context-navigation.ts, apps/gateway/test/context-navigation.test.ts (how it builds sessions, an in-memory AuthzStore and subtree grants) and apps/gateway/test/context-navigation-mutations.mjs.
- OrganizationDeletionRecords in packages/organizations/src/organizations.ts (isDeleted and deletedAmong) and its export from @studenthub/organizations.
- apps/gateway/src/login-runtime.ts: where organizationDeletionStore is built and where createContextNavigation is called.

Design:
- createContextNavigation(sessions, store, organizationReader?, deletions?: OrganizationDeletionRecords), the type imported from @studenthub/organizations.
- When an organization is selected, after the existing organization lookup and before active is set: if the port is set and await deletions.isDeleted(org.id) is true, answer 403 context_forbidden.
- After the contexts list is built and before the existing check that the active selection is still in it: if the port is set and the list is not empty, call deletions.deletedAmong once with the listed organization ids (each id once) and remove those contexts.
- Errors from the port fall into the existing catch, which answers 503 context_unavailable.
- login-runtime.ts passes organizationDeletionStore as the fourth argument and changes nothing else.

Tests (apps/gateway/test/context-navigation.test.ts, with an in-memory deletions port that counts its calls):
- "SHU328_NAV_ACTIVE ...": a parent with two children and an admin subtree grant on the parent; one child deleted. Selecting the deleted child answers 403 context_forbidden; selecting the live child works as before.
- "SHU328_NAV_LIST ...": the same fixture lists the parent and the live child, not the deleted child, with exactly one deletedAmong call; with no grants at all, the list is empty and deletedAmong is not called.
- One more test: a port whose deletedAmong throws answers 503 context_unavailable.
- context-navigation-mutations.mjs: the "grants must be read again after revocation" mutant anchors the createContextNavigation signature line in the built file; update that one mutant's from and to for the new signature and change nothing else in it. Add two mutants in the same form: skip the isDeleted refusal (pattern SHU328_NAV_ACTIVE) and skip removing deleted contexts (pattern SHU328_NAV_LIST). Take each anchor from dist/apps/gateway/src/context-navigation.js, not the TypeScript, and check by hand that each mutant fails its test and that the script passes unmutated.

Out of scope: the write guards in the Postgres stores (SHU-327), the read model and directory, listEffectiveContexts and anything in packages/contracts, the deletion store and its routes, web-ui.ts and any HTML change, package.json, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-329 is slice O6d (risk R3), found by Sentry on the pull request that
// committed this queue: organization documents authorize through
// resolveActiveContext alone, so an org-owner whose subtree grant sits above a
// soft-deleted organization can still upload, replace, remove or copy its
// logo and licence. Candidate documents are a different scope and stay as
// they are.
export const SHU329_PATHS = Object.freeze([
  "packages/private-documents/src/index.ts",
  "packages/private-documents/test/organization-deletion-mutations.mjs",
  "apps/gateway/src/organization-documents-runtime.ts",
  "apps/gateway/test/organization-documents-http.test.ts",
  "package.json",
]);

const SHU329_ACCEPTANCE = [
  "(1) PrivateDocumentOptions gains an optional port organizationDeleted?: (orgId: string) => Promise<boolean>; when it is set and the scope is an organization's own (no personId), authorize answers denied for a deleted organization after the existing context check, so upload, metadata, copy (both the source and the target), replace, remove, issueDelivery and deliver all refuse it with the same denied an unauthorized caller gets; removing that check makes \"SHU329_DOCS_DELETED\" fail;",
  "(2) candidate-scoped documents (a personId in the scope) never consult the port, and with no port every operation behaves exactly as before; every existing private-documents, hardening, candidate-lifecycle and organization-documents test passes unchanged; a port that throws answers unavailable, never ok;",
  "(3) the live runtime wires the port: createRuntimeOrganizationDocumentsFromEnv builds a PostgresOrganizationDeletionStore from DATABASE_URL (with organizationDeletionDecision, organizationDeletionBlockers and the two refs from @studenthub/organizations), passes organizationDeleted: (orgId) => deletions.isDeleted(orgId) to createOrganizationDocuments, and closes the store with the others;",
  "(4) a new script packages/private-documents/test/organization-deletion-mutations.mjs applies the mutation for (1), which makes SHU329_DOCS_DELETED fail by assertion, the script passes on the unmutated code and restores the built file, and every existing private-documents and organization-documents mutation script still binds each anchor exactly once and passes;",
  "(5) npm run typecheck and npm test pass, the new script runs from npm test right after npm run test:documents:hardening:mutations, and nothing outside the card's paths changes.",
].join(" ");

const SHU329_BRIEF = `Card SHU-329: organization documents refuse a deleted organization (slice O6d, a follow-up to SHU-326; risk R3).

You are working in the StudentHub platform monorepo at the bound head, which includes SHU-326 (soft delete: organization_deletions and PostgresOrganizationDeletionStore). Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/.

Why. PrivateDocuments.authorize checks only resolveActiveContext for the org-owner role. SHU-326 refuses a deletion while a grant names the organization itself, but a subtree org-owner grant on an ancestor still reaches a deleted child, so its owner can still change the deleted organization's logo, licence and other documents. Everything else about a deleted organization already reads as not found.

Read first:
- packages/private-documents/src/index.ts: PrivateDocumentOptions, run, authorize, find, and every public operation (upload, metadata, copy, replace, remove, issueDelivery, deliver). copy authorizes both the source document's scope and the target scope.
- apps/gateway/test/organization-documents-http.test.ts: how it builds an InMemoryAuthzStore, org-owner grants and the service through createOrganizationDocuments; tests are named with a token first and a space.
- packages/private-documents/test/hardening-mutations.mjs: the mutation pattern the new script copies (anchored on dist/packages/private-documents/src/index.js).
- apps/gateway/src/organization-documents-runtime.ts: createOrganizationDocuments and createRuntimeOrganizationDocumentsFromEnv.
- packages/db/src/postgres-organization-deletion-store.ts (isDeleted) and its constructor options; organizationDeletionDecision, organizationDeletionBlockers, organizationDeletionRecordRef and organizationDeletionPrincipalRef in @studenthub/organizations, and how apps/gateway/src/login-runtime.ts constructs the store.

Design:
- PrivateDocumentOptions gains organizationDeleted?: (orgId: string) => Promise<boolean>, with a one-line doc comment.
- In authorize, after the existing resolveActiveContext check and the existing personId check, and only when scope.personId is undefined and the port is set: if await this.options.organizationDeleted(scope.orgId) is true, fail('denied'). Keep it one statement so its mutation is a single anchor. A thrown error from the port reaches run's catch and becomes unavailable.
- createOrganizationDocuments takes an optional organizationDeleted in its ports and passes it through. createRuntimeOrganizationDocumentsFromEnv constructs the deletion store as login-runtime.ts does, pushes its close onto closers, and passes organizationDeleted: (orgId) => deletions.isDeleted(orgId).
- Nothing else changes: no change to the store format, to delivery signing or to candidate documents.

Tests (apps/gateway/test/organization-documents-http.test.ts, through createOrganizationDocuments with an in-memory port backed by a Set):
- "SHU329_DOCS_DELETED ...": an org-owner with a subtree grant on a parent uploads a document for a child organization; after the child is marked deleted, upload, metadata, copy (to it and from it), replace, remove, issueDelivery and deliver each answer denied, and the stored state is unchanged; the live parent's documents still work.
- "SHU329_DOCS_PORT ...": a port that throws makes the operation answer unavailable; with no port at all, the earlier behaviour holds.
- packages/private-documents/test/organization-deletion-mutations.mjs (new): copy hardening-mutations.mjs's form, but run the built gateway test dist/apps/gateway/test/organization-documents-http.test.js with --test-name-pattern=^SHU329_DOCS_DELETED followed by a space. One mutation replaces the deletion check in dist/packages/private-documents/src/index.js with a no-op; restore the file in a finally. Take the anchor from the built JavaScript and check by hand that it fails the test and that the script passes unmutated.
- package.json: add a test:documents:deletion:mutations script that runs it, chained into test as " && npm run test:documents:deletion:mutations" right after "npm run test:documents:hardening:mutations"; change no other script text and no dependency.

Out of scope: the Postgres write guards (SHU-327), /workspace (SHU-328), purging or moving stored documents, candidate documents, organization-documents-http.ts and its routes, packages/db, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-164 and SHU-168 are the sixth committed card queue (SHU-312). SHU-164 is
// slice O6e (risk R3), the store half of O6 now that SHU-165 (O7a, migration
// 0202) gave organizations their stores: an organization with a live store
// cannot be deleted, and a store write refuses a deleted organization under the
// same race-free check SHU-327 gave every other organization write. SHU-165's
// stores store checks liveness and takes its row lock in one statement, the
// pattern SHU-327 replaced, so a store created while a deletion holds the row
// can still land on the deleted organization. Restoring within a grace period,
// the assignment and transfer guards (their tables do not exist) and the
// audited member-removal route (O4) remain on the card.
export const SHU164_PATHS = Object.freeze([
  "packages/organizations/src/deletion-writes.ts",
  "packages/organizations/test/deletion-writes.test.ts",
  "packages/organizations/test/deletion-writes-mutations.mjs",
  "packages/db/src/postgres-organization-deletion-store.ts",
  "packages/db/src/postgres-organization-stores-store.ts",
  "packages/db/test/postgres-organization-deletion.test.ts",
  "packages/db/test/postgres-organization-deletion-guards.test.ts",
  "packages/db/test/organization-deletion-guards-mutations.mjs",
  "apps/gateway/test/organization-deletion-http.test.ts",
]);

const SHU164_ACCEPTANCE = [
  "(1) OrganizationDeletionCounts (and the db store's DeletionCounts) gain liveStores, the organization's organization_stores rows with status 'active', read in the same counts statement as the other three; ORGANIZATION_DELETION_BLOCKERS becomes [\"live_sub_organizations\", \"live_pay_contracts\", \"member_grants\", \"live_stores\"] and organizationDeletionBlockers adds \"live_stores\" last, tested on its own line as counts.liveStores > 0; making that test false makes \"SHU164_STORES_BLOCK\" fail;",
  "(2) on Postgres, an organization with an active store is blocked with exactly [\"live_stores\"], a removed (status 'deleted') store does not block, and a store created between preview and confirm makes the confirm answer state_changed with no deletion record (\"SHU164_PG_STORES_BLOCK\");",
  "(3) PostgresOrganizationStoresStore's #allowed checks the organization with organizationLive(c, orgId, lock) from ./organization-liveness.js instead of its single-statement check, so create, update, remove and list of a deleted organization answer not_found (list null) as an unknown one does; removing that check makes \"SHU164_PG_STORES_PREVIEW\" fail;",
  "(4) a store create that reaches its check while a deletion holds the organization row waits on the row, then reads the committed deletion record and answers not_found with no organization_stores row and no store audit row written; passing false instead of lock makes \"SHU164_PG_STORES_RACE\" fail;",
  "(5) deletion-writes-mutations.mjs and organization-deletion-guards-mutations.mjs gain the mutants for (1), (3) and (4), each makes its named test fail by assertion, every existing mutant still binds exactly once and is still killed, and both scripts pass on the unmutated code;",
  "(6) every existing deletion, deletion-guard, organization-stores and gateway deletion test passes, changed only where the brief says; npm run typecheck and npm test pass; nothing outside the card's paths changes.",
].join(" ");

const SHU164_BRIEF = `Card SHU-164: an organization with live stores cannot be deleted, and store writes refuse a deleted organization (slice O6e of O6, after SHU-326, SHU-327 and SHU-165; risk R3).

You are working in the StudentHub platform monorepo at the bound head, which includes SHU-326 (migration 0201, organization_deletions and the deletion store), SHU-327 (organization-liveness.ts and the deletion write guards) and SHU-165 (migration 0202, organization_stores and its store). Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Why. Legacy refuses to delete a company that still has stores (docs/parity/organizations-stores-and-contacts.md section 4.3). SHU-326 could not guard stores because their table did not exist; SHU-165 has since added organization_stores, so today an admin can delete an organization that still has active stores and strand them. Separately, PostgresOrganizationStoresStore.#allowed checks "the organization exists and has no deletion record" in one statement with FOR SHARE OF o. Under READ COMMITTED a row lock that waits does not refresh the NOT EXISTS subquery's snapshot, so a store create that waits behind a deletion still sees no deletion record and inserts a store on the deleted organization. SHU-327 fixed exactly this for the other organization writes with organizationLive.

Read first:
- packages/organizations/src/deletion-writes.ts: ORGANIZATION_DELETION_BLOCKERS, OrganizationDeletionCounts, organizationDeletionBlockers (and its comment that store and transfer guards wait for their tables) and organizationDeletionGuardedCheck.
- packages/db/src/postgres-organization-deletion-store.ts: DeletionCounts, counts(org, c) (one SELECT of three subqueries) and #commit, which reads the counts on its own client after SELECT ... FOR UPDATE on the organization row.
- packages/db/src/postgres-organization-stores-store.ts: #allowed (the single statement to replace), #transaction (advisory lock 165 first), create, update, remove and list.
- packages/db/src/organization-liveness.ts and its comment, and packages/db/migrations/0202_organization_stores.sql (status 'active' or 'deleted', created_by_ref and updated_by_ref 64 hex, removal is an UPDATE).
- packages/organizations/test/deletion-writes.test.ts and deletion-writes-mutations.mjs; packages/db/test/postgres-organization-deletion.test.ts; packages/db/test/postgres-organization-deletion-guards.test.ts (its org() fixture and the SHU327_PG_BRANDS_RACE test, the closest model) and organization-deletion-guards-mutations.mjs; packages/db/test/postgres-organization-stores.test.ts (how the stores store is constructed with organizationStoreWriteDecision and organizationStoreReadDecision); apps/gateway/test/organization-deletion-http.test.ts (its two counts stubs).

Design:
- deletion-writes.ts: add liveStores to OrganizationDeletionCounts; append "live_stores" to ORGANIZATION_DELETION_BLOCKERS; in organizationDeletionBlockers add, after the member-grants line, its own line if (counts.liveStores > 0) result.push("live_stores"). Replace the comment's "Store and transfer dependency guards wait for their platform tables (O7 and F2)" with one saying only the transfer guard waits (F2). Keep the three existing tests (counts.liveSubOrganizations > 0, counts.livePayContracts > 0, counts.memberGrants > 0) exactly as they are: they are mutation anchors. The file is written on few long lines; keep its style and change only these places.
- postgres-organization-deletion-store.ts: add liveStores to DeletionCounts and a fourth subquery to the counts statement, (SELECT count(*) FROM organization_stores s WHERE s.org_id=$1 AND s.status='active') live_stores, mapped to liveStores. #commit already reads counts on its locked client and refuses with state_changed when any blocker is present; change nothing else there. Why this is race-free: a store insert checks its foreign key to organizations with FOR KEY SHARE and the stores store will hold FOR SHARE (below), both of which conflict with the deletion's FOR UPDATE; so a store committed before the deletion's lock is counted, and one that arrives after waits and is refused.
- postgres-organization-stores-store.ts: import organizationLive from "./organization-liveness.js" and replace the first two lines of #allowed's body (the live query and its "if (!live.rows.length) return false;") with one line: if (!await organizationLive(c, orgId, lock)) return false; keep the comment above it. Grants and ancestry are read after it, as now. Nothing else in the file changes.
- No migration, no gateway source change: the gateway's 409 deletion_blocked already returns whatever list the store's blockers give.

Tests (name every new test with its token first and a space after it):
- packages/organizations/test/deletion-writes.test.ts: add liveStores: 0 to the fixture's counts object and to the blockers literal in the SHU-326/AC-03 to AC-05 loop, and add "SHU164_STORES_BLOCK ...": organizationDeletionBlockers({ ...zeros, liveStores: 1 }) is ["live_stores"], all four set give the four blockers in order, and through the fixture a preview with no dependents followed by set("liveStores") makes the confirm answer state_changed. Do not rename or reorder the existing tests.
- packages/db/test/postgres-organization-deletion.test.ts: "SHU164_PG_STORES_BLOCK ...": insert an active store row directly (INSERT INTO organization_stores(id,org_id,name,created_by_ref,updated_by_ref) with a random uuid and "a".repeat(64)) for a fresh org: store.blockers(admin, org) is ["live_stores"]; UPDATE it to status='deleted', deleted_at=clock_timestamp(): blockers is [] and the deletion succeeds; for a second org, preview the deletion, then insert an active store, then confirm: state_changed and no organization_deletions row.
- packages/db/test/postgres-organization-deletion-guards.test.ts: construct new PostgresOrganizationStoresStore({ pool, writeDecision: organizationStoreWriteDecision, readDecision: organizationStoreReadDecision }) (the org() actor's subtree admin grant on root allows it). "SHU164_PG_STORES_PREVIEW ...": a store created on the live company lists; after deleted(company), list answers null and create, update and remove answer { kind: "not_found" }, with the earlier store row unchanged. "SHU164_PG_STORES_RACE ...": copy SHU327_PG_BRANDS_RACE: a second client BEGINs, locks the company row FOR UPDATE and inserts its deletion record; start store.create without awaiting; poll pg_stat_activity (bounded, as that test does) until another backend waits on a Lock in a query starting 'SELECT id FROM organizations', and fail by assertion if none does; COMMIT; the create answers { kind: "not_found" } and the company has no organization_stores row and no organization.store.create audit row. Release every client, even when the test fails.
- packages/db/test/organization-deletion-guards-mutations.mjs: its run() selects ^SHU327_PG_<pattern> followed by a space. Change it to take the whole token: write each existing entry's pattern as "SHU327_PG_<pattern>" (the assert.match too), change nothing else in those entries, and add a stores file entry (dist/postgres-organization-stores-store.js) with two mutants: "if (!await organizationLive(c, orgId, lock))" made "if (false)" (SHU164_PG_STORES_PREVIEW) and "organizationLive(c, orgId, lock)" made "organizationLive(c, orgId, false)" (SHU164_PG_STORES_RACE). Restore the stores file in the same finally as the others.
- packages/organizations/test/deletion-writes-mutations.mjs: add ["stores","SHU164_STORES_BLOCK","counts.liveStores > 0","false"] (it targets dist/deletion-writes.js like the other blocker mutants) and make the final line print "10/10".
- apps/gateway/test/organization-deletion-http.test.ts: add liveStores: 0 to its two counts stubs; change nothing else.
- Take every anchor from the built JavaScript after npm run build, not the TypeScript, assert each binds exactly once, and check by hand that each new mutant fails its named test.

Out of scope: restoring a deleted organization within a grace period (organization_deletions is append-only by migration 0201; that needs its own decision and migration), the assignment and transfer guards (their tables do not exist), deleting a store while candidates are assigned, member removal and grant revocation routes (O4), any migration, the read model, directory and organizations.ts, the deletion store's other methods, the gateway sources, package.json (every touched test and script already runs from test or test:db), the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-168 is slice O10a (risk R2): the company directory shows each company's
// active store count, computed from organization_stores at read time with one
// query per page and only for the companies the caller's grants cover. Nothing
// stores a counter, so there is nothing to reconcile. Active-candidate and
// open-request counts wait for the assignment and request tables (SHU-126).
export const SHU168_PATHS = Object.freeze([
  "packages/organizations/src/types.ts",
  "packages/organizations/src/organizations.ts",
  "packages/organizations/test/organization-directory.test.ts",
  "packages/organizations/test/directory-mutations.mjs",
  "packages/db/src/postgres-organization-stores-store.ts",
  "packages/db/test/postgres-organization-stores.test.ts",
  "apps/gateway/src/login-runtime.ts",
  "apps/gateway/src/web-ui.ts",
  "apps/gateway/test/company-directory.test.ts",
]);

const SHU168_ACCEPTANCE = [
  "(1) OrganizationDirectoryEntry gains storeCount: number | null, the company's own organization_stores rows with status 'active', read through a new optional OrganizationRepository port storeCounts (OrganizationStoreCounts, countMany(orgIds) => Promise<ReadonlyMap<string, number>>) on every listOrganizations call, so a store created or removed shows in the next list; a company the map omits counts 0, and with no port storeCount is null; skipping the port's value makes \"SHU168_STORE_COUNT\" fail;",
  "(2) the count is grant-scoped: countMany is called once per list with exactly the ids of the covered top-level companies (each once), never with an uncovered, deleted or sub-organization id, and not at all when no company is shown; passing the registry's organizations instead makes \"SHU168_STORE_COUNT_SCOPE\" fail;",
  "(3) PostgresOrganizationStoresStore.countMany(orgIds) answers from one GROUP BY query over active rows with = ANY, runs no query for an empty list, and reflects a create and a removal immediately (\"SHU168_PG_STORE_COUNTS\");",
  "(4) no column, table, cache or job stores a store count, so no reconciliation exists or is needed; the audit rows' storeCount stays an audit summary and is never read back as a count;",
  "(5) the live runtime passes the stores store as storeCounts; the staff and admin company page shows a Stores column with the count, or the existing Unavailable marker when it is null (\"SHU168_PAGE\"); the JSON list carries storeCount;",
  "(6) directory-mutations.mjs gains the two mutants for (1) and (2), each makes its named test fail by assertion, its existing mutants and every other organizations.js and web-ui.js mutation script still bind each anchor exactly once and pass; the existing directory tests pass with storeCount added to ENTRY_KEYS and nothing else changed; npm run typecheck and npm test pass; nothing outside the card's paths changes.",
].join(" ");

const SHU168_BRIEF = `Card SHU-168: the company directory counts each company's stores at read time (slice O10a of O10, after SHU-165; risk R2).

You are working in the StudentHub platform monorepo at the bound head, which includes SHU-163 (the staff and admin company directory), SHU-326 (deleted organizations leave the directory) and SHU-165 (migration 0202, organization_stores and PostgresOrganizationStoresStore). Dependencies are installed. There is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Why. Legacy kept denormalised counters (total_candidate, store_total_candidates, no_of_active_requests) that a cron rewrote and that drift (docs/parity/organizations-stores-and-contacts.md section 10, the SHU-39 row on denormalised counters, slice O10 in section 11 and section 13). The platform stores no counter today: subOrganizationCount is already computed from the registry per request. Of the counts the card names, only stores now have a source table, so this slice adds the store count the same way, computed at read time and scoped by the caller's grants. Active-candidate and open-request counts wait for their tables.

Read first:
- packages/organizations/src/organizations.ts: listOrganizations (covered, deletedIds, shown, batchRecords, approvedBatch, children) and directoryEntry; the optional ports in the OrganizationRepository constructor (approvedToHire is the closest model: a readMany batch over shown).
- packages/organizations/src/types.ts: OrganizationDirectoryEntry.
- packages/organizations/test/organization-directory.test.ts (setup, STAFF, ENTRY_KEYS, the SHU-163/AC-01 SCOPE test) and directory-mutations.mjs (its mutants and SHU163_TEST_MODULE).
- packages/db/src/postgres-organization-stores-store.ts and packages/db/test/postgres-organization-stores.test.ts.
- apps/gateway/src/login-runtime.ts (organizationStoresStore is built before the OrganizationRepository), apps/gateway/src/web-ui.ts renderCompanyDirectory, and apps/gateway/test/company-directory.test.ts (its fixture builds an OrganizationRepository) with company-directory-mutations.mjs.

Design:
- organizations.ts: export interface OrganizationStoreCounts { countMany(orgIds: readonly string[]): Promise<ReadonlyMap<string, number>> }; add an optional constructor option storeCounts kept in a private field #storeCounts. In listOrganizations, right after the approvedBatch line, add one statement: const storeTotals = shown.length > 0 && this.#storeCounts ? await this.#storeCounts.countMany(shown.map((org) => org.id)) : undefined; and pass storeTotals ? storeTotals.get(org.id) ?? 0 : null to directoryEntry as a new last parameter storeCount: number | null. In directoryEntry put storeCount as the last key of the object, after status. shown already holds only covered, live, top-level companies, so the count inherits the directory's grant scope; a port that throws reaches the existing catch and the list answers unavailable.
- types.ts: add to OrganizationDirectoryEntry, after status: /** Active stores of this company, counted from source at read time; null when no store source is configured. */ readonly storeCount: number | null;
- Existing mutation anchors in dist/organizations.js must still bind exactly once and keep their meaning: do not edit the subOrganizationCount, legalName, approvedToHire or status lines of directoryEntry, the batchRecords or approvedBatch lines, the covered filter, deletedIds, or the #authorize lines, and do not name anything ending in batchRecords, record, own or approvedRecord.
- postgres-organization-stores-store.ts: add async countMany(orgIds: readonly string[]): Promise<Map<string, number>>: an empty list returns an empty map with no query; otherwise one query, SELECT org_id, count(*)::int AS count FROM organization_stores WHERE status='active' AND org_id = ANY($1::text[]) GROUP BY org_id. packages/db does not import packages/organizations; the port matches structurally.
- login-runtime.ts: pass storeCounts: organizationStoresStore to the OrganizationRepository; change nothing else.
- web-ui.ts renderCompanyDirectory: add a Stores column after Sub-companies, <th scope="col">Stores</th> in the header and, in the row, a cell with the number, or for null the same '<span class="missing" data-state="unavailable">Unavailable</span>' marker cell() uses. Keep \${escapeHtml(name)}</a>\${common} and every other line company-directory-mutations.mjs and context-navigation-mutations.mjs anchor exactly as they are.
- No migration, no stored counter, no cache, no background job, no change to the audit rows.

Tests (name every new test with its token first and a space after it):
- organization-directory.test.ts: add "storeCount" to ENTRY_KEYS in sorted order. Give setup an optional storeCounts port. "SHU168_STORE_COUNT ...": with an in-memory port backed by a Map that records each call, staff list org-a with its count and org-b with 0 (absent from the map); after the map changes (as a create would), the next list shows the new count; without a port every entry's storeCount is null. "SHU168_STORE_COUNT_SCOPE ...": STAFF's list calls countMany once with exactly ["org-a", "org-b"] (in any order, each once), never with org-a1 or org-a2; staff-self-a's list calls it with ["org-a"] only; staff-self-root's empty list does not call it; a port that throws answers unavailable.
- directory-mutations.mjs: add two mutants in its form: replace the storeTotals value passed to directoryEntry with null or 0 (SHU168_STORE_COUNT), and replace shown.map in the countMany call with organizations.map (SHU168_STORE_COUNT_SCOPE). Take both anchors from packages/organizations/dist/organizations.js, the built file the script reads, assert each binds once (the script prints its count from the list), and check by hand that each fails its named test.
- postgres-organization-stores.test.ts: "SHU168_PG_STORE_COUNTS ...": two fresh organizations and a third with no stores; create two stores in the first and one in the second through store.create; countMany of all three gives { first: 2, second: 1 } with the third absent; after store.remove of one, the next countMany gives first 1; countMany([]) is an empty map.
- company-directory.test.ts: let fixture take an optional storeCounts port and pass it to the OrganizationRepository. "SHU168_PAGE ...": with counts { "org-a": 3 }, the HTML page has the Stores header and the cells 3 and 0, and the JSON entries carry storeCount 3 and 0; with no port the cells show Unavailable. Change no existing test.

Out of scope: active-candidate and open-request counts (no assignment or request tables), counts on the organization view, sub-organization lists or the stores page, any stored counter or reconciliation job, migrations, the stores store's writes and #allowed (SHU-164 changes it; do not touch it), the deletion store, package.json (all these tests already run from test, test:web and test:db), the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

// SHU-331, SHU-332 and SHU-333 are the seventh committed card queue (SHU-312),
// the next organizations slices now that O6 and O7a have landed. SHU-331 is
// slice O7b (risk R2): a parent company reads its own and its covered
// sub-companies' stores in one list, each organization authorized by the stores
// store's own list. SHU-332 is slice O1b (risk R2): the workspace of a selected
// top-level company lists its sub-companies through the existing
// listSubOrganizations. SHU-333 is slice O5e (risk R3): staff and admin with a
// subtree grant create a company or a sub-company through one audited write,
// migration 0203. The paths are disjoint and only SHU-333 has a migration, so the
// read-only cards run first.
export const SHU331_PATHS = Object.freeze([
  "packages/organizations/src/organization-stores.ts",
  "packages/organizations/test/organization-stores.test.ts",
  "packages/organizations/test/organization-stores-mutations.mjs",
  "packages/db/src/postgres-organization-stores-store.ts",
  "packages/db/test/postgres-organization-stores.test.ts",
  "apps/gateway/src/organization-stores.ts",
  "apps/gateway/test/organization-stores-http.test.ts",
]);

const SHU331_ACCEPTANCE = [
  "(1) organization-stores.ts exports organizationGroupStores(orgId, list, children). It calls list(orgId) first and answers null when that is null, without calling children. Then, for each id children(orgId) returns, it calls list(child) and includes that child only when the result is not null. Ignoring the parent's null makes SHU331_GROUP_REFUSED fail; including a child whose list is null makes SHU331_GROUP_SCOPE fail;",
  "(2) Each entry is {orgId, storeId, name, location, brand, mall}, built from organizationStoresView per organization (removed stores and removed references stay hidden). The order is the parent's stores first, then each child's in the order children gave, and the keys are exact (SHU331_GROUP_VIEW);",
  "(3) PostgresOrganizationStoresStore.childOrganizations(orgId) answers the ids of the organization's direct children ordered by id, in one query and never grandchildren. A deleted child is returned but its list is null, so it never shows (SHU331_PG_GROUP);",
  "(4) GET /organization/stores/:orgId/group answers 200 {stores:[...]} or 404 not_found (unknown, deleted or refused parent), with the same session and method handling as the list route; GET /organization/stores/:orgId is unchanged (SHU331_HTTP);",
  "(5) organization-stores-mutations.mjs gains the two mutants for item 1. Each fails its named test by assertion, the nine existing mutants still bind once and are killed, and the final line prints 11/11;",
  "(6) Every existing stores, deletion-guard and directory test passes unchanged. npm run typecheck and npm test pass, and nothing outside the card's paths changes.",
].join(" ");

const SHU331_BRIEF = `Card SHU-331: a parent company reads its own and its sub-companies' stores in one list (slice O7, after SHU-165; risk R2).

You are working in the StudentHub platform monorepo at the bound head, which includes SHU-165 (migration 0202, organization_stores and PostgresOrganizationStoresStore), SHU-164 (store writes refuse a deleted organization) and SHU-168 (countMany). Dependencies are installed and there is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Why. Legacy employers see their company's stores together with their sub-companies' stores. StoreManager::getManagedStores() collects the parent id plus its children's ids and queries stores in that set (docs/parity/organizations-stores-and-contacts.md:16, :90, citing company/components/StoreManager.php:49-61 and company/models/Company.php:103-130). Enterprise clients run about four sub-companies of about thirty stores each (:22). The platform lists stores one organization at a time (apps/gateway/src/organization-stores.ts:9, :64-70), so a group owner must open every sub-company separately. Legacy also cached that list for 60 seconds on a plain timer (:90). This slice reads from source on each request and authorizes every organization in the group separately, so a sub-company the caller's grants do not cover never appears. A self grant on the parent therefore shows only the parent's stores, and a subtree grant shows the children too.

Read first:
- packages/organizations/src/organization-stores.ts: organizationStoreReadDecision (:53-57) and organizationStoresView (:86-98). The view deliberately has no org_id (organization-stores.test.ts:51-54).
- packages/organizations/test/organization-stores-mutations.mjs: its nine anchors in dist/organization-stores.js, among them .map((row) => ({ (spread), .filter((row) => row.status === "active") and row.brand_status === "active" ?. Each must still bind exactly once after your change.
- packages/db/src/postgres-organization-stores-store.ts: #allowed (:47-55) and list (:134-141, which returns null for a refused reader or a missing or deleted organization). Do not touch #allowed, the writes or countMany, and do not repeat the strings if (!await organizationLive(c, orgId, lock)) or organizationLive(c, orgId, lock), which packages/db/test/organization-deletion-guards-mutations.mjs anchors.
- apps/gateway/src/organization-stores.ts, the whole file, and apps/gateway/test/organization-stores-http.test.ts (its in-memory store fake at :10-21).
- packages/db/test/postgres-organization-stores.test.ts (fixtures :22-31, and SHU168_PG_STORE_COUNTS at :131).

Design:
- organization-stores.ts (packages/organizations):
  - export interface OrganizationGroupStoreView extends OrganizationStoreView { readonly orgId: string }
  - export async function organizationGroupStores(orgId: string, list: (orgId: string) => Promise<readonly OrganizationStoreRow[] | null>, children: (orgId: string) => Promise<readonly string[]>): Promise<OrganizationGroupStoreView[] | null>:
    - const parent = await list(orgId); if (parent === null) return null;
    - then, for each id of await children(orgId) in order, const rows = await list(child); if (rows === null) continue;
    - and build each organization's entries as organizationStoresView(rows).map((store) => ({ orgId: id, ...store })).

    Do not write a second .map((row) => ({ or .filter((row) => line in this file. Keep the two if statements on their own lines; they are the mutation anchors.
  - The function decides nothing about grants: each list call is the store's own authorization, so the existing read decision and its mutants keep covering roles and subtree.
- postgres-organization-stores-store.ts: add async childOrganizations(orgId: string): Promise<string[]>, one query, SELECT id FROM organizations WHERE parent_org_id=$1 ORDER BY id, on the pool. It is ids only and is called only after the parent's list authorized the caller. Nothing else in the file changes.
- apps/gateway/src/organization-stores.ts:
  - Add childOrganizations(orgId: string): Promise<readonly string[]> to the OrganizationStoresStore interface (the Postgres store satisfies it structurally, so login-runtime.ts does not change).
  - Add group(session, orgId) to OrganizationStores. It needs a session (401), passes the id regex (400), calls organizationGroupStores(orgId, (o) => p.store.list(id, o), (o) => p.store.childOrganizations(o)), and answers 200 {stores} or 404 not_found.
  - In handleOrganizationStores, add const GROUP = /^\\/organization\\/stores\\/([^/]+)\\/group$/, matched after LIST. It is GET only, a non-GET answers 404 like the list, and it uses the same decodeURIComponent guard. The new path has two segments after /stores/, so LIST never matches it.
- No migration, no cache, no runtime change, no HTML page.

Tests (name every new test with its token first and a space after it):
- organization-stores.test.ts, through subject so the mutants apply:
  - "SHU331_GROUP_REFUSED ...": a list that returns null for the parent makes the result null, and children is never called.
  - "SHU331_GROUP_SCOPE ...": a parent with two children where list returns rows for the parent and child c1 but null for c2. The result holds the parent's and c1's stores only, with no orgId c2.
  - "SHU331_GROUP_VIEW ...": the keys are exactly ["orgId","storeId","name","location","brand","mall"]; a removed store and a removed brand stay hidden; the parent comes first.
- organization-stores-mutations.mjs: add ["group-parent", "SHU331_GROUP_REFUSED", "if (parent === null) return null;", "if (false) return null;"] and ["group-scope", "SHU331_GROUP_SCOPE", "if (rows === null) continue;", "if (false) continue;"] (the exact anchors depend on how tsc prints them: take them from dist/organization-stores.js after npm run build and assert each binds once). Change nothing else in the script except the count it prints, which follows from the list.
- postgres-organization-stores.test.ts: "SHU331_PG_GROUP ...":
  - Setup: a parent with two children and one grandchild under the first child (written with authz.upsertOrganization; the registry permits it, and the read model would refuse it later).
  - childOrganizations(parent) is exactly the two children in id order; childOrganizations(child) is the grandchild; a leaf gives [].
  - After inserting an organization_deletions row for one child, it is still listed, and store.list(subtreeStaff, thatChild) is null.
- organization-stores-http.test.ts: add childOrganizations to the fake. "SHU331_HTTP ...":
  - GET /organization/stores/org/group gives 200 with each store's orgId, where the fake returns one child, a refused child that is left out, and a parent store.
  - A refused parent gives 404 and makes no childOrganizations call.
  - A missing session gives 401, POST gives 404, and a bad id gives 400.

  The existing two tests stay unchanged; extend the shared calls assertions only by adding new tests.

Out of scope: writes, #allowed, countMany, the deletion store and guards, store managers (OR-21, I4), assignment requests (OR-22, SHU-126), any count or cache, the read model and directory, login-runtime.ts, index.ts, web-ui.ts, package.json (every touched test and script already runs from test or test:db), the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

export const SHU332_PATHS = Object.freeze([
  "apps/gateway/src/context-navigation.ts",
  "apps/gateway/src/web-ui.ts",
  "apps/gateway/test/context-navigation.test.ts",
  "apps/gateway/test/context-navigation-mutations.mjs",
]);

const SHU332_ACCEPTANCE = [
  "(1) When /workspace reads the selected organization as found and its parentOrgId is null, the 200 body gains subOrganizations. It is {kind:\"found\", subOrganizations:[{orgId, registryName, status}]} from one organizationReader.listSubOrganizations call with the same principal, org and role as the read, or {kind:\"unavailable\"} when that answers unavailable. Skipping the call makes SHU332_NAV_SUBS fail;",
  "(2) A sub-organization card, a not-applicable or unavailable card, no selection, and no reader leave subOrganizations absent and make no call. An unavailable list never hides or changes the company card; mapping unavailable to an empty list makes SHU332_NAV_SUBS_UNAVAILABLE fail;",
  "(3) The list inherits the read model's scope: a self org-owner grant on the parent lists no children, a subtree grant lists the covered ones, and a deleted child is never listed (SHU332_NAV_SUBS);",
  "(4) The workspace HTML shows a \"Sub-companies\" section under the company card. Each child is a link to /workspace?org_id=<child>&role=<active role> with its status, names are escaped, an empty list shows \"No sub-companies you can open\", and the unavailable state shows a retry notice. Dropping the escape makes SHU332_NAV_SUBS_HTML fail;",
  "(5) context-navigation-mutations.mjs gains the three mutants. Each fails its named test by assertion, and every existing mutant (including the SHU91_HISTORY and company-directory-mutations.mjs anchors in web-ui.js) still binds once and is killed;",
  "(6) Every existing navigation, web-ui and company-directory test passes unchanged. npm run typecheck and npm test pass, and nothing outside the card's paths changes.",
].join(" ");

const SHU332_BRIEF = `Card SHU-332: the selected company's workspace lists its sub-companies (slice O1, row OR-02, after SHU-159, SHU-326 and SHU-328; risk R2).

You are working in the StudentHub platform monorepo at the bound head. Dependencies are installed and there is no network. You may run npm run typecheck, npm test and node --test on built files under dist/.

Why. OR-02 "View sub-organizations" is REQUIRED in slice O1 (docs/parity/organizations-stores-and-contacts.md:177), and legacy employers and managers have ListChild (:91). SHU-159 built OrganizationRepository.listSubOrganizations (packages/organizations/src/organizations.ts:458-492). It authorizes the parent, then each child separately through #authorize (:469), which also hides deleted organizations (:416), and returns sorted {orgId, registryName, status} summaries (packages/organizations/src/types.ts:76-80). Nothing calls it: createContextNavigation reads only organizationReader.read (apps/gateway/src/context-navigation.ts:93). The staff company list tells people to "Open one to see its details and sub-companies" (apps/gateway/src/web-ui.ts:199), and the workspace page cannot show them. This card wires the existing method into /workspace; it adds no read-model logic.

Read first:
- apps/gateway/src/context-navigation.ts, the whole file: NavigationResult (:20-26), ActiveOrganization (:15-18) and the read at :91-97.
- apps/gateway/src/web-ui.ts: renderOrganization (:129-145) and renderWorkspace (:202-219, which calls renderOrganization(result.body.organization) inside its template at :217).
- apps/gateway/test/context-navigation.test.ts: fixture (:16-49), deletionFixture (:70-83) and "SHU-159/AC-09 CARD ..." (:310-355, an OrganizationRepository over InMemoryAuthzStore with root, served through createGatewayServer).
- apps/gateway/test/context-navigation-mutations.mjs. Its mutants anchor five lines of dist/apps/gateway/src/context-navigation.js: the session line, const selected = selection.size > 0;, the createContextNavigation signature line, the isDeleted line and the deleted.has(...) line. Three anchors in web-ui.js are covered by the SHU91_HISTORY loop: document.documentElement.hidden = true;, if (event.persisted) location.reload(); and /assets/workspace-history.js. apps/gateway/test/company-directory-mutations.mjs anchors if (!active || !login.companies || !DIRECTORY_ROLES.has(active.role)) and \${escapeHtml(name)}</a>\${common} in web-ui.js. None of these may be duplicated or changed; in particular, do not name your loop variable name next to </a>\${common}.

Design:
- context-navigation.ts:
  - Export type SubOrganizationsPanel = { readonly kind: "found"; readonly subOrganizations: readonly SubOrganizationSummary[] } | { readonly kind: "unavailable" }, importing SubOrganizationSummary from @studenthub/organizations.
  - Add readonly subOrganizations?: SubOrganizationsPanel to the 200 body.
  - After the organization value is built (:94-96), and only when read.kind === "found" && read.organization.parentOrgId === null, call const children = await organizationReader.listSubOrganizations({ principalId: session.personId, orgId: active.orgId, role: active.role }); and map it: found gives {kind:"found", subOrganizations: children.subOrganizations}, unavailable gives {kind:"unavailable"}, and not_found gives no key.
  - Return { contexts, active, organization, ...(panel ? { subOrganizations: panel } : {}) }. A throw falls into the existing catch (503), as every other dependency failure does.
  - Keep the signature line unchanged; this card adds no parameter.
- web-ui.ts:
  - Add function renderSubOrganizations(panel, active), called right after \${renderOrganization(result.body.organization)} in renderWorkspace's template.
  - It renders nothing when panel is undefined. For unavailable, render <section class="notice org-notice" role="status"><strong>Sub-companies couldn’t be loaded.</strong><p>Please try again in a moment.</p></section>.
  - For found, render <section aria-labelledby="sub-title"><h2 id="sub-title">Sub-companies</h2>, then either a <nav class="context-list"> of <a class="context-option" href="\${escapeHtml(href)}"><span>\${escapeHtml(child.registryName)}</span><strong>\${status}</strong></a>, or <p class="empty-contexts">No sub-companies you can open.</p>.
  - href is /workspace?\${new URLSearchParams({ org_id: child.orgId, role: active.role })}, and status uses the existing statusNames map (web-ui.ts:157) or the existing Unavailable marker.
  - Add no CSS and no script, and change no other line.
- The link is only a preference: selecting a child re-resolves its grant (:57-63), which is why the list may only hold covered children, as the read model already ensures.

Tests (in context-navigation.test.ts, name each with its token first and a space after it; build on the AC-09 pattern, adding children org-a1 and org-a2 with parentOrgId: "org-a" and the childA1 snapshot from SYNTHETIC_ORGANIZATION_FIXTURES):
- "SHU332_NAV_SUBS ...":
  - An org-owner with a subtree grant on org-a gets subOrganizations.kind found, with org-a1 and org-a2 in name order.
  - A self org-owner grant on org-a gets found with [].
  - With a deletions port that marks org-a2 deleted, only org-a1 is listed.
  - Selecting org-a1 (a sub-organization) and selecting a candidate role leave the key absent.
  - No selection leaves both organization and subOrganizations absent.
  - Use a wrapper reader that counts listSubOrganizations calls: exactly one per top-level card, none otherwise.
- "SHU332_NAV_SUBS_UNAVAILABLE ...": a reader whose read delegates but whose listSubOrganizations answers unavailable gives subOrganizations {kind:"unavailable"}, while organization.kind stays found and its fields are unchanged; the HTML shows the retry notice and the company card.
- "SHU332_NAV_SUBS_HTML ...": a child registered with the name <b>Sub & Co</b> renders escaped (&lt;b&gt;Sub &amp; Co&lt;/b&gt;) inside a link whose href holds org_id=org-a1&amp;role=org-owner, and an empty list renders "No sub-companies you can open".
- context-navigation-mutations.mjs:
  - Add two entries to the mutants array in its form: replace the listSubOrganizations call's result with { kind: "not_found" } (pattern SHU332_NAV_SUBS), and map unavailable to { kind: "found", subOrganizations: [] } (pattern SHU332_NAV_SUBS_UNAVAILABLE).
  - Add a third, for web-ui.js, as a second small loop after the history loop and in its form: escapeHtml(child.registryName) becomes child.registryName, with the assertion /not ok .*SHU332_NAV_SUBS_HTML /.
  - Take every anchor from the built files after npm run build, assert each binds once, and check by hand that each fails its test.

Out of scope: store counts on sub-companies (a later O10 slice), the group store list (SHU-331), the read model and listSubOrganizations itself, the company directory and its page, sub-company creation (SHU-333), login-runtime.ts (the reader is already passed at :277), index.ts, package.json (these tests already run from test:web), CSS, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

export const SHU333_PATHS = Object.freeze([
  "packages/organizations/src/organization-creation.ts",
  "packages/organizations/src/index.ts",
  "packages/organizations/test/organization-creation.test.ts",
  "packages/organizations/test/organization-creation-mutations.mjs",
  "packages/db/migrations/0203_organization_creation.sql",
  "packages/db/src/postgres-organization-creation-store.ts",
  "packages/db/src/index.ts",
  "packages/db/test/postgres-organization-creation.test.ts",
  "packages/db/test/postgres-authz-store.test.ts",
  "apps/gateway/src/organization-creation.ts",
  "apps/gateway/src/index.ts",
  "apps/gateway/src/login-runtime.ts",
  "apps/gateway/test/organization-creation-http.test.ts",
  "package.json",
]);

const SHU333_ACCEPTANCE = [
  "(1) A new module packages/organizations/src/organization-creation.ts exports organizationCreationDecision(rows, parentId, ancestors), true only when a grant with role staff or admin **and scope subtree** is on the parent itself or on one of its ancestors; a self grant, an org-owner, recruiter, finance or candidate grant is refused. Accepting any role makes SHU333_DECISION fail; dropping the subtree requirement makes SHU333_DECISION fail;",
  "(2) It exports organizationCreationParentAllowed(parentId, parentOfParent, operators = DEFAULT_OPERATOR_ORG_IDS): true when the parent is an operator organization (the new row is a top-level company) or the parent is a top-level company (its own parent is null or an operator), false for a sub-company parent, so the hierarchy stays one level deep. Making it always true makes SHU333_HIERARCHY fail;",
  "(3) It exports parseOrganizationName(value): a string trimmed to 1..255 characters with no control characters, otherwise undefined. Removing the trim makes SHU333_NAME fail;",
  "(4) PostgresOrganizationCreationStore.create(principalId, parentId, name) runs in one transaction under pg_advisory_xact_lock(hashtextextended(parentId,163)). It calls organizationLive(c, parentId, true), reads the caller's grants FOR SHARE and the parent's ancestry, then applies the decision, then the hierarchy rule, then refuses a live sibling with the same name (case-insensitive). Only then does it insert organizations(id,name,parent_org_id) with a new UUID id and one audit row. It answers created with the id, or not_found, hierarchy or name_taken with nothing written (SHU333_PG_CREATE, SHU333_PG_REFUSED, SHU333_PG_HIERARCHY, SHU333_PG_NAME_TAKEN);",
  "(5) A create whose parent is being deleted waits on the parent row, reads the committed deletion record and answers not_found with no row and no audit (SHU333_PG_RACE). Passing false instead of true to organizationLive makes that test fail;",
  "(6) The audit row has operation organization.create, target_org_refs = [organizationAuditRef(newId)] (never a raw id), target_principal_ref = actor, and before/after summaries { childCount }, the parent's live children before and after. Migration 0203 widens the operation check, the cardinality = 1 branch and authorization_audit_summary_valid from 0202's definitions, drops nothing else, and accepts every existing row. \"0203_organization_creation\" follows \"0202_organization_stores\" in both lists in postgres-authz-store.test.ts;",
  "(7) POST /organization/create {parentOrgId, name} answers 200 {orgId, changed:true}. It answers 404 not_found for a refused caller and for an unknown or deleted parent, 409 hierarchy_too_deep or name_taken, and 400, 401, 403 origin_rejected or 503 like the stores route. The HTTP test calls the real handler (SHU333_HTTP);",
  "(8) organization-creation-mutations.mjs applies the mutants for items 1-3, each fails its named test by assertion, and it passes unmutated. The Postgres mutations for items 4-5 are checked by hand and reported. npm run typecheck and npm test pass, and nothing outside the card's paths changes.",
].join(" ");

const SHU333_BRIEF = `Card SHU-333: staff and admin create a company or a sub-company (slice O5, row OR-06; risk R3).

You are working in the StudentHub platform monorepo at the bound head. It includes SHU-326/327 (migration 0201, organization_deletions, organization-liveness.ts) and SHU-165 (migration 0202, the latest audit-constraint definitions). Dependencies are installed and there is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Why. Legacy staff and admin create a company directly, or a sub-company with parent (docs/parity/organizations-stores-and-contacts.md §4.1 line 105, row OR-06 line 181: REQUIRED, slice O5). Self-service onboarding (O3) is blocked on D-OR1 (§12 line 278), and the platform writes organization rows only through bootstrap-admin.ts:188 and PostgresAuthzStore.upsertOrganization (packages/db/src/postgres-authz-store.ts:309-361). Those are seed paths with no grant check and no audit. So no company can be added through the product. This card adds the smallest audited create: a name and a parent. Status, commercial terms, approved-to-hire and profile already have their own writes (SHU-305, SHU-314, SHU-315, SHU-300) and stay separate.

Read first:
- packages/organizations/src/organizations.ts: DEFAULT_OPERATOR_ORG_IDS (:351) and companyParentOf (:358-372, the one-level rule the read model enforces). In listOrganizations (:499-557), note that a company under an operator organization is a top-level directory entry.
- packages/organizations/src/organization-stores.ts: covers and the two decisions (:44-57), and text() (:62-67), the name-parsing pattern to copy.
- packages/db/src/postgres-organization-stores-store.ts, the closest model, a direct audited write that is not a safe write: #allowed (:47-55), #transaction (:70-89), create (:95-105) and #audit (:143-148).
- packages/db/src/organization-liveness.ts:3-10 and the deletion store's counts (postgres-organization-deletion-store.ts:6). live_sub_organizations counts children with no deletion record, so a sub-company created before a deletion's FOR UPDATE blocks it.
- packages/db/migrations/0202_organization_stores.sql: the ALTER TABLE authorization_mutation_audit block and authorization_audit_summary_valid. These are the latest definitions; start 0203 from their text.
- apps/gateway/src/organization-stores.ts (service, handleOrganizationStores, cookie and body parsing) and apps/gateway/test/organization-stores-http.test.ts (its fake request/response).
- apps/gateway/src/login-runtime.ts:233 (how the stores store is built), :271-277, :291 (the services object) and :307-308 (closers); apps/gateway/src/index.ts:194-195 (route mounts).
- packages/organizations/test/organization-stores-mutations.mjs, the mutation script form to copy, with its SHU165_TEST_MODULE env import in organization-stores.test.ts:5-6.

Design:
- organization-creation.ts (new), exported from packages/organizations/src/index.ts:
  - export interface OrganizationCreationGrantRow { readonly org_id: string; readonly role: string; readonly scope: string }
  - organizationCreationDecision(rows, parentId, ancestors): boolean returns rows.some((row) => (row.role === "staff" || row.role === "admin") && row.scope === "subtree" && (row.org_id === parentId || ancestors.includes(row.org_id))). Require subtree, because a self grant would not cover the organization the caller just created, so they could not open it.
  - organizationCreationParentAllowed(parentId: string, parentOfParent: string | null, operators: readonly string[] = DEFAULT_OPERATOR_ORG_IDS): boolean returns operators.includes(parentId) || parentOfParent === null || operators.includes(parentOfParent). Add a one-line comment: an operator parent makes a company, and a top-level company parent makes a sub-company.
  - ORGANIZATION_NAME_MAX = 255 and parseOrganizationName(value: unknown): string | undefined (trim, 1..255, refuse [\\u0000-\\u001f\\u007f]). Write it in this file and do not import the stores' text.
- packages/db/src/postgres-organization-creation-store.ts (new), exported from packages/db/src/index.ts with ORGANIZATION_CREATE_OPERATION = "organization.create". Its constructor takes { connectionString?, pool?, decision, parentAllowed } and owns its pool exactly as the stores store does (:30-36). packages/db must not import packages/organizations: the functions come in through the constructor.
  - create(principalId, parentId, name) uses one transaction (copy #transaction), with the advisory lock pg_advisory_xact_lock(hashtextextended($1,163)) on parentId; key 163 is unused today, the keys in use are 165, 305, 314-318, 325 and 326. In order:
    1. if (!await organizationLive(c, parentId, true)) returns not_found.
    2. Read grants: SELECT org_id,role,scope FROM grants WHERE principal_id=$1 FOR SHARE, unfiltered.
    3. Read the parent's ancestors with the recursive chain query from the stores store (:52).
    4. If decision refuses, return not_found.
    5. Read SELECT parent_org_id FROM organizations WHERE id=$1. If parentAllowed(parentId, parentOfParent) is false, return hierarchy.
    6. Refuse with name_taken when SELECT 1 FROM organizations o WHERE o.parent_org_id=$1 AND lower(o.name)=lower($2) AND NOT EXISTS (SELECT 1 FROM organization_deletions d WHERE d.org_id=o.id) finds a row.
    7. Count live children the same way.
    8. Insert with randomUUID(), then write the audit with requestAuditRef("organization_create_" + randomUUID()), principalAuditRef(principalId) as actor and target principal, [organizationAuditRef(orgId)], and {childCount: n} / {childCount: n+1}.

    Every refusal rolls back.
  - Why it is race-free: a parent deletion locks the parent FOR UPDATE before counting children (postgres-organization-deletion-store.ts:10). A create that holds FOR SHARE first makes the deletion wait and then be blocked by the new child. A create that arrives second waits, then reads the committed deletion record in organizationLive's second statement. Say this in a comment.
- 0203_organization_creation.sql (new): copy 0202's ALTER TABLE and add 'organization.create' to the operation check and to the cardinality(target_org_refs)=1 branch. CREATE OR REPLACE the summary function from 0202's text plus one branch, WHEN audit_operation='organization.create' THEN jsonb_typeof(summary)='object' AND summary ?& ARRAY['childCount'] AND summary-ARRAY['childCount']='{}'::jsonb AND jsonb_typeof(summary->'childCount')='number' AND summary->>'childCount' ~ '^(0|[1-9][0-9]{0,17})$'. Leave auth_audit_safe_write_halves and auth_audit_safe_write_self alone (both are NOT IN lists). No table, column or index change.
- apps/gateway/src/organization-creation.ts (new): copy organization-stores.ts's structure for one write route, POST /organization/create. The body is exactly {parentOrgId, name}; parentOrgId passes the same id regex (organization-stores.ts:28) and name passes parseOrganizationName.
  - Results: created gives 200 {orgId, changed:true}, not_found gives 404, hierarchy gives 409 {error:"hierarchy_too_deep"}, and name_taken gives 409 {error:"name_taken"}.
  - The Origin, content-type, 4096-byte body and cookie checks are the stores route's. A missing service or origin answers 503 organization_creation_unavailable.
- index.ts: one import and one line, if(await handleOrganizationCreation(...))return;, right after the handleOrganizationDeletion line (:195). Touch no other line; packages/observability/test/mutations.mjs anchors lines of index.js.
- login-runtime.ts: build the store next to organizationStoresStore (:233) with decision: organizationCreationDecision and parentAllowed: (parent, grand) => organizationCreationParentAllowed(parent, grand, DEFAULT_OPERATOR_ORG_IDS). Add organizationCreation: createOrganizationCreation({sessions, store}) beside organizationStores (:291) and its close() to the closers (:307-308). Change nothing else.

Tests (name every new test with its token first and a space after it):
- packages/organizations/test/organization-creation.test.ts (import through process.env.SHU333_TEST_MODULE ?? "../src/organization-creation.js", as organization-stores.test.ts:5-6 does):
  - "SHU333_DECISION ...": subtree staff and subtree admin on the parent or on root are allowed. A self staff grant on the parent, subtree org-owner, recruiter, finance and candidate are refused.
  - "SHU333_HIERARCHY ...": allowed for parent root with parentOfParent null, for a company under root, and for a parentless company; refused for a sub-company whose parent is a company.
  - "SHU333_NAME ...": "  Acme  " gives "Acme". Empty, 256 characters, a control character and a non-string all give undefined.
- packages/organizations/test/organization-creation-mutations.mjs (new; copy organization-stores-mutations.mjs, env SHU333_TEST_MODULE, target ../dist/organization-creation.js). Mutants:
  - (row.role === "staff" || row.role === "admin") becomes true, killed by SHU333_DECISION.
  - row.scope === "subtree" &&  is removed, killed by SHU333_DECISION.
  - || operators.includes(parentOfParent) becomes || true, killed by SHU333_HIERARCHY.
  - const trimmed = value.trim(); becomes const trimmed = value;, killed by SHU333_NAME.

  Take each anchor from the built JavaScript, assert it binds once, and print 4/4 SHU333 mutations killed.
- packages/db/test/postgres-organization-creation.test.ts (new; fixtures as in postgres-organization-stores.test.ts:11-31; ensure a root organization exists with authz.upsertOrganization, which is idempotent):
  - "SHU333_PG_CREATE ...": a principal with a subtree staff grant on root creates a company under root and then a sub-company under it. Both rows read back through authz.listOrganizations() with the right parent_org_id. Each has exactly one organization.create audit row whose target_org_refs is [organizationAuditRef(id)] and whose summaries are the child counts.
  - "SHU333_PG_REFUSED ...": a self staff grant on root, a subtree org-owner and a subtree recruiter each answer not_found. An unknown parent, and a parent with an organization_deletions row, also answer not_found. No organization row or audit row is written.
  - "SHU333_PG_HIERARCHY ...": creating under the sub-company answers hierarchy and writes nothing.
  - "SHU333_PG_NAME_TAKEN ...": a second " acme "/"ACME" under the same parent answers name_taken. The same name under another parent is created.
  - "SHU333_PG_RACE ...": copy SHU164_PG_STORES_RACE in postgres-organization-deletion-guards.test.ts. A second client BEGINs, locks the parent company FOR UPDATE and inserts its deletion record. Start create without awaiting it. Poll pg_stat_activity (bounded to 10 s) until another backend waits on a Lock, and fail by assertion if none does. COMMIT, then assert not_found, no child row and no audit row. Release every client, even on failure.
  - In your final message, report by hand that organizationLive(c, parentId, false) makes SHU333_PG_RACE fail.
- postgres-authz-store.test.ts: only add "0203_organization_creation" after "0202_organization_stores" at :1584 and :1637.
- apps/gateway/test/organization-creation-http.test.ts: "SHU333_HTTP ...", with an in-memory store fake that records calls, through the real handler. It covers each status above, unknown body keys (400), a bad origin (403) and a missing session (401), and asserts that the origin, session and method refusals reach no store call.
- package.json: leave every script's text as it is, with these additions:
  - Append dist/packages/organizations/test/organization-creation.test.js and dist/apps/gateway/test/organization-creation-http.test.js at the END of the node --test list in test.
  - Append dist/packages/db/test/postgres-organization-creation.test.js at the END of the test:db list.
  - Add "test:organization-creation:mutations": "node packages/organizations/test/organization-creation-mutations.mjs", chained into test as  && npm run test:organization-creation:mutations right after npm run test:organization-stores:mutations.

  Never change dependencies.

Out of scope:
- Setting status, approved-to-hire, terms, currency, profile, logo or licence at creation (each has its own write), and onboarding requests and approval (O3, D-OR1).
- Granting anyone on the new organization (O4), moving or renaming an organization, and any UI or HTML.
- PostgresAuthzStore.upsertOrganization and bootstrap-admin.
- Any change to packages/contracts, packages/safe-write-contract or the login code, and the lockfile.
- Any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

export const SHU334_PATHS = Object.freeze([
  "packages/organizations/src/types.ts",
  "packages/organizations/src/organizations.ts",
  "packages/organizations/test/organizations.test.ts",
  "packages/organizations/test/mutations.mjs",
  "apps/gateway/src/context-navigation.ts",
  "apps/gateway/src/web-ui.ts",
  "apps/gateway/test/context-navigation.test.ts",
  "apps/gateway/test/context-navigation-mutations.mjs",
]);

const SHU334_ACCEPTANCE = [
  "(1) OrganizationRepository.readCounts(request) answers {kind:\"found\", counts:{stores, subOrganizations}} only when #authorize resolves the caller to the admin audience at request.orgId; an employer, a staff caller, an operator organization, an unknown or a deleted organization answers not_found, and any throw answers unavailable. Letting any audience through makes SHU334_COUNTS_SCOPE fail;",
  "(2) subOrganizations counts the organization's direct children that #authorize lets the same caller open, so an uncovered child and a deleted child are never counted. Counting every child makes SHU334_COUNTS_CHILDREN fail;",
  "(3) stores is the storeCounts port's countMany([orgId]) value for that one organization (0 when the map has no entry), and null when the repository has no storeCounts port, never 0. Answering 0 without a port, or counting another set, makes SHU334_COUNTS_STORES fail;",
  "(4) OrganizationReader gains the optional readCounts; read, listSubOrganizations, the directory and every view key are unchanged, so every existing organizations, directory and status-batch test passes unchanged;",
  "(5) /workspace adds counts only for an admin context whose card reads as found: {kind:\"found\", counts} from one readCounts call with the same principal, org and role as the read, or {kind:\"unavailable\"}. Other roles, a not-applicable or unavailable card, no selection and a reader without readCounts leave the key absent and make no call (SHU334_NAV_COUNTS, SHU334_NAV_COUNTS_UNAVAILABLE);",
  "(6) The workspace HTML shows the two counts under the company card, a null store count as the Unavailable marker, and the unavailable panel as a retry notice that leaves the company card in place (SHU334_NAV_COUNTS_HTML);",
  "(7) mutations.mjs and context-navigation-mutations.mjs gain the mutants for items 1-3 and 5-6. Each fails its named test by assertion, every existing mutant (including directory-mutations.mjs, status-batch-reads-mutations.mjs, approved-to-hire-writes-mutations.mjs and company-directory-mutations.mjs anchors) still binds once and is killed. npm run typecheck and npm test pass, and nothing outside the card's paths changes.",
].join(" ");

const SHU334_BRIEF = `Card SHU-334: an admin sees a company's store and sub-company counts on its workspace card (slice O10b of O10, after SHU-168 and SHU-332; risk R2).

You are working in the StudentHub platform monorepo at the bound head, which includes SHU-168 (the directory's read-time store counts) and SHU-332 (the workspace lists sub-companies). Dependencies are installed and there is no network. You may run npm run typecheck, npm test and node --test on built files under dist/.

Why. Legacy admin sees four counters on a company: total_candidates, total_subcompanies, total_stores and total_suggestions; staff see only the candidate and suggestion counters, and employers none (docs/parity/organizations-stores-and-contacts.md:82, §3). Candidates and suggestions belong to other clusters, but stores and sub-companies are this cluster's. SHU-168 counts stores at read time for the directory only (packages/organizations/src/organizations.ts:532, through the OrganizationStoreCounts port at :164, which login-runtime.ts:274 already passes as storeCounts), and the directory's subOrganizationCount (:327-342) is likewise directory-only. An admin who opens one company in the workspace gets the card from read() (:420-456), which has neither count. This card adds a separate admin-only read of the two counts and shows it under the card. It adds no counter column and no cache: both numbers are derived on each request from the same sources the directory uses.

Read first:
- packages/organizations/src/organizations.ts: OrganizationStoreCounts (:164), the constructor (:384-402), #authorize (:405-419, which also hides deleted organizations through the deletions port), read (:420-456) and listSubOrganizations (:458-492), whose per-child #authorize loop is the scope rule to copy.
- packages/organizations/src/types.ts: OrganizationReadResult, SubOrganizationListResult and OrganizationReader (:103-116).
- packages/organizations/test/organizations.test.ts: setup (:27-56, an InMemoryAuthzStore with staff and admin subtree grants on root) and the SHU159_TEST_MODULE import (:14-17).
- packages/organizations/test/mutations.mjs, the script your organization mutants join. Anchors in dist/organizations.js that other scripts own and you must not duplicate: directory-mutations.mjs (among them child.parentOrgId === org.id && covered.has(child.id), storeTotals ? storeTotals.get(org.id) ?? 0 : null and this.#storeCounts.countMany(shown.map((org) => org.id))), status-batch-reads-mutations.mjs (batchRecords.get(org.id) ?? { kind: "absent" } and the two const batchRecords = lines), approved-to-hire-writes-mutations.mjs (the approvedToHire lines) and mutations.mjs itself (among them if (parentOrgId !== null && children.length > 0) and the #authorize resolution check).
- apps/gateway/src/context-navigation.ts:85-115 (the read at :98 and the SHU-332 panel at :102-111) and NavigationResult (:23-30).
- apps/gateway/src/web-ui.ts: renderOrganization (:129-145), renderSubOrganizations (:159-174) and the renderWorkspace template at :234.
- apps/gateway/test/context-navigation.test.ts: shu332Rig (:361-390) and the three SHU332 tests (:392-480); apps/gateway/test/context-navigation-mutations.mjs, its mutants array and its two web-ui.js loops.

Design:
- types.ts:
  - export interface OrganizationCounts { readonly stores: number | null; readonly subOrganizations: number }
  - export type OrganizationCountsResult = { readonly kind: "found"; readonly counts: OrganizationCounts } | { readonly kind: "not_found" } | { readonly kind: "unavailable" }
  - Add readCounts?(request: OrganizationReadRequest): Promise<OrganizationCountsResult> to OrganizationReader. It is optional, so the test readers that implement OrganizationReader (context-navigation.test.ts:395, :445) still compile.
- organizations.ts, a new method on OrganizationRepository after listSubOrganizations:
  - async readCounts(request) { try { const audience = await this.#authorize(request, request.orgId); if (audience !== "admin") return { kind: "not_found" }; ... } catch { return { kind: "unavailable" }; } }
  - const organizations = await this.#store.listOrganizations(); then let subOrganizations = 0; and for each child of organizations.filter((org) => org.parentOrgId === request.orgId), if (await this.#authorize(request, child.id) !== undefined) subOrganizations++;
  - const totals = this.#storeCounts ? await this.#storeCounts.countMany([request.orgId]) : undefined;
  - return { kind: "found", counts: Object.freeze({ stores: totals ? totals.get(request.orgId) ?? 0 : null, subOrganizations }) };
  - Keep the three expressions audience !== "admin", this.#authorize(request, child.id) !== undefined and totals ? totals.get(request.orgId) ?? 0 : null exactly as written: they are the mutation anchors. Do not name the variable storeTotals, and do not touch read, listSubOrganizations, listOrganizations, directoryEntry or any projection.
- context-navigation.ts:
  - Export type OrganizationCountsPanel = { readonly kind: "found"; readonly counts: OrganizationCounts } | { readonly kind: "unavailable" }, importing OrganizationCounts from @studenthub/organizations, and add readonly counts?: OrganizationCountsPanel to the 200 body.
  - After the organization value is built and before the SHU-332 panel, only when read.kind === "found" && active.role === "admin" && organizationReader.readCounts, call const tally = await organizationReader.readCounts({ principalId: session.personId, orgId: active.orgId, role: active.role }); and map it: found gives {kind:"found", counts: tally.counts}, unavailable gives {kind:"unavailable"}, and not_found gives no key.
  - Return { contexts, active, organization, ...(counts ? { counts } : {}), ...(panel ? { subOrganizations: panel } : {}) }. A throw falls into the existing catch (503).
  - Keep the signature line and every existing mutation anchor unchanged; this card adds no parameter.
- web-ui.ts: add function renderOrganizationCounts(panel: OrganizationCountsPanel | undefined), called right after \${renderOrganization(result.body.organization)} and before \${renderSubOrganizations(...)} in renderWorkspace's template.
  - It renders nothing when panel is undefined. For unavailable, render <section class="notice org-notice" role="status"><strong>Company counts couldn’t be loaded.</strong><p>Please try again in a moment.</p></section>.
  - For found, write const stores = panel.counts.stores === null ? '<span class="missing" data-state="unavailable">Unavailable</span>' : String(panel.counts.stores); and render <section aria-labelledby="counts-title"><h2 id="counts-title">At a glance</h2><dl class="profile-fields"><div><dt>Stores</dt><dd>\${stores}</dd></div><div><dt>Sub-companies</dt><dd>\${panel.counts.subOrganizations}</dd></div></dl></section>.
  - Add no CSS and no script, and change no other line.
- No migration, no runtime change (login-runtime.ts already passes storeCounts and the deletions port to the repository), no counter column and no cache.

Tests (name every new test with its token first and a space after it):
- organizations.test.ts, through implementation so the mutants apply. Build each repository with new OrganizationRepository({ store, source, storeCounts, deletions }) over setup's store, where storeCounts is a fake that records the ids it was asked for:
  - "SHU334_COUNTS_SCOPE ...": admin (subtree on root) reading org-a gets found. Staff reading org-a, owner-a and recruiter-a1 reading their organizations, admin reading root, an unknown organization, and org-a after the deletions port marks it deleted all answer not_found. A storeCounts that throws answers unavailable.
  - "SHU334_COUNTS_CHILDREN ...": admin reading org-a gets subOrganizations 2; with the deletions port marking org-a2 deleted it gets 1; an admin with only a self grant on org-a gets 0; a sub-company (org-a1) gets 0.
  - "SHU334_COUNTS_STORES ...": the fake answers 3 for org-a, so stores is 3 and countMany was called with exactly ["org-a"]; a fake whose map has no entry gives 0; a repository with no storeCounts port gives stores null.
- mutations.mjs: add four entries in its form:
  - "let any audience read counts", SHU334_COUNTS_SCOPE: audience !== "admin" becomes audience === undefined.
  - "count every child", SHU334_COUNTS_CHILDREN: this.#authorize(request, child.id) !== undefined becomes true.
  - "store count without a port", SHU334_COUNTS_STORES: totals ? totals.get(request.orgId) ?? 0 : null becomes totals ? totals.get(request.orgId) ?? 0 : 0.
  - "count the wrong set", SHU334_COUNTS_STORES: countMany([request.orgId]) becomes countMany([]).

  The exact anchors depend on how tsc prints them: take them from dist/organizations.js after npm run build and assert each binds once. Change nothing else in the script; the count it prints follows from the list.
- context-navigation.test.ts, on a rig like shu332Rig where person-1 also holds an admin subtree grant on root and the repository has a storeCounts fake answering 4 for org-a:
  - "SHU334_NAV_COUNTS ...": selecting org-a as admin gives counts {kind:"found", counts:{stores:4, subOrganizations:2}}; selecting org-a as org-owner, and selecting no context, leave the key absent. Use a wrapper reader that counts readCounts calls: exactly one for the admin card, none otherwise. A reader without readCounts leaves the key absent.
  - "SHU334_NAV_COUNTS_UNAVAILABLE ...": a reader whose read delegates but whose readCounts answers unavailable gives counts {kind:"unavailable"} while organization.kind stays found; the HTML shows "Company counts couldn’t be loaded" and the company card.
  - "SHU334_NAV_COUNTS_HTML ...": the found panel renders "At a glance", "Stores" with 4 and "Sub-companies" with 2; a panel with stores null renders the Unavailable marker inside the counts section and never "null".
- context-navigation-mutations.mjs:
  - Add two entries to the mutants array in its form: replace the readCounts call's result with { kind: "not_found" } (pattern SHU334_NAV_COUNTS), and map unavailable to { kind: "found", counts: { stores: 0, subOrganizations: 0 } } (pattern SHU334_NAV_COUNTS_UNAVAILABLE).
  - Add a third, for web-ui.js, as one more small loop in the form of the sub-company loop: panel.counts.stores === null ? becomes false ?, with the assertion /not ok .*SHU334_NAV_COUNTS_HTML /.
  - Take every anchor from the built files after npm run build, assert each binds once, and check by hand that each fails its test.

Out of scope: candidate and suggestion counters (other clusters), counts for staff or employers, any change to read(), listSubOrganizations or the directory and its page, any stored counter, cache or migration, the stores package and its Postgres store, login-runtime.ts and index.ts, package.json (every touched test and script already runs from test and test:web), CSS, the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

export const SHU335_PATHS = Object.freeze([
  "packages/organizations/src/status-writes.ts",
  "packages/organizations/test/status-events.test.ts",
  "packages/organizations/test/status-events-mutations.mjs",
  "packages/db/src/postgres-organization-status-store.ts",
  "packages/db/test/postgres-organization-status.test.ts",
  "apps/gateway/src/organization-status.ts",
  "apps/gateway/test/organization-status-http.test.ts",
]);

const SHU335_ACCEPTANCE = [
  "(1) status-writes.ts exports ORGANIZATION_STATUS_HISTORY_LIMIT = 50 and organizationStatusHistoryView(rows), which maps each row to exactly {from, to, occurredAt} (occurredAt an ISO string), orders newest first and keeps at most 50. Leaking a row field makes SHU335_HISTORY_VIEW fail, reversing the order makes SHU335_HISTORY_VIEW fail, and dropping the cap makes SHU335_HISTORY_LIMIT fail;",
  "(2) PostgresOrganizationStatusStore.history(principalId, orgId) answers null unless the existing #allowed admits the caller (staff or admin covering a live organization, by the status write's own decision), and otherwise the organization's events from organization_status_events, newest first, at most 50, in one query. It never returns receipt_ref, delivered_at, ids or anything from the audit table (SHU335_PG_HISTORY, SHU335_PG_REFUSED);",
  "(3) GET /organization/status/:orgId/history answers 200 {history:[...]} or 404 not_found for a refused caller, an unknown or a deleted organization, 401 without a session, 400 for a malformed id, and 404 for any other method; the preview, confirm and receipt routes are unchanged (SHU335_HTTP);",
  "(4) status-events-mutations.mjs gains the three mutants for item 1. Each fails its named test, the three SHU-313 mutants and every status-writes-mutations.mjs and organization-deletion-guards-mutations.mjs anchor still bind once and are killed, and the final line prints 6/6;",
  "(5) Every existing status, status-event and deletion-guard test passes unchanged. npm run typecheck and npm test pass, and nothing outside the card's paths changes.",
].join(" ");

const SHU335_BRIEF = `Card SHU-335: staff and admin read a company's status history (slice O5g of O5, row OR-08, after SHU-305 and SHU-313; risk R2).

You are working in the StudentHub platform monorepo at the bound head, which includes SHU-305 (the staff and admin status write) and SHU-313 (migration 0191, organization_status_events, one durable event per committed change). Dependencies are installed and there is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Why. OR-08 "Change status / approve to hire" is REQUIRED "with the notification" (docs/parity/organizations-stores-and-contacts.md:183). Legacy ChangeStatus only logs a Yii::info line (:109), and leaving under review sends an account-live email to the company (:110, :161). SHU-313 writes exactly one organization_status_events row per committed change, in the same transaction as the change (packages/db/src/postgres-organization-status-store.ts:39). Its delivered_at column is waiting for a later delivery card, and mail delivery belongs to SHU-189/C4 (docs/parity/platform-ops-and-integrations.md:137). Nothing reads those events today, so staff cannot see when a company went live or who should be told. This card adds the read: staff and admin list a company's status changes, newest first. It sends nothing.

Read first:
- packages/organizations/src/status-writes.ts, the whole file: organizationStatusEvent (:10-14) and organizationStatusDecision (:17-22).
- packages/organizations/test/status-events.test.ts (the SHU313_TEST_MODULE import at :4-6) and packages/organizations/test/status-events-mutations.mjs. Anchors in dist/status-writes.js that you must not duplicate: from status-events-mutations.mjs, if (from === to), return { from, to }; and value === "none" ? null : value; from status-writes-mutations.mjs, row.role === "staff" || row.role === "admin", return current === expected; and the return { preview: implementation.preview, confirm: implementation.confirm }; line.
- packages/db/migrations/0191_organization_status_events.sql (the columns) and packages/db/src/postgres-organization-status-store.ts: read (:22), readReceipt (:29) and #allowed (:32). #allowed already refuses a deleted organization through organizationLive and applies the status decision. packages/db/test/organization-deletion-guards-mutations.mjs anchors if (!await organizationLive(c, org)) and if (!await organizationLive(client, org, true)) in this file, so call #allowed and do not write either string again.
- packages/db/test/postgres-organization-status.test.ts, especially "SHU-313 postgres status events are exactly-once ..." (:10), which shows how to drive real writes.
- apps/gateway/src/organization-status.ts, the whole file, and apps/gateway/test/organization-status-http.test.ts (its in-memory store at :11 and its fake request/response).

Design:
- status-writes.ts:
  - export interface OrganizationStatusEventRow { readonly from_status: string | null; readonly to_status: string | null; readonly occurred_at: Date | string }
  - export interface OrganizationStatusHistoryEntry { readonly from: OrganizationStatus | null; readonly to: OrganizationStatus | null; readonly occurredAt: string }
  - export const ORGANIZATION_STATUS_HISTORY_LIMIT = 50;
  - export function organizationStatusHistoryView(rows: readonly OrganizationStatusEventRow[]): OrganizationStatusHistoryEntry[]: map each row with ({ from: row.from_status as OrganizationStatus | null, to: row.to_status as OrganizationStatus | null, occurredAt: new Date(row.occurred_at).toISOString() }), then .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt)) (a stable sort, so equal times keep the store's order), then .slice(0, ORGANIZATION_STATUS_HISTORY_LIMIT).
  - Keep the object literal, the comparator and the slice call written as above: they are the mutation anchors.
- postgres-organization-status-store.ts: add async history(principalId: string, orgId: string): Promise<OrganizationStatusEventRow-shaped rows | null>. If !await this.#allowed(this.#pool, principalId, orgId) return null; otherwise run SELECT from_status,to_status,occurred_at FROM organization_status_events WHERE org_id=$1 ORDER BY occurred_at DESC, id DESC LIMIT 50 and return its rows. Declare the row type locally; packages/db must not import packages/organizations. Nothing else in the file changes.
- organization-status.ts (gateway):
  - Add history(principalId: string, orgId: string): Promise<readonly OrganizationStatusEventRow[] | null> to the OrganizationStatusStore interface. The Postgres store satisfies it structurally, so login-runtime.ts does not change.
  - Add history(session, orgId) to OrganizationStatus: 401 without a person, 200 {history: organizationStatusHistoryView(rows)} when the store answers rows, and 404 {error:"not_found"} for null.
  - In handleOrganizationStatus, add HISTORY = /^\\/organization\\/status\\/([^/]+)\\/history$/ next to RECEIPT, include it in the early return false check, and handle it before the POST branch: GET only (any other method answers 404 not_found), with the same decodeURIComponent guard (400 invalid_request) and the same headers.
  - The history route belongs to the status service, so it has that service's availability: without SAFE_WRITE_SIGNING_KEY the service is not built and history answers 503 safe_write_unavailable, exactly like the status receipts route today. Keep that (it is the existing !service check, reached before HISTORY is matched); making the read keyless needs login-runtime.ts and is a later card.
- No migration, no change to the write, the event insert, the audit or the safe-write contract, and nothing sent.

Tests (name every new test with its token first and a space after it):
- status-events.test.ts, through subject so the mutants apply:
  - "SHU335_HISTORY_VIEW ...": three rows given oldest first (under_review to active, active to inactive, inactive to null) come back newest first, each with keys exactly ["from","occurredAt","to"]. A Date and an ISO string both give the same ISO occurredAt, and an extra row field such as receipt_ref never appears.
  - "SHU335_HISTORY_LIMIT ...": 60 rows give exactly 50, the newest 50.
- status-events-mutations.mjs: add three entries in its form:
  - ["leak row fields", "SHU335_HISTORY_VIEW", "({ from: row.from_status", "({ ...row, from: row.from_status"]
  - ["oldest first", "SHU335_HISTORY_VIEW", "b.occurredAt.localeCompare(a.occurredAt)", "a.occurredAt.localeCompare(b.occurredAt)"]
  - ["no cap", "SHU335_HISTORY_LIMIT", ".slice(0, ORGANIZATION_STATUS_HISTORY_LIMIT)", ""]

  The exact anchors depend on how tsc prints them: take them from dist/status-writes.js after npm run build and assert each binds once. Change nothing else in the script except the line it prints, which becomes "6/6 SHU-313 and SHU-335 mutations killed".
- postgres-organization-status.test.ts, appended, on its own fresh organization under ROOT:
  - "SHU335_PG_HISTORY ...": a staff person commits under_review, then active, then clears with "none" through the real writer. history(staff, org) answers three rows newest first with from_status/to_status (null, under_review), (under_review, active), (active, null) in reverse order, and the row keys are exactly from_status, to_status and occurred_at. An admin with a grant on ROOT and scope subtree reads the same rows.
  - "SHU335_PG_REFUSED ...": an org-owner of the organization, a staff person whose grant is on another organization, and an unknown principal each get null. After inserting an organization_deletions row for the organization, the staff person gets null too.
- organization-status-http.test.ts: add history to the in-memory store (it answers rows for ORG and null otherwise, and records its calls). "SHU335_HTTP ...":
  - GET /organization/status/org-a/history gives 200 with newest-first entries and the nosniff and no-store headers.
  - An unknown organization gives 404, a missing session gives 401 and makes no store call, POST to the history path gives 404, and a malformed id gives 400.

  The existing four tests stay unchanged.

Out of scope: sending or queuing any notification, delivered_at and its updates, the account-live email and its recipients (SHU-189/C4), who made each change (audit actor refs stay out of the response), any HTML page, the write, its decision and its event insert, the approved-to-hire history, migrations, login-runtime.ts, index.ts, package.json (every touched test and script already runs from test or test:db), the lockfile, and any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

export const SHU336_PATHS = Object.freeze([
  "packages/organizations/src/account-manager-writes.ts",
  "packages/organizations/src/index.ts",
  "packages/organizations/test/account-manager-writes.test.ts",
  "packages/organizations/test/account-manager-writes-mutations.mjs",
  "packages/db/migrations/0204_organization_account_managers.sql",
  "packages/db/src/postgres-organization-account-manager-store.ts",
  "packages/db/src/index.ts",
  "packages/db/test/postgres-organization-account-manager.test.ts",
  "packages/db/test/postgres-authz-store.test.ts",
  "apps/gateway/src/organization-account-manager.ts",
  "apps/gateway/src/index.ts",
  "apps/gateway/src/login-runtime.ts",
  "apps/gateway/test/organization-account-manager-http.test.ts",
  "package.json",
]);

const SHU336_ACCEPTANCE = [
  "(1) A new module packages/organizations/src/account-manager-writes.ts exports organizationAccountManagerDecision(rows, orgId, ancestors, operators), true only for an admin grant on the organization or a subtree admin grant on an ancestor, never for an operator organization; staff, org-owner and every other role are refused (SHU336_DECISION);",
  "(2) It exports organizationAccountManagerReadDecision with the same shape for staff or admin, used both for who may read the manager and for who may be assigned (SHU336_ELIGIBLE), organizationAccountManagerValue (field account_manager, value \"none\" or a principal id of 1..128 characters from [A-Za-z0-9._:-], SHU336_VALUE), organizationAccountManagerStateDecision (current === expected, SHU336_STALE), the record and principal refs, and buildOrganizationAccountManagerWrite, which refuses a malformed value, and an assignee its required eligible port answers \"ineligible\" for, with invalid_value at both preview and confirm before the safe write runs. The port answers \"refused\" for a caller the writer decision refuses (or a missing or deleted organization) without looking at the assignee, and the builder then lets the safe write refuse that caller with not_own_record, so a caller without the admin grant cannot learn whether a principal is staff or admin on the organization (SHU336_BUILDER, SHU336_PG_REFUSED). The builder passes runSafeWriteConformance;",
  "(3) Migration 0204 creates organization_account_managers (org_id primary key referencing organizations on delete cascade, principal_id not null referencing principals on delete cascade, updated_at) and admits organization.account_manager.safe_write to the operation check, the cardinality > 0 branch, auth_audit_safe_write_halves and the safe-write branch of authorization_audit_summary_valid with fields [\"account_manager\"], plus its token and receipt unique indexes, starting from the latest definitions (0203 for the operation check, cardinality and summary function, 0201 for the halves) and accepting every existing row. \"0204_organization_account_managers\" follows \"0203_organization_creation\" in both lists in postgres-authz-store.test.ts;",
  "(4) PostgresOrganizationAccountManagerStore commits under pg_advisory_xact_lock(hashtextextended(org,336)) with organizationLive(client, org, true), the caller's grants FOR SHARE and the writer decision, the token check, the state compare, and then the assignee's grants FOR SHARE: an assignee who no longer qualifies answers state_changed with nothing written. It upserts the row (\"none\" deletes it) and writes one audit row with target_org_refs [organizationAuditRef(org)] and fields [\"account_manager\"], never a raw id (SHU336_PG_ASSIGN, SHU336_PG_REFUSED, SHU336_PG_STALE, SHU336_PG_DELETED);",
  "(5) POST /organization/account-manager/preview and /confirm and GET /organization/account-manager/:orgId/receipts/:ref follow the approved-to-hire route exactly, and GET /organization/account-manager/:orgId answers 200 {accountManager: null | {principalId, displayName}} to staff and admin covering a live organization, 404 not_found otherwise and 401 without a session, also when SAFE_WRITE_SIGNING_KEY is unset, while only the write paths answer 503 safe_write_unavailable then (SHU336_HTTP);",
  "(6) account-manager-writes-mutations.mjs applies the mutants for items 1-2, each fails its named test by assertion, and it passes unmutated; the Postgres mutations for item 4 are checked by hand and reported. npm run typecheck and npm test pass, and nothing outside the card's paths changes.",
].join(" ");

const SHU336_BRIEF = `Card SHU-336: an admin assigns a company's account manager, and staff and admin read who it is (slice O5f of O5, row OR-09, after SHU-315, SHU-326/327 and SHU-333; risk R3).

You are working in the StudentHub platform monorepo at the bound head. It includes SHU-315 (migration 0193, the approved-to-hire safe write this card copies), SHU-326/327 (migration 0201, organization_deletions, organization-liveness.ts) and SHU-333 (migration 0203, the latest operation check, cardinality and summary function). Dependencies are installed and there is no network. You may run npm run typecheck, npm test and node --test on built files under dist/. The Postgres tests (npm run test:db) cannot run here, so write them carefully; CI runs them on the card's pull request.

Why. Every legacy company has an owning account manager, company.staff_id (docs/parity/organizations-stores-and-contacts.md:31), set only by admin UpdateStaff (admin/.../CompanyController.php:655). Row OR-09 "Assign account manager" is REQUIRED in slice O5 (:184), and §8 lists it among the untested legacy behaviour (:227). Staff's AssignedList filters companies by it (:92), which a later card builds on this one. Nothing on the platform records it: there is no account-manager column, table, store or route. This card adds it as a single-field admin safe write on an existing company, preview → confirm → receipt, the same shape as approved-to-hire (SHU-315). In the platform, staff are principals with staff or admin grants, so the assignee is a principal, and only one who can actually open the company may be assigned.

Read first:
- packages/organizations/src/approved-to-hire-writes.ts, the whole file: the decision, value check, state decision, refs and the builder wrapper that refuses invalid_value before createSafeWrite runs. packages/organizations/src/commercial-terms-writes.ts:9 is the admin-only decision to copy.
- packages/organizations/test/approved-to-hire-writes.test.ts (fixture, conformance at AC-01) and approved-to-hire-writes-mutations.mjs, the test and mutation-script forms to copy (env SHU315_TEST_MODULE, --test-name-pattern with a "^" prefix and a trailing space).
- packages/db/src/postgres-organization-approved-to-hire-store.ts, the whole file: forPrincipal, readReceipt, #allowed, #value and #commit (advisory lock, organizationLive(client, org, true), grants FOR SHARE, token check, state compare, upsert, audit).
- packages/db/migrations/0193_organization_approved_to_hire.sql (table plus the two unique indexes), 0201_organization_deletion.sql:12-16 (the latest auth_audit_safe_write_halves) and 0203_organization_creation.sql (the latest operation check, cardinality check and authorization_audit_summary_valid; start 0204 from their text).
- packages/db/test/postgres-organization-approved-to-hire.test.ts, the Postgres test form, and postgres-authz-store.test.ts:1584 and :1637 (the two migration lists).
- apps/gateway/src/organization-approved-to-hire.ts, the whole file, and apps/gateway/test/organization-approved-to-hire-http.test.ts.
- apps/gateway/src/login-runtime.ts:231 (how the approved-to-hire store is built), :290 (its service, behind safeWriteKey) and :310-311 (closers); apps/gateway/src/index.ts:191 and :197 (route mounts). packages/observability/test/mutations.mjs anchors lines of index.js, so touch no other line there.
- packages/organizations/src/index.ts and packages/db/src/index.ts:40 (the export form).

Design:
- account-manager-writes.ts (new), exported from packages/organizations/src/index.ts:
  - ORGANIZATION_ACCOUNT_MANAGER_FIELDS = ["account_manager"] and ORGANIZATION_ACCOUNT_MANAGER_POLICY with maxValueLength 128.
  - export interface OrganizationAccountManagerGrantRow { readonly org_id: string; readonly role: string; readonly scope: string }
  - A private covers(row, orgId, ancestors) helper: row.org_id === orgId || (row.scope === "subtree" && ancestors.includes(row.org_id)).
  - organizationAccountManagerDecision(rows, orgId, ancestors, operators = DEFAULT_OPERATOR_ORG_IDS) returns !operators.includes(orgId) && rows.some((row) => row.role === "admin" && covers(row, orgId, ancestors)).
  - organizationAccountManagerReadDecision(rows, orgId, ancestors, operators = DEFAULT_OPERATOR_ORG_IDS) returns !operators.includes(orgId) && rows.some((row) => (row.role === "staff" || row.role === "admin") && covers(row, orgId, ancestors)). It decides both who may read the manager and whom an admin may assign.
  - organizationAccountManagerValue(field, value) returns field === "account_manager" && (value === "none" || /^[A-Za-z0-9._:-]{1,128}$/.test(value)).
  - organizationAccountManagerStateDecision(current, expected) returns current === expected.
  - organizationAccountManagerRecordRef and organizationAccountManagerPrincipalRef over the domains organization-account-manager-record and organization-account-manager-principal.
  - buildOrganizationAccountManagerWrite(input) takes { store, secret, eligible: (principalId: string) => Promise<"eligible" | "ineligible" | "refused">, policy?, clock?, tokenLifetimeMs?, check? }. As approved-to-hire's builder, it refuses a value check failure with invalid_value. Then, in both preview and confirm, if (value !== "none" && (await input.eligible(value)) === "ineligible") it answers { ok: false, reason: "invalid_value" }; otherwise ("eligible", or "refused", which the safe write's own ownership check refuses as not_own_record) it calls the safe write. Never answer invalid_value for "refused": that would tell a caller without the admin grant whether the assignee is staff or admin on the organization.
  - Write the role tests and that if statement exactly as above: they are the mutation anchors.
- 0204_organization_account_managers.sql (new):
  - CREATE TABLE organization_account_managers (org_id text PRIMARY KEY REFERENCES organizations(id) ON DELETE CASCADE, principal_id text NOT NULL REFERENCES principals(id) ON DELETE CASCADE, updated_at timestamptz NOT NULL DEFAULT clock_timestamp()).
  - Copy 0203's ALTER TABLE: add 'organization.account_manager.safe_write' to the operation check and to the cardinality(target_org_refs)>0 branch, and copy 0201's auth_audit_safe_write_halves with the new operation added to its NOT IN list.
  - CREATE OR REPLACE authorization_audit_summary_valid from 0203's text with the operation added to the safe-write IN list and one more fields branch: OR (audit_operation='organization.account_manager.safe_write' AND summary->'fields'='["account_manager"]'::jsonb).
  - Add the two unique indexes in 0193's form, ..._organization_account_manager_token on (after_summary->>'tokenRef') and ..._organization_account_manager_receipt on request_ref, each WHERE operation='organization.account_manager.safe_write'.
  - Leave auth_audit_safe_write_self alone. Change no other table, column or index.
- packages/db/src/postgres-organization-account-manager-store.ts (new), exported from packages/db/src/index.ts with ORGANIZATION_ACCOUNT_MANAGER_OPERATION = "organization.account_manager.safe_write". Copy the approved-to-hire store. Its constructor takes { connectionString?, pool?, decision, readDecision, stateDecision, recordRef, principalRef }; packages/db must not import packages/organizations.
  - forPrincipal and readReceipt as in approved-to-hire, with the field account_manager. #value reads principal_id or null.
  - async eligible(callerId, orgId, principalId): "refused" when the organization is not live or decision(the caller's grants, orgId, ancestors) fails, and in that case it reads nothing about principalId. Otherwise "eligible" when readDecision(that principal's grants, orgId, ancestors) holds, else "ineligible". An unknown principal has no grants, so it is "ineligible".
  - async manager(principalId, orgId) answers null when the caller fails readDecision on a live organization (the same #grants/#ancestors reads). Otherwise it answers { manager: null } or { manager: { principalId, displayName } }, from one join of organization_account_managers to principals (display_name, or null).
  - #commit runs in one transaction:
    1. SELECT pg_advisory_xact_lock(hashtextextended($1,336)) on org (key 336 is unused; the keys in use are 163, 165, 300, 305, 314-318, 325, 326 and 5959).
    2. if (!await organizationLive(client, org, true)) refuses not_own_record.
    3. Read the caller's grants FOR SHARE and the ancestors, then apply decision (not_own_record).
    4. Run the token check (token_already_used), then the state compare (state_changed).
    5. For a value other than "none", read the assignee's grants FOR SHARE. If readDecision refuses, return state_changed: the assignee changed since preview.
    6. Upsert the row, or DELETE it for "none".
    7. Write the audit row exactly as approved-to-hire does: {valuePresent} before, the receipt shape and tokenRef after, fields [input.field], target_org_refs [organizationAuditRef(org)].

    Every refusal rolls back, and 23505 answers token_already_used.
- apps/gateway/src/organization-account-manager.ts (new): copy organization-approved-to-hire.ts.
  - Paths are /organization/account-manager/preview, /confirm and /:orgId/receipts/:ref, plus READ = /^\\/organization\\/account-manager\\/([^/]+)$/ for GET. The exact preview and confirm paths are POST only and never reach READ.
  - The body is exactly {orgId, field:"account_manager", value}, with value "none" or a principal id matching the value check.
  - The store interface is forPrincipal, readReceipt, eligible(callerId, orgId, principalId) and manager(principalId, orgId). The writer passes eligible: (value) => ports.store.eligible(<the session's principal id>, r.orgId, value).
  - read(session, orgId) answers 401, 404 not_found for null, or 200 {accountManager}.
  - The read never needs the signing key. createOrganizationAccountManager({sessions, store, secret?}) always builds read; preview, confirm and receipt exist only when secret is given. handleOrganizationAccountManager matches READ first: a GET on READ is answered from read even when the write side is absent, and only the preview, confirm and receipt paths answer 503 safe_write_unavailable when it is. A non-GET on READ answers 404.
  - Refusal mapping, headers, origin, content-type, the 4096-byte body and 503 safe_write_unavailable for the write paths are approved-to-hire's.
  - "none" always means clear. A principal whose id is exactly "none" cannot be assigned (the value check reads it as clear); say so in a one-line comment beside the value check.
- index.ts: one import and one line, if(await handleOrganizationAccountManager(...))return;, right after the handleOrganizationCreation line (:197).
- login-runtime.ts: build the store next to the approved-to-hire store (:231) with the four functions and the two refs, add organizationAccountManager: createOrganizationAccountManager({sessions, store, ...(safeWriteKey ? {secret: safeWriteKey} : {})}) unconditionally beside organizationApprovedToHire (:290), so the read works without SAFE_WRITE_SIGNING_KEY and the writes stay behind it, and add its close() to the closers (:310-311). Change nothing else.

Tests (name every new test with its token first and a space after it):
- packages/organizations/test/account-manager-writes.test.ts (import through process.env.SHU336_TEST_MODULE ?? "../src/account-manager-writes.js", as approved-to-hire-writes.test.ts does), with a fixture store like approved-to-hire's and an eligible fake that records its calls:
  - "SHU336_DECISION ...": admin self on the organization and subtree admin on an ancestor are allowed. Staff (self or subtree), org-owner, recruiter, finance and candidate are refused, and so is an admin grant when the organization is the operator root.
  - "SHU336_ELIGIBLE ...": the read decision allows staff and admin, self or covering subtree, and refuses org-owner, recruiter, finance, candidate, an uncovered staff grant and the operator root.
  - "SHU336_VALUE ...": "none", a UUID and "staff.one:2" pass. "", 129 characters, "a b", "x/y", a wrong field and a non-string fail. A malformed value previews as invalid_value without calling eligible.
  - "SHU336_BUILDER ...": an assignee the eligible fake answers "ineligible" for previews and confirms as invalid_value and never commits; when the fake answers "refused" the request reaches the safe write and a caller the fixture store does not own answers not_own_record, never invalid_value; "none" never calls eligible; an eligible assignee commits. runSafeWriteConformance passes with check: () => true and eligible: async () => "eligible".
  - "SHU336_STALE ...": a confirm after the stored value changes is state_changed.
- packages/organizations/test/account-manager-writes-mutations.mjs (new; copy approved-to-hire-writes-mutations.mjs, env SHU336_TEST_MODULE, target ../dist/account-manager-writes.js). Mutants:
  - row.role === "admin" && covers( becomes true && covers(, killed by SHU336_DECISION.
  - !operators.includes(orgId) && rows.some((row) => row.role === "admin" becomes rows.some((row) => row.role === "admin", killed by SHU336_DECISION (the operator-root case). The read decision's line differs after rows.some, so this anchor binds once.
  - (row.role === "staff" || row.role === "admin") && covers( becomes true && covers(, killed by SHU336_ELIGIBLE.
  - the value check's return becomes return true;, killed by SHU336_VALUE.
  - value !== "none" && (await input.eligible(value)) === "ineligible" becomes false, killed by SHU336_BUILDER. If it appears once for preview and once for confirm, mutate both in one mutant and check both bind.
  - return current === expected; becomes return true;, killed by SHU336_STALE.

  The exact anchors depend on how tsc prints them: take each from dist/account-manager-writes.js after npm run build, assert it binds once (or as stated), and print 6/6 SHU336 mutations killed.
- packages/db/test/postgres-organization-account-manager.test.ts (new; fixtures as in postgres-organization-approved-to-hire.test.ts, a ROOT operator and a company ORG under it):
  - "SHU336_PG_ASSIGN ...":
    - An admin (subtree on ROOT) previews and confirms a staff principal who holds a staff grant on ORG. manager(admin, ORG) gives that principalId and displayName, and a staff reader gets the same answer.
    - The single audit row has operation ORGANIZATION_ACCOUNT_MANAGER_OPERATION, target_org_refs [organizationAuditRef(ORG)] and fields ["account_manager"], and its summaries contain neither principal id.
    - Clearing with "none" gives { manager: null } and a second audit row.
  - "SHU336_PG_REFUSED ...":
    - A staff writer and an org-owner writer preview as not_own_record.
    - An org-owner reader gets null from manager.
    - With the admin as caller, eligible is "ineligible" for an org-owner of ORG, a staff person whose grant is on another company, and an unknown principal. With a staff caller or an org-owner caller, eligible is "refused" for an eligible staff assignee and for an ineligible one alike, and the writer previews both as not_own_record (no assignee oracle).
    - An assignee whose staff grant is revoked between preview and confirm makes confirm answer invalid_value through the builder's eligible check. Then build a second writer with eligible: async () => "eligible", so only the store's own re-check stands: the same revocation makes confirm answer state_changed. Both leave no row and no audit row.
  - "SHU336_PG_STALE ...": a stale confirm is state_changed and a second confirm of one token is token_already_used, each leaving the row and the audit count unchanged.
  - "SHU336_PG_DELETED ...": on its own fresh company, the admin previews an assignment, then an organization_deletions row is inserted for that company. The confirm answers not_own_record with no row and no audit row, a new preview is not_own_record, and manager answers null.
  - In your final message, report by hand that dropping the assignee re-check (step 5 of #commit) makes the second revocation case in SHU336_PG_REFUSED fail.
- postgres-authz-store.test.ts: only add "0204_organization_account_managers" after "0203_organization_creation" at :1584 and :1637.
- apps/gateway/test/organization-account-manager-http.test.ts: "SHU336_HTTP ...", with an in-memory store fake that records calls, through the real handler.
  - It covers preview and confirm, a receipt, an ineligible assignee (400 invalid_value), a refused writer (404, the same for an eligible and an ineligible assignee) and a stale confirm (409).
  - It covers GET of the manager (200 with null and with a manager, 404 for a refused reader), unknown body keys (400), a bad origin (403) and a missing session (401).
  - With a service built without a secret, GET of the manager still answers 200 and preview, confirm and a receipt answer 503 safe_write_unavailable.
  - It asserts that the origin, session and method refusals reach no store call.
- package.json: leave every script's text as it is, with these additions:
  - Append dist/packages/organizations/test/account-manager-writes.test.js and dist/apps/gateway/test/organization-account-manager-http.test.js at the END of the node --test list in test.
  - Append dist/packages/db/test/postgres-organization-account-manager.test.js at the END of the test:db list.
  - Add "test:organization-account-manager:mutations": "node packages/organizations/test/account-manager-writes-mutations.mjs", chained into test as  && npm run test:organization-account-manager:mutations right after npm run test:organization-creation:mutations.

  Never change dependencies.

Out of scope:
- The staff "my companies" list (AssignedList) and any directory filter or column for the account manager (a later card), showing the manager on the workspace card or any HTML, and notifying the manager.
- Assigning several managers, follow-up fields (OR-10, D-OR3), and grants or membership (O4).
- The read model, approved-to-hire, status and every other write.
- Any change to packages/contracts, packages/safe-write-contract, the login and session flow (login-application.ts, the session store and the auth middleware), and the lockfile. login-runtime.ts and index.ts are in scope only for the wiring the Design section names, and nothing else in them changes.
- Any network call, credential, staging or production access.

Finish with npm run typecheck and npm test passing, run to the end. If a test cannot run in your sandbox (for example because it opens a network listener), say which one and why in your final message rather than working around it or changing it. In your final message, list the files you changed and how each acceptance item is pinned.`;

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
  "SHU-308": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU308_PATHS,
    revision_paths: SHU308_PATHS,
    acceptance: SHU308_ACCEPTANCE,
    brief: SHU308_BRIEF,
  }),
  "SHU-309": Object.freeze({
    initial_build_paths: SHU309_PATHS,
    revision_paths: SHU309_PATHS,
    acceptance: SHU309_ACCEPTANCE,
    brief: SHU309_BRIEF,
  }),
  "SHU-311": Object.freeze({
    initial_build_paths: SHU311_PATHS,
    revision_paths: SHU311_PATHS,
    acceptance: SHU311_ACCEPTANCE,
    brief: SHU311_BRIEF,
  }),
  "SHU-313": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU313_PATHS,
    revision_paths: SHU313_PATHS,
    acceptance: SHU313_ACCEPTANCE,
    brief: SHU313_BRIEF,
  }),
  "SHU-314": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU314_PATHS,
    revision_paths: SHU314_PATHS,
    acceptance: SHU314_ACCEPTANCE,
    brief: SHU314_BRIEF,
  }),
  "SHU-315": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU315_PATHS,
    revision_paths: SHU315_PATHS,
    acceptance: SHU315_ACCEPTANCE,
    brief: SHU315_BRIEF,
  }),
  "SHU-316": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU316_PATHS,
    revision_paths: SHU316_PATHS,
    acceptance: SHU316_ACCEPTANCE,
    brief: SHU316_BRIEF,
  }),
  "SHU-317": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU317_PATHS,
    revision_paths: SHU317_PATHS,
    acceptance: SHU317_ACCEPTANCE,
    brief: SHU317_BRIEF,
  }),
  "SHU-318": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU318_PATHS,
    revision_paths: SHU318_PATHS,
    acceptance: SHU318_ACCEPTANCE,
    brief: SHU318_BRIEF,
  }),
  "SHU-319": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU319_PATHS,
    revision_paths: SHU319_PATHS,
    acceptance: SHU319_ACCEPTANCE,
    brief: SHU319_BRIEF,
  }),
  "SHU-320": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU320_PATHS,
    revision_paths: SHU320_PATHS,
    acceptance: SHU320_ACCEPTANCE,
    brief: SHU320_BRIEF,
  }),
  "SHU-323": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU323_PATHS,
    revision_paths: SHU323_PATHS,
    acceptance: SHU323_ACCEPTANCE,
    brief: SHU323_BRIEF,
  }),
  "SHU-324": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU324_PATHS,
    revision_paths: SHU324_PATHS,
    acceptance: SHU324_ACCEPTANCE,
    brief: SHU324_BRIEF,
  }),
  "SHU-325": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU325_PATHS,
    revision_paths: SHU325_PATHS,
    acceptance: SHU325_ACCEPTANCE,
    brief: SHU325_BRIEF,
  }),
  "SHU-326": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU326_PATHS,
    revision_paths: SHU326_PATHS,
    acceptance: SHU326_ACCEPTANCE,
    brief: SHU326_BRIEF,
  }),
  "SHU-327": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU327_PATHS,
    revision_paths: SHU327_PATHS,
    acceptance: SHU327_ACCEPTANCE,
    brief: SHU327_BRIEF,
  }),
  "SHU-328": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU328_PATHS,
    revision_paths: SHU328_PATHS,
    acceptance: SHU328_ACCEPTANCE,
    brief: SHU328_BRIEF,
  }),
  "SHU-329": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU329_PATHS,
    revision_paths: SHU329_PATHS,
    acceptance: SHU329_ACCEPTANCE,
    brief: SHU329_BRIEF,
  }),
  "SHU-164": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU164_PATHS,
    revision_paths: SHU164_PATHS,
    acceptance: SHU164_ACCEPTANCE,
    brief: SHU164_BRIEF,
  }),
  "SHU-168": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU168_PATHS,
    revision_paths: SHU168_PATHS,
    acceptance: SHU168_ACCEPTANCE,
    brief: SHU168_BRIEF,
  }),
  "SHU-331": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU331_PATHS,
    revision_paths: SHU331_PATHS,
    acceptance: SHU331_ACCEPTANCE,
    brief: SHU331_BRIEF,
  }),
  "SHU-332": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU332_PATHS,
    revision_paths: SHU332_PATHS,
    acceptance: SHU332_ACCEPTANCE,
    brief: SHU332_BRIEF,
  }),
  "SHU-333": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU333_PATHS,
    revision_paths: SHU333_PATHS,
    acceptance: SHU333_ACCEPTANCE,
    brief: SHU333_BRIEF,
  }),
  "SHU-334": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU334_PATHS,
    revision_paths: SHU334_PATHS,
    acceptance: SHU334_ACCEPTANCE,
    brief: SHU334_BRIEF,
  }),
  "SHU-335": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU335_PATHS,
    revision_paths: SHU335_PATHS,
    acceptance: SHU335_ACCEPTANCE,
    brief: SHU335_BRIEF,
  }),
  "SHU-336": Object.freeze({
    workspace_mode: "repo",
    initial_build_paths: SHU336_PATHS,
    revision_paths: SHU336_PATHS,
    acceptance: SHU336_ACCEPTANCE,
    brief: SHU336_BRIEF,
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
