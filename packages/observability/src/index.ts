import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { sanitizeEvent, type Component, type Journey, type Outcome, type Fault } from './schema.js';
export * from './schema.js';
export * from './alerts.js';
const context = new AsyncLocalStorage<Span>();
const minted = new WeakSet<object>();
export interface Span { readonly traceId: string; readonly spanId: string; readonly parentSpanId?: string }
export function newSpan(parent = context.getStore()): Span {
  const trusted = parent && minted.has(parent) ? parent : undefined;
  const span = Object.freeze({ traceId: trusted?.traceId ?? randomBytes(16).toString('hex'),
    spanId: randomBytes(8).toString('hex'), ...(trusted ? { parentSpanId: trusted.spanId } : {}) });
  minted.add(span); return span;
}
export function currentTraceId(): string | undefined { return context.getStore()?.traceId; }
export function inSpan<T>(span: Span, work: () => T): T { return context.run(minted.has(span) ? span : newSpan(), work); }
export const LIMIT = 64;
export const RETENTION_MS = 5 * 60 * 1000;
export const LATENCY_BUCKETS = [10, 50, 100, 500, 1000, 5000, 30_000, 3_600_000] as const;
export function telemetryMode(env: NodeJS.ProcessEnv): 'disabled' | 'local' {
  // SENTRY_DSN and other SDK environment variables deliberately confer no authority.
  return env.SHU_TELEMETRY_MODE === 'local' ? 'local' : 'disabled';
}
interface Metric { count: number; durationMs: number; buckets: number[] }
export class Telemetry {
  private worker?: Worker;
  private pending = new Map<number, ReturnType<typeof setTimeout>>();
  private sequence = 0;
  private stopped = false;
  private metrics = new Map<string, Metric>();
  private epoch = Date.now();
  private expiry?: ReturnType<typeof setInterval>;
  private counters = { accepted: 0, dropped: 0, unavailable: 0 };
  constructor(mode: 'disabled' | 'local' = 'disabled', workerUrl = new URL('./sentry-worker.js', import.meta.url)) {
    if (mode !== 'local') return;
    this.expiry = setInterval(() => {
      if (Date.now() - this.epoch >= RETENTION_MS) { this.metrics.clear(); this.epoch = Date.now(); }
    }, 1000); this.expiry.unref();
    try {
      this.worker = new Worker(workerUrl, { env: {}, resourceLimits: { maxOldGenerationSizeMb: 64 } });
      this.worker.unref();
      this.worker.on('message', (message) => {
        if (message?.type === 'unavailable') this.disable();
        if (message?.type === 'ack' && typeof message.id === 'number') {
          clearTimeout(this.pending.get(message.id)); this.pending.delete(message.id);
        }
      });
      this.worker.on('error', () => this.disable());
      this.worker.on('exit', () => this.disable());
    } catch { this.disable(); }
  }
  private disable(outage = true): void {
    if (this.stopped) return;
    this.stopped = true; if (outage) this.counters.unavailable++;
    clearInterval(this.expiry); this.metrics.clear();
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear(); void this.worker?.terminate().catch(() => undefined);
  }
  record(span: Span, component: Component, journey: Journey, outcome: Outcome, fault: Fault, durationMs: number): void {
    try {
      if (!minted.has(span)) return;
      const event = sanitizeEvent({ version: 1, ...span, component, journey, outcome, fault,
        durationMs: Math.min(3_600_000, Math.max(0, durationMs)) });
      if (!event || !this.worker || this.stopped) return;
      if (Date.now() - this.epoch >= RETENTION_MS) { this.metrics.clear(); this.epoch = Date.now(); }
      const key = `${event.component}:${event.journey}:${event.outcome}`;
      const metric = this.metrics.get(key) ?? { count: 0, durationMs: 0, buckets: LATENCY_BUCKETS.map(() => 0) };
      metric.count = Math.min(Number.MAX_SAFE_INTEGER, metric.count + 1);
      metric.durationMs = Math.min(Number.MAX_SAFE_INTEGER, metric.durationMs + event.durationMs);
      LATENCY_BUCKETS.forEach((bound, i) => { if (event.durationMs <= bound) metric.buckets[i] = Math.min(Number.MAX_SAFE_INTEGER, metric.buckets[i] + 1); });
      this.metrics.set(key, metric);
      if (this.pending.size >= LIMIT) { this.counters.dropped++; return; }
      const id = ++this.sequence;
      const timer = setTimeout(() => this.disable(), 2000); timer.unref();
      this.pending.set(id, timer);
      // No callback, SDK, transport, disk write or await runs on the request thread.
      this.worker.postMessage({ type: 'event', id, event }); this.counters.accepted++;
    } catch { this.disable(); }
  }
  async snapshot(): Promise<{ metrics: Record<string, Metric>; counters: { accepted: number; dropped: number; unavailable: number }; events: unknown[] }> {
    if (Date.now() - this.epoch >= RETENTION_MS) { this.metrics.clear(); this.epoch = Date.now(); }
    const base = { metrics: structuredClone(Object.fromEntries(this.metrics)), counters: { ...this.counters } };
    if (!this.worker || this.stopped) return { ...base, events: [] };
    const worker = this.worker;
    const events = await new Promise<unknown[]>((resolve) => {
      const id = ++this.sequence;
      const timer = setTimeout(() => finish([]), 2000);
      const receive = (message: { type?: string; id?: number; events?: unknown[] }) => {
        if (message.type === 'snapshot' && message.id === id) finish(message.events ?? []);
      };
      const finish = (values: unknown[]) => { clearTimeout(timer); worker.off('message', receive); resolve(values); };
      worker.on('message', receive);
      try { worker.postMessage({ type: 'snapshot', id }); } catch { finish([]); }
    });
    return { metrics: structuredClone(Object.fromEntries(this.metrics)), counters: { ...this.counters }, events };
  }
  async close(): Promise<void> { this.disable(false); await this.worker?.terminate().catch(() => undefined); this.metrics.clear(); }
}
export const disabledTelemetry = new Telemetry();
export async function observedJob<T>(work: () => Promise<T>, telemetry = disabledTelemetry, journey: Journey = 'job'): Promise<T> {
  const span = newSpan(), start = performance.now();
  return inSpan(span, async () => {
    try { const result = await work(); telemetry.record(span, 'worker', journey, 'success', 'none', performance.now() - start); return result; }
    catch (error) { telemetry.record(span, 'worker', journey, 'failure', 'job_failure', performance.now() - start); throw error; }
  });
}
