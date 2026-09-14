import assert from 'node:assert/strict';

export const HOLD_CODES = Object.freeze([
  'BLOCKED_BY_APPROVED_WINDOW', 'AWAITING_VERDICT', 'MISSING_AUTHORITY',
  'NO_ELIGIBLE_WORK', 'CAPACITY_FULL', 'AWAITING_LAUNCH', 'MISSING_CLAIM',
  'MISSING_LAUNCH_RECEIPT', 'BRANCH_OCCUPIED', 'AMBIGUOUS_LAUNCH',
]);
export function requireHoldCode(code) {
  assert.ok(HOLD_CODES.includes(code), 'HOLD_CODE_REQUIRED: an enumerated HOLD code is required');
  return code;
}
export function hasLaunchReceipt(receipt, order) {
  return receipt?.phase === 'launched' && receipt.attempt_id === order.attempt_id
    && receipt.issue_id === order.issue_id && receipt.target_sha === order.target_sha
    && Number.isInteger(receipt.pid) && receipt.pid > 0;
}
