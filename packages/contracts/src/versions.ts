/**
 * Per-contract versioning (Opus standard amendment, SHU-49).
 *
 * There is deliberately NO single "platform contract version" anymore:
 * every contract slot evolves independently, so a bump of the authz grant
 * semantics never drags the health envelope (or vice versa) with it.
 *
 * - `health`   – the /health envelope spoken by gateway & worker (wire v1).
 * - `authz`    – roles, grants, org hierarchy and active-context resolution.
 * - `identity` – the `bawes-aa.v1` actor assertion: claim set, envelope,
 *                signing input and subject policy.
 *
 * `PLATFORM_CONTRACT_VERSION` (in index.ts) is kept only as a wire-compatible
 * alias of the health slot for existing consumers; new code should read its
 * contract's own slot from this map.
 */
export const CONTRACT_VERSIONS = {
  health: "1.0.0",
  authz: "1.0.0",
  identity: "1.0.0",
} as const;

export type ContractName = keyof typeof CONTRACT_VERSIONS;

/**
 * Deliberately `string`, not the union of today's literals. All three slots
 * currently read "1.0.0", so a literal type would make
 * `contractVersion("authz") === "1.1.0"` a compile error for every consumer
 * until something happened to be bumped. The compatibility policy in
 * docs/authz-roles.md defines what a bump means.
 */
export type ContractVersion = string;

export function contractVersion(name: ContractName): ContractVersion {
  return CONTRACT_VERSIONS[name];
}
