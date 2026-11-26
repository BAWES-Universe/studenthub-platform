import { run } from "node:test";

const [file, encoded] = process.argv.slice(2);
const expected = new Set(JSON.parse(encoded));
const seen = new Set();
let aggregate, perFile, bytes = 0;
let namedTests = 0;
let outputLimited = false;
const abort = new AbortController();
try {
  for await (const { type, data } of run({
    files: [file], isolation: "process", signal: abort.signal, concurrency: 1,
  })) {
    if (type === "test:stdout" || type === "test:stderr") {
      bytes += Buffer.byteLength(data.message);
      if (bytes > 64 * 1024) {
        outputLimited = true;
        abort.abort();
        break;
      }
    }
    if ((type === "test:pass" || type === "test:fail") &&
        data.details?.type === "test" && !data.skip && !data.todo) {
      if (expected.has(data.name)) seen.add(data.name);
      if (data.name !== file) namedTests += 1;
    }
    if (type === "test:summary") {
      if (data.file === file) perFile = data;
      if (!data.file) aggregate = data;
    }
  }
} catch {
  if (!outputLimited) {
    process.send?.({ outcome: "UNAVAILABLE", reason: "reporter_error" });
    process.exitCode = 2;
  }
}
if (!process.exitCode) {
  const missing = [...expected].filter((name) => !seen.has(name)).length;
  let outcome = "PASS", reason = null;
  if (outputLimited) [outcome, reason] = ["UNAVAILABLE", "output_limit"];
  else if (!aggregate) [outcome, reason] = ["UNAVAILABLE", "incomplete_report"];
  else if (!aggregate.success || aggregate.counts.failed || aggregate.counts.cancelled) [outcome, reason] = ["FAIL", "test_runner_failure"];
  else if (!perFile || !perFile.counts.passed || !namedTests) [outcome, reason] = ["NO_RUN", "no_completed_tests"];
  else if (missing) [outcome, reason] = ["NO_RUN", "changed_named_test_missing"];
  process.send?.({ outcome, reason, counts: perFile?.counts ?? null, expectedCount: expected.size, missingCount: missing });
  process.exitCode = outcome === "PASS" ? 0 : 1;
}
