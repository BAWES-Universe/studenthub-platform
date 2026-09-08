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
  expectedStateDigest,
  fieldKey,
  signActionToken,
  type ActionToken,
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
  /** Rule: a preview must not write. */
  previewWritesEagerly?: boolean;
  /** Rule: a preview must show what the value is now. */
  hideBeforeValue?: boolean;
  /** Rule: what is committed is what the preview showed. */
  confirmWritesDifferentValue?: boolean;
  /** Rule: the token commits to the change set. */
  confirmIgnoresChangeSet?: boolean;
  /** Rule: single-use. */
  reusableTokens?: boolean;
  /** Rule: expiring. */
  ignoreExpiry?: boolean;
  /** Rule: caller-bound. */
  ignoreTokenPrincipal?: boolean;
  /** Rule: re-derived at confirm, never inherited. */
  inheritPreviewAuthorization?: boolean;
  /** Rule: the record must not survive a failed receipt. */
  commitBeforeReceipt?: boolean;
  /** Rule: receipts carry references, not content. */
  receiptEchoesValue?: boolean;
  /** Rule: closed refusal vocabulary. */
  freeTextRefusals?: boolean;
  /** Rule: only permitted fields are writable. */
  acceptAnyField?: boolean;
  /** Rule: a preview must not read a record the caller does not own. */
  previewAllowsForeignRecord?: boolean;
  /** Rule: values are exact, never cleaned. */
  trimValues?: boolean;
  /** Rule: a write that never happened must not consume its token. */
  spendTokenOnFailure?: boolean;
  /** Rule: only a token this implementation issued may be confirmed. */
  acceptForgedTokens?: boolean;
  /** Rule: a record changed since the preview is not overwritten. */
  overwriteConcurrentChange?: boolean;
  /** Rule: the atomic compare-and-write guard is honoured. */
  ignoreCompareAndWrite?: boolean;
  /** Rule: the store's single-use record is honoured. */
  ignoreStoreTokenSpend?: boolean;
  /** Rule: ownership is re-checked inside the atomic commit. */
  ignoreCommitOwnership?: boolean;
  /** Rule: a receipt's `fields` names fields, not references. */
  receiptFieldsCarryReferences?: boolean;
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

    /** Rewrite token fields and re-sign, so only the named rule is disabled. */
    const resign = (token: ActionToken, changes: Partial<Omit<ActionToken, "mac">>): ActionToken => {
      const { mac: _stale, ...unsigned } = token;
      const rebound = { ...unsigned, ...changes };
      return { ...rebound, mac: signActionToken(rebound, input.secret) };
    };
    const spent = faults.reusableTokens ? new ForgetfulSet() : new Set<string>();

    // Counted so `overwriteConcurrentChange` can tell WHICH guard refused: the
    // application-level state binding (before any commit is attempted) or the
    // atomic compare inside the store (after one is). Disabling both at once
    // would be two faults wearing one name.
    let commitAttempts = 0;
    /**
     * Whether the grant was ALREADY gone when the confirm started. Separates
     * "the confirm inherited the preview's authorization" (revoked before it
     * ran) from "the grant was withdrawn mid-commit" — different rules, and a
     * fault that broke both would be two faults under one name.
     */
    let staleAtConfirmEntry = false;

    const effectiveStore: SafeWriteStore = {
      ...store,
      commit: async (commitInput) => {
        commitAttempts += 1;
        if (faults.commitBeforeReceipt) {
          // Field write and receipt write are not one unit. The field lands
          // first, so when the receipt fails the mutation survives a failure it
          // should not have survived. Only a store that was going to fail is
          // affected: a fault that broke every commit would not isolate a rule.
          try {
            return await store.commit(commitInput);
          } catch (error) {
            const recording = store as Partial<RecordingStore>;
            recording.fields?.set(fieldKey(commitInput.personRef, commitInput.field), commitInput.value);
            throw error;
          }
        }
        const altered = faults.confirmWritesDifferentValue
          ? { ...commitInput, value: `${commitInput.value} (altered)` }
          : commitInput;
        const outcome = await store.commit(altered);
        // Report a refusal the store made as a completed write. Each flag
        // suppresses exactly one of the three preconditions the commit checks.
        if (outcome.ok) return outcome;
        if (faults.ignoreCompareAndWrite && outcome.reason === "state_changed") return { ok: true };
        if (faults.ignoreStoreTokenSpend && outcome.reason === "token_already_used") return { ok: true };
        if (faults.ignoreCommitOwnership && outcome.reason === "not_own_record") return { ok: true };
        if (faults.inheritPreviewAuthorization && staleAtConfirmEntry
            && outcome.reason === "not_own_record") {
          return { ok: true };
        }
        return outcome;
      },
    };

    const real = createSafeWrite({
      store: effectiveStore,
      secret: input.secret,
      policy: faults.acceptAnyField
        ? { ...policy, allowed: [...policy.allowed, "secret_field", "candidate_civil_photo_front"] }
        : policy,
      clock,
      tokenLifetimeMs: faults.ignoreExpiry ? 100 * 365 * 24 * 3600 * 1000 : input.tokenLifetimeMs,
      spentTokens: spent,
    });

    const implementation: SafeWriteImplementation = {
      async preview(request: PreviewRequest): Promise<PreviewResult> {
        const effective = faults.trimValues
          ? { ...request, change: { ...request.change, value: request.change.value.trim() } }
          : request;
        let result = await real.preview(effective);

        if (faults.previewAllowsForeignRecord && !result.ok && result.reason === "not_own_record") {
          result = {
            ok: true,
            changes: [{
              field: request.change.field,
              before: await store.readField(request.change.personRef, request.change.field),
              after: request.change.value,
            }],
            token: {
              tokenId: `foreign-${Math.random().toString(16).slice(2)}`,
              // Deliberately unauthentic: this fault breaks the PREVIEW rule,
              // and a confirm with this token would rightly be refused.
              mac: "foreign-not-signed",
              changeSetDigest: changeSetDigest(request.change),
              expectedBeforeDigest: expectedStateDigest(null),
              principalRef: request.principalRef,
              issuedAt: clock.now().toISOString(),
              expiresAt: new Date(clock.now().getTime() + 300_000).toISOString(),
            },
          };
        }

        if (faults.previewWritesEagerly && result.ok) {
          // Writes an UNRELATED key. A preview that writes anything violates
          // the rule; touching the field under test would additionally trip
          // the expected-state rule and stop this fault isolating one thing.
          const recording = store as Partial<RecordingStore>;
          recording.fields?.set(
            fieldKey(request.change.personRef, "preview_side_effect"),
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

      async confirm(request: ConfirmRequest): Promise<ConfirmResult> {
        if (faults.acceptForgedTokens) {
          // Re-sign the token that ARRIVED, leaving every other field alone, so
          // only the issuance rule is disabled.
          const { mac: _ignored, ...unsigned } = request.token;
          return real.confirm({
            ...request,
            token: { ...unsigned, mac: signActionToken(unsigned, input.secret) },
          });
        }

        if (faults.overwriteConcurrentChange) {
          const attemptsBefore = commitAttempts;
          const refused = await real.confirm(request);
          // Only the binding between preview and confirm is disabled. A refusal
          // that came from the atomic compare (a commit WAS attempted) stands,
          // so `ignoreCompareAndWrite` remains the only fault that breaks it.
          if (refused.ok || refused.reason !== "state_changed" || commitAttempts !== attemptsBefore) {
            return refused;
          }
          // Re-point the token at whatever the record holds NOW, which is what
          // an implementation with no expected-state binding effectively does.
          // The token is already known authentic — an unissued one would have
          // been refused above — so this cannot launder a forgery.
          const current = await store.readField(request.change.personRef, request.change.field);
          const { mac: _unused, ...unsigned } = request.token;
          const rebound = { ...unsigned, expectedBeforeDigest: expectedStateDigest(current) };
          return real.confirm({
            ...request,
            token: { ...rebound, mac: signActionToken(rebound, input.secret) },
          });
        }

        // Both of these rewrite a token field, so both must RE-SIGN it. Without
        // that the MAC check refuses the token first and the fault disables the
        // issuance rule instead of the one it names — the scenario still fails,
        // but for the wrong reason, which is indistinguishable from working.
        //
        // Re-signing must not launder a FORGERY, though, or the fault would also
        // disable the issuance rule. So the real implementation sees the token
        // untouched first: one it rejects as unissued stays rejected, and only
        // an authentic token gets its rule disabled.
        const disableWithResignedToken = async (
          changes: Partial<Omit<ActionToken, "mac">>,
        ): Promise<ConfirmResult> => {
          const asIs = await real.confirm(request);
          if (asIs.ok || asIs.reason === "token_not_issued") return asIs;
          return real.confirm({ ...request, token: resign(request.token, changes) });
        };

        if (faults.confirmIgnoresChangeSet) {
          return disableWithResignedToken({ changeSetDigest: changeSetDigest(request.change) });
        }

        if (faults.ignoreTokenPrincipal) {
          return disableWithResignedToken({ principalRef: request.principalRef });
        }

        if (faults.inheritPreviewAuthorization) {
          // Treat the token as proof of authorization. Ownership revoked after
          // the preview is never noticed — at either layer, since the store's
          // own check would otherwise backstop the application's and the fault
          // would isolate nothing.
          staleAtConfirmEntry =
            (await store.ownedRecord(request.principalRef)) !== request.change.personRef;
          const permissive: SafeWriteStore = {
            ...effectiveStore,
            ownedRecord: async () => request.change.personRef,
          };
          const lenient = createSafeWrite({
            store: permissive, secret: input.secret, policy, clock, spentTokens: spent,
          });
          return lenient.confirm(request);
        }

        const effective = faults.trimValues
          ? { ...request, change: { ...request.change, value: request.change.value.trim() } }
          : request;
        const result = await real.confirm(effective);

        if (faults.spendTokenOnFailure && !result.ok && result.reason === "receipt_failed") {
          spent.add(request.token.tokenId);
        }

        if (faults.receiptFieldsCarryReferences && result.ok) {
          // A well-shaped string in a slot that means something else. Passes a
          // whitelist that approves strings independently of their position.
          return { ...result, receipt: { ...result.receipt, fields: [result.receipt.personRef] } };
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
  async preview(request) {
    return {
      ok: true,
      changes: [{ field: request.change.field, before: null, after: request.change.value }],
      token: {
        tokenId: "static-token",
        mac: "static-mac",
        changeSetDigest: "static",
        expectedBeforeDigest: "static",
        principalRef: request.principalRef,
        issuedAt: "2026-09-08T12:00:00.000Z",
        expiresAt: "2099-01-01T00:00:00.000Z",
      },
    };
  },
  async confirm(request) {
    return {
      ok: true,
      receipt: {
        contractVersion: "3.0.0",
        receiptRef: "static",
        personRef: request.change.personRef,
        principalRef: request.principalRef,
        changeSetDigest: "static",
        fields: [request.change.value],
        committedAt: "2026-09-08T12:00:00.000Z",
      },
    };
  },
});

/** Anti-circularity: refuses everything, which is also not the contract. */
export const inertFactory: SafeWriteFactory = () => ({
  async preview() {
    return { ok: false, reason: "invalid_value" };
  },
  async confirm() {
    return { ok: false, reason: "invalid_value" };
  },
});
