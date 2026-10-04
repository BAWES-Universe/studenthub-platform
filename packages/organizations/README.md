# Organization read model (SHU-159, slice O1)

One `organization` read model replacing the four legacy `Company` projections
(`company/`, `manager/`, `staff/` and `admin/models/Company.php`). Parity
authority: `BAWES-Universe/studenthub` at
`c2ce255695eabc7e3a0f23b162f5996274234c63`, as inventoried in
`docs/parity/organizations-stores-and-contacts.md` §2–§3.

Read only. Writes belong to O2–O6.

## Access

`OrganizationRepository.read({ principalId, orgId, role })` resolves the
caller's grant with the shared `resolveActiveContext` on every call. A record
the caller cannot read is `not_found`, the same answer as a missing one:

- a self grant at a parent does not cover its sub-organizations; only an
  explicit `subtree` grant does;
- a recruiter on one sub-organization cannot read its sibling or its parent;
- `candidate` and `finance` have no organization projection;
- the operator organization (`root`, where staff and admin grants live) is not
  itself a readable organization.

## One closed projection per audience

| Role | Audience | Fields |
|---|---|---|
| `org-owner`, `recruiter` | employer | legal and common names, descriptions, website, currency, approved to hire, status, hourly rate |
| `staff` | staff | employer fields + company email + staff-set status override |
| `admin` | admin | staff fields + bonus commission |

Never in any projection: legacy credential columns (`company_auth_key`,
password hash, reset token), commercial licence and logo object keys, the
account-manager staff id, follow-up CRM fields and timestamps. Store managers
have no platform role yet; their projection arrives with the store-scoped
grant (I4). Counters such as total candidates and stores belong to O10.

Deliberate differences from legacy, each recorded here rather than inferred:

- the employer receives `company_description_ar` (legacy listed the English key
  twice, so the Arabic one was dropped by accident) and no longer receives the
  raw `company_status_override`;
- staff no longer receive the whole row (`parent::fields()` included the
  credential columns);
- the website is returned as recorded; the staff-only `http://` prefixing is a
  display concern.

## One status derivation

Legacy derived `company_status` in four places and two of them ignored the
override (finding OR-F2), so an employer and staff could see different statuses
for the same company. Here there is one rule, used for every audience:

1. `company_status_override` of 10 (active) or 9 (under review) wins. As in
   legacy, 0 or false is the column default and means "no override".
2. Otherwise the organization is active when any of `total_candidate`,
   `is_request_updates_in_30_days` or `no_of_active_requests` is positive, and
   inactive when all are zero.
3. A missing counter is never treated as zero: with no positive counter and any
   counter missing, status is `unavailable`.

The stored `company_status` column is never read.

## One level of hierarchy

A sub-organization's parent must be a top-level organization. A registry that
places an organization below a sub-organization is refused (`unavailable`), and
so is a snapshot whose parent disagrees with the registry that grants resolve
against. This bounds depth only: any number of direct sub-organizations is
allowed.

`hourlyRate` and `bonusCommission` fall back to the parent's value when the
organization's own value is not recorded, as both legacy projections do. Rates
are exact decimal strings.

## Data source

`ApprovedOrganizationAdapter` is a seam for an approved, already-linked
`company` snapshot. Runtime wiring uses the unconfigured adapter, so every
imported field shows as `unavailable` with reason `not_imported` while the
registry name still identifies the organization. The in-memory adapter and
`SYNTHETIC_ORGANIZATION_FIXTURES` are synthetic and for tests and local preview
only.

## Company directory (SHU-163, slice O5 read half)

`OrganizationRepository.listOrganizations({ principalId, orgId, role, filters, page })`
is the staff and admin company list (OR-05). It is read only; creating
companies, commercial terms, status changes and account-manager assignment are
writes and wait for the platform's first safe-write path (SHU-84).

- Only `staff` and `admin` list. Every other role is `not_found`, as is a
  context the caller holds no grant at.
- The active context is re-resolved on every call, and the list holds the
  companies the caller's current grants cover **under that role and within
  that context**. A staff grant without `subtree` at the operator root covers
  no company, and another role's grant is never borrowed.
- As in legacy (`filterParent`), entries are top-level companies. Each carries
  the number of sub-organizations the caller's grants cover; sub-organizations
  open from their parent. A nested registry refuses the whole list.
- Entries are a closed set: registry name, legal and common names, currency,
  approved to hire, status and the sub-organization count. No email, rates,
  commission or legacy credential column.
- Filters: a case-insensitive search over the legal, English, Arabic and
  registry names, plus status, approved to hire and currency. A filter on a
  field that is unavailable for a company never matches it. Twenty per page,
  ordered by registry name.
- A malformed or unreadable snapshot refuses the list (`unavailable`) instead
  of quietly leaving a company out.

Deliberate differences from the legacy staff `List`
(`staff/modules/v1/controllers/CompanyController.php` at the pin):

- Status filters use the one derivation above. Legacy filtered "active" on the
  counters only and "under review" on the override, so a company under review
  with activity appeared under both.
- No implicit currency: legacy defaulted the `Currency` header to `KWD`, so a
  list without the header silently hid other currencies. Here currency is an
  explicit, optional filter.
- Not carried yet: the 40-day payment and request filters, `have_students` and
  the account-manager filter. Each needs data this read model does not import
  (payments, requests, counters in O10, the account manager in the write half).

The gateway serves it at `/workspace/companies?org_id=…&role=…` with the same
closed query vocabulary (`q`, `status`, `approved`, `currency`, `page`), and the
workspace shows a Companies link only for a staff or admin context.

## Tests

`dist/packages/organizations/test/organizations.test.js` names each acceptance
bullet `SHU-159/AC-NN` plus the contract scenario `SHU-159/parity-contract`.
`npm run test:organizations:mutations` applies 11 deliberate breaks to the built
module and requires the named test to fail by assertion each time, with the
suite green before and after.

`dist/packages/organizations/test/organization-directory.test.js` names the
directory acceptance `SHU-163/AC-01`–`AC-06` plus `SHU-163/parity-contract`;
`npm run test:organization-directory:mutations` applies 13 breaks the same way.
The gateway page is `SHU-163/AC-07`–`AC-08` in
`apps/gateway/test/company-directory.test.ts`, with 5 mutants in
`company-directory-mutations.mjs`.
