import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
const mutations = [
  ['SDK failure hidden', 'packages/observability/src/local-sentry.js', 'catch {\n                return false;', 'catch {\n                return true;', 'SDK: ambient'],
  ['abort observation removed', 'apps/gateway/src/index.js', "response.once('close', () => complete(!response.writableFinished));", '', 'gateway: aborted'],
  ['unknown fields leak', 'packages/observability/src/schema.js', 'return { version: 1, traceId, spanId,', 'return { ...input, version: 1, traceId, spanId,', 'redaction: exhaustive'],
  ['journey vocabulary bypass', 'packages/observability/src/schema.js', '!JOURNEYS.includes(journey)', 'false', 'redaction: poisoned'],
  ['untrusted context inheritance', 'packages/observability/src/index.js', 'parent && minted.has(parent) ? parent : undefined', 'parent', 'correlation: only'],
  ['audit correlation removed', 'apps/gateway/src/authz-middleware.js', 'currentTraceId() ?? middleware.newRequestId()', 'middleware.newRequestId()', 'gateway: concurrent'],
  ['worker span disconnected', 'packages/observability/src/index.js', 'const span = newSpan(), start = performance.now();', 'const span = newSpan({}), start = performance.now();', 'gateway: concurrent'],
  ['gateway emission removed', 'apps/gateway/src/index.js', "telemetry.record(span, 'gateway', journey, outcome, reason, performance.now() - started);", '', 'gateway: concurrent'],
  ['web emission removed', 'apps/gateway/src/index.js', "telemetry.record(webSpan, 'web', journey, outcome, reason, performance.now() - started);", '{}', 'gateway: concurrent'],
  ['worker failure emission removed', 'packages/observability/src/index.js', "telemetry.record(span, 'worker', journey, 'failure', 'job_failure', performance.now() - start);", '', 'metrics: fixed'],
  ['queue bound removed', 'packages/observability/src/index.js', 'this.pending.size >= LIMIT', 'false', 'isolation: stalled'],
  ['request waits for telemetry', 'apps/gateway/src/index.js', "void inSpan(webSpan ?? span, async () => {", "void inSpan(webSpan ?? span, async () => { await telemetry.snapshot();", 'isolation: stalled'],
  ['retention expiry removed', 'packages/observability/src/local-sentry.js', 'now() - captured[0].at >= EVENT_TTL_MS', 'false', 'retention: Sentry'],
  ['retention capacity removed', 'packages/observability/src/local-sentry.js', 'captured.length > EVENT_LIMIT', 'false', 'retention: Sentry'],
  ['latency measurement removed', 'packages/observability/src/index.js', 'event.durationMs <= bound', 'false', 'metrics: fixed'],
  ['external mode accepted', 'packages/observability/src/index.js', "env.SHU_TELEMETRY_MODE === 'local'", "Boolean(env.SENTRY_DSN) || env.SHU_TELEMETRY_MODE === 'local'", 'configuration: external'],
  ['failure alert removed', 'packages/observability/src/alerts.js', "codes.add('journey_failures')", 'void 0', 'alerts: failure'],
];
const root = new URL('../../../', import.meta.url);
const suite = 'packages/observability/test/observability.test.js';
for (const [name, file, from, to, pattern] of mutations) {
  // Scratch copy under repository root retains workspace dependency resolution.
  const dir = await mkdtemp(new URL('./node_modules/.shu90-mutation-', root).pathname);
  try {
    await cp(new URL('./dist/', root), dir, { recursive: true });
    await writeFile(join(dir, 'package.json'), '{"type":"module"}');
    const target = join(dir, file), source = await readFile(target, 'utf8');
    assert.equal(source.split(from).length - 1, 1, `mutation must bind exactly once: ${name}`);
    await writeFile(target, source.replace(from, to));
    const run = spawnSync(process.execPath, ['--test', '--test-reporter=tap', `--test-name-pattern=${pattern}`, join(dir, suite)], { encoding: 'utf8', timeout: 20_000 });
    const output = run.stdout + run.stderr;
    assert.equal(run.error, undefined, `${name}: runner error`);
    assert.notEqual(run.status, 0, `${name}: survived`);
    assert.match(output, new RegExp(`not ok \\d+ - ${pattern}`), `${name}: wrong failure\n${output}`);
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND|ERR_UNKNOWN_FILE_EXTENSION/, `${name}: infrastructure failure\n${output}`);
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
  } finally { await rm(dir, { recursive: true, force: true }); }
}
process.stdout.write(`${mutations.length}/${mutations.length} SHU-90 mutations killed\n`);
