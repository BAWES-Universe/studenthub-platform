import { sha256 } from "../../fixtures/src/canonical.js";
import { ENTITY_KINDS, type EntityKind, type FixtureDataset } from "../../fixtures/src/types.js";
import { assertRedacted } from "./redaction.js";

export interface EntityDifference {
  readonly entity: EntityKind;
  /** Ids present in source but absent from target. */
  readonly missingInTarget: readonly string[];
  /** Ids present in target but absent from source. */
  readonly extraInTarget: readonly string[];
  /** Ids present in both whose content hash differs. */
  readonly changed: readonly string[];
}

export interface ReconciliationReport {
  readonly counts: Readonly<Record<EntityKind, { readonly source: number; readonly target: number }>>;
  readonly hashes: Readonly<Record<EntityKind, { readonly source: string; readonly target: string }>>;
  readonly differences: readonly EntityDifference[];
  readonly clean: boolean;
}

function indexById(rows: readonly { id: string }[]): Map<string, string> {
  return new Map(rows.map((row) => [row.id, sha256(row)]));
}

/**
 * Compares two datasets and reports counts, per-entity hashes and differences by
 * identifier only. No field value ever enters the report, and the result is
 * redaction-checked before it is returned — a leak fails loudly here rather than
 * silently in a public artifact.
 */
export function reconcile(source: FixtureDataset, target: FixtureDataset): ReconciliationReport {
  const counts = {} as Record<EntityKind, { source: number; target: number }>;
  const hashes = {} as Record<EntityKind, { source: string; target: string }>;
  const differences: EntityDifference[] = [];

  for (const entity of ENTITY_KINDS) {
    const sourceRows = source[entity] as readonly { id: string }[];
    const targetRows = target[entity] as readonly { id: string }[];

    counts[entity] = { source: sourceRows.length, target: targetRows.length };
    hashes[entity] = { source: sha256(sourceRows), target: sha256(targetRows) };

    const sourceIndex = indexById(sourceRows);
    const targetIndex = indexById(targetRows);

    const missingInTarget: string[] = [];
    const changed: string[] = [];
    for (const [id, hash] of sourceIndex) {
      const targetHash = targetIndex.get(id);
      if (targetHash === undefined) missingInTarget.push(id);
      else if (targetHash !== hash) changed.push(id);
    }

    const extraInTarget = [...targetIndex.keys()].filter((id) => !sourceIndex.has(id));

    if (missingInTarget.length > 0 || extraInTarget.length > 0 || changed.length > 0) {
      differences.push({
        entity,
        missingInTarget: missingInTarget.sort(),
        extraInTarget: extraInTarget.sort(),
        changed: changed.sort(),
      });
    }
  }

  const report: ReconciliationReport = {
    counts: Object.freeze(counts),
    hashes: Object.freeze(hashes),
    differences,
    clean: differences.length === 0,
  };

  assertRedacted(report);
  return report;
}
