import type {
  FinanceReferenceResolver, FinanceReferenceType, PayContract, PayContractAudit, PayContractStore, PayContractTransaction,
} from "./types.js";

/** Synthetic/local store with the same commit-or-rollback contract as PostgreSQL. */
export class InMemoryPayContractStore implements PayContractStore {
  #rows = new Map<string, PayContract>();
  #audit: PayContractAudit[] = [];
  #tail: Promise<unknown> = Promise.resolve();
  /** Test hook: makes the next audit write throw, as a failing audit insert would. */
  failNextAudit = false;

  get auditLog(): readonly PayContractAudit[] { return [...this.#audit]; }

  async get(id: string): Promise<PayContract | undefined> {
    return this.#rows.get(id);
  }

  async listForCandidate(candidateId: string): Promise<readonly PayContract[]> {
    return [...this.#rows.values()].filter((row) => row.candidateId === candidateId);
  }

  transaction<T>(work: (tx: PayContractTransaction) => Promise<T>): Promise<T> {
    const run = this.#tail.then(async () => {
      const rows = new Map(this.#rows);
      const audit = [...this.#audit];
      const tx: PayContractTransaction = {
        lockPair: async (candidateId, storeId) => [...rows.values()].filter((row) => row.candidateId === candidateId && row.storeId === storeId),
        find: async (id) => rows.get(id),
        insert: async (contract) => {
          if (rows.has(contract.id)) throw new Error("duplicate contract id");
          rows.set(contract.id, contract);
        },
        replace: async (contract) => {
          const current = rows.get(contract.id);
          if (!current || current.candidateId !== contract.candidateId || current.storeId !== contract.storeId || current.companyId !== contract.companyId) {
            throw new Error("contract parties changed");
          }
          rows.set(contract.id, contract);
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
export class InMemoryFinanceReferenceResolver implements FinanceReferenceResolver {
  readonly #items = new Map<string, { type: FinanceReferenceType; status: "active" | "deleted" }>();

  set(type: FinanceReferenceType, id: string, status: "active" | "deleted" = "active"): void {
    this.#items.set(id, { type, status });
  }

  async resolve(type: FinanceReferenceType, id: string): Promise<{ readonly status: "active" | "deleted" } | undefined> {
    const item = this.#items.get(id);
    return item && item.type === type ? { status: item.status } : undefined;
  }
}
