import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const runtime = await readFile(new URL("../../../dist/apps/gateway/src/login-runtime.js", import.meta.url), "utf8");
const contributions = await readFile(new URL("../../../dist/apps/gateway/src/contributions/index.js", import.meta.url), "utf8");
for (const needle of ["...payContractArea.services", "access.close()", "profile.close()", "organizationArea.close()", "payContractArea.close()", "ops.close()"]) {
  assert.equal(runtime.split(needle).length - 1, 1, `PREP_WIRING_COUNT mutation needle ${needle}`);
}
for (const needle of ["left.order - right.order", "duplicate contribution key"]) {
  assert.equal(contributions.split(needle).length - 1, 1, `PREP_NAV_MERGE mutation needle ${needle}`);
}
