/** Synthetic domain shapes used by fixtures, import and reconciliation. */

export interface Organization {
  readonly id: string;
  readonly name: string;
  readonly country: string;
}

export interface Candidate {
  readonly id: string;
  readonly email: string;
  readonly displayName: string;
  readonly universityId: string;
  readonly status: "active" | "inactive";
}

export interface HiringRequest {
  readonly id: string;
  readonly organizationId: string;
  readonly title: string;
  readonly openings: number;
  readonly status: "open" | "closed";
}

export interface Application {
  readonly id: string;
  readonly requestId: string;
  readonly candidateId: string;
  readonly stage: "applied" | "interview" | "offer" | "rejected";
}

export interface FixtureDataset {
  readonly seed: string;
  readonly organizations: readonly Organization[];
  readonly candidates: readonly Candidate[];
  readonly requests: readonly HiringRequest[];
  readonly applications: readonly Application[];
}

/** Entity collections carried by a dataset, in a stable order. */
export const ENTITY_KINDS = ["organizations", "candidates", "requests", "applications"] as const;

export type EntityKind = (typeof ENTITY_KINDS)[number];
