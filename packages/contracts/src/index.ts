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
): HealthResponse {
  return Object.freeze({
    status: "ok",
    component,
    contractVersion: PLATFORM_CONTRACT_VERSION,
    timestamp: now.toISOString(),
  });
}
