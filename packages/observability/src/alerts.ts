/** Local rule evaluation only. No notification or external integration is activated. */
export type Alert = {
  code: 'journey_failures' | 'journey_latency' | 'telemetry_dropped' | 'telemetry_unavailable';
  owner: 'platform-on-call';
  runbook: 'docs/observability.md';
}|{code:'job_failed'|'job_overlap'|'job_missed';jobName:'heartbeat'|'missed_run_check';owner:'platform-on-call';runbook:'docs/observability.md'};
export function evaluateAlerts(snapshot: {
  metrics: Record<string, { count: number; buckets: number[] }>;
  counters: { dropped: number; unavailable: number };
}): Alert[] {
  const codes = new Set<Exclude<Alert['code'],'job_failed'|'job_overlap'|'job_missed'>>();
  const journeys = new Map<string, { count: number; failed: number; slow: number }>();
  for (const [key, metric] of Object.entries(snapshot.metrics)) {
    const [component, journey, outcome] = key.split(':');
    const id = `${component}:${journey}`;
    const summary = journeys.get(id) ?? { count: 0, failed: 0, slow: 0 };
    summary.count += metric.count;
    if (outcome === 'failure' || outcome === 'aborted') summary.failed += metric.count;
    summary.slow += metric.count - metric.buckets[4]; // > 1 second
    journeys.set(id, summary);
  }
  for (const summary of journeys.values()) {
    if (summary.failed >= 5 && summary.failed / summary.count >= 0.05) codes.add('journey_failures');
    if (summary.count >= 20 && summary.slow / summary.count > 0.05) codes.add('journey_latency');
  }
  if (snapshot.counters.dropped > 0) codes.add('telemetry_dropped');
  if (snapshot.counters.unavailable > 0) codes.add('telemetry_unavailable');
  return [...codes].map(code => ({ code, owner: 'platform-on-call', runbook: 'docs/observability.md' }));
}
