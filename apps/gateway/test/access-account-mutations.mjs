import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

// Access lane U-03: the account page and sign out everywhere. Each rule dies by its named test.
const built = (name) => new URL(`../../../dist/apps/gateway/src/access/${name}`, import.meta.url);
const suites = ["access-account.test.js"].map((name) =>
  fileURLToPath(new URL(`../../../dist/apps/gateway/test/${name}`, import.meta.url)));
const mutations = [
  ["answer a signed-out visitor", "U03_SIGNED_OUT", "admin-access.js",
    "if (!session || !caller)\n", "if (!session)\n"],
  ["skip the same-origin check", "U03_SAME_ORIGIN", "admin-access.js",
    'if (!origin || req.headers.origin !== origin || req.headers["sec-fetch-site"] === "cross-site") {\n        req.resume();\n        write(403, "Account"',
    'if (false) {\n        req.resume();\n        write(403, "Account"'],
  ["accept a form with fields", "U03_SAME_ORIGIN", "admin-access.js",
    "if (!form || Object.keys(form).length !== 0) {", "if (!form) {"],
  ["keep the cookie", "U03_EVERYWHERE", "admin-access.js",
    'res.writeHead(303, { location: "/signed-out", "set-cookie": SIGNED_OUT_COOKIE, "cache-control": "no-store" });',
    'res.writeHead(303, { location: "/signed-out", "cache-control": "no-store" });'],
  ["drop a __proto__ field", "U03_SAME_ORIGIN", "admin-access.js",
    "const out = Object.create(null);", "const out = {};"],
  ["count others from the capped list", "U03_OVER_LIMIT", "admin-access.js",
    "list.live - (sessions.some((item) => item.current) ? 1 : 0)", "sessions.length - (sessions.some((item) => item.current) ? 1 : 0)"],
  ["mark another session as this browser", "U03_PAGE", "admin-access.js",
    '${item.current ? "This browser" : "Another browser or device"}', '${"This browser"}'],
];
const run = (pattern) => spawnSync(process.execPath, ["--test", "--test-reporter=tap",
  ...(pattern ? [`--test-name-pattern=^${pattern} `] : []), ...suites], { encoding: "utf8", timeout: 120_000 });
const originals = new Map();
for (const [, , file] of mutations) if (!originals.has(file)) originals.set(file, await readFile(built(file), "utf8"));
try {
  assert.equal(run().status, 0, "the unmutated suites pass");
  for (const [name, pattern, file, from, to] of mutations) {
    const original = originals.get(file);
    assert.equal(original.split(from).length - 1, 1, `mutation binds exactly once: ${name}`);
    await writeFile(built(file), original.replace(from, to));
    const result = run(pattern);
    const output = result.stdout + result.stderr;
    assert.notEqual(result.status, 0, `${name}: mutation survived\n${output}`);
    assert.match(output, new RegExp(`not ok \\d+ - ${pattern} `), `${name}: named test did not fail\n${output}`);
    assert.match(output, /AssertionError|ERR_ASSERTION/, `${name}: did not die by assertion\n${output}`);
    process.stdout.write(`KILLED ${name} -> ${pattern}\n`);
    await writeFile(built(file), original);
  }
} finally {
  for (const [file, original] of originals) await writeFile(built(file), original);
}
assert.equal(run().status, 0, "the restored suites pass");
process.stdout.write(`${mutations.length}/${mutations.length} access U-03 mutations killed\n`);
