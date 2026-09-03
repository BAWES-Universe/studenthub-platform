import { sha256 } from "./canonical.js";
import { ENTITY_KINDS, type EntityKind, type FixtureDataset } from "./types.js";

export interface FixtureManifest {
  readonly seed: string;
  readonly counts: Readonly<Record<EntityKind, number>>;
  readonly entityHashes: Readonly<Record<EntityKind, string>>;
  readonly manifestHash: string;
}

/**
 * A manifest deliberately carries no timestamp and no host detail: it must hash
 * identically on every machine so CI can assert reproducibility.
 */
export function buildManifest(dataset: FixtureDataset): FixtureManifest {
  const counts = {} as Record<EntityKind, number>;
  const entityHashes = {} as Record<EntityKind, string>;

  for (const kind of ENTITY_KINDS) {
    const rows = dataset[kind];
    counts[kind] = rows.length;
    entityHashes[kind] = sha256(rows);
  }

  return Object.freeze({
    seed: dataset.seed,
    counts: Object.freeze(counts),
    entityHashes: Object.freeze(entityHashes),
    manifestHash: sha256({ seed: dataset.seed, counts, entityHashes }),
  });
}
