import type {
  ProfileRecordAudit, ProfileRecordKind, ProfileRecordStore, ProfileRecordTransaction,
  ReferenceResolver, ReferenceType, StoredProfileRecord,
} from "./types.js";

/** Synthetic/local store with the same commit-or-rollback contract as PostgreSQL. */
export class InMemoryProfileRecordStore implements ProfileRecordStore {
  #rows = new Map<string, StoredProfileRecord>();
  #audit: ProfileRecordAudit[] = [];
  #tail: Promise<unknown> = Promise.resolve();
  /** Test hook: makes the next audit write throw, as a failing audit insert would. */
  failNextAudit = false;

  get auditLog(): readonly ProfileRecordAudit[] { return [...this.#audit]; }

  async listAll(ownerId: string): Promise<readonly StoredProfileRecord[]> {
    return [...this.#rows.values()].filter((row) => row.ownerId === ownerId);
  }

  transaction<T>(work: (tx: ProfileRecordTransaction) => Promise<T>): Promise<T> {
    const run = this.#tail.then(async () => {
      const rows = new Map(this.#rows);
      const audit = [...this.#audit];
      const tx: ProfileRecordTransaction = {
        listOwned: async (ownerId, kind) => [...rows.values()].filter((row) => row.ownerId === ownerId && row.kind === kind),
        findOwned: async (ownerId, kind, id) => {
          const row = rows.get(id);
          return row && row.ownerId === ownerId && row.kind === kind ? row : undefined;
        },
        insert: async (record) => {
          if (rows.has(record.id)) throw new Error("duplicate profile record id");
          rows.set(record.id, record);
        },
        replace: async (record) => {
          const current = rows.get(record.id);
          if (!current || current.ownerId !== record.ownerId || current.kind !== record.kind) throw new Error("profile record owner changed");
          rows.set(current.id, record);
        },
        audit: async (entry) => {
          if (this.failNextAudit) { this.failNextAudit = false; throw new Error("injected audit failure"); }
          audit.push(Object.freeze({ ...entry }));
        },
      };
      const result = await work(tx);
      this.#rows = rows;
      this.#audit = audit;
      return result;
    });
    this.#tail = run.catch(() => undefined);
    return run;
  }
}

/** Synthetic catalogue port for tests and the local preview. */
export class InMemoryReferenceResolver implements ReferenceResolver {
  readonly #items = new Map<string, { type: ReferenceType; status: "active" | "deleted" }>();

  set(type: ReferenceType, id: string, status: "active" | "deleted" = "active"): void {
    this.#items.set(id, { type, status });
  }

  async resolve(type: ReferenceType, id: string): Promise<{ readonly status: "active" | "deleted" } | undefined> {
    const item = this.#items.get(id);
    return item && item.type === type ? { status: item.status } : undefined;
  }
}

export type { ProfileRecordKind };
