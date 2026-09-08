import { createHash } from "node:crypto";

/**
 * Identifier masking for the SHU-77 source-connection contract.
 *
 * This lives in its own module because both the implementation and the
 * conformance scenarios depend on it: the contract defines what a masked
 * identifier looks like, and an implementation does not get to redefine it.
 */

/** Characters of a raw identifier left visible on each side of a mask. */
const MASK_EDGE = 2;

/** An identifier short enough that showing any of it would show most of it. */
const MASK_ALL_BELOW = 2 * MASK_EDGE + 3;

/**
 * Reduce an identifier to something an operator can correlate against a donor
 * export without the value itself appearing in a report, a log, a pull request,
 * or an issue tracker. Total on all inputs, including the empty string.
 */
export function maskIdentifier(value: string): string {
  const length = value.length;
  if (length < MASK_ALL_BELOW) {
    return `***(${length})`;
  }
  return `${value.slice(0, MASK_EDGE)}***${value.slice(-MASK_EDGE)}(${length})`;
}

/**
 * A stable, non-revealing reference to a platform person id.
 *
 * Person ids get stronger treatment than external ids because a person id can
 * literally BE an email address: Universe applications run Authentik with
 * `sub_mode = user_email`, so the subject that becomes a principal id is the
 * user's address (`packages/actor-assertion/src/types.ts`), and SHU-59's audit
 * migration records the same hazard — "principal identifiers can contain an
 * Authentik subject or email in legacy bootstrap data", which is why those rows
 * store SHA-256 references rather than raw values.
 *
 * A prefix/suffix mask leaks part of an address; a digest leaks none of it and
 * is MORE useful to an operator, who can hash their own ids and match exactly
 * rather than eyeballing an elision. The 64-character hex shape matches the
 * platform's existing `authorization_mutation_audit` references.
 */
export function personRef(personId: string): string {
  return createHash("sha256").update(personId, "utf8").digest("hex");
}
