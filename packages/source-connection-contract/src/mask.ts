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
