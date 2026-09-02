export const PLATFORM_CONTRACT_VERSION = "1.0.0" as const;

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
