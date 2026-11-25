import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Access lane (migration 0410): a person's email is verified only when the
// issuer said so for their current address. Each mutation rewrites a built
// file in place, the named test must fail by assertion, and the file is restored.
if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required for the access email verification mutations");
const loginStore = new URL("../dist/postgres-login-store.js", import.meta.url);
const predicate = new URL("../dist/access/email-verification.js", import.meta.url);
const suite = fileURLToPath(new URL("../../../dist/packages/db/test/postgres-access-email-verification.test.js", import.meta.url));
const mutations = [
  ["record an answer for an address that is not the person's", loginStore, "EV_OTHER_ADDRESS",
    "AND lower(btrim(p.email)) = lower(btrim($2::text))", ""],
  ["keep the first answer instead of the issuer's latest", loginStore, "EV_RECORD",
    "DO UPDATE SET verified = EXCLUDED.verified,", "DO UPDATE SET verified = principal_email_verifications.verified,"],
  ["count an address recorded as not verified", predicate, "EV_RECORD",
    "AND pev.verified AND", "AND"],
  ["read the principal without locking it", loginStore, "EV_SERIAL_CHANGE_FIRST",
    "        FOR SHARE OF p\n", ""],
  ["recover by deleting the answers instead of vetoing", loginStore, "EV_VETO_LEGACY",
    "DO UPDATE SET verified = false, source = 'oidc', recorded_at = EXCLUDED.recorded_at`, [personId]);",
    "DO NOTHING`, [personId]);\n        await this.#pool.query(\"DELETE FROM principal_email_verifications WHERE principal_id = $1::text\", [personId]);"],
  ["veto with a true answer", loginStore, "EV_VETO",
    "SELECT p.id, lower(btrim(p.email)), false, 'oidc', now()", "SELECT p.id, lower(btrim(p.email)), true, 'oidc', now()"],
  ["keep an earlier true when vetoing", loginStore, "EV_VETO",
    "DO UPDATE SET verified = false, source", "DO UPDATE SET source"],
];
const run = (pattern) => spawnSync(process.execPath, ["--test", "--test-reporter=tap", "--test-concurrency=1",
  ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), suite], { encoding: "utf8", timeout: 120_000 });
const originals = new Map([[loginStore.href, await readFile(loginStore, "utf8")], [predicate.href, await readFile(predicate, "utf8")]]);
const restore = async () => { for (const [href, text] of originals) await writeFile(new URL(href), text); };
try {
  assert.equal(run().status, 0, "the unmutated suite passes");
  for (const [name, file, pattern, from, to] of mutations) {
    const original = originals.get(file.href);
    assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
    await writeFile(file, original.replace(from, to));
    const result = run(pattern);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `${name}: mutation survived\n${output}`);
    assert.match(output, new RegExp(`not ok \\d+ - ${pattern} `), `${name}: named test did not fail\n${output}`);
    assert.match(output, /AssertionError|ERR_ASSERTION/, `${name}: did not die by assertion\n${output}`);
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
    await writeFile(file, original);
  }
} finally {
  await restore();
}
assert.equal(run().status, 0, "the restored suite passes");
process.stdout.write(`${mutations.length}/${mutations.length} access email verification Postgres mutations killed\n`);
