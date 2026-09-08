/**
 * Deliberately broken implementations, one rule each.
 *
 * Every fault WRAPS the real implementation rather than reimplementing it, so
 * "this fault fails exactly these scenarios" is a claim about the scenario
 * rather than about a second copy of the logic.
 */
import {
  changeSetDigest,
  createSafeWrite,
  fieldKey,
  signActionToken,
  type ConfirmRequest,
  type ConfirmResult,
  type PreviewRequest,
  type PreviewResult,
  type RecordingStore,
  type SafeWriteFactory,
  type SafeWriteImplementation,
  type SafeWriteStore,
} from "../src/index.js";

export interface SafeWriteFaults {
  /** Rule 1: a preview must not write. */
  previewWritesEagerly?: boolean;
  /** Rule 1: a preview must show what the value is now. */
  hideBeforeValue?: boolean;
  /** Rule 2: what is committed is what the preview showed. */
  confirmWritesDifferentValue?: boolean;
  /** Rule 2: the token commits to the change set. */
  confirmIgnoresChangeSet?: boolean;
  /** Rule 3: single-use. */
  reusableTokens?: boolean;
  /** Rule 3: expiring. */
  ignoreExpiry?: boolean;
  /** Rule 3: caller-bound. */
  ignoreTokenPrincipal?: boolean;
  /** Rule 4: re-derived at confirm, never inherited. */
  inheritPreviewAuthorization?: boolean;
  /** Rule 5: the record must not survive a failed receipt. */
  commitBeforeReceipt?: boolean;
  /** Rule 6: receipts carry references, not content. */
  receiptEchoesValue?: boolean;
  /** Rule 7: closed refusal vocabulary. */
  freeTextRefusals?: boolean;
  /** Rule 7 / policy: only permitted fields are writable. */
  acceptAnyField?: boolean;
  /** Rule 4: a preview must not read a record the caller does not own. */
  previewAllowsForeignRecord?: boolean;
  /** Rule 1: values are exact, never cleaned. */
  trimValues?: boolean;
  /** Rule 5: a write that never happened must not consume its token. */
  spendTokenOnFailure?: boolean;
  /** Rule 2: only a token this implementation issued may be confirmed. */
  acceptForgedTokens?: boolean;
}

/** A Set that accepts additions and forgets them, so tokens stay reusable. */
class ForgetfulSet extends Set<string> {
  override add(): this {
    return this;
  }
}

export function makeFaultyFactory(faults: SafeWriteFaults): SafeWriteFactory {
  return (input) => {
    const { store, policy, clock } = input;
    // The fault wrapper keeps its own spent-token set so `reusableTokens` can
    // decline to record a spend without reaching into the real implementation.
    const spent = faults.reusableTokens ? new ForgetfulSet() : new Set<string>();
    const effectiveStore: SafeWriteStore = faults.confirmWritesDifferentValue
      ? { ...store, commit: (input) => store.commit({ ...input, value: `${input.value} (altered)` }) }
      : store;
    const real = createSafeWrite({
      store: effectiveStore,
      secret: input.secret,
      policy: faults.acceptAnyField ? { ...policy, allowed: [...policy.allowed, "secret_field", "candidate_civil_photo_front"] } : policy,
      clock,
      tokenLifetimeMs: faults.ignoreExpiry ? 100 * 365 * 24 * 3600 * 1000 : input.tokenLifetimeMs,
      spentTokens: spent,
    });

    const implementation: SafeWriteImplementation = {
      preview(request: PreviewRequest): PreviewResult {
        const effective = faults.trimValues
          ? { ...request, change: { ...request.change, value: request.change.value.trim() } }
          : request;
        let result = real.preview(effective);

        if (faults.previewAllowsForeignRecord && !result.ok && result.reason === "not_own_record") {
          result = {
            ok: true,
            changes: [{
              field: request.change.field,
              before: store.readField(request.change.personRef, request.change.field),
              after: request.change.value,
            }],
            token: {
              tokenId: `foreign-${Math.random().toString(16).slice(2)}`,
              // Deliberately unauthentic: this fault breaks the PREVIEW rule,
              // and a confirm with this token would rightly be refused.
              mac: "foreign-not-signed",
              changeSetDigest: changeSetDigest(request.change),
              principalRef: request.principalRef,
              issuedAt: clock.now().toISOString(),
              expiresAt: new Date(clock.now().getTime() + 300_000).toISOString(),
            },
          };
        }

        if (faults.previewWritesEagerly && result.ok) {
          const recording = store as Partial<RecordingStore>;
          recording.fields?.set(
            fieldKey(request.change.personRef, request.change.field),
            request.change.value,
          );
        }

        if (faults.hideBeforeValue && result.ok) {
          return { ...result, changes: result.changes.map((change) => ({ ...change, before: null })) };
        }

        if (faults.freeTextRefusals && !result.ok) {
          return { ok: false, reason: `cannot write ${request.change.value}` as never };
        }

        return result;
      },

      confirm(request: ConfirmRequest): ConfirmResult {
        if (faults.acceptForgedTokens) {
          // Re-sign the token that ARRIVED, leaving every other field alone, so
          // only the issuance rule is disabled. Re-issuing a fresh token here
          // would also defeat substitution, single-use and expiry, and the
          // fault would stop isolating what it names.
          const { mac: _ignored, ...unsigned } = request.token;
          return real.confirm({
            ...request,
            token: { ...unsigned, mac: signActionToken(unsigned, input.secret) },
          });
        }

        if (faults.confirmIgnoresChangeSet) {
          // Re-point the token at whatever change arrived, so any submitted
          // change matches: the substitution the token exists to prevent.
          return real.confirm({
            ...request,
            token: { ...request.token, changeSetDigest: changeSetDigest(request.change) },
          });
        }

        if (faults.ignoreTokenPrincipal) {
          return real.confirm({ ...request, token: { ...request.token, principalRef: request.principalRef } });
        }

        if (faults.inheritPreviewAuthorization) {
          // Treat the token as proof of authorization. Ownership revoked after
          // the preview is never noticed.
          const permissive = {
            ...store,
            ownedRecord: () => request.change.personRef,
          };
          const lenient = createSafeWrite({ store: permissive, secret: input.secret, policy, clock, spentTokens: spent });
          return lenient.confirm(request);
        }

        if (faults.commitBeforeReceipt) {
          const recording = store as Partial<RecordingStore>;
          recording.fields?.set(
            fieldKey(request.change.personRef, request.change.field),
            request.change.value,
          );
          return real.confirm(request);
        }

        const effective = faults.trimValues
          ? { ...request, change: { ...request.change, value: request.change.value.trim() } }
          : request;
        const result = real.confirm(effective);

        if (faults.spendTokenOnFailure && !result.ok && result.reason === "receipt_failed") {
          spent.add(request.token.tokenId);
        }

        if (faults.receiptEchoesValue && result.ok) {
          return { ...result, receipt: { ...result.receipt, fields: [request.change.value] } };
        }

        return result;
      },
    };

    return implementation;
  };
}

/** Anti-circularity: breaks the contract with no fault flag set at all. */
export const passthroughFactory: SafeWriteFactory = () => ({
  preview: (request) => ({
    ok: true,
    changes: [{ field: request.change.field, before: null, after: request.change.value }],
    token: {
      tokenId: "static-token",
      mac: "static-mac",
      changeSetDigest: "static",
      principalRef: request.principalRef,
      issuedAt: "2026-09-08T12:00:00.000Z",
      expiresAt: "2099-01-01T00:00:00.000Z",
    },
  }),
  confirm: (request) => ({
    ok: true,
    receipt: {
      contractVersion: "1.0.0",
      receiptRef: "static",
      personRef: request.change.personRef,
      principalRef: request.principalRef,
      changeSetDigest: "static",
      fields: [request.change.value],
      committedAt: "2026-09-08T12:00:00.000Z",
    },
  }),
});

/** Anti-circularity: refuses everything, which is also not the contract. */
export const inertFactory: SafeWriteFactory = () => ({
  preview: () => ({ ok: false, reason: "invalid_value" }),
  confirm: () => ({ ok: false, reason: "invalid_value" }),
});
