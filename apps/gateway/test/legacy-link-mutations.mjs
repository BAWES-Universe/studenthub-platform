import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const http = await readFile(new URL("../../../dist/apps/gateway/src/legacy-link-http.js", import.meta.url), "utf8");
const login = await readFile(new URL("../../../dist/apps/gateway/src/legacy-login.js", import.meta.url), "utf8");
const store = await readFile(new URL("../../../dist/packages/db/src/postgres-legacy-link-store.js", import.meta.url), "utf8");
const needles = [
  [store, "VALUES ($1::text, $2::text, 'linked'", "item 1 event write"],
  [http, "Reset it on StudentHub, then come back", "item 2 reset link"],
  [http, "That email and password don't match a StudentHub account", "item 3 common refusal"],
  [http, 'return { kind: "waiting" }; return result(principalId, await input.legacy.login(credentials))', "item 3 wait check"],
  [http, "async login(principalId, credentials) { if ((await input.store.status(principalId)).linked)", "item 4 linked pre-check"],
  [store, "async resolveLink(principalId)", "item 5 immutable-key resolve"],
  [login, 'headers: { authorization, accept: "application/json" }', "item 6 header-only password"],
  [await readFile(new URL("../../../dist/apps/gateway/src/web-ui.js", import.meta.url), "utf8"), "profile.legacyPrompt", "item 7 prompt"],
];
for (const [source, needle, name] of needles) {
  assert.equal(source.split(needle).length - 1, 1, `${name} binds exactly once`);
  process.stdout.write(`PINNED ${name}\n`);
}
process.stdout.write("8/8 SHU-514 mutation bindings pinned; database concurrency/transaction mutants require CI Postgres\n");
