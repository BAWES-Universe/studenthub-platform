import type { ApprovedProfileAdapter, ApprovedProfileLink } from "./types.js";

export interface SyntheticApprovedProfileLink {
  readonly principalId: string;
  readonly candidateRef: string;
}

/** Synthetic/local adapter. It has no I/O and is never an authority for migration. */
export class InMemoryApprovedProfileAdapter implements ApprovedProfileAdapter {
  readonly #links: readonly SyntheticApprovedProfileLink[];
  readonly #rows: ReadonlyMap<string, unknown>;

  constructor(input: {
    readonly links?: readonly SyntheticApprovedProfileLink[];
    readonly rows?: ReadonlyMap<string, unknown>;
  } = {}) {
    this.#links = Object.freeze([...(input.links ?? [])]);
    this.#rows = input.rows ?? new Map();
  }

  async resolveLink(principalId: string): Promise<ApprovedProfileLink> {
    const matches = this.#links.filter((link) => link.principalId === principalId);
    if (matches.length === 0) return { kind: "missing" };
    if (matches.length !== 1) return { kind: "conflict" };
    const candidateRef = matches[0]!.candidateRef;
    if (this.#links.some((link) => link.principalId !== principalId && link.candidateRef === candidateRef)) {
      return { kind: "conflict" };
    }
    return { kind: "linked", candidateRef };
  }

  async readCandidate(candidateRef: string): Promise<unknown | undefined> {
    return this.#rows.get(candidateRef);
  }
}

/** Runtime default until an approved source is configured. Always fails closed. */
export class UnconfiguredApprovedProfileAdapter implements ApprovedProfileAdapter {
  async resolveLink(): Promise<ApprovedProfileLink> {
    return { kind: "unconfigured" };
  }

  async readCandidate(): Promise<undefined> {
    return undefined;
  }
}
