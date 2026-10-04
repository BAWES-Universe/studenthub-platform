// Explicit trusted-coordinator recovery entrypoint. readAuthorization must read
// fresh signed activation, config/revision/gates, transport-authenticated receipts,
// journal and remote evidence using the same boundaries as ordinary validation.
// This does not grant dispatch: only the selected journalled edge can be retried.
import { validateTwoFixtureActivation } from './two-fixture-activation.mjs';
import { recoverExactSha } from './push-broker.mjs';

export async function recoverTwoFixturePush({ readAuthorization, ...brokerOptions }) {
  return recoverExactSha({ ...brokerOptions, beforePublish: async () => {
    if (typeof readAuthorization !== 'function') return false;
    const evidence = await readAuthorization();
    const receipt = evidence.receipts?.find(r => r.attempt_id === brokerOptions.attempt_id);
    if (!receipt || receipt.target_sha !== brokerOptions.target_sha ||
        receipt.branch !== brokerOptions.branch || receipt.repo !== brokerOptions.repo) return false;
    const journal = evidence.readPush(receipt);
    if (!journal || journal.attempt_id !== receipt.attempt_id) return false;
    // Validate the entire chain INCLUDING the pending edge, never omit it. Only
    // the selected branch's expected post-recovery head is projected. All other
    // observed heads retain their ordinary checks. The broker separately demands
    // actual remote == exact target (PENDING only) or exact result, never another
    // head. Signature, expiry, actor, role, digest and fork checks run
    // unchanged on every authorization check.
    const status = validateTwoFixtureActivation({ ...evidence,
      heads: { ...evidence.heads, [receipt.branch]: journal.result_sha },
      // An unpushed snapshot is absent from the remote compare API. This one
      // exact edge's ancestry is checked from reconstructed objects by the
      // broker before ANY recovery remote write or success. Other edges must
      // still pass the ordinary evidence resolver here.
      isAncestor: (base, head) => base === receipt.target_sha && head === journal.result_sha
        ? true : evidence.isAncestor(base, head) });
    return status.valid === true && status.state === 'armed';
  } });
}
