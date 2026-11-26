// Access lane U-03: the Account page is reachable from the workspace sidebar and
// the profile menu wherever the sessions store is wired. Mutants run on a copy.
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = mkdtempSync(join(process.cwd(), ".account-link-mutations-"));
try {
  cpSync("dist", join(root, "dist"), { recursive: true });
  cpSync("packages/db/dist", join(root, "packages/db/dist"), { recursive: true });
  const testFile = join(root, "dist/apps/gateway/test/access-admin.test.js");
  const run = () => spawnSync(process.execPath,
    ["--test", "--experimental-test-isolation=none", "--test-reporter=tap", "--test-name-pattern=^U03_ACCOUNT_LINK", testFile],
    { encoding: "utf8", timeout: 60_000 });
  assert.equal(run().status, 0, "account link mutation baseline");
  const mutants = [
    ["drop the workspace link", "dist/apps/gateway/src/web-ui.js", "${accountLink(login)}</nav>", "</nav>"],
    ["show the workspace link without the sessions store", "dist/apps/gateway/src/web-ui.js",
      "return login.access?.account ? '<a", "return login.access ? '<a"],
    ["show the menu entry without the sessions store", "dist/apps/gateway/src/contributions/access.js",
      "visible: (login) => Boolean(login.access?.account)", "visible: (login) => Boolean(login.access)"],
  ];
  for (const [name, relative, from, to] of mutants) {
    const file = join(root, relative);
    const original = readFileSync(file, "utf8");
    assert.equal(original.split(from).length - 1, 1, `${name}: unique compiled anchor`);
    writeFileSync(file, original.replace(from, to));
    const result = run();
    assert.equal(result.status, 1, `${name}: mutant survived\n${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.split("\n").some((line) => line.startsWith("not ok ") && line.includes("U03_ACCOUNT_LINK")),
      `${name}: U03_ACCOUNT_LINK did not fail\n${result.stdout}${result.stderr}`);
    assert.ok(result.stdout.includes("ERR_ASSERTION"), `${name}: failure was not an assertion\n${result.stdout}${result.stderr}`);
    writeFileSync(file, original);
    console.log(`KILLED: ${name}`);
  }
  assert.equal(run().status, 0, "restored account link mutation baseline");
} finally {
  rmSync(root, { recursive: true, force: true });
}
