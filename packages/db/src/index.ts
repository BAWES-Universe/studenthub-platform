/**
 * @studenthub/db — the platform's Postgres data layer (SHU-55).
 *
 * Deliberately thin: one AuthzStore implementation behind the EXACT
 * contracts interfaces, a versioned migration runner, and admin seeding.
 * Raw `pg` only — no ORM, no query builder (architecture decision, SHU-55).
 */
export { PostgresAuthzStore } from "./postgres-authz-store.js";
export {
  AUTHORIZATION_MUTATION_OPERATIONS,
  organizationAuditRef,
  principalAuditRef,
  requestAuditRef,
  type AuthorizationMutationAuditRecord,
  type AuthorizationMutationContext,
  type AuthorizationMutationOperation,
} from "./authorization-audit.js";
export {
  LANGUAGE_FIELD,
  LANGUAGES,
  PostgresSafeWriteStore,
  SAFE_WRITE_OPERATION,
  personRecordRef,
  safeWritePrincipalRef,
  type Language,
} from "./safe-write-store.js";
export { PostgresLoginStore } from "./postgres-login-store.js";
export { PostgresPersonProfileStore, PERSON_PROFILE_OPERATION, type PersonProfileRead } from "./person-profile-store.js";
export { PostgresCatalogueStore } from "./postgres-catalogue-store.js";
export { PostgresProfileRecordStore, PostgresReferenceResolver } from "./postgres-profile-records-store.js";
export { PostgresFinanceReferenceResolver, PostgresPayContractStore } from "./postgres-pay-contract-store.js";
export { runMigrations } from "./migrate.js";
export { bootstrapAdmin, type BootstrapResult } from "./bootstrap-admin.js";
export { DEFAULT_DATABASE_URL, databaseUrl } from "./connection.js";
export { PostgresOrganizationProfileStore, ORGANIZATION_PROFILE_OPERATION,
  type PostgresOrganizationProfileStoreOptions } from "./postgres-organization-profile-store.js";
export { PostgresOrganizationProfileReads } from "./postgres-organization-profile-reads.js";
export { PostgresBankDetailsStore, BANK_DETAILS_OPERATION,
  type PostgresBankDetailsStoreOptions } from "./postgres-bank-details-store.js";
export {PostgresOrganizationStatusStore,ORGANIZATION_STATUS_OPERATION,type PostgresOrganizationStatusStoreOptions} from "./postgres-organization-status-store.js";
export {PostgresOrganizationCommercialTermsStore,ORGANIZATION_COMMERCIAL_TERMS_OPERATION,type PostgresOrganizationCommercialTermsStoreOptions} from "./postgres-organization-commercial-terms-store.js";
export {PostgresOrganizationApprovedToHireStore,ORGANIZATION_APPROVED_TO_HIRE_OPERATION,type PostgresOrganizationApprovedToHireStoreOptions} from "./postgres-organization-approved-to-hire-store.js";
export {PostgresOrganizationNotesStore,ORGANIZATION_NOTES_OPERATION,type OrganizationNoteDbRow} from "./postgres-organization-notes-store.js";
export {PostgresOrganizationBrandsStore,ORGANIZATION_BRAND_LINK_OPERATION,ORGANIZATION_BRAND_UNLINK_OPERATION} from "./postgres-organization-brands-store.js";
export {PostgresOrganizationStoresStore,ORGANIZATION_STORE_CREATE_OPERATION,ORGANIZATION_STORE_UPDATE_OPERATION,ORGANIZATION_STORE_REMOVE_OPERATION,type OrganizationStoreInput,type OrganizationStoreRecord,type OrganizationStoreCreateResult,type OrganizationStoreUpdateResult,type OrganizationStoreRemoveResult} from "./postgres-organization-stores-store.js";
export {PostgresOrganizationCreationStore,ORGANIZATION_CREATE_OPERATION,type OrganizationCreateResult} from "./postgres-organization-creation-store.js";
export {PostgresOrganizationDeletionStore,ORGANIZATION_DELETION_OPERATION,type PostgresOrganizationDeletionStoreOptions} from "./postgres-organization-deletion-store.js";
export {PostgresPayContractSafeWriteStore,PAY_CONTRACT_CREATE_SAFE_WRITE_OPERATION,type PostgresPayContractSafeWriteStoreOptions} from "./postgres-pay-contract-safe-write-store.js";
export {PostgresOrganizationAccountManagerStore,ORGANIZATION_ACCOUNT_MANAGER_OPERATION,type PostgresOrganizationAccountManagerStoreOptions} from "./postgres-organization-account-manager-store.js";
export {PostgresOrganizationAccountManagerReads} from "./postgres-organization-account-manager-reads.js";
