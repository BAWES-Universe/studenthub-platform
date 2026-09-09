import { CONTRACT_VERSIONS } from "./versions.js";

export * from "./versions.js";
export * from "./authz/index.js";
export * from "./search.js";

/**
 * Wire-compatible alias kept for existing consumers (gateway/worker health
 * envelopes and their tests). Per-contract versioning lives in
 * CONTRACT_VERSIONS — new contracts must read their own slot instead of this.
 */
export const PLATFORM_CONTRACT_VERSION = CONTRACT_VERSIONS.health;

export type PlatformComponent = "gateway" | "worker";

export interface HealthResponse {
  readonly status: "ok";
  readonly component: PlatformComponent;
  readonly contractVersion: typeof PLATFORM_CONTRACT_VERSION;
  /**
   * Exact deployed source revision, baked at image build time via
   * `SOURCE_REVISION` (preflight requires the 40-hex form). Null when the
   * variable is unset (local development). Exposing it on the health payload
   * makes every deploy self-attesting: any party can confirm which commit is
   * serving without GHCR or Coolify access.
   */
  readonly revision: string | null;
  readonly timestamp: string;
}

export interface McpToolCall {
  readonly name: string;
  readonly arguments: Readonly<Record<string, unknown>>;
}

export interface McpToolResult {
  readonly ok: boolean;
  readonly content: readonly { readonly type: "text"; readonly text: string }[];
}

export interface McpAdapter {
  callTool(call: McpToolCall): Promise<McpToolResult>;
}

export function createHealthResponse(
  component: PlatformComponent,
  now: Date = new Date(),
  revision: string | null = process.env.SOURCE_REVISION || null,
): HealthResponse {
  return Object.freeze({
    status: "ok",
    component,
    contractVersion: PLATFORM_CONTRACT_VERSION,
    revision,
    timestamp: now.toISOString(),
  });
}
