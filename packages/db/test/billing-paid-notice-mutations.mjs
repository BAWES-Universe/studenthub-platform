import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Pay F6 paid notices: each guard between a paid line and the person's feed must be
// load-bearing. Each mutant rewrites one built file (or the migration), the named test
// must fail by assertion, and the file is restored before the next.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the paid notice mutations");
const files = {
  store: new URL("../dist/billing/postgres-bank-result-store.js", import.meta.url),
  feed: new URL("../dist/postgres-notifications-store.js", import.meta.url),
  kind: new URL("../../../dist/packages/notifications/src/notifications.js", import.meta.url),
  migration: new URL("../migrations/0607_pay_line_paid_feed.sql", import.meta.url),
};
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-billing-paid-notice.test.js", import.meta.url));
const mutations = [
  ["send no paid notice", "PAID_NOTICE_ONE", "store",
    "await client.query(`INSERT INTO notifications(", "if (false) await client.query(`INSERT INTO notifications("],
  ["address the notice to the finance actor", "PAID_NOTICE_ONE", "store",
    "[people.get(d.lineId), `bank_confirmation:", "[actor.principalId, `bank_confirmation:"],
  ["render another person's line", "PAID_NOTICE_OWN", "feed",
    "WHERE l.person_id=$1 AND l.paid AND", "WHERE $1::text IS NOT NULL AND l.paid AND"],
  ["show the raw stored amount", "PAID_NOTICE_ONE", "kind",
    "${p.currencyCode} ${amount} has been", "${p.currencyCode} ${p.amount} has been"],
  ["open the pay list instead of the line", "PAID_NOTICE_ONE", "kind",
    "href: `/pay/${encodeURIComponent(p.lineId)}`", "href: `/pay`"],
  ["accept parameters on the paid notice", "PAID_NOTICE_CHECK", "migration",
    "'^bank_confirmation:[1-9][0-9]{0,18}$'\n  AND parameters='{}'::jsonb)", "'^bank_confirmation:[1-9][0-9]{0,18}$')"],
  ["drop an earlier kind when re-stating the rule", "PAID_NOTICE_CHECK", "migration",
    " OR\n (kind='work.assigned'", " OR\n (kind='work.assigned.gone'"],
];
const originals = Object.fromEntries(await Promise.all(Object.entries(files).map(async ([k, u]) => [k, await readFile(u, "utf8")])));
const restore = () => Promise.all(Object.entries(files).map(([k, u]) => writeFile(u, originals[k])));
const run = (pattern) => spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1",
  ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], { encoding: "utf8", timeout: 120_000 });
let killed = 0;
try {
  assert.equal(run().status, 0, "the unmutated suite passes");
  for (const [name, pattern, file, from, to] of mutations) {
    const original = originals[file];
    assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
    await writeFile(files[file], original.replace(from, () => to));
    const result = run(pattern);
    const output = result.stdout + result.stderr;
    assert.equal(result.error, undefined, `${name}: runner error`);
    assert.notEqual(result.status, 0, `${name}: mutation survived\n${output}`);
    assert.match(output, new RegExp(`not ok \\d+ - ${pattern} `), `${name}: named test did not fail\n${output}`);
    assert.doesNotMatch(output, /SyntaxError|ERR_MODULE_NOT_FOUND/, `${name}: infrastructure failure\n${output}`);
    assert.match(output, /AssertionError|ERR_ASSERTION/, `${name}: did not die by assertion\n${output}`);
    killed++;
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
    await restore();
  }
} finally { await restore(); }
assert.equal(run().status, 0, "the restored suite passes");
process.stdout.write(`${killed}/${mutations.length} paid notice mutations killed\n`);
