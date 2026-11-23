# Access

Access supplies StudentHub's grant, team, contact, registration and account-access
rules. [src/index.ts](src/index.ts) exports the twelve modules below. There is no
package manifest here: the [root TypeScript build](../../tsconfig.build.json)
compiles this directory, and consumers import its source entry point by relative
path. HTTP handlers live in the gateway; PostgreSQL implementations live in
[the database access area](../db/src/access/index.ts).

## Grants

- [grant-catalogue.ts](src/grant-catalogue.ts) defines `grantCovers`,
  `grantCatalogue`, `catalogueAllows` and `mayOpenAccessAdmin`. A grant covers its
  own organization, plus descendants at `subtree` scope. An operator admin can
  grant `staff`, `admin` and `finance` on an operator organization. On a company,
  covering admins and staff can grant `org-owner`, `recruiter` and `finance`;
  only admins can offer `subtree` there. The catalogue never offers `candidate`.
  Opening Access administration requires an operator admin grant with valid
  scope, or an operator staff grant at `subtree` scope.
- [grant-change.ts](src/grant-change.ts) parses a `GrantChangeRequest`, decides
  changes with `decideGrantChange`, and issues/verifies `GrantToken` values.
  Self-changes, unauthorized changes and removal of the last operator admin
  are refused. A role already held at the requested scope or wider is unchanged.
  Tokens bind caller, exact request (including reason), prior scope and a
  15-minute deadline; cryptographic verification alone does not enforce reuse.
- [grant-service.ts](src/grant-service.ts) exposes `createAccessGrantService`:
  `preview` reads a snapshot and returns either an unchanged result or a token;
  `confirm` verifies it and delegates to `AccessGrantWriteStore.apply`. The store
  must re-read and decide inside its transaction, check the prior state and
  consume the token once. `AccessReadStore` supplies people, organizations,
  grants, history and own-access rows; `parsePeopleQuery` validates searches.
  [PostgresAccessGrantsStore](../db/src/access/postgres-access-grants-store.ts)
  implements the transaction, token replay/state checks and audit writes.

## Invitations and their records

[invitations.ts](src/invitations.ts) contains the pure decisions. `teamCatalogue`
lets a covering company owner invite `org-owner`, `recruiter` or `finance`, at
no wider scope than their own covering owner grant. `decideInvite` checks the
company, inviter rights, duplicate pending invitations and the cap of 50 pending
invitations. Tokens contain 32 random bytes, have a seven-day lifetime, and are
stored as a domain-separated hash. `decideAccept` rechecks expiry, use/revocation,
company liveness and the inviter's current authority, then matches the signed-in
principal's current email. Dead links return `invalid`; an address mismatch is
`wrong_address`. `decideRemove` removes only direct company grants and protects
the last direct owner.

[invitation-service.ts](src/invitation-service.ts) exposes
`createCompanyTeamService`, with `team`, `invite`, `revoke`, `remove`,
`removeStoreManager`, `invitation` and `accept`. `InvitationStore` is its persistence
port. `TeamMember`, `PendingInvitation` and `StoreManagerListRow` are list records;
`PendingInvitation` includes an optional store, email, role, scope, inviter and
expiry, but no raw token. The invitation landing-page projection omits the email.
[PostgresAccessInvitationsStore](../db/src/access/postgres-access-invitations-store.ts)
stores invitation hashes and lifecycle timestamps, and makes acceptance and its
grant/audit changes transactional. These are company-access invitations, not
recruitment invitations.

[invitation-mail.ts](src/invitation-mail.ts) defines `InvitationMessage` and the
`InvitationMailer.send` port. `NO_SEND_INVITATION_MAILER` returns false;
`recordingInvitationMailer` captures messages for tests and previews. The service
defaults to no-send and returns the newly created link even if mail delivery or
the post-save context lookup fails. Current
[gateway wiring](../../apps/gateway/src/wiring/access-lane.ts) supplies no mailer,
so this path does not send email. The inviting user receives the link to copy.

## Registration and contacts

[company-registration.ts](src/company-registration.ts) defines form parsers,
`CompanyRegistration` records, `CompanyRegistrationStore` and
`createCompanyRegistrationService`. The store handles submission, the submitter's
list and the review queue; the service delegates review with `decideReview`.
Review requires Access-administration authority, a pending request and a different
reviewer from the submitter. Approval additionally refuses an occupied company
name or paused submitter. The
[registration adapter](../db/src/access/postgres-access-registrations-store.ts)
creates the company under the configured operator organization, marks it active
and approved to hire, and grants the submitter `org-owner` at `self` scope in one
transaction. The [HTTP handler](../../apps/gateway/src/access/company-registration.ts)
provides signed-in submission and the staff review queue.

[company-contacts.ts](src/company-contacts.ts) keeps extra contacts separate from
login identities and grants. `ContactInput`/`CompanyContact` carry a name, optional
title and up to five phone and five email channels. `parseContactForm` normalizes
channels; callers must reject unknown form keys. Covering owners, recruiters,
finance members, staff and admins can read; only owners, staff and admins can
write. `createCompanyContactsService` offers `view`, `create`, `update` and
`remove`, passing `decideContactWrite` into the store transaction. Creation is
capped at 200 live contacts per company. Persistence is in
[PostgresAccessContactsStore](../db/src/access/postgres-access-contacts-store.ts).

## Store access

[store-access.ts](src/store-access.ts) defines `STORE_MANAGER`, `ManagedStoreRow`,
`storeAccessHolds`, `managedStores` and `openManagedStore`. Store-manager access is
a separate store/principal record, not an organization role in `grants`. It holds
only while unrevoked, the store is active and its company is live. Filtering also
checks the principal and, when opening a store, its ID. Covering owners, staff
and admins can offer/remove access to an active store of that company.

The invitation decisions and service above support store-manager invitations
with one store ID and `self` scope. Acceptance creates store access instead of a
company role. [PostgresAccessStoreManagersStore](../db/src/access/postgres-access-store-managers-store.ts)
reads the joined store/company/access rows;
[the manager handler](../../apps/gateway/src/access/store-manager.ts) uses the
domain filters for the caller's stores and single-store page.

## Account pause

[account-pause.ts](src/account-pause.ts) provides `parsePauseRequest`,
`mayPauseAccount`, `decidePause`, `AccountPauseStore` and
`createAccountPauseService`. A reason is required. Access administrators may
pause/resume other people; targeting an operator staff member or admin requires
an operator admin. Self-changes are refused. The service passes its decision
into the store rather than performing persistence itself.

[PostgresAccessPausesStore](../db/src/access/postgres-access-pauses-store.ts)
records the suspended company and store grants, removes/revokes them and deletes
login sessions transactionally. Resume restores eligible grants and returns
`restored` and `leftOut` counts. Its `paused` port supports batch reads.
[Gateway wiring](../../apps/gateway/src/wiring/access-lane.ts) enables grant and
pause write services only when its safe-write key setting is present; the pause
service itself does not implement the grant preview-token flow.

## Abuse handling and staff view

[abuse.ts](src/abuse.ts) defines `PERSON_LIMITS`: 120 writes per 600 seconds and
30 uploads per 3,600 seconds, in fixed per-person windows. `limitKind` classifies
writes/uploads, including the JSON organization-document upload routes;
`decideLimit` returns allow or a retry delay. `AbuseStore` supplies counters and
address-block persistence. `parseCidr`, `blockListOf` and `listed` handle separate
IPv4/IPv6 lists; `clientAddress` trusts forwarding headers only behind a configured
trusted peer and walks the chain from the right. `parseTrustedProxies` rejects
malformed configuration. Only an operator admin passes `mayManageBlocks`.
Enforcement is in [abuse-gate.ts](../../apps/gateway/src/access/abuse-gate.ts),
backed by [PostgresAccessAbuseStore](../db/src/access/postgres-access-abuse-store.ts).

[staff-view.ts](src/staff-view.ts) defines `parseStaffViewRequest`, `mayViewAs`,
`viewOpen`, `StaffView` and `StaffViewStore`. Permission uses the same caller/target
rule as account pause. Views require a reason and last at most 15 minutes;
the expiry instant is excluded. The
[staff-view adapter](../db/src/access/postgres-access-staff-views-store.ts) records
both identities and the reason. The
[gateway staff-view handler](../../apps/gateway/src/access/staff-view.ts) renders
the person's profile read-only without creating a session as that person.
[Your access](../../apps/gateway/src/access/admin-access.ts) shows the person's
staff-view dates without staff names.

## Actual importers and integration points

All gateway imports below use the relative `src/index.ts` entry point (spelled
`.js` in TypeScript imports). This table distinguishes direct imports from
structurally compatible database adapters.

| Area | Direct gateway consumer |
| --- | --- |
| Grant catalogue, parsing, tokens and service/read types; pause rules and types | [admin-access.ts](../../apps/gateway/src/access/admin-access.ts) |
| Team service/view types, invitation constants/token shape, store-manager constant and contacts types | [company-team.ts](../../apps/gateway/src/access/company-team.ts) |
| Contacts parser, constants and types | [company-contacts.ts](../../apps/gateway/src/access/company-contacts.ts) |
| Registration parsers, review permission and records/service/store types | [company-registration.ts](../../apps/gateway/src/access/company-registration.ts) |
| Store filters and row type | [store-manager.ts](../../apps/gateway/src/access/store-manager.ts); `managedStores` also in [gateway entry](../../apps/gateway/src/index.ts) |
| Abuse rules and ports | [abuse-gate.ts](../../apps/gateway/src/access/abuse-gate.ts) |
| Address helpers | [comms wiring](../../apps/gateway/src/comms/wiring.ts); `clientAddress` and `AddressList` in [ID-card HTTP](../../apps/gateway/src/reports/id-cards-http.ts) |
| Staff-view rules and store type, plus Access read/permission helpers | [staff-view.ts](../../apps/gateway/src/access/staff-view.ts) |
| Grant, team, contacts, pause and registration service factories; proxy helpers | [access-lane.ts](../../apps/gateway/src/wiring/access-lane.ts) |

The [database adapters](../db/src/access/index.ts) use structural types and
decision callbacks, not imports from this package. Their
[database tests](../db/test/) do import the access service factories and helpers
for integration tests. [Package tests](test/) import the domain entry point;
[gateway tests](../../apps/gateway/test/) import its factories, helpers and types.
There is no direct access-package import in the worker app at this base.
`InvitationMailer` has no production sender importer; its recording implementation
is used by [invitation tests](test/invitations.test.ts) and
[database invitation tests](../db/test/postgres-access-invitations.test.ts).
The [legacy contacts mapper](../../tools/legacy-import/src/m4-contacts.ts) imports
contact limits and phone normalization directly from `company-contacts.ts`, and
email normalization directly from `invitations.ts`; this is a source reference,
not an instruction to run an import.

## Verification

Run commands from the repository root. Definitions are in
[package.json](../../package.json); suite discovery and database selection are in
[the test runner](../../tools/test-runner/run.mjs) and its
[baseline](../../tools/test-runner/baseline.json).

| Command | Purpose |
| --- | --- |
| `npm ci` | Install the locked workspace dependencies. |
| `npm run typecheck` | Build prerequisite workspaces and check root TypeScript without emitting it. |
| `npm test` | Build, then run the default test-runner groups, including access tests and mutations. |
| `npm run test:db` | Build, then run database suites; requires disposable PostgreSQL 17 configured through `DATABASE_URL`. |

The [test-running guide](../../docs/runbooks/running-tests.md) explains database
setup and runner prerequisites. See [grant tests](test/grant-writes.test.ts),
[invitations](test/invitations.test.ts), [contacts](test/company-contacts.test.ts),
[registration](test/company-registration.test.ts), [stores](test/store-access.test.ts),
[pause](test/account-pause.test.ts), [abuse](test/abuse.test.ts) and
[staff view](test/staff-view.test.ts) for executable behavior checks. Test results
for this documentation change are recorded in the PR's Evidence section; they do
not establish live acceptance.
