import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

import {
  REFERENCE_PATTERN,
  SAFE_WRITE_CONTRACT_VERSION,
  type ActionToken,
  type ChangeRequest,
  type ConfirmRequest,
  type ConfirmResult,
  type FieldPolicy,
  type PreviewRequest,
  type PreviewResult,
  type Receipt,
  type RejectionReason,
  type SafeWriteClock,
  type SafeWriteImplementation,
  type SafeWriteSecret,
  type SafeWriteStore,
} from "./types.js";

const DEFAULT_TOKEN_LIFETIME_MS = 5 * 60 * 1000;

/**
 * Distinguishes "the field was absent" from "the field held this string".
 * The presence tag is a separate line rather than a prefix on the value, so no
 * stored string can be crafted to collide with the absent case.
 */
const ABSENT = "absent";
const PRESENT = "present";

function sorted(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sorted);
  if (!value || typeof value !== "object") return value;
  const record = value as Record<string, unknown>;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, sorted(record[key])]));
}

/**
 * Key order must not change a digest, or the same change would produce two
 * different tokens and the anti-substitution rule would be enforcing nothing.
 */
export function canonical(value: unknown): string {
  return JSON.stringify(sorted(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

/** The digest a token commits to. Covers the record, the field and the value. */
export function changeSetDigest(change: ChangeRequest): string {
  return sha256Hex(
    `${SAFE_WRITE_CONTRACT_VERSION}\n${canonical({
      personRef: change.personRef,
      field: change.field,
      value: change.value,
    })}`,
  );
}

/**
 * The digest of the value a preview showed as current. A confirm compares this
 * against what the record holds now, so approving "A becomes C" cannot apply to
 * a record that has since become B.
 */
export function expectedStateDigest(before: string | null): string {
  return sha256Hex(
    `${SAFE_WRITE_CONTRACT_VERSION}\n${before === null ? ABSENT : PRESENT}\n${before ?? ""}`,
  );
}

function refused(reason: RejectionReason): { ok: false; reason: RejectionReason } {
  return { ok: false, reason };
}

function validateChange(change: ChangeRequest, policy: FieldPolicy): RejectionReason | null {
  if (!REFERENCE_PATTERN.test(change.personRef)) return "malformed_reference";
  if (!policy.allowed.includes(change.field)) return "unknown_field";
  if (typeof change.value !== "string") return "invalid_value";
  if (change.value.length === 0 || change.value.length > policy.maxValueLength) return "invalid_value";
  // Edge whitespace is rejected rather than trimmed: silently cleaning a value
  // stores something other than what the preview showed the person.
  if (change.value !== change.value.trim()) return "invalid_value";
  return null;
}

function assertSecret(secret: SafeWriteSecret): Buffer {
  const bytes = Buffer.isBuffer(secret) ? secret : Buffer.from(secret ?? "");
  if (bytes.length < 32) throw new Error("safe-write secret must be at least 32 bytes");
  return bytes;
}

/** The MAC covers every field a confirm trusts, so none of them can be edited. */
export function signActionToken(token: Omit<ActionToken, "mac">, secret: SafeWriteSecret): string {
  return tokenMac(token, assertSecret(secret));
}

function tokenMac(token: Omit<ActionToken, "mac">, secret: Buffer): string {
  return createHmac("sha256", secret)
    .update(`${SAFE_WRITE_CONTRACT_VERSION}\n${canonical(token)}`)
    .digest("base64url");
}

export interface SafeWriteOptions {
  readonly store: SafeWriteStore;
  /** Signs action tokens. Must be at least 32 bytes. */
  readonly secret: SafeWriteSecret;
  readonly policy: FieldPolicy;
  readonly clock?: SafeWriteClock;
  readonly tokenLifetimeMs?: number;
  /** Injectable so a test can observe which tokens were spent. */
  readonly spentTokens?: Set<string>;
}

export function createSafeWrite(options: SafeWriteOptions): SafeWriteImplementation {
  const { store, policy } = options;
  const secret = assertSecret(options.secret);
  const clock = options.clock ?? { now: () => new Date() };
  const lifetimeMs = options.tokenLifetimeMs ?? DEFAULT_TOKEN_LIFETIME_MS;
  const spent = options.spentTokens ?? new Set<string>();

  async function preview(request: PreviewRequest): Promise<PreviewResult> {
    const { change, principalRef } = request;
    if (!REFERENCE_PATTERN.test(principalRef)) return refused("malformed_reference");

    const invalid = validateChange(change, policy);
    if (invalid) return refused(invalid);

    // Own-record only. Checked here so a preview cannot be used to read a field
    // off someone else's record, and checked AGAIN at confirm — see below.
    if ((await store.ownedRecord(principalRef)) !== change.personRef) return refused("not_own_record");

    const before = await store.readField(change.personRef, change.field);
    const issuedAt = clock.now();
    const unsigned: Omit<ActionToken, "mac"> = {
      tokenId: randomBytes(16).toString("hex"),
      changeSetDigest: changeSetDigest(change),
      expectedBeforeDigest: expectedStateDigest(before),
      principalRef,
      issuedAt: issuedAt.toISOString(),
      expiresAt: new Date(issuedAt.getTime() + lifetimeMs).toISOString(),
    };
    const token: ActionToken = { ...unsigned, mac: tokenMac(unsigned, secret) };

    return {
      ok: true,
      changes: [{ field: change.field, before, after: change.value }],
      token,
    };
  }

  async function confirm(request: ConfirmRequest): Promise<ConfirmResult> {
    const { token, change, principalRef } = request;
    if (!REFERENCE_PATTERN.test(principalRef)) return refused("malformed_reference");

    const invalid = validateChange(change, policy);
    if (invalid) return refused(invalid);

    // Checked FIRST: a token this implementation never issued is unauthentic
    // whatever else it claims, and reporting some other reason would tell a
    // forger which field to edit next.
    const { mac, ...unsigned } = token;
    const expectedMac = Buffer.from(tokenMac(unsigned, secret));
    const suppliedMac = Buffer.from(typeof mac === "string" ? mac : "");
    if (suppliedMac.length !== expectedMac.length || !timingSafeEqual(suppliedMac, expectedMac)) {
      return refused("token_not_issued");
    }

    if (token.principalRef !== principalRef) return refused("token_principal_mismatch");
    if (spent.has(token.tokenId)) return refused("token_already_used");
    if (clock.now().getTime() >= Date.parse(token.expiresAt)) return refused("token_expired");

    // The anti-substitution rule. The token commits to a change set; a confirm
    // carrying a different one is refused BEFORE anything is written.
    const digest = changeSetDigest(change);
    if (token.changeSetDigest !== digest) return refused("token_change_set_mismatch");

    // Re-derived, never inherited from the preview. Grants can be revoked
    // between the two calls, and a token is not an authorization.
    if ((await store.ownedRecord(principalRef)) !== change.personRef) return refused("not_own_record");

    // Read the current value to report `state_changed` early and cheaply. This
    // read is NOT the guard — the guard is the compare inside the atomic commit
    // below, because anything checked here could change before the write.
    const current = await store.readField(change.personRef, change.field);
    if (token.expectedBeforeDigest !== expectedStateDigest(current)) return refused("state_changed");

    const committedAt = clock.now().toISOString();
    const receipt: Receipt = {
      contractVersion: SAFE_WRITE_CONTRACT_VERSION,
      receiptRef: sha256Hex(`${token.tokenId}\n${digest}\n${committedAt}`),
      personRef: change.personRef,
      principalRef,
      changeSetDigest: digest,
      fields: [change.field],
      committedAt,
    };

    let outcome;
    try {
      outcome = await store.commit({
        personRef: change.personRef,
        principalRef,
        field: change.field,
        expectedBefore: current,
        value: change.value,
        changeSetDigest: digest,
        receipt,
      });
    } catch {
      // The store aborts as one unit, so nothing was written. The token is
      // deliberately NOT spent: refusing to retry a write that never happened
      // would strand the person with no way to complete their own change.
      return refused("receipt_failed");
    }

    // The compare half of compare-and-write lost the race. Nothing was written.
    if (!outcome?.ok) return refused("state_changed");

    spent.add(token.tokenId);
    return { ok: true, receipt };
  }

  return { preview, confirm };
}
