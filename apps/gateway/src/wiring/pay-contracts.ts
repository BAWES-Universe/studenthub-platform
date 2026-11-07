import { PostgresFinanceReferenceResolver, PostgresPayContractSafeWriteStore, PostgresPayContractStore } from "@studenthub/db/pay-contracts";
import { DEFAULT_OPERATOR_ORG_IDS } from "@studenthub/organizations";
import { payContractChangeCheck, payContractChanger, payContractCompanyRecordRef, payContractCreateCheck, payContractCreator, payContractEditableValue, payContractPrincipalRef, payContractReadAccess, payContractRecordRef, payContractStateDecision, payContractWriteDecision } from "@studenthub/pay-contracts";
import { createPayContracts } from "../pay-contracts-http.js";
import type { wireAccess } from "./access.js";
import type { Wired, WiringSettings } from "./context.js";

type Access = ReturnType<typeof wireAccess>["services"];

export function wirePayContracts(settings: WiringSettings, access: Access): Wired<{ readonly payContracts: ReturnType<typeof createPayContracts> }> {
  const payContracts = new PostgresPayContractStore({ connectionString: settings.databaseUrl });
  const payContractReferences = new PostgresFinanceReferenceResolver({ connectionString: settings.databaseUrl });
  const payContractWrites = new PostgresPayContractSafeWriteStore({connectionString:settings.databaseUrl,
    decision:(rows,company,ancestors)=>payContractWriteDecision(rows,company,ancestors,DEFAULT_OPERATOR_ORG_IDS),
    readDecision:(rows,company,ancestors)=>payContractReadAccess(rows,company,ancestors,DEFAULT_OPERATOR_ORG_IDS),
    creator:payContractCreator(payContractReferences),changer:payContractChanger(payContractReferences),stateDecision:payContractStateDecision,editableValue:payContractEditableValue,recordRef:payContractCompanyRecordRef,contractRecordRef:payContractRecordRef,principalRef:payContractPrincipalRef});
  return {
    services: { payContracts:createPayContracts({sessions:access.loginStore.sessions,store:payContractWrites,contracts:payContracts,
      ...(settings.safeWriteKey?{secret:settings.safeWriteKey,check:payContractCreateCheck({references:payContractReferences,contracts:payContracts,candidates:payContractWrites}),changeCheck:payContractChangeCheck({references:payContractReferences,contracts:payContracts})}: {})}) },
    async close() { await Promise.all([payContracts.close(), payContractReferences.close(), payContractWrites.close()]); },
  };
}
