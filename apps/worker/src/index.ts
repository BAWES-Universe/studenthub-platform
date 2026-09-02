import { pathToFileURL } from "node:url";

import { createHealthResponse, type HealthResponse } from "../../../packages/contracts/src/index.js";

export function createWorkerHeartbeat(now: Date = new Date()): HealthResponse {
  return createHealthResponse("worker", now);
}

const entrypoint = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entrypoint === import.meta.url) {
  process.stdout.write(`${JSON.stringify(createWorkerHeartbeat())}\n`);
}
