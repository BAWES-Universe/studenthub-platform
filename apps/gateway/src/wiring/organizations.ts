import { PostgresOrganizationAccountManagerReads, PostgresOrganizationAccountManagerStore, PostgresOrganizationApprovedToHireStore, PostgresOrganizationBrandsStore, PostgresOrganizationCommercialTermsStore, PostgresOrganizationCreationStore, PostgresOrganizationDeletionStore, PostgresOrganizationNotesStore, PostgresOrganizationProfileReads, PostgresOrganizationProfileStore, PostgresOrganizationStatusStore, PostgresOrganizationStoresStore } from "@studenthub/db";
import { DEFAULT_OPERATOR_ORG_IDS, OrganizationRepository, UnconfiguredApprovedOrganizationAdapter, organizationAccountManagerDecision, organizationAccountManagerPrincipalRef, organizationAccountManagerReadDecision, organizationAccountManagerRecordRef, organizationAccountManagerStateDecision, organizationApprovedToHireDecision, organizationApprovedToHirePrincipalRef, organizationApprovedToHireRecordRef, organizationApprovedToHireStateDecision, organizationBrandDecision, organizationBrandLinkOutcome, organizationBrandUnlinkOutcome, organizationCommercialTermsDecision, organizationCommercialTermsPrincipalRef, organizationCommercialTermsRecordRef, organizationCommercialTermsStateDecision, organizationCreationDecision, organizationCreationParentAllowed, organizationDeletionBlockers, organizationDeletionDecision, organizationDeletionPrincipalRef, organizationDeletionRecordRef, organizationEligibleAccountManagersView, organizationNoteDecision, organizationNotePrincipalRef, organizationNoteRecordRef, organizationNoteTypeOf, organizationOwnerDecision, organizationProfilePrincipalRef, organizationProfileRecordRef, organizationProfileStateDecision, organizationStatusDecision, organizationStatusEvent, organizationStatusPrincipalRef, organizationStatusRecordRef, organizationStatusStateDecision, organizationStoreReadDecision, organizationStoreWriteDecision } from "@studenthub/organizations";
import { createCompanyDirectory } from "../company-directory.js";
import { createContextNavigation } from "../context-navigation.js";
import { createOrganizationAccountManager } from "../organization-account-manager.js";
import { createOrganizationApprovedToHire } from "../organization-approved-to-hire.js";
import { createOrganizationBrands } from "../organization-brands.js";
import { createOrganizationCommercialTerms } from "../organization-commercial-terms.js";
import { createOrganizationCreation } from "../organization-creation.js";
import { createOrganizationDeletion } from "../organization-deletion.js";
import { createOrganizationNotes } from "../organization-notes.js";
import { createOrganizationProfile } from "../organization-profile.js";
import { createOrganizationStatus } from "../organization-status.js";
import { createOrganizationStores } from "../organization-stores.js";
import type { wireAccess } from "./access.js";
import type { Wired, WiringSettings } from "./context.js";

type Access = ReturnType<typeof wireAccess>["services"];

export function wireOrganizations(settings: WiringSettings, access: Access): Wired<{
  readonly application: Record<string, unknown>;
  readonly organizations: OrganizationRepository;
  readonly organizationAccountManagerStore: PostgresOrganizationAccountManagerStore;
}> {
  const { databaseUrl, safeWriteKey } = settings;
  const organizationProfileStore = safeWriteKey ? new PostgresOrganizationProfileStore({ connectionString:databaseUrl,
    ownerDecision:organizationOwnerDecision,stateDecision:organizationProfileStateDecision,
    recordRef:organizationProfileRecordRef,principalRef:organizationProfilePrincipalRef }) : undefined;
  const organizationProfileReads = new PostgresOrganizationProfileReads({connectionString:databaseUrl});
  const organizationStatusStore = new PostgresOrganizationStatusStore({connectionString:databaseUrl,
    decision:organizationStatusDecision,stateDecision:organizationStatusStateDecision,event:organizationStatusEvent,
    recordRef:organizationStatusRecordRef,principalRef:organizationStatusPrincipalRef});
  const organizationCommercialTermsStore=new PostgresOrganizationCommercialTermsStore({connectionString:databaseUrl,decision:organizationCommercialTermsDecision,stateDecision:organizationCommercialTermsStateDecision,recordRef:organizationCommercialTermsRecordRef,principalRef:organizationCommercialTermsPrincipalRef});
  const organizationApprovedToHireStore=new PostgresOrganizationApprovedToHireStore({connectionString:databaseUrl,decision:organizationApprovedToHireDecision,stateDecision:organizationApprovedToHireStateDecision,recordRef:organizationApprovedToHireRecordRef,principalRef:organizationApprovedToHirePrincipalRef});
  const organizationAccountManagerStore=new PostgresOrganizationAccountManagerStore({connectionString:databaseUrl,decision:organizationAccountManagerDecision,readDecision:organizationAccountManagerReadDecision,eligibleView:organizationEligibleAccountManagersView,stateDecision:organizationAccountManagerStateDecision,recordRef:organizationAccountManagerRecordRef,principalRef:organizationAccountManagerPrincipalRef});
  const organizationAccountManagerReads=new PostgresOrganizationAccountManagerReads({connectionString:databaseUrl,decision:organizationAccountManagerReadDecision});
  const organizationNotesStore=new PostgresOrganizationNotesStore({connectionString:databaseUrl,decision:organizationNoteDecision,recordRef:organizationNoteRecordRef,principalRef:organizationNotePrincipalRef,noteType:organizationNoteTypeOf});
  const organizationBrandsStore=new PostgresOrganizationBrandsStore({connectionString:databaseUrl,decision:organizationBrandDecision,linkOutcome:organizationBrandLinkOutcome,unlinkOutcome:organizationBrandUnlinkOutcome});
  const organizationStoresStore=new PostgresOrganizationStoresStore({connectionString:databaseUrl,writeDecision:organizationStoreWriteDecision,readDecision:organizationStoreReadDecision});
  const organizationCreationStore=new PostgresOrganizationCreationStore({connectionString:databaseUrl,decision:organizationCreationDecision,parentAllowed:(parent,grand)=>organizationCreationParentAllowed(parent,grand,DEFAULT_OPERATOR_ORG_IDS)});
  const organizationDeletionStore=new PostgresOrganizationDeletionStore({connectionString:databaseUrl,decision:organizationDeletionDecision,blockers:organizationDeletionBlockers,recordRef:organizationDeletionRecordRef,principalRef:organizationDeletionPrincipalRef});
  // Organization snapshots stay unconfigured until an approved import exists:
  // the card and the company list show registry names and visibly unavailable fields.
  const organizations = new OrganizationRepository({
    store: access.authzStore, source: new UnconfiguredApprovedOrganizationAdapter(), statusRecords:organizationStatusStore,commercialTerms:organizationCommercialTermsStore,approvedToHire:organizationApprovedToHireStore,deletions:organizationDeletionStore,storeCounts:organizationStoresStore,accountManagers:organizationAccountManagerReads,profiles:organizationProfileReads,
  });
  return {
    services: { application: {
      navigation: createContextNavigation(access.loginStore.sessions, access.authzStore, Object.assign(organizations,{accountManagers:organizationAccountManagerStore}), organizationDeletionStore, organizationStatusStore),
      companies: createCompanyDirectory(access.loginStore.sessions, access.authzStore, organizations, organizationAccountManagerStore),
      ...(organizationProfileStore && safeWriteKey ? { organizationProfile: createOrganizationProfile({sessions:access.loginStore.sessions,store:organizationProfileStore,secret:safeWriteKey}) } : {}),
      ...(safeWriteKey ? {organizationStatus:createOrganizationStatus({sessions:access.loginStore.sessions,store:organizationStatusStore,secret:safeWriteKey})}:{}),
      ...(safeWriteKey?{organizationCommercialTerms:createOrganizationCommercialTerms({sessions:access.loginStore.sessions,store:organizationCommercialTermsStore,secret:safeWriteKey})}:{}),
      ...(safeWriteKey?{organizationApprovedToHire:createOrganizationApprovedToHire({sessions:access.loginStore.sessions,store:organizationApprovedToHireStore,secret:safeWriteKey})}:{}),
      ...({organizationAccountManager:createOrganizationAccountManager({sessions:access.loginStore.sessions,store:organizationAccountManagerStore,...(safeWriteKey?{secret:safeWriteKey}:{})})} as {}),
      ...(safeWriteKey?{organizationNotes:createOrganizationNotes({sessions:access.loginStore.sessions,store:organizationNotesStore,secret:safeWriteKey})}:{}),
      ...({organizationBrands:createOrganizationBrands({sessions:access.loginStore.sessions,store:organizationBrandsStore})} as {}),
      ...({organizationStores:createOrganizationStores({sessions:access.loginStore.sessions,store:organizationStoresStore})} as {}),
      ...({organizationCreation:createOrganizationCreation({sessions:access.loginStore.sessions,store:organizationCreationStore})} as {}),
      ...(safeWriteKey?{organizationDeletion:createOrganizationDeletion({sessions:access.loginStore.sessions,store:organizationDeletionStore,secret:safeWriteKey})}:{}),
      }, organizations, organizationAccountManagerStore },
    async close() { await Promise.all([organizationProfileStore?.close(), organizationProfileReads.close(), organizationStatusStore.close(),organizationCommercialTermsStore.close(),organizationApprovedToHireStore.close(),organizationAccountManagerStore.close(),organizationAccountManagerReads.close(),organizationNotesStore.close(), organizationBrandsStore.close(),organizationStoresStore.close(),organizationCreationStore.close(),organizationDeletionStore.close()]); },
  };
}
