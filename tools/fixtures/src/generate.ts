import { createPrng, seedFromString } from "./prng.js";
import type {
  Application,
  Candidate,
  FixtureDataset,
  HiringRequest,
  Organization,
} from "./types.js";

/**
 * Every generated value is synthetic by construction. Emails use the reserved
 * `.invalid` TLD (RFC 2606), which can never resolve to a real mailbox, and
 * display names come from the NATO alphabet rather than any person register.
 */
const NAME_PARTS = [
  "Alpha", "Bravo", "Charlie", "Delta", "Echo", "Foxtrot", "Golf", "Hotel",
  "India", "Juliett", "Kilo", "Lima", "Mike", "November", "Oscar", "Papa",
] as const;

const COUNTRIES = ["KW", "AE", "SA", "QA", "BH", "OM"] as const;
const STAGES = ["applied", "interview", "offer", "rejected"] as const;

export interface FixtureSize {
  readonly organizations: number;
  readonly candidates: number;
  readonly requests: number;
  readonly applications: number;
}

export const DEFAULT_SIZE: FixtureSize = Object.freeze({
  organizations: 4,
  candidates: 24,
  requests: 8,
  applications: 40,
});

function pad(value: number): string {
  return String(value).padStart(4, "0");
}

function pick<T>(items: readonly T[], random: () => number): T {
  return items[Math.floor(random() * items.length)] as T;
}

/**
 * Builds a deterministic, referentially consistent dataset. The same seed and
 * size always produce byte-identical output — there is no clock, no UUID and no
 * ambient randomness anywhere in this function.
 */
export function generateDataset(seed: string, size: FixtureSize = DEFAULT_SIZE): FixtureDataset {
  const random = createPrng(seedFromString(seed));

  const organizations: Organization[] = Array.from({ length: size.organizations }, (_, index) => ({
    id: `org-${pad(index + 1)}`,
    name: `${pick(NAME_PARTS, random)} Holding ${pad(index + 1)}`,
    country: pick(COUNTRIES, random),
  }));

  const candidates: Candidate[] = Array.from({ length: size.candidates }, (_, index) => ({
    id: `cand-${pad(index + 1)}`,
    email: `candidate-${pad(index + 1)}@fixture.invalid`,
    displayName: `${pick(NAME_PARTS, random)} ${pick(NAME_PARTS, random)}`,
    universityId: `uni-${pad(1 + Math.floor(random() * 6))}`,
    status: random() < 0.85 ? "active" : "inactive",
  }));

  const requests: HiringRequest[] = Array.from({ length: size.requests }, (_, index) => ({
    id: `req-${pad(index + 1)}`,
    organizationId: organizations[Math.floor(random() * organizations.length)]!.id,
    title: `${pick(NAME_PARTS, random)} Role ${pad(index + 1)}`,
    openings: 1 + Math.floor(random() * 5),
    status: random() < 0.7 ? "open" : "closed",
  }));

  // Applications are unique per (request, candidate); collisions are skipped
  // rather than resolved randomly, keeping generation deterministic.
  const applications: Application[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < size.applications; index += 1) {
    const request = requests[Math.floor(random() * requests.length)]!;
    const candidate = candidates[Math.floor(random() * candidates.length)]!;
    const pairKey = `${request.id}:${candidate.id}`;
    const stage = pick(STAGES, random);
    if (seen.has(pairKey)) continue;
    seen.add(pairKey);
    applications.push({
      id: `app-${pad(applications.length + 1)}`,
      requestId: request.id,
      candidateId: candidate.id,
      stage,
    });
  }

  return { seed, organizations, candidates, requests, applications };
}
