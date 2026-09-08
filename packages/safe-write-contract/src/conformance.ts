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
  tokenLifetimeMs?: number;
  ownership?: ReadonlyMap<string, string>;
} = {}) {
  const store = createRecordingStore({
    failCommit: options.failCommit,
    mutateAtCommit: options.mutateAtCommit,
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
 * The sensitive-output rule, inverted. Chasing individual leaks only finds the
 * field somebody thought to plant a canary in; requiring every emitted string
 * to match an approved shape catches the field nobody predicted.
 */
function unapprovedStrings(value: unknown, policy: FieldPolicy): string[] {
  const bad: string[] = [];
  const approved = (candidate: string): boolean =>
    REFERENCE_PATTERN.test(candidate)
    || policy.allowed.includes(candidate)
    || candidate === SAFE_WRITE_CONTRACT_VERSION
    || (REJECTION_REASONS as readonly string[]).includes(candidate)
    || ISO_INSTANT.test(candidate);

  const walk = (node: unknown): void => {
    if (typeof node === "string") {
      if (!approved(node)) bad.push(node);
      return;
    }
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (node && typeof node === "object") {
      for (const [key, child] of Object.entries(node as Record<string, unknown>)) {
        if (!approved(key) && !/^[a-z][A-Za-z]*$/.test(key)) bad.push(key);
        walk(child);
      }
    }
  };

  walk(value);
  return bad;
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
      const bad = unapprovedStrings(confirmed.receipt, TEST_POLICY);
      if (bad.length > 0) return `receipt carries unapproved strings: ${JSON.stringify(bad)}`;
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
        const bad = unapprovedStrings(refusal, TEST_POLICY);
        if (bad.length > 0) return `refusal carries unapproved strings: ${JSON.stringify(bad)}`;
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
