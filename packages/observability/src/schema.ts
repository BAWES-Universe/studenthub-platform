/** Only closed vocabularies and server-minted random IDs cross the telemetry boundary. */
export const JOURNEYS = ['landing', 'login_start', 'login_callback', 'profile_read', 'logout', 'mcp_call', 'health', 'asset', 'unknown', 'heartbeat', 'job'] as const;
export const COMPONENTS = ['gateway', 'web', 'worker'] as const;
export const OUTCOMES = ['success', 'refused', 'failure', 'aborted'] as const;
export const FAULTS = ['none', 'dependency_unavailable', 'render_failure', 'adapter_failure', 'unhandled_failure', 'job_failure', 'response_aborted'] as const;
export type Journey = typeof JOURNEYS[number];
export type Component = typeof COMPONENTS[number];
export type Outcome = typeof OUTCOMES[number];
export type Fault = typeof FAULTS[number];
export interface SafeEvent {
  version: 1; traceId: string; spanId: string; parentSpanId?: string;
  journey: Journey; component: Component; outcome: Outcome; fault: Fault;
  durationMs: number;
}
function own(value: object, key: string): unknown {
  // Never invoke getters, toJSON, or coercions on untrusted objects.
  return Object.getOwnPropertyDescriptor(value, key)?.value;
}
export function sanitizeEvent(input: unknown): SafeEvent | null {
  try {
    if (!input || typeof input !== 'object') return null;
    const traceId = own(input, 'traceId'), spanId = own(input, 'spanId'), parentSpanId = own(input, 'parentSpanId');
    const journey = own(input, 'journey'), component = own(input, 'component');
    const outcome = own(input, 'outcome'), fault = own(input, 'fault'), durationMs = own(input, 'durationMs');
    if (own(input, 'version') !== 1 || typeof traceId !== 'string' || !/^[a-f0-9]{32}$/.test(traceId)
      || typeof spanId !== 'string' || !/^[a-f0-9]{16}$/.test(spanId)
      || (parentSpanId !== undefined && (typeof parentSpanId !== 'string' || !/^[a-f0-9]{16}$/.test(parentSpanId)))
      || !JOURNEYS.includes(journey as Journey) || !COMPONENTS.includes(component as Component)
      || !OUTCOMES.includes(outcome as Outcome) || !FAULTS.includes(fault as Fault)
      || typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0 || durationMs > 3_600_000) return null;
    return { version: 1, traceId, spanId, ...(parentSpanId === undefined ? {} : { parentSpanId }),
      journey: journey as Journey, component: component as Component, outcome: outcome as Outcome,
      fault: fault as Fault, durationMs: Math.round(durationMs) };
  } catch { return null; }
}
export function classifyJourney(rawUrl: string | undefined): Journey {
  // No URL, query, dynamic path, tool name or request body is retained.
  const path = rawUrl?.split('?', 1)[0];
  switch (path) {
    case '/': return 'landing'; case '/login/universe': return 'login_start';
    case '/login/callback': return 'login_callback'; case '/profile': return 'profile_read';
    case '/logout': return 'logout'; case '/mcp/tools/call': return 'mcp_call';
    case '/health': return 'health'; case '/assets/studenthub.css': return 'asset'; default: return 'unknown';
  }
}
