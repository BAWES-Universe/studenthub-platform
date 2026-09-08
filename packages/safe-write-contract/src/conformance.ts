import {
  OTHER_PERSON_REF,
  OTHER_PRINCIPAL_REF,
  OWNER_PERSON_REF,
  OWNER_PRINCIPAL_REF,
  OWNER_SUBJECT,
  PROFILE_CANARY,
  TEST_POLICY,
  createClock,
  createRecordingStore,
  fieldKey,
} from "./fixtures.js";
import { changeSetDigest } from "./safe-write.js";
import {
  REFERENCE_PATTERN,
  REJECTION_REASONS,
  SAFE_WRITE_CONTRACT_VERSION,
  type ChangeRequest,
  type FieldPolicy,
  type Receipt,
  type Refused,
  type SafeWriteClock,
  type SafeWriteImplementation,
  type SafeWriteStore,
} from "./types.js";

/** Fixture signing key. Self-describing so it is obviously not a real secret. */
export const TEST_SECRET = "safe-write-contract-test-secret-not-a-real-key";

export interface SafeWriteFactoryInput {
  readonly store: SafeWriteStore;
  readonly secret: string;
  readonly policy: FieldPolicy;
  readonly clock: SafeWriteClock;
  readonly tokenLifetimeMs?: number;
}

/**
 * The subject of a conformance run is a FACTORY, not an instance: several rules
 * are only observable by controlling the store or the clock the implementation
 * was built with.
 */
export type SafeWriteFactory = (input: SafeWriteFactoryInput) => SafeWriteImplementation;

export const SAFE_WRITE_SCENARIOS = [
  "a preview writes nothing and reserves nothing",
  "a preview names the field with its before and after value",
  "a confirm applies exactly the change the preview showed",
  "a token cannot be substituted onto a different change set",
  "a token is single-use",
  "an expired token is refused",
  "a token issued to one principal cannot be confirmed by another",
  "write authorization is re-derived at confirm, never inherited from preview",
  "a failed receipt leaves the record unchanged",
  "a receipt carries only references, field names and closed vocabulary",
  "a refusal carries a typed reason and never record content",
  "an unwritable field or malformed reference is refused",
  "a preview refuses a record the caller does not own",
  "a value with edge whitespace is refused, never trimmed",
  "a failed write leaves its token spendable",
  "a token no preview issued is refused",
  "a record changed since the preview is not overwritten",
  "the atomic commit refuses a change that lands after the confirm's own read",
  "a token spent through one instance cannot be spent through another",
  "authorization revoked during the confirm stops the write",
  "a refusal to a revoked principal does not disclose the record's state",
] as const;

export type SafeWriteScenario = (typeof SAFE_WRITE_SCENARIOS)[number];

export interface ScenarioResult {
  readonly name: SafeWriteScenario;
  readonly ok: boolean;
  readonly detail?: string;
}

export interface ConformanceReport {
  readonly contractVersion: string;
  readonly ok: boolean;
  readonly results: readonly ScenarioResult[];
}

const ISO_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

const NEW_VALUE = "Chosen Name";
const OTHER_VALUE = "Different Name";
const CONCURRENT_VALUE = "Concurrent Name";

function ownerChange(overrides: Partial<ChangeRequest> = {}): ChangeRequest {
  return { personRef: OWNER_PERSON_REF, field: "display_name", value: NEW_VALUE, ...overrides };
}

function build(factory: SafeWriteFactory, options: {
  failCommit?: boolean;
  mutateAtCommit?: string;
  revokeAtCommit?: boolean;
  tokenLifetimeMs?: number;
  ownership?: ReadonlyMap<string, string>;
} = {}) {
  const store = createRecordingStore({
    failCommit: options.failCommit,
    mutateAtCommit: options.mutateAtCommit,
    revokeAtCommit: options.revokeAtCommit,
    ownership: options.ownership,
  });
  const clock = createClock();
  const implementation = factory({
    store,
    secret: TEST_SECRET,
    policy: TEST_POLICY,
    clock,
    tokenLifetimeMs: options.tokenLifetimeMs,
  });
  return { store, clock, implementation };
}

/**
 * The sensitive-output rule, made POSITIONAL.
 *
 * An earlier version approved any string that matched any approved shape,
 * wherever it appeared. That accepts a reference in a slot where only a field
 * name is meaningful: an implementation returning `fields: [receipt.personRef]`
 * passed the entire corpus while emitting audit metadata that names no field.
 * "Contains only approved strings" is a weaker claim than "each position holds
 * the kind of value that position is for", and only the second one is the rule.
 *
 * So every key is checked against what is valid THERE, and an unexpected key is
 * a defect in itself — a receipt that grew a field nobody predicted is exactly
 * the case the whitelist exists to catch.
 */
function receiptDefects(receipt: Receipt, policy: FieldPolicy): string[] {
  const defects: string[] = [];
  const record = receipt as unknown as Record<string, unknown>;
  const expected = [
    "contractVersion", "receiptRef", "personRef", "principalRef",
    "changeSetDigest", "fields", "committedAt",
  ];

  for (const key of Object.keys(record)) {
    if (!expected.includes(key)) defects.push(`unexpected key: ${key}`);
  }

  const reference = (key: string): void => {
    const value = record[key];
    if (typeof value !== "string" || !REFERENCE_PATTERN.test(value)) {
      defects.push(`${key} is not a reference: ${JSON.stringify(value)}`);
    }
  };
  for (const key of ["receiptRef", "personRef", "principalRef", "changeSetDigest"]) reference(key);

  if (receipt.contractVersion !== SAFE_WRITE_CONTRACT_VERSION) {
    defects.push(`contractVersion is not the contract's: ${JSON.stringify(receipt.contractVersion)}`);
  }
  if (typeof receipt.committedAt !== "string" || !ISO_INSTANT.test(receipt.committedAt)) {
    defects.push(`committedAt is not an instant: ${JSON.stringify(receipt.committedAt)}`);
  }
  if (!Array.isArray(receipt.fields) || receipt.fields.length === 0) {
    defects.push(`fields is not a non-empty list: ${JSON.stringify(receipt.fields)}`);
  } else {
    for (const field of receipt.fields) {
      // A field name, and one this deployment permits. A reference here would
      // be a well-shaped string that names nothing an auditor can act on.
      if (typeof field !== "string" || !policy.allowed.includes(field)) {
        defects.push(`fields entry is not a permitted field name: ${JSON.stringify(field)}`);
      }
    }
  }

  return defects;
}

/**
 * The same rule for refusals, which have their own tiny shape: a refusal must
 * be exactly `{ ok: false, reason }` with the reason from the closed vocabulary.
 * Anything else it carries is content that a refusal has no business emitting.
 */
function refusalDefects(refusal: Refused): string[] {
  const defects: string[] = [];
  const record = refusal as unknown as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (key !== "ok" && key !== "reason") defects.push(`unexpected key: ${key}`);
  }
  if (!(REJECTION_REASONS as readonly string[]).includes(refusal.reason)) {
    defects.push(`reason outside the closed vocabulary: ${JSON.stringify(refusal.reason)}`);
  }
  return defects;
}

type Check = () => Promise<string | null>;

function scenarioChecks(factory: SafeWriteFactory): Record<SafeWriteScenario, Check> {
  return {
    "a preview writes nothing and reserves nothing": async () => {
      const { store, implementation } = build(factory);
      const before = store.snapshot();
      const result = await implementation.preview({ change: ownerChange(), principalRef: OWNER_PRINCIPAL_REF });
      if (!result.ok) return `preview refused: ${result.reason}`;
      if (store.commits.length !== 0) return "preview committed something";
      if (store.snapshot() !== before) return "preview mutated stored state";
      return null;
    },

    "a preview names the field with its before and after value": async () => {
      const { implementation } = build(factory);
      const result = await implementation.preview({ change: ownerChange(), principalRef: OWNER_PRINCIPAL_REF });
      if (!result.ok) return `preview refused: ${result.reason}`;
      if (result.changes.length !== 1) return `expected one change, got ${result.changes.length}`;
      const [change] = result.changes;
      if (change?.field !== "display_name") return "preview named the wrong field";
      if (change.before !== PROFILE_CANARY) return "preview did not report the prior value";
      if (change.after !== NEW_VALUE) return "preview did not report the proposed value";
      return null;
    },

    "a confirm applies exactly the change the preview showed": async () => {
      const { store, implementation } = build(factory);
      const change = ownerChange();
      const preview = await implementation.preview({ change, principalRef: OWNER_PRINCIPAL_REF });
      if (!preview.ok) return `preview refused: ${preview.reason}`;
      const confirmed = await implementation.confirm({
        token: preview.token, change, principalRef: OWNER_PRINCIPAL_REF,
      });
      if (!confirmed.ok) return `confirm refused: ${confirmed.reason}`;
      if (store.commits.length !== 1) return `expected one commit, got ${store.commits.length}`;
      const [commit] = store.commits;
      if (commit?.value !== NEW_VALUE) return "committed a value the preview did not show";
      if ((await store.readField(OWNER_PERSON_REF, "display_name")) !== NEW_VALUE) return "record was not updated";
      return null;
    },

    "a token cannot be substituted onto a different change set": async () => {
      const { store, implementation } = build(factory);
      const preview = await implementation.preview({ change: ownerChange(), principalRef: OWNER_PRINCIPAL_REF });
      if (!preview.ok) return `preview refused: ${preview.reason}`;
      const substituted = ownerChange({ value: OTHER_VALUE });
      const confirmed = await implementation.confirm({
        token: preview.token, change: substituted, principalRef: OWNER_PRINCIPAL_REF,
      });
      if (confirmed.ok) return "a substituted change set was accepted";
      if (confirmed.reason !== "token_change_set_mismatch") return `wrong reason: ${confirmed.reason}`;
      if (store.commits.length !== 0) return "a refused confirm still wrote";
      return null;
    },

    "a token is single-use": async () => {
      const { store, implementation } = build(factory);
      const change = ownerChange();
      const preview = await implementation.preview({ change, principalRef: OWNER_PRINCIPAL_REF });
      if (!preview.ok) return `preview refused: ${preview.reason}`;
      const first = await implementation.confirm({ token: preview.token, change, principalRef: OWNER_PRINCIPAL_REF });
      if (!first.ok) return `first confirm refused: ${first.reason}`;
      const replay = await implementation.confirm({ token: preview.token, change, principalRef: OWNER_PRINCIPAL_REF });
      if (replay.ok) return "a token was accepted twice";
      if (replay.reason !== "token_already_used") return `wrong reason: ${replay.reason}`;
      if (store.commits.length !== 1) return `replay wrote again: ${store.commits.length} commits`;
      return null;
    },

    "an expired token is refused": async () => {
      const { store, clock, implementation } = build(factory, { tokenLifetimeMs: 1_000 });
      const change = ownerChange();
      const preview = await implementation.preview({ change, principalRef: OWNER_PRINCIPAL_REF });
      if (!preview.ok) return `preview refused: ${preview.reason}`;
      clock.advance(60_000);
      const confirmed = await implementation.confirm({ token: preview.token, change, principalRef: OWNER_PRINCIPAL_REF });
      if (confirmed.ok) return "an expired token was accepted";
      if (confirmed.reason !== "token_expired") return `wrong reason: ${confirmed.reason}`;
      if (store.commits.length !== 0) return "an expired confirm still wrote";
      return null;
    },

    "a token issued to one principal cannot be confirmed by another": async () => {
      const { store, implementation } = build(factory);
      const change = ownerChange();
      const preview = await implementation.preview({ change, principalRef: OWNER_PRINCIPAL_REF });
      if (!preview.ok) return `preview refused: ${preview.reason}`;
      const confirmed = await implementation.confirm({
        token: preview.token, change, principalRef: OTHER_PRINCIPAL_REF,
      });
      if (confirmed.ok) return "another principal spent someone else's token";
      if (confirmed.reason !== "token_principal_mismatch") return `wrong reason: ${confirmed.reason}`;
      if (store.commits.length !== 0) return "a refused confirm still wrote";
      return null;
    },

    "write authorization is re-derived at confirm, never inherited from preview": async () => {
      // Ownership is revoked between preview and confirm. A token is not an
      // authorization, so the confirm must refuse on the CURRENT grant.
      const ownership = new Map([[OWNER_PRINCIPAL_REF, OWNER_PERSON_REF]]);
      const store = createRecordingStore({ ownership });
      const implementation = factory({ store, secret: TEST_SECRET, policy: TEST_POLICY, clock: createClock() });
      const change = ownerChange();
      const preview = await implementation.preview({ change, principalRef: OWNER_PRINCIPAL_REF });
      if (!preview.ok) return `preview refused: ${preview.reason}`;
      ownership.delete(OWNER_PRINCIPAL_REF);
      const confirmed = await implementation.confirm({ token: preview.token, change, principalRef: OWNER_PRINCIPAL_REF });
      if (confirmed.ok) return "a revoked principal completed a write";
      if (confirmed.reason !== "not_own_record") return `wrong reason: ${confirmed.reason}`;
      if (store.commits.length !== 0) return "a refused confirm still wrote";
      return null;
    },

    "a failed receipt leaves the record unchanged": async () => {
      const { store, implementation } = build(factory, { failCommit: true });
      const change = ownerChange();
      const before = store.snapshot();
      const preview = await implementation.preview({ change, principalRef: OWNER_PRINCIPAL_REF });
      if (!preview.ok) return `preview refused: ${preview.reason}`;
      const confirmed = await implementation.confirm({ token: preview.token, change, principalRef: OWNER_PRINCIPAL_REF });
      if (confirmed.ok) return "a write reported success though its receipt failed";
      if (confirmed.reason !== "receipt_failed") return `wrong reason: ${confirmed.reason}`;
      if (store.snapshot() !== before) return "the record changed although the receipt failed";
      return null;
    },

    "a receipt carries only references, field names and closed vocabulary": async () => {
      const { implementation } = build(factory);
      const change = ownerChange();
      const preview = await implementation.preview({ change, principalRef: OWNER_PRINCIPAL_REF });
      if (!preview.ok) return `preview refused: ${preview.reason}`;
      const confirmed = await implementation.confirm({ token: preview.token, change, principalRef: OWNER_PRINCIPAL_REF });
      if (!confirmed.ok) return `confirm refused: ${confirmed.reason}`;
      const serialized = JSON.stringify(confirmed.receipt);
      if (serialized.includes(PROFILE_CANARY)) return "the receipt echoed the prior value";
      if (serialized.includes(NEW_VALUE)) return "the receipt echoed the written value";
      if (serialized.includes(OWNER_SUBJECT)) return "the receipt echoed a subject";
      const bad = receiptDefects(confirmed.receipt, TEST_POLICY);
      if (bad.length > 0) return `receipt is malformed: ${JSON.stringify(bad)}`;
      return null;
    },

    "a refusal carries a typed reason and never record content": async () => {
      const { implementation } = build(factory);
      const refusals = [
        await implementation.preview({ change: ownerChange({ field: "secret_field" }), principalRef: OWNER_PRINCIPAL_REF }),
        await implementation.preview({ change: ownerChange({ personRef: OTHER_PERSON_REF }), principalRef: OWNER_PRINCIPAL_REF }),
        await implementation.preview({ change: ownerChange({ value: " padded " }), principalRef: OWNER_PRINCIPAL_REF }),
      ];
      for (const refusal of refusals) {
        if (refusal.ok) return "a refusable request was accepted";
        if (!(REJECTION_REASONS as readonly string[]).includes(refusal.reason)) {
          return `reason outside the closed vocabulary: ${refusal.reason}`;
        }
        const bad = refusalDefects(refusal);
        if (bad.length > 0) return `refusal is malformed: ${JSON.stringify(bad)}`;
      }
      return null;
    },

    "a preview refuses a record the caller does not own": async () => {
      const { store, implementation } = build(factory);
      const result = await implementation.preview({
        change: ownerChange({ personRef: OTHER_PERSON_REF }), principalRef: OWNER_PRINCIPAL_REF,
      });
      if (result.ok) return "a preview read a record the caller does not own";
      if (result.reason !== "not_own_record") return `wrong reason: ${result.reason}`;
      if (store.commits.length !== 0) return "a refused preview wrote";
      return null;
    },

    "a value with edge whitespace is refused, never trimmed": async () => {
      const { implementation } = build(factory);
      const padded = ownerChange({ value: " Chosen Name " });
      const result = await implementation.preview({ change: padded, principalRef: OWNER_PRINCIPAL_REF });
      if (result.ok) {
        const [change] = result.changes;
        return change?.after === padded.value
          ? "a padded value was accepted"
          : "a padded value was silently trimmed";
      }
      if (result.reason !== "invalid_value") return `wrong reason: ${result.reason}`;
      return null;
    },

    "a failed write leaves its token spendable": async () => {
      const { store, implementation } = build(factory, { failCommit: true });
      const change = ownerChange();
      const preview = await implementation.preview({ change, principalRef: OWNER_PRINCIPAL_REF });
      if (!preview.ok) return `preview refused: ${preview.reason}`;
      const first = await implementation.confirm({ token: preview.token, change, principalRef: OWNER_PRINCIPAL_REF });
      if (first.ok) return "a write reported success though its receipt failed";
      const retry = await implementation.confirm({ token: preview.token, change, principalRef: OWNER_PRINCIPAL_REF });
      if (retry.ok) return "the retry unexpectedly succeeded against a failing store";
      if (retry.reason === "token_already_used") return "a write that never happened consumed its token";
      if (retry.reason !== "receipt_failed") return `wrong reason: ${retry.reason}`;
      if (store.commits.length !== 0) return "a failed write committed";
      return null;
    },

    "a token no preview issued is refused": async () => {
      const { store, implementation } = build(factory);
      const change = ownerChange();
      const issued = await implementation.preview({ change, principalRef: OWNER_PRINCIPAL_REF });
      if (!issued.ok) return `preview refused: ${issued.reason}`;
      const forged = { ...issued.token, tokenId: "never-issued-by-any-preview", mac: "forged" };
      const confirmed = await implementation.confirm({ token: forged, change, principalRef: OWNER_PRINCIPAL_REF });
      if (confirmed.ok) return "a token no preview issued completed a write";
      if (confirmed.reason !== "token_not_issued") return `wrong reason: ${confirmed.reason}`;
      if (store.commits.length !== 0) return "a forged confirm still wrote";
      return null;
    },

    "a record changed since the preview is not overwritten": async () => {
      // A person approves "A becomes C". If the record has become B in the
      // meantime, applying the change would overwrite a transition they never
      // saw. The token commits to the before value as well as the after.
      const { store, implementation } = build(factory);
      const change = ownerChange();
      const preview = await implementation.preview({ change, principalRef: OWNER_PRINCIPAL_REF });
      if (!preview.ok) return `preview refused: ${preview.reason}`;
      // The precondition is read from the STORE, not from the preview's report.
      // Reading it from the report would make this scenario also enforce the
      // "a preview names its before value" rule, and one broken rule would then
      // fail two scenarios that are supposed to isolate different things.
      if (store.fields.get(fieldKey(OWNER_PERSON_REF, "display_name")) !== PROFILE_CANARY) {
        return "fixture precondition: the record did not start at the canary value";
      }

      store.fields.set(fieldKey(OWNER_PERSON_REF, "display_name"), CONCURRENT_VALUE);

      const confirmed = await implementation.confirm({ token: preview.token, change, principalRef: OWNER_PRINCIPAL_REF });
      if (confirmed.ok) return "a concurrent change was silently overwritten";
      if (confirmed.reason !== "state_changed") return `wrong reason: ${confirmed.reason}`;
      if (store.commits.length !== 0) return "a refused confirm still wrote";
      if (store.fields.get(fieldKey(OWNER_PERSON_REF, "display_name")) !== CONCURRENT_VALUE) {
        return "the concurrent value did not survive";
      }
      return null;
    },

    "the atomic commit refuses a change that lands after the confirm's own read": async () => {
      // The confirm's own read cannot close the race: a writer can land between
      // that read and the write. Only the compare INSIDE the atomic commit can,
      // so this scenario moves the record at commit time rather than before it.
      const { store, implementation } = build(factory, { mutateAtCommit: CONCURRENT_VALUE });
      const change = ownerChange();
      const preview = await implementation.preview({ change, principalRef: OWNER_PRINCIPAL_REF });
      if (!preview.ok) return `preview refused: ${preview.reason}`;
      const confirmed = await implementation.confirm({ token: preview.token, change, principalRef: OWNER_PRINCIPAL_REF });
      if (confirmed.ok) return "a change landing at commit time was overwritten";
      if (confirmed.reason !== "state_changed") return `wrong reason: ${confirmed.reason}`;
      if (store.commits.length !== 0) return "a refused confirm still wrote";
      return null;
    },

    "a token spent through one instance cannot be spent through another": async () => {
      // Two instances over one store are two processes. Neither can see the
      // other's in-memory guard, so an implementation that tracks spent tokens
      // only in memory does not have a single-use token — it has one that is
      // usually used once, and a restart re-opens replay.
      //
      // The change is deliberately a NO-OP, so compare-and-write cannot save
      // it either: the value already equals what is stored, so the first commit
      // leaves nothing for the second to notice. Only the store recording the
      // token id refuses the second write.
      const store = createRecordingStore();
      const clock = createClock();
      const instance = () => factory({ store, secret: TEST_SECRET, policy: TEST_POLICY, clock });
      const [first, second] = [instance(), instance()];
      const change = ownerChange({ value: PROFILE_CANARY });
      const preview = await first.preview({ change, principalRef: OWNER_PRINCIPAL_REF });
      if (!preview.ok) return `preview refused: ${preview.reason}`;

      const [a, b] = await Promise.all([
        first.confirm({ token: preview.token, change, principalRef: OWNER_PRINCIPAL_REF }),
        second.confirm({ token: preview.token, change, principalRef: OWNER_PRINCIPAL_REF }),
      ]);
      const accepted = [a, b].filter((result) => result.ok);
      if (accepted.length > 1) return "one token completed two writes";
      if (accepted.length === 0) return "neither confirm succeeded";
      const rejected = [a, b].find((result) => !result.ok) as Refused;
      if (rejected.reason !== "token_already_used") return `wrong reason: ${rejected.reason}`;
      if (store.commits.length !== 1) return `expected one commit, got ${store.commits.length}`;
      return null;
    },

    "authorization revoked during the confirm stops the write": async () => {
      // The confirm re-derives ownership, but awaits twice more before writing.
      // A grant withdrawn in that window is invisible to every check the caller
      // could make, so the ownership predicate has to be evaluated in the same
      // atomic operation as the mutation.
      const { store, implementation } = build(factory, { revokeAtCommit: true });
      const change = ownerChange();
      const preview = await implementation.preview({ change, principalRef: OWNER_PRINCIPAL_REF });
      if (!preview.ok) return `preview refused: ${preview.reason}`;
      const confirmed = await implementation.confirm({ token: preview.token, change, principalRef: OWNER_PRINCIPAL_REF });
      if (confirmed.ok) return "a write landed on a record the caller no longer owned";
      if (confirmed.reason !== "not_own_record") return `wrong reason: ${confirmed.reason}`;
      if (store.commits.length !== 0) return "a refused confirm still wrote";
      if (store.fields.get(fieldKey(OWNER_PERSON_REF, "display_name")) !== PROFILE_CANARY) {
        return "the record changed although the write was refused";
      }
      return null;
    },

    "a refusal to a revoked principal does not disclose the record's state": async () => {
      // The ownership check inside the commit makes the confirm's own check
      // look redundant — it is not. Ownership is re-derived BEFORE the current
      // value is read, so a principal whose grant is gone is told that and
      // nothing else. Drop the early check and the same caller is instead told
      // `state_changed`, which reveals that a record they no longer own has
      // been modified since they last saw it.
      const ownership = new Map([[OWNER_PRINCIPAL_REF, OWNER_PERSON_REF]]);
      const store = createRecordingStore({ ownership });
      const implementation = factory({ store, secret: TEST_SECRET, policy: TEST_POLICY, clock: createClock() });
      const change = ownerChange();
      const preview = await implementation.preview({ change, principalRef: OWNER_PRINCIPAL_REF });
      if (!preview.ok) return `preview refused: ${preview.reason}`;

      // Both happen after the preview: the grant is withdrawn AND the record moves.
      ownership.delete(OWNER_PRINCIPAL_REF);
      store.fields.set(fieldKey(OWNER_PERSON_REF, "display_name"), CONCURRENT_VALUE);

      const confirmed = await implementation.confirm({ token: preview.token, change, principalRef: OWNER_PRINCIPAL_REF });
      if (confirmed.ok) return "a revoked principal completed a write";
      if (confirmed.reason === "state_changed") {
        return "the refusal disclosed that the record changed to a principal who no longer owns it";
      }
      if (confirmed.reason !== "not_own_record") return `wrong reason: ${confirmed.reason}`;
      if (store.commits.length !== 0) return "a refused confirm still wrote";
      return null;
    },

    "an unwritable field or malformed reference is refused": async () => {
      const { store, implementation } = build(factory);
      const unknownField = await implementation.preview({
        change: ownerChange({ field: "candidate_civil_photo_front" }), principalRef: OWNER_PRINCIPAL_REF,
      });
      if (unknownField.ok) return "a field outside the policy was previewed";
      if (unknownField.reason !== "unknown_field") return `wrong reason: ${unknownField.reason}`;
      const malformed = await implementation.preview({
        change: ownerChange({ personRef: "not-a-reference" }), principalRef: OWNER_PRINCIPAL_REF,
      });
      if (malformed.ok) return "a malformed reference was previewed";
      if (malformed.reason !== "malformed_reference") return `wrong reason: ${malformed.reason}`;
      if (store.commits.length !== 0) return "a refused preview wrote";
      return null;
    },
  };
}

export async function runSafeWriteConformance(factory: SafeWriteFactory): Promise<ConformanceReport> {
  const checks = scenarioChecks(factory);
  const results: ScenarioResult[] = [];
  for (const name of SAFE_WRITE_SCENARIOS) {
    try {
      const detail = await checks[name]();
      results.push(detail === null ? { name, ok: true } : { name, ok: false, detail });
    } catch (error) {
      results.push({ name, ok: false, detail: `threw: ${String((error as Error)?.message ?? error)}` });
    }
  }

  return {
    contractVersion: SAFE_WRITE_CONTRACT_VERSION,
    ok: results.every((result) => result.ok),
    results,
  };
}

export function failedScenarios(report: ConformanceReport): SafeWriteScenario[] {
  return report.results.filter((result) => !result.ok).map((result) => result.name);
}

export { changeSetDigest };
