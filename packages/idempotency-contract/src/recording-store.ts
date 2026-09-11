import {
  type AtomicMutationInput,
  type AtomicMutationOutcome,
  type IdempotencyClock,
  type IdempotencyStore,
  type IdempotencyTransaction,
  type JsonValue,
  type MutationOperation,
  type StoredResponse,
} from "./types.js";

interface StoredRecord {
  readonly fingerprint: string;
  readonly expiresAt: Date;
  readonly response: StoredResponse;
}

export interface RecordingStoreOptions {
  /** Test-only fault seam used by the named record-uniqueness mutation. */
  readonly enforceUniqueRecords?: boolean;
  readonly clock?: IdempotencyClock;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

/**
 * Executable fixture for the contract. It models the two database primitives a
 * production adapter must use: a unique (principal_ref, key) record and one
 * transaction containing that record, domain rows and outbox rows.
 */
export class RecordingIdempotencyStore implements IdempotencyStore {
  readonly #records = new Map<string, StoredRecord>();
  #collections = new Map<string, JsonValue[]>();
  #outbox = new Map<string, JsonValue[]>();
  readonly #keyLocks = new Map<string, Promise<void>>();
  #transactionTail: Promise<void> = Promise.resolve();
  readonly #enforceUniqueRecords: boolean;
  readonly #clock: IdempotencyClock;

  constructor(options: RecordingStoreOptions = {}) {
    this.#enforceUniqueRecords = options.enforceUniqueRecords ?? true;
    this.#clock = options.clock ?? { now: () => new Date() };
  }

  seed(collection: string, row: JsonValue): void {
    const rows = this.#collections.get(collection) ?? [];
    rows.push(copy(row));
    this.#collections.set(collection, rows);
  }

  rows(collection: string): readonly JsonValue[] {
    return copy(this.#collections.get(collection) ?? []);
  }

  events(topic: string): readonly JsonValue[] {
    return copy(this.#outbox.get(topic) ?? []);
  }

  get recordCount(): number {
    return this.#records.size;
  }

  async #locked<T>(slot: "transaction" | string, work: () => Promise<T>): Promise<T> {
    if (slot === "transaction") {
      const prior = this.#transactionTail;
      let release!: () => void;
      const mine = new Promise<void>((resolve) => { release = resolve; });
      this.#transactionTail = prior.then(() => mine);
      await prior;
      try { return await work(); } finally { release(); }
    }

    const prior = this.#keyLocks.get(slot) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((resolve) => { release = resolve; });
    const tail = prior.then(() => mine);
    this.#keyLocks.set(slot, tail);
    await prior;
    try {
      return await work();
    } finally {
      release();
      if (this.#keyLocks.get(slot) === tail) this.#keyLocks.delete(slot);
    }
  }

  async executeAtomic(input: AtomicMutationInput, operation: MutationOperation): Promise<AtomicMutationOutcome> {
    const scope = `${input.principalRef}\n${input.key}`;
    const run = () => this.#locked("transaction", async () => {
      // Re-check against the transaction's clock, not only the executor's
      // earlier validation. Cleanup and a queued replay cannot race this check.
      if (this.#clock.now().getTime() >= input.expiresAt.getTime()) {
        return { kind: "expired" } as const;
      }
      const existing = this.#records.get(scope);
      if (this.#enforceUniqueRecords && existing) {
        if (existing.fingerprint !== input.fingerprint) return { kind: "conflict" } as const;
        return { kind: "replayed", response: copy(existing.response) } as const;
      }

      const collections = copy(this.#collections);
      const outbox = copy(this.#outbox);
      const transaction: IdempotencyTransaction = {
        insert: (collection, row) => {
          const rows = collections.get(collection) ?? [];
          rows.push(copy(row));
          collections.set(collection, rows);
        },
        enqueue: (topic, event) => {
          const events = outbox.get(topic) ?? [];
          events.push(copy(event));
          outbox.set(topic, events);
        },
      };

      try {
        const response = copy(await operation(transaction));
        this.#collections = collections;
        this.#outbox = outbox;
        this.#records.set(scope, {
          fingerprint: input.fingerprint,
          expiresAt: new Date(input.expiresAt),
          response: copy(response),
        });
        return { kind: "executed", response } as const;
      } catch {
        // All drafts, including the idempotency claim, are discarded. A retry
        // can execute because the first attempt applied nothing.
        return { kind: "failed" } as const;
      }
    });

    // The database UNIQUE constraint is represented by the per-key lock. The
    // second arrival waits for the first transaction, then reads its response.
    return this.#enforceUniqueRecords ? this.#locked(scope, run) : run();
  }

  async cleanupExpired(now: Date): Promise<number> {
    return this.#locked("transaction", async () => {
      let removed = 0;
      for (const [scope, record] of this.#records) {
        if (record.expiresAt.getTime() <= now.getTime()) {
          this.#records.delete(scope);
          removed += 1;
        }
      }
      return removed;
    });
  }
}

export function createRecordingIdempotencyStore(options: RecordingStoreOptions = {}): RecordingIdempotencyStore {
  return new RecordingIdempotencyStore(options);
}
