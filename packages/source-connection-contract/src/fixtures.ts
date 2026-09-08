/**
 * Synthetic fixtures for the SHU-77 source-connection contract.
 *
 * Every value in this file is invented. There is no donor export, no live
 * query, no credential, and no personal data here, and nothing in this package
 * reads any. The identifiers are deliberately self-describing ("person-alpha",
 * "discord-uid-...") so a real identifier appearing anywhere in this package's
 * fixtures, tests, reports or pull requests is visible at a glance.
 *
 * `PROFILE_CANARY` exists so the sensitive-output scenarios can assert a
 * negative: a value present in the INPUT that must appear in no output of any
 * kind. A test that only checks "the output has no `profile` field" passes
 * against an implementation that inlines the same value under a different name;
 * a canary does not.
 *
 * The default profile claims are derived from `personId`, so two rows for the
 * same person share them and two rows for different people do not. That is what
 * lets the profile-matching scenario be specific: a record set where two
 * DIFFERENT people share a profile claim only occurs where a scenario asks for
 * it explicitly.
 */

import type { RawSourceRecord } from "./types.js";

/**
 * A value planted in fixture profile claims. It must never appear in a
 * normalization result, a dry-run report, a rejection, or a conflict.
 */
export const PROFILE_CANARY = "PROFILE-CANARY-MUST-NOT-BE-EMITTED";

/** Synthetic platform person identifiers. */
export const PERSON_ALPHA = "person-alpha";
export const PERSON_BETA = "person-beta";
export const PERSON_GAMMA = "person-gamma";

/** Synthetic external account identifiers, long enough to exercise masking. */
export const DISCORD_ACCOUNT_ONE = "discord-uid-000000000000000101";
export const DISCORD_ACCOUNT_TWO = "discord-uid-000000000000000102";
export const GOOGLE_ACCOUNT_ONE = "google-sub-000000000000000201";
export const GOOGLE_ACCOUNT_TWO = "google-sub-000000000000000202";

/** Synthetic provenance strings, naming a fixture rather than a real export. */
export const DISCORD_PROVENANCE = "synthetic-fixture/discord-export-0001";
export const GOOGLE_PROVENANCE = "synthetic-fixture/google-export-0001";

/**
 * Mutable claims a donor export might carry. Nothing in the contract may key,
 * match, or join on any of these; they exist in the fixtures only so the
 * scenarios can prove that.
 */
export function syntheticProfile(
  personId: string,
  overrides: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> {
  return {
    displayName: `synthetic-display-name-${personId} ${PROFILE_CANARY}`,
    email: `synthetic-${personId}-${PROFILE_CANARY}@example.invalid`,
    locale: "en-US",
    ...overrides,
  };
}

function withDerivedProfile(
  base: RawSourceRecord,
  overrides: Partial<RawSourceRecord>,
): RawSourceRecord {
  const merged: RawSourceRecord = { ...base, ...overrides };
  if ("profile" in overrides) {
    return merged;
  }
  return { ...merged, profile: syntheticProfile(merged.personId ?? "unknown-person") };
}

/** Build a well-formed synthetic Discord record, then override what a test needs. */
export function discordRecord(overrides: Partial<RawSourceRecord> = {}): RawSourceRecord {
  return withDerivedProfile(
    {
      source: "discord",
      externalId: DISCORD_ACCOUNT_ONE,
      personId: PERSON_ALPHA,
      provenance: DISCORD_PROVENANCE,
      observedAt: "2026-01-02T03:04:05Z",
    },
    overrides,
  );
}

/** Build a well-formed synthetic Google record, then override what a test needs. */
export function googleRecord(overrides: Partial<RawSourceRecord> = {}): RawSourceRecord {
  return withDerivedProfile(
    {
      source: "google",
      externalId: GOOGLE_ACCOUNT_ONE,
      personId: PERSON_BETA,
      provenance: GOOGLE_PROVENANCE,
      observedAt: "2026-01-03T06:07:08Z",
    },
    overrides,
  );
}
