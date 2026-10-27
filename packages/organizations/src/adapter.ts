import type { ApprovedOrganizationAdapter, ApprovedOrganizationSnapshot } from "./types.js";

/** Synthetic/local adapter. It has no I/O and is never an authority for migration. */
export class InMemoryApprovedOrganizationAdapter implements ApprovedOrganizationAdapter {
  readonly #rows: ReadonlyMap<string, unknown>;

  constructor(rows: ReadonlyMap<string, unknown> = new Map()) {
    this.#rows = rows;
  }

  async readSnapshot(orgId: string): Promise<ApprovedOrganizationSnapshot> {
    return this.#rows.has(orgId) ? { kind: "found", row: this.#rows.get(orgId) } : { kind: "missing" };
  }

  async readSnapshots(orgIds: readonly string[]): Promise<ReadonlyMap<string, ApprovedOrganizationSnapshot>> {
    return new Map(orgIds.map((orgId) => [orgId, this.#rows.has(orgId)
      ? { kind: "found" as const, row: this.#rows.get(orgId) }
      : { kind: "missing" as const }]));
  }
}

/** Runtime default until an approved source is configured. Every imported field stays unavailable. */
export class UnconfiguredApprovedOrganizationAdapter implements ApprovedOrganizationAdapter {
  async readSnapshot(): Promise<ApprovedOrganizationSnapshot> {
    return { kind: "unconfigured" };
  }

  async readSnapshots(orgIds: readonly string[]): Promise<ReadonlyMap<string, ApprovedOrganizationSnapshot>> {
    return new Map(orgIds.map((orgId) => [orgId, { kind: "unconfigured" as const }]));
  }
}
