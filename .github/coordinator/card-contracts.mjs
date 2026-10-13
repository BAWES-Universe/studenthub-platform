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
