import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

// One poll per invocation. A scheduler can invoke this command without any model.
// --events accepts normalized offline events; --run polls one explicit gateway run.
export function pollGatewayRun(repository, runId, execute = execFileSync) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? '') || !/^\d+$/.test(runId ?? '')) {
    throw new Error('explicit repository and numeric run ID required');
  }
  const run = JSON.parse(execute('gh', ['api', `repos/${repository}/actions/runs/${runId}`],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30_000 }));
  if (run.path !== '.github/workflows/build.yml' || String(run.id) !== runId) {
    throw new Error('run must belong to the gateway build workflow');
  }
  return [{ source: 'github', id: `${repository}/${runId}`, status: run.conclusion ?? run.status }];
}

export function emitFailures(events, signalDir, stdout = process.stdout) {
  if (!Array.isArray(events)) throw new Error('events must be an array');
  const failures = events.filter((event) => ['failed', 'failure', 'timed_out', 'startup_failure']
    .includes(String(event?.status).toLowerCase()));
  for (const event of failures) {
    if (!['github', 'coolify'].includes(event.source) || typeof event.id !== 'string'
        || !/^[\w./:-]{1,200}$/.test(event.id)) throw new Error('failure event requires a valid source and ID');
  }
  if (!failures.length) return 0;
  if (!signalDir) throw new Error('failure delivery requires --signal-dir');
  mkdirSync(signalDir, { recursive: true, mode: 0o700 });
  for (const event of failures) {
    const incident = { schema: 1, kind: 'deployment_failure', route: 'orchestration',
      source: event.source, id: event.id, status: 'FAILED', observedAt: new Date().toISOString() };
    const line = `${JSON.stringify(incident)}\n`;
    // Per-event durable incident avoids losing failures when a later wake overwrites the latch.
    const key = createHash('sha256').update(`${event.source}:${event.id}`).digest('hex');
    const name = `incident-${key}.json`;
    const atomic = (filename, data) => {
      const temporary = join(signalDir, `.${filename}.${process.pid}.tmp`);
      writeFileSync(temporary, data, { mode: 0o600 });
      renameSync(temporary, join(signalDir, filename));
    };
    atomic(name, line);
    atomic('wake.json', `${JSON.stringify({ schema: 1, route: 'orchestration', incident: name })}\n`);
    stdout.write(line);
  }
  return failures.length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2);
    const options = {};
    for (let index = 0; index < args.length; index += 2) {
      if (!['--events', '--run', '--repo', '--signal-dir'].includes(args[index]) || !args[index + 1]
          || options[args[index]]) throw new Error('invalid watcher arguments');
      options[args[index]] = args[index + 1];
    }
    if (Boolean(options['--events']) === Boolean(options['--run'])) throw new Error('choose --events or --run');
    const events = options['--events']
      ? JSON.parse(readFileSync(options['--events'], 'utf8'))
      : pollGatewayRun(options['--repo'], options['--run']);
    emitFailures(events, options['--signal-dir']);
  } catch { console.error('deployment watcher failed to read or deliver state'); process.exitCode = 1; }
}
