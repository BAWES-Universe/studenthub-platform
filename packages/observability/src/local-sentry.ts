import { randomBytes } from 'node:crypto';
import { NodeClient, defaultStackParser } from '@sentry/node';
import type { Event, ErrorEvent } from '@sentry/node';
import { sanitizeEvent, type SafeEvent } from './schema.js';
export const EVENT_LIMIT = 128;
export const EVENT_TTL_MS = 3_600_000;
function sentryEvent(event: SafeEvent, id: string): ErrorEvent {
  return {
    type: undefined, timestamp: Date.now() / 1000, event_id: id, platform: 'node', level: event.outcome === 'failure' || event.outcome === 'aborted' ? 'error' : 'info',
    message: `studenthub.${event.fault === 'none' ? event.outcome : event.fault}`,
    fingerprint: ['studenthub', event.component, event.journey, event.fault, event.outcome],
    tags: { component: event.component, journey: event.journey, outcome: event.outcome, fault: event.fault, mode: 'local' },
    contexts: { trace: { trace_id: event.traceId, span_id: event.spanId,
      ...(event.parentSpanId ? { parent_span_id: event.parentSpanId } : {}), op: `${event.component}.${event.journey}` } },
    measurements: { journey_duration: { value: event.durationMs, unit: 'millisecond' } },
  };
}
/** No network transport exists here, even if inherited SENTRY_* configuration is populated. */
export function createLocalSentry(now: () => number = Date.now) {
  const pending = new Map<string, SafeEvent>();
  const captured: { at: number; event: Event }[] = [];
  function prune() { while (captured.length && now() - captured[0].at >= EVENT_TTL_MS) captured.shift(); }
  const client = new NodeClient({
    dsn: 'https://local@telemetry.invalid/1', environment: 'local',
    integrations: [], stackParser: defaultStackParser, sendDefaultPii: false,
    tracesSampleRate: 0, enableLogs: false,
    beforeSend(event) {
      const safe = event.event_id ? pending.get(event.event_id) : undefined;
      return safe && event.event_id ? sentryEvent(safe, event.event_id) : null;
    },
    transport: () => ({
      send(envelope) {
        // A second rebuild at the transport boundary also discards SDK enrichment,
        // envelope metadata, attachments, replay, spans and unknown item types.
        for (const [header, payload] of envelope[1]) {
          if (header.type !== 'event' || !payload || typeof payload !== 'object') continue;
          const id = (payload as Event).event_id;
          const safe = id ? pending.get(id) : undefined;
          if (!safe || !id) continue;
          prune(); captured.push({ at: now(), event: sentryEvent(safe, id) });
          while (captured.length > EVENT_LIMIT) captured.shift();
          pending.delete(id);
        }
        return Promise.resolve({ statusCode: 200 });
      },
      flush: () => Promise.resolve(true),
    }),
  });
  client.init();
  return {
    async capture(input: unknown) {
      const event = sanitizeEvent(input);
      if (!event || pending.size >= 64) return false;
      const id = randomBytes(16).toString('hex'); pending.set(id, event);
      try {
        client.captureEvent(sentryEvent(event, id));
        await client.flush(100);
        return !pending.has(id); // Only the transport can acknowledge delivery.
      } catch { return false; }
      finally { pending.delete(id); }
    },
    async snapshot() { await client.flush(100); prune(); return structuredClone(captured.map(({ event }) => event)); },
    prune,
    async close() { captured.length = 0; pending.clear(); await client.close(100); },
  };
}
