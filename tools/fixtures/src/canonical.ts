import { createHash } from "node:crypto";

/**
 * Deterministic JSON: object keys sorted, `undefined` dropped. Two structurally
 * equal values always serialise to the same string, so hashes are stable across
 * runs, machines and Node versions.
 */
export function canonicalize(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(",")}]`;

  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entryValue]) => entryValue !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));

  return `{${entries.map(([key, entryValue]) => `${JSON.stringify(key)}:${canonicalize(entryValue)}`).join(",")}}`;
}

export function sha256(value: unknown): string {
  return createHash("sha256").update(canonicalize(value), "utf8").digest("hex");
}

/** Short digest for referring to a value in evidence without disclosing it. */
export function shortDigest(value: unknown): string {
  return sha256(value).slice(0, 12);
}
