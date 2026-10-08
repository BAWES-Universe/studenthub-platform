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
export { PostgresCatalogueStore } from "./postgres-catalogue-store.js";
export { PostgresProfileRecordStore, PostgresReferenceResolver } from "./postgres-profile-records-store.js";
export { PostgresFinanceReferenceResolver, PostgresPayContractStore } from "./postgres-pay-contract-store.js";
export { runMigrations } from "./migrate.js";
export { bootstrapAdmin, type BootstrapResult } from "./bootstrap-admin.js";
export { DEFAULT_DATABASE_URL, databaseUrl } from "./connection.js";
export { PostgresOrganizationProfileStore, ORGANIZATION_PROFILE_OPERATION,
  type PostgresOrganizationProfileStoreOptions } from "./postgres-organization-profile-store.js";
export { PostgresBankDetailsStore, BANK_DETAILS_OPERATION,
  type PostgresBankDetailsStoreOptions } from "./postgres-bank-details-store.js";
export { PostgresCandidateProfileStore, CANDIDATE_PROFILE_OPERATION,
  type PostgresCandidateProfileStoreOptions } from "./postgres-candidate-profile-store.js";
