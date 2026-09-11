import { parentPort } from 'node:worker_threads';
import { createLocalSentry } from './local-sentry.js';
const sentry = createLocalSentry();
const expiry = setInterval(() => sentry.prune(), 1000); expiry.unref();
parentPort?.on('message', async (message) => {
  try {
    if (message.type === 'event') {
      const delivered = await sentry.capture(message.event);
      parentPort?.postMessage({ type: delivered ? 'ack' : 'unavailable', id: message.id });
    } else if (message.type === 'snapshot') {
      parentPort?.postMessage({ type: 'snapshot', id: message.id, events: await sentry.snapshot() });
    }
  } catch {
    // No raw exception or incoming message is ever echoed into the diagnostic channel.
    parentPort?.postMessage({ type: 'unavailable', id: message.id });
  }
});
