import { sha256Hex } from "./safe-write.js";
import type { FieldPolicy, Receipt, SafeWriteStore } from "./types.js";

/**
 * Every fixture value is invented and lives here, so a real identifier
 * appearing anywhere in this package is visible at a glance. The canary is a
 * value the contract must never let out; the scenarios assert it is present in
 * the INPUT so the "must not appear" checks cannot pass vacuously.
 */
export const PROFILE_CANARY = "canary-value-must-not-escape";

export const OWNER_SUBJECT = "owner@example.invalid";
export const OTHER_SUBJECT = "other@example.invalid";

export const OWNER_PRINCIPAL_REF = sha256Hex(OWNER_SUBJECT);
export const OTHER_PRINCIPAL_REF = sha256Hex(OTHER_SUBJECT);
export const OWNER_PERSON_REF = sha256Hex("person:owner");
export const OTHER_PERSON_REF = sha256Hex("person:other");

export const TEST_POLICY: FieldPolicy = Object.freeze({
  allowed: Object.freeze(["display_name", "pronouns"]) as readonly string[],
  maxValueLength: 64,
});

export interface RecordedCommit {
  readonly personRef: string;
  readonly field: string;
  readonly value: string;
  readonly receipt: Receipt;
}

export interface RecordingStore extends SafeWriteStore {
  /** Every commit the implementation actually made, in order. */
  readonly commits: RecordedCommit[];
  /** Reads are counted too: a preview may read, a refusal should not write. */
  readonly fields: Map<string, string>;
  snapshot(): string;
}

export interface RecordingStoreOptions {
  /** Make the receipt write fail, to prove the mutation does not survive it. */
  readonly failCommit?: boolean;
  readonly ownership?: ReadonlyMap<string, string>;
  readonly initial?: ReadonlyMap<string, string>;
}

export function fieldKey(personRef: string, field: string): string {
  return `${personRef} ${field}`;
}

export function createRecordingStore(options: RecordingStoreOptions = {}): RecordingStore {
  const ownership = options.ownership
    ?? new Map([[OWNER_PRINCIPAL_REF, OWNER_PERSON_REF], [OTHER_PRINCIPAL_REF, OTHER_PERSON_REF]]);
  const fields = new Map<string, string>(
    options.initial
      ?? new Map([
        [fieldKey(OWNER_PERSON_REF, "display_name"), PROFILE_CANARY],
        [fieldKey(OTHER_PERSON_REF, "display_name"), PROFILE_CANARY],
      ]),
  );
  const commits: RecordedCommit[] = [];

  const store: RecordingStore = {
    commits,
    fields,
    snapshot() {
      return JSON.stringify([...fields.entries()].sort());
    },
    readField(personRef, field) {
      return fields.get(fieldKey(personRef, field)) ?? null;
    },
    ownedRecord(principalRef) {
      return ownership.get(principalRef) ?? null;
    },
    commit(input) {
      // A real store applies the field and writes the receipt in one
      // transaction. Failing BEFORE mutating is what "neither happened" means.
      if (options.failCommit) throw new Error("receipt write failed");
      fields.set(fieldKey(input.personRef, input.field), input.value);
      commits.push({
        personRef: input.personRef,
        field: input.field,
        value: input.value,
        receipt: input.receipt,
      });
    },
  };

  return store;
}

/** A clock a scenario can advance, so token expiry is tested without waiting. */
export function createClock(start = "2026-09-08T12:00:00.000Z") {
  let current = new Date(start);
  return {
    now: () => current,
    advance(ms: number) {
      current = new Date(current.getTime() + ms);
    },
  };
}
