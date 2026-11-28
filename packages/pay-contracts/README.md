# Pay contracts

This package contains the domain rules for recording, changing and reading pay
contracts. It also validates and safely writes candidate bank details in the
canonical form used when producing bank files, and resolves the effective pay
terms for a transfer. [src/index.ts](src/index.ts) is the public barrel for the
modules described below.

## Contracts and their terms

| Source | Behaviour and principal exports |
| --- | --- |
| [types.ts](src/types.ts) | Defines the contract aggregate, its hourly, fixed-price and monthly-salary terms, status and audit shapes, plus the storage and finance-catalogue ports. Principal exports include `PAY_MODELS`, `PayModel`, `ContractTerms`, `PayContract`, `PayContractAudit`, `PayContractStore`, `PayContractTransaction` and `FinanceReferenceResolver`. |
| [decimal.ts](src/decimal.ts) | Parses exact non-negative decimal values into a canonical three-place string and compares them through integer thousandths rather than floating-point arithmetic. Principal exports are `canonicalDecimal`, `thousandths`, `compareDecimal` and `isPositiveDecimal`. |
| [contracts.ts](src/contracts.ts) | Normalizes create and replace-style update payloads, validates the three pay models and date ranges, rejects overlapping live contracts for the same candidate and store, and performs create, update and soft-delete operations with their audit entry in the store transaction. Principal exports include `PayContracts`, `PayContractError`, `normalizeTerms`, `normalizePayContractCreate`, `normalizePayContractUpdate`, `overlaps`, `NormalizedPayContractCreate`, `NormalizedPayContractUpdate` and `isPayModel`. |
| [resolution.ts](src/resolution.ts) | Selects the applicable non-deleted contract for a transfer period, refuses ambiguous or inapplicable selections, and otherwise resolves guarded manual hourly-rate fallbacks. Its result includes the ordered reasoning steps but does not calculate a payable amount. Principal exports include `resolveEffectiveRate`, `matchContracts`, `isCalendarDate`, `RateResolution`, `RateResolutionInput`, `RateResolutionError`, `ResolutionStep` and `RATE_RESOLUTION_VERSION`. |

## Writes and changes

| Source | Behaviour and principal exports |
| --- | --- |
| [contract-writes.ts](src/contract-writes.ts) | Adapts contract creation to the safe-write preview/confirm contract. It creates canonical values and opaque references, decides company write access, checks the candidate, currency and overlap before preview and confirm, and invokes `PayContracts.create` at commit. Principal exports include `PAY_CONTRACT_CREATE_FIELD`, `PAY_CONTRACT_CREATE_POLICY`, `payContractCreateValue`, `payContractCompanyRecordRef`, `payContractPrincipalRef`, `payContractWriteDecision`, `payContractCreateCheck`, `buildPayContractCreateWrite`, `payContractCreator` and `PayContractSafeWriteStore`. |
| [contract-changes.ts](src/contract-changes.ts) | Adapts replace-style edits and removals to safe-write preview/confirm, binding confirmation to the current editable value. It checks canonical input, currency changes and overlaps before applying `PayContracts.update` or `PayContracts.remove`. Principal exports include `PAY_CONTRACT_TERMS_FIELD`, `PAY_CONTRACT_REMOVAL_FIELD`, `PAY_CONTRACT_CHANGE_POLICY`, `payContractRecordRef`, `payContractTermsValue`, `payContractEditableValue`, `payContractStateDecision`, `payContractChangeCheck`, `buildPayContractChangeWrite` and `payContractChanger`. |

## Reads and views

| Source | Behaviour and principal exports |
| --- | --- |
| [contract-reads.ts](src/contract-reads.ts) | Decides whether grants receive a full or company view, and projects each non-deleted contract so company and candidate views expose only their respective side of the terms. Principal exports are `PayContractView`, `payContractReadAccess`, `projectPayContract` and `payContractListView`. |

## Bank details and bank-file values

| Source | Behaviour and principal exports |
| --- | --- |
| [bank.ts](src/bank.ts) | Normalizes and validates IBANs and beneficiary names, validates the closed bank-details shape, and checks that its bank is active through the finance reference port. The normalized beneficiary name is the value carried into bank files. Principal exports include `BankDetails`, `BankDetailError`, `IBAN_LENGTHS`, `BENEFICIARY_NAME_FORBIDDEN_RANGES`, `normalizeIban`, `ibanChecksumValid`, `normalizeBeneficiaryName`, `normalizeBankDetails` and `validateBankDetails`. |
| [bank-write.ts](src/bank-write.ts) | Treats bank, IBAN and beneficiary name as one canonical JSON field and adapts it to safe-write preview/confirm. It checks candidate ownership and revalidates the catalogue-backed value at both stages. Principal exports include `BANK_DETAILS_FIELD`, `BANK_DETAILS_POLICY`, `bankDetailsValue`, `parseBankDetailsValue`, `candidateBankOwnerDecision`, `bankDetailsRecordRef`, `catalogueBankDetailsCheck`, `buildBankDetailsWrite`, `BankDetailsValueCheck` and `BankDetailsBuildInput`. |
| [name-code-points.ts](src/name-code-points.ts) | Internal to this package and not re-exported by `src/index.ts`. It holds the explicit forbidden code-point ranges used by [bank.ts](src/bank.ts) when normalizing beneficiary names. |

## Shared in-memory implementations

| Source | Behaviour and principal exports |
| --- | --- |
| [memory-store.ts](src/memory-store.ts) | Supplies a serialized, commit-or-rollback contract store and a configurable finance-reference resolver for synthetic tests and local use. Principal exports are `InMemoryPayContractStore` and `InMemoryFinanceReferenceResolver`. |

## Gateway composition

[apps/gateway/src/wiring/pay-contracts.ts](../../apps/gateway/src/wiring/pay-contracts.ts)
constructs the PostgreSQL contract, reference and safe-write stores, applies the
package's access and validation decisions, and passes them to the gateway service.
[apps/gateway/src/pay-contracts-http.ts](../../apps/gateway/src/pay-contracts-http.ts)
serves contract creation, change, receipt and list operations through that service.

[apps/gateway/src/bank-details.ts](../../apps/gateway/src/bank-details.ts) validates,
previews, confirms and serves receipts for a signed-in candidate's own bank details.
The persistence adapter is
[packages/db/src/postgres-bank-details-store.ts](../db/src/postgres-bank-details-store.ts),
which binds the package's safe-write field to the candidate bank-details row and
stores the mutation receipt in the same transaction.

## Build and test

Run commands from the repository root. The package's
[package.json](package.json) defines `npm run build` as
`tsc -p tsconfig.build.json`. The package tests in [test/](test/) cover contract
normalization and lifecycle rules, effective-rate resolution, atomic audit writes,
bank validation and safe writes, contract creation and change safe writes, access
projections, replay/state changes, and mutation checks.

For repository-wide verification, run:

```sh
npm run typecheck
npm test
```
