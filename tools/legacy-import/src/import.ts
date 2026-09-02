import { sha256 } from "../../fixtures/src/canonical.js";
import { ENTITY_KINDS, type EntityKind, type FixtureDataset } from "../../fixtures/src/types.js";
import { checkInvariants, type InvariantViolation } from "./invariants.js";

export interface ImportConflict {
  readonly entity: EntityKind;
  readonly id: string;
  /** Digest of the row already held; the row itself is never echoed. */
  readonly existingHash: string;
  readonly incomingHash: string;
}

export interface ImportResult {
  readonly inserted: Readonly<Record<EntityKind, number>>;
  readonly unchanged: Readonly<Record<EntityKind, number>>;
  readonly conflicts: readonly ImportConflict[];
  readonly violations: readonly InvariantViolation[];
  readonly ok: boolean;
}

/** In-memory target. A real target swaps this for PostgreSQL; the contract holds. */
export class ImportStore {
  private readonly rows = new Map<string, { hash: string; row: unknown }>();

  private key(entity: EntityKind, id: string): string {
    return `${entity}:${id}`;
  }

  get(entity: EntityKind, id: string): unknown {
    return this.rows.get(this.key(entity, id))?.row;
  }

  hash(entity: EntityKind, id: string): string | undefined {
    return this.rows.get(this.key(entity, id))?.hash;
  }

  put(entity: EntityKind, id: string, row: unknown, hash: string): void {
    this.rows.set(this.key(entity, id), { hash, row });
  }

  get size(): number {
    return this.rows.size;
  }
}

function emptyCounts(): Record<EntityKind, number> {
  return { organizations: 0, candidates: 0, requests: 0, applications: 0 };
}

/**
 * Applies a dataset into the store. Re-running with the same input is a no-op:
 * rows are keyed by id and compared by content hash, so a repeat import reports
 * everything as `unchanged` and writes nothing.
 *
 * A row whose id already exists with different content is never overwritten —
 * it is reported as a conflict with both digests, so the operator decides.
 * Invariant violations abort the import before any write.
 */
export function runImport(store: ImportStore, dataset: FixtureDataset): ImportResult {
  const violations = checkInvariants(dataset);
  const inserted = emptyCounts();
  const unchanged = emptyCounts();
  const conflicts: ImportConflict[] = [];

  if (violations.length > 0) {
    return { inserted, unchanged, conflicts, violations, ok: false };
  }

  for (const entity of ENTITY_KINDS) {
    for (const row of dataset[entity] as readonly { id: string }[]) {
      const incomingHash = sha256(row);
      const existingHash = store.hash(entity, row.id);

      if (existingHash === undefined) {
        store.put(entity, row.id, row, incomingHash);
        inserted[entity] += 1;
        continue;
      }
      if (existingHash === incomingHash) {
        unchanged[entity] += 1;
        continue;
      }
      conflicts.push({ entity, id: row.id, existingHash, incomingHash });
    }
  }

  return {
    inserted: Object.freeze(inserted),
    unchanged: Object.freeze(unchanged),
    conflicts,
    violations,
    ok: conflicts.length === 0,
  };
}
