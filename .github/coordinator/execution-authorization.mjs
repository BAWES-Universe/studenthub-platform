// The signed record is created AFTER the final approved execution SHA exists.
// Anchor provenance is deliberately not an input to execution authorization.
const SHA = /^[0-9a-f]{40}$/;
export function executionBindingError(record, revision, mainRevision) {
  if (!SHA.test(record?.coordinator_revision ?? '')) return 'ACT_EXECUTION_BINDING_MISSING';
  if (!SHA.test(mainRevision ?? '') || record.coordinator_revision !== mainRevision) return 'ACT_EXECUTION_REVISION_WRONG';
  if (!SHA.test(revision ?? '') || revision !== record.coordinator_revision) return 'ACT_CHECKOUT_DRIFT';
  return null;
}
