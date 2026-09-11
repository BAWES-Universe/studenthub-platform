import { Telemetry, telemetryMode, observedJob } from '../../../packages/observability/src/index.js';
export { observedJob } from '../../../packages/observability/src/index.js';
import { pathToFileURL } from "node:url";

import { createHealthResponse, type HealthResponse } from "@studenthub/contracts";

export function createWorkerHeartbeat(now: Date = new Date()): HealthResponse {
  return createHealthResponse("worker", now);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  const telemetry = new Telemetry(telemetryMode(process.env));
  try {
    const heartbeat = await observedJob(async () => createWorkerHeartbeat(), telemetry, 'heartbeat');
    process.stdout.write(`${JSON.stringify(heartbeat)}\n`);
    // Bounded diagnostic drain belongs to CLI shutdown, never a business request.
    await telemetry.snapshot();
  } finally { await telemetry.close(); }
}
