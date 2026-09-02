import { shortDigest } from "../../fixtures/src/canonical.js";
import type { FixtureDataset } from "../../fixtures/src/types.js";

export interface InvariantViolation {
  /** Stable rule identifier, safe to assert on in tests. */
  readonly rule: string;
  readonly entity: string;
  /** Synthetic or legacy identifier — never a personal value. */
  readonly id: string;
  /** Actionable description. Contains identifiers and digests only. */
  readonly detail: string;
}

/**
 * Referential and business rules. Every violation names the rule, the entity and
 * the offending id so an operator can act on it, and deliberately never quotes a
 * field value — evidence from these checks is safe to publish.
 */
export function checkInvariants(dataset: FixtureDataset): readonly InvariantViolation[] {
  const violations: InvariantViolation[] = [];

  const organizationIds = new Set(dataset.organizations.map((row) => row.id));
  const candidateIds = new Set(dataset.candidates.map((row) => row.id));
  const requestIds = new Set(dataset.requests.map((row) => row.id));

  for (const request of dataset.requests) {
    if (!organizationIds.has(request.organizationId)) {
      violations.push({
        rule: "referential.request.organization",
        entity: "requests",
        id: request.id,
        detail: `organizationId '${request.organizationId}' has no organization`,
      });
    }
    if (request.openings < 1) {
      violations.push({
        rule: "business.request.openings",
        entity: "requests",
        id: request.id,
        detail: `openings must be >= 1, found ${request.openings}`,
      });
    }
  }

  for (const application of dataset.applications) {
    if (!requestIds.has(application.requestId)) {
      violations.push({
        rule: "referential.application.request",
        entity: "applications",
        id: application.id,
        detail: `requestId '${application.requestId}' has no request`,
      });
    }
    if (!candidateIds.has(application.candidateId)) {
      violations.push({
        rule: "referential.application.candidate",
        entity: "applications",
        id: application.id,
        detail: `candidateId '${application.candidateId}' has no candidate`,
      });
    }
  }

  // Duplicate contact is reported by digest, never by address: the point is that
  // two ids collide, not what they collide on.
  const emailOwners = new Map<string, string>();
  for (const candidate of dataset.candidates) {
    const digest = shortDigest(candidate.email.trim().toLowerCase());
    const existing = emailOwners.get(digest);
    if (existing) {
      violations.push({
        rule: "business.candidate.uniqueEmail",
        entity: "candidates",
        id: candidate.id,
        detail: `email digest ${digest} already used by '${existing}'`,
      });
      continue;
    }
    emailOwners.set(digest, candidate.id);
  }

  const applicationPairs = new Map<string, string>();
  for (const application of dataset.applications) {
    const pairKey = `${application.requestId}:${application.candidateId}`;
    const existing = applicationPairs.get(pairKey);
    if (existing) {
      violations.push({
        rule: "business.application.uniquePerRequestCandidate",
        entity: "applications",
        id: application.id,
        detail: `duplicate of '${existing}' for ${pairKey}`,
      });
      continue;
    }
    applicationPairs.set(pairKey, application.id);
  }

  return violations;
}
